// One detail page per event. The recurring events from events.js are the skeleton (what usually happens, when);
// an optional AI step (needs ANTHROPIC_API_KEY) reads fresh sources (RSI Comm-Links and a few fixed news pages),
// keeps the page up to date and creates pages for events nobody listed yet. Without a key the pages simply show the
// static data, nothing breaks.
const crypto = require("crypto");
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
const MODEL = process.env.EVENT_AI_MODEL || "claude-haiku-4-5-20251001";
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

async function ask(system, user, maxTokens = 3000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = (await res.json()).content?.map((c) => c.text || "").join("") || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI answered without JSON");
  return JSON.parse(m[0]);
}

const SYSTEM = `You maintain event pages for a Star Citizen organization. You get the current page as JSON and fresh source texts.
Return the updated page as ONE JSON object with exactly these keys: name, status ("official" only if a robertsspaceindustries.com source states the dates, "leaked" if only datamining/community sources, otherwise "expected"), startDate and endDate (YYYY-MM-DD in the game year, or null), location (string or null), summary (2-4 sentences, plain English), highlights (string array), schedule (array of {date, title, detail}), ships (array of {name, maker, date, note}), sales (string or null: what is sold, discounts, how it works), howToJoin (string or null), sources (array of {title, url}, only pages you actually used).
Use ONLY facts stated in the sources or already on the page. Never invent dates, ships or prices. Keep unknown fields empty. English only.`;

const needsKey = () => !KEY;

async function researchOne(page) {
  const kws = [page.name.replace(/\(.*?\)/g, "").trim(), ...(page.name.match(/\((.*?)\)/) ? [page.name.match(/\((.*?)\)/)[1]] : [])].map((s) => s.toLowerCase());
  const ann = getRecentAnnouncements(60).filter((a) => kws.some((k) => a.title.toLowerCase().includes(k)) || (a.matchedKeywords || []).some((k) => kws.includes(k.toLowerCase())));
  const urls = [...new Set([...ann.slice(0, 3).map((a) => a.url), ...(EXTRA_SOURCES[page.slug] || [])])];
  const texts = [];
  for (const u of urls) {
    const t = await fetchText(u);
    if (t && t.length > 400) texts.push({ url: u, text: t });
  }
  if (!texts.length) return false;
  const hash = crypto.createHash("sha1").update(texts.map((t) => t.url + t.text).join("|")).digest("hex");
  const r = row(page.slug);
  if (r && r.source_hash === hash) return false;
  const out = await ask(SYSTEM, `Current page:\n${JSON.stringify(page)}\n\nSources:\n${texts.map((t) => `--- ${t.url}\n${t.text}`).join("\n\n")}`);
  save({ ...page, ...out, slug: page.slug, recurring: page.recurring, majorSale: page.majorSale }, hash);
  return true;
}

/** Titles of new RSI Comm-Links that look like an event or sale nobody has a page for yet. */
async function discover(log) {
  const known = getEventPages().map((p) => p.name);
  const seenKey = "event_discovery_seen";
  const seen = new Set(JSON.parse(getMeta(seenKey) || "[]"));
  const fresh = getRecentAnnouncements(40).filter((a) => !seen.has(a.id));
  if (!fresh.length) return 0;
  const out = await ask(
    "You classify Star Citizen news titles. Return ONE JSON object {\"events\":[{\"id\":\"<id>\",\"name\":\"<short official event name>\"}]} listing ONLY titles that announce a store event, sale, free-fly or in-game event that is NOT already one of the known events. Most titles are not events: return an empty list then.",
    `Known events: ${known.join("; ")}\nTitles:\n${fresh.map((a) => `${a.id} | ${a.title}`).join("\n")}`,
    800,
  );
  let created = 0;
  for (const ev of out.events || []) {
    const a = fresh.find((x) => x.id === ev.id);
    if (!a || !ev.name) continue;
    const slug = slugify(ev.name);
    if (!slug || row(slug)) continue;
    const page = { slug, name: ev.name, status: "official", recurring: null, majorSale: false, summary: a.title, highlights: [], schedule: [], ships: [], sources: [{ title: a.title, url: a.url }], discovered: true };
    const text = await fetchText(a.url);
    const filled = text ? await ask(SYSTEM, `Current page:\n${JSON.stringify(page)}\n\nSources:\n--- ${a.url}\n${text}`).catch(() => null) : null;
    save(filled ? { ...page, ...filled, slug, recurring: null, discovered: true } : page, null);
    created++;
    log(`[events] new event page: ${ev.name}`);
  }
  for (const a of fresh) seen.add(a.id);
  setMeta(seenKey, JSON.stringify([...seen].slice(-300)));
  return created;
}

/** Runs from the scan cycle, at most every 6 hours; does nothing without an API key. */
async function refreshEventPages(log = console.log) {
  if (needsKey()) return { skipped: "no ANTHROPIC_API_KEY" };
  const last = getMeta("event_ai_run_at");
  if (last && Date.now() - new Date(last).getTime() < 6 * 3600 * 1000) return { skipped: "recent" };
  setMeta("event_ai_run_at", new Date().toISOString());
  const now = new Date();
  let updated = 0;
  for (const p of getEventPages()) {
    // only events that are close (or running); the rest cannot have news worth paying for
    const m = p.recurring?.month;
    const near = !m || ((m - 1 - now.getUTCMonth() + 12) % 12 <= 4) || p.discovered || p.status !== "expected";
    if (!near) continue;
    try {
      if (await researchOne(p)) updated++;
    } catch (e) {
      log(`[events] ${p.name}: ${e.message}`);
    }
  }
  const created = await discover(log).catch((e) => (log(`[events] discovery: ${e.message}`), 0));
  log(`[events] ${updated} pages updated, ${created} new`);
  return { updated, created };
}

module.exports = { getEventPages, getEventPage, refreshEventPages };
