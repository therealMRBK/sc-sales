// One detail page per event. The recurring events from events.js are the skeleton (what usually happens, when);
// an optional AI step (needs ANTHROPIC_API_KEY) runs once a day: it reads RSI Comm-Links and a few fixed pages, searches
// the web for news, leaks and datamining about each upcoming event, keeps the page up to date (including a news list)
// and creates pages for events nobody listed yet. Without a key the pages simply show the static data, nothing breaks.
const Anthropic = require("@anthropic-ai/sdk");
const { db, getRecentAnnouncements, getMeta, setMeta } = require("./db");
const RECURRING = require("./events");

db.exec(`CREATE TABLE IF NOT EXISTS event_pages (
  slug TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_hash TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL
);`);

const KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const MODEL = process.env.EVENT_AI_MODEL || "claude-haiku-5-5";
const INTERVAL_HOURS = Number(process.env.EVENT_AI_INTERVAL_HOURS || 24);
// Web searches per event and run ($10 per 1000 searches): a handful is enough for one event's news of the day.
const SEARCHES_PER_EVENT = Number(process.env.EVENT_AI_SEARCHES || 3);
const client = KEY ? new Anthropic({ apiKey: KEY }) : null;
const slugify = (s) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Facts we know now (kept short on purpose; the AI step extends and corrects them).
const SEED = {
  "intergalactic-aerospace-expo": {
    status: "leaked",
    startDate: "2956-11-13",
    endDate: "2956-11-30",
    location: "Tobin Expo Hall, New Babbage (MicroTech)",
    summary:
      "The biggest ship event of the year: a free-fly period in which nearly every ship and vehicle can be flown for free, plus the largest pledge sale. The dates below were found in the Alpha 4.10.2 game files and are not confirmed by RSI yet.",
    schedule: [
      { date: "2956-11-13", title: "Expo opens", detail: "Constellation Mk V Andromeda and Skylark (both RSI) debut." },
      { date: "2956-11-15", title: "Anvil HM6 Auxelia debuts" },
      { date: "2956-11-17", title: "Drake Marauder debuts" },
      { date: "2956-11-18", title: "Greycat MFC debuts" },
      { date: "2956-11-21", title: "GATAC Hyun debuts" },
      { date: "2956-11-30", title: "Expo ends" },
    ],
    ships: [
      { name: "Constellation Mk V Andromeda", maker: "RSI", date: "2956-11-13" },
      { name: "Skylark", maker: "RSI", date: "2956-11-13" },
      { name: "HM6 Auxelia", maker: "Anvil Aerospace", date: "2956-11-15" },
      { name: "Marauder", maker: "Drake Interplanetary", date: "2956-11-17" },
      { name: "MFC", maker: "Greycat Industrial", date: "2956-11-18" },
      { name: "Hyun", maker: "GATAC", date: "2956-11-21" },
      { name: "Galaxy", maker: "RSI", note: "Announced earlier as the headliner." },
      { name: "Liberator", maker: "Anvil Aerospace", note: "A surprise: this light carrier was planned for 2027." },
    ],
    highlights: ["Free-fly with all ships", "Biggest pledge sale of the year", "Also leaked: Monolith armor and the VKL L55 SMG"],
    sources: [
      { title: "LimitLoot: IAE 2956 datamining", url: "https://limitloot.de/star-citizen/news/datamining-iae-2956-neue-schiffe-fahrzeuge" },
      { title: "MMOPIXEL: 4.10.2 leaks and reveals", url: "https://www.mmopixel.com/news/star-citizen-4-10-2-leaks-and-reveals" },
    ],
  },
};
// Extra pages the AI should read for an event (besides matching RSI Comm-Links).
const EXTRA_SOURCES = {
  "intergalactic-aerospace-expo": ["https://limitloot.de/star-citizen/news/datamining-iae-2956-neue-schiffe-fahrzeuge", "https://starcitizen.tools/Intergalactic_Aerospace_Expo"],
};

function base(e) {
  const slug = slugify(e.name);
  return {
    slug,
    name: e.name,
    status: "expected",
    recurring: { month: e.month, day: e.day ?? null },
    majorSale: !!e.majorSale,
    summary: e.noteEn,
    highlights: [],
    schedule: [],
    ships: [],
    news: [],
    sources: [],
    ...(SEED[slug] || {}),
  };
}

const row = (slug) => db.prepare("SELECT * FROM event_pages WHERE slug = ?").get(slug);
function save(page, hash) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO event_pages (slug, data, source_hash, checked_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET data = excluded.data, source_hash = COALESCE(excluded.source_hash, source_hash), checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
  ).run(page.slug, JSON.stringify(page), hash ?? null, now, now);
}

/** All pages: the stored version when there is one, otherwise the static skeleton. Plus pages the AI discovered. */
function getEventPages() {
  const pages = new Map();
  for (const e of RECURRING) {
    const b = base(e);
    const r = row(b.slug);
    pages.set(b.slug, r ? { ...b, ...JSON.parse(r.data), updatedAt: r.updated_at } : b);
  }
  for (const r of db.prepare("SELECT * FROM event_pages").all()) if (!pages.has(r.slug)) pages.set(r.slug, { ...JSON.parse(r.data), updatedAt: r.updated_at });
  return [...pages.values()];
}
const getEventPage = (slug) => getEventPages().find((p) => p.slug === slug) || null;

// ---- AI -----------------------------------------------------------------------------------------------------

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; urmtek-calendar/1.0)" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const html = await res.text();
    return html
      .replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24000);
  } catch {
    return null;
  }
}

// Web searches made in this run (logged, they are the main cost).
let searches = 0;

/**
 * One request; with `search` > 0 Claude may search the web that many times. Server-side searches can pause a long turn
 * (stop_reason "pause_turn"): the answer so far goes back as the assistant turn and the request continues.
 */
async function ask(system, user, { maxTokens = 16000, search = 0 } = {}) {
  const tools = search > 0 ? [{ type: "web_search_20250305", name: "web_search", max_uses: search }] : undefined;
  const messages = [{ role: "user", content: user }];
  let response;
  for (let turn = 0; turn < 4; turn++) {
    response = await client.messages.create({ model: MODEL, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) }, { timeout: 180000 });
    searches += response.usage?.server_tool_use?.web_search_requests || 0;
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  if (response.stop_reason === "refusal") throw new Error(`AI declined (${response.stop_details?.category ?? "no category"})`);
  // with web search the answer is spread over several text blocks around the search results
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`AI answered without JSON (${response.stop_reason})`);
  return JSON.parse(m[0]);
}

const SYSTEM = `You maintain event pages for a Star Citizen organization. You get the current page as JSON and source texts, and you may search the web.
Search for what is new about this event: RSI announcements (robertsspaceindustries.com Comm-Links, Spectrum, This Week in Star Citizen), patch notes, datamining and leaks (game files, PTU/Evocati builds), and community news (Reddit r/starcitizen, starcitizen.tools, news sites). Prefer the last few weeks.
Return the updated page as ONE JSON object with exactly these keys: name, status ("official" only if a robertsspaceindustries.com source states the dates, "leaked" if only datamining/community sources, otherwise "expected"), startDate and endDate (YYYY-MM-DD in the game year, or null), location (string or null), summary (2-4 sentences, plain English), highlights (string array), schedule (array of {date, title, detail}), ships (array of {name, maker, date, note}), sales (string or null: what is sold, discounts, how it works), howToJoin (string or null), news (array of {date, title, summary, url, kind}), sources (array of {title, url}, only pages you actually used).
news: the newest findings first, at most 12. date is the real-world publication date (YYYY-MM-DD), summary one or two sentences, kind is "official" (RSI said it), "leak" (datamined or leaked), or "rumor" (unconfirmed community talk). Keep earlier news items of the page unless a newer source shows they were wrong; then drop them.
Leaked facts may go into schedule and ships, with "leaked" in the note or detail. Rumors stay in news only.
Use ONLY facts stated in the sources, the search results or already on the page. Never invent dates, ships, prices or URLs. Keep unknown fields empty. English only. Answer with the JSON object and nothing else.`;

const needsKey = () => !KEY;

async function researchOne(page) {
  const kws = [page.name.replace(/\(.*?\)/g, "").trim(), ...(page.name.match(/\((.*?)\)/) ? [page.name.match(/\((.*?)\)/)[1]] : [])].map((s) => s.toLowerCase());
  const ann = getRecentAnnouncements(60).filter((a) => kws.some((k) => a.title.toLowerCase().includes(k)) || (a.matchedKeywords || []).some((k) => kws.includes(k.toLowerCase())));
  const urls = [...new Set([...ann.slice(0, 3).map((a) => a.url), ...(EXTRA_SOURCES[page.slug] || []), ...(page.sources || []).slice(0, 2).map((s) => s.url)])];
  const texts = [];
  for (const u of urls) {
    const t = await fetchText(u);
    if (t && t.length > 400) texts.push({ url: u, text: t });
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = await ask(
    SYSTEM,
    `Today is ${today}.\n\nCurrent page:\n${JSON.stringify(page)}\n\nSources:\n${texts.length ? texts.map((t) => `--- ${t.url}\n${t.text}`).join("\n\n") : "(none fetched, use the web search)"}`,
    { search: SEARCHES_PER_EVENT },
  );
  save({ ...page, ...out, slug: page.slug, name: page.name, recurring: page.recurring, majorSale: page.majorSale, discovered: page.discovered }, null);
  return true;
}

/** New events nobody has a page for yet: from new RSI Comm-Link titles and from a web search for announcements and leaks. */
async function discover(log) {
  const known = getEventPages().map((p) => p.name);
  const seenKey = "event_discovery_seen";
  const seen = new Set(JSON.parse(getMeta(seenKey) || "[]"));
  const fresh = getRecentAnnouncements(40).filter((a) => !seen.has(a.id));
  const out = await ask(
    `You find Star Citizen events. Search the web for store events, sales, free-fly weeks and in-game events that RSI announced, or that leaked or were datamined, in the last two weeks. Also look at the new RSI news titles given to you.
Return ONE JSON object {"events":[{"name":"<short official event name>","url":"<the page that announces or leaks it>"}]} listing ONLY events that are NOT already one of the known events (also not under another name). Most news is not a new event: return an empty list then. Never invent events or URLs. Answer with the JSON object and nothing else.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.\nKnown events: ${known.join("; ")}\nNew RSI titles:\n${fresh.map((a) => `${a.title} | ${a.url}`).join("\n") || "(none)"}`,
    { maxTokens: 8000, search: SEARCHES_PER_EVENT },
  );
  let created = 0;
  for (const ev of out.events || []) {
    if (!ev.name || !/^https?:\/\//.test(ev.url || "")) continue;
    const slug = slugify(ev.name);
    if (!slug || row(slug) || getEventPages().some((p) => p.slug === slug)) continue;
    const isRsi = /robertsspaceindustries\.com/.test(ev.url);
    const page = { slug, name: ev.name, status: isRsi ? "official" : "leaked", recurring: null, majorSale: false, summary: "", highlights: [], schedule: [], ships: [], news: [], sources: [{ title: ev.name, url: ev.url }], discovered: true };
    save(page, null);
    await researchOne(page).catch((e) => log(`[events] ${ev.name}: ${e.message}`));
    created++;
    log(`[events] new event page: ${ev.name}`);
  }
  for (const a of fresh) seen.add(a.id);
  setMeta(seenKey, JSON.stringify([...seen].slice(-300)));
  return created;
}

// Dates on the pages are in the game year, which runs 930 years ahead of ours.
const GAME_YEAR_OFFSET = 930;
/** An event that ended more than two weeks ago: nothing new will come, so it is not researched any more. */
function isOver(page) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(page.endDate || "");
  if (!m) return false;
  const end = Date.UTC(Number(m[1]) - GAME_YEAR_OFFSET, Number(m[2]) - 1, Number(m[3]));
  return Date.now() - end > 14 * 86400 * 1000;
}

/** Runs from the scan cycle, once every EVENT_AI_INTERVAL_HOURS (default a day); does nothing without an API key. */
async function refreshEventPages(log = console.log) {
  if (needsKey()) return { skipped: "no ANTHROPIC_API_KEY" };
  // a changed prompt or model refreshes all pages right away instead of waiting out the interval
  const version = `${MODEL}:${SYSTEM.length}`;
  const last = getMeta("event_ai_run_at");
  if (last && getMeta("event_ai_version") === version && Date.now() - new Date(last).getTime() < INTERVAL_HOURS * 3600 * 1000) return { skipped: "recent" };
  setMeta("event_ai_run_at", new Date().toISOString());
  setMeta("event_ai_version", version);
  searches = 0;
  const now = new Date();
  let updated = 0;
  for (const p of getEventPages()) {
    // only events that are close (or running); the rest cannot have news worth paying for
    const m = p.recurring?.month;
    const near = !m || ((m - 1 - now.getUTCMonth() + 12) % 12 <= 4) || p.discovered || p.status !== "expected";
    if (!near || isOver(p)) continue;
    try {
      if (await researchOne(p)) updated++;
    } catch (e) {
      log(`[events] ${p.name}: ${e.message}`);
    }
  }
  const created = await discover(log).catch((e) => (log(`[events] discovery: ${e.message}`), 0));
  log(`[events] ${updated} pages updated, ${created} new, ${searches} web searches`);
  return { updated, created, searches };
}

module.exports = { getEventPages, getEventPage, refreshEventPages };
