// Watches status.robertsspaceindustries.com (cState: index.json + RSS) and keeps a Discord channel current:
//  - one status message (Platform, Persistent Universe, Arena Commander), edited in place when something changes
//  - a new message when RSI opens an incident or maintenance, edited while it gets updates,
//    and another new message when it is resolved.
// Plain polling every minute, no AI.
const crypto = require("crypto");
const { getMeta, setMeta } = require("./db");

const WEBHOOK = (process.env.DISCORD_STATUS_WEBHOOK_URL || "").trim().split("?")[0];
const INTERVAL_MS = Number(process.env.STATUS_INTERVAL_SECONDS || 60) * 1000;
const NAME = process.env.DISCORD_POST_NAME || "URMTeK Status";
const AVATAR = process.env.DISCORD_AVATAR_URL || "https://urmtek.org/discord-app-icon.png";
const BASE = "https://status.robertsspaceindustries.com";
const WATCHED = ["Platform", "Persistent Universe", "Arena Commander"];
const UA = "urmtek-status-monitor/1.0";

const STATE = {
  operational: { icon: "🟢", text: "Operational", color: 0x2ecc71 },
  maintenance: { icon: "🔧", text: "Maintenance", color: 0x3b82f6 },
  notice: { icon: "ℹ️", text: "Notice", color: 0x3b82f6 },
  disrupted: { icon: "🟠", text: "Disrupted", color: 0xe67e22 },
  degraded: { icon: "🟠", text: "Degraded", color: 0xe67e22 },
  down: { icon: "🔴", text: "Down", color: 0xe74c3c },
};
const st = (s) => STATE[s] || { icon: "⚪", text: String(s || "unknown"), color: 0x95a5a6 };
const WORST = ["down", "disrupted", "degraded", "maintenance", "notice", "operational"];

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return JSON.parse((await res.text()).trim());
}

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const htmlToText = (h) =>
  decode(h)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/p>|<br\s*\/?>|<\/li>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<\/?strong>|<\/?b>/gi, "**")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The incident text (with all updates) from the RSS feed, keyed by the issue folder name; `recent` = newest items. */
async function incidentTexts() {
  const res = await fetch(`${BASE}/index.xml`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return {};
  const xml = await res.text();
  const out = {};
  const recent = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const guid = /<guid>([^<]+)<\/guid>/.exec(m[1])?.[1];
    const desc = /<description>([\s\S]*?)<\/description>/.exec(m[1])?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(m[1])?.[1];
    const date = /<pubDate>([^<]*)<\/pubDate>/.exec(m[1])?.[1];
    if (guid && desc) out[guid.replace(/\/$/, "")] = htmlToText(desc);
    if (guid && title && recent.length < 6) recent.push({ title: decode(title), link: guid, ts: Math.floor(new Date(date).getTime() / 1000) });
  }
  Object.defineProperty(out, "__recent", { value: recent, enumerable: false });
  return out;
}
const keyOf = (permalink) => permalink.replace(/\/index\.html$/, "").replace(/\/$/, "");

async function send(method, url, body) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({}))).retry_after || 2);
    await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 200));
    return send(method, url, body);
  }
  return res;
}
async function post(payload) {
  const res = await send("POST", `${WEBHOOK}?wait=true`, { username: NAME, avatar_url: AVATAR, allowed_mentions: { parse: [] }, ...payload });
  if (!res.ok) throw new Error(`Discord post HTTP ${res.status}`);
  return (await res.json()).id;
}
async function edit(id, payload) {
  const res = await send("PATCH", `${WEBHOOK}/messages/${id}`, { allowed_mentions: { parse: [] }, ...payload });
  if (res.status === 404) return false; // message was deleted by hand
  if (!res.ok) throw new Error(`Discord edit HTTP ${res.status}`);
  return true;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const sha = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex");

/** The status message: systems, the full text of every open incident (like the website) and the latest history. */
function statusEmbeds(systems, active, texts) {
  const watched = WATCHED.map((n) => systems.find((s) => s.name === n)).filter(Boolean);
  const worst = WORST.find((w) => watched.some((s) => s.status === w)) || "operational";
  const lines = watched.map((s) => `${st(s.status).icon} **${s.name}**: ${st(s.status).text}`);
  const head = {
    title: "RSI server status",
    url: BASE,
    color: st(worst).color,
    description: lines.join("\n") + (active.length ? "" : "\n\nNo open incidents."),
    footer: { text: "Updated every minute · status.robertsspaceindustries.com" },
  };
  // Discord allows 6000 characters over all embeds of a message
  const budget = Math.max(600, Math.floor((5200 - 400) / Math.max(1, active.length)));
  const embeds = [head];
  for (const inc of active.slice(0, 5)) {
    const sev = st(inc.severity);
    embeds.push({
      title: `${sev.icon} ${inc.title}`,
      url: inc.permalink,
      color: sev.color,
      description: clip(texts[keyOf(inc.permalink)] || "No details yet.", Math.min(budget, 3800)),
      fields: [{ name: "Affects", value: inc.affected.join(", ") || "n/a", inline: true }, { name: "Type", value: sev.text, inline: true }],
    });
  }
  const recent = texts.__recent || [];
  if (recent.length && embeds.length < 7) {
    embeds[embeds.length - 1].fields = [...(embeds[embeds.length - 1].fields || []), { name: "Recent history", value: clip(recent.map((r) => `<t:${r.ts}:d> [${r.title}](${r.link})`).join("\n"), 1000) }];
  }
  return embeds;
}

/** Short notification only; the full text lives in the status message. */
function incidentEmbed(inc, resolved) {
  const sev = st(inc.severity);
  return {
    title: `${resolved ? "✅ Resolved: " : `${sev.icon} New: `}${inc.title}`,
    url: inc.permalink,
    color: resolved ? 0x2ecc71 : sev.color,
    description: resolved ? "RSI marked this as resolved." : "Details are in the live status message above.",
    fields: [
      { name: "Affects", value: inc.affected.join(", ") || "n/a", inline: true },
      { name: "Type", value: sev.text, inline: true },
    ],
    footer: { text: "RSI status page" },
    timestamp: new Date().toISOString(),
  };
}

let running = false;
async function checkStatus(log = console.log) {
  if (!WEBHOOK || running) return;
  running = true;
  try {
    const idx = await getJson(`${BASE}/index.json`);
    const systems = idx.systems || [];
    const open = new Map();
    for (const s of systems) for (const i of s.unresolvedIssues || []) if (!i.resolved) open.set(i.permalink, i);
    const active = [...open.values()].map((i) => ({ ...i, affected: i.affected || [] }));

    const state = JSON.parse(getMeta("rsi_status_state") || "{}");
    state.incidents ||= {};
    const texts = await incidentTexts().catch(() => ({}));

    // 1) incidents: new -> short notice, gone -> notice replaced by a "Resolved" one (the live message carries the text)
    for (const inc of active) {
      const known = state.incidents[inc.permalink];
      if (!known) {
        const id = await post({ embeds: [incidentEmbed(inc, false)] });
        state.incidents[inc.permalink] = { msgId: id, resolved: false, title: inc.title, severity: inc.severity, affected: inc.affected };
        log(`[status] new incident: ${inc.title}`);
      }
    }
    for (const [link, known] of Object.entries(state.incidents)) {
      if (known.resolved || open.has(link)) continue;
      const inc = { title: known.title.replace(/^\[Resolved\]\s*/i, ""), permalink: link, severity: known.severity, affected: known.affected || [] };
      if (known.msgId) await send("DELETE", `${WEBHOOK}/messages/${known.msgId}`); // the "New" notice is replaced by the "Resolved" one
      await post({ embeds: [incidentEmbed(inc, true)] });
      known.resolved = true;
      known.resolvedAt = new Date().toISOString();
      log(`[status] incident resolved: ${inc.title}`);
    }
    // keep the state small: forget incidents resolved more than 3 days ago
    for (const [link, k] of Object.entries(state.incidents)) if (k.resolved && Date.now() - new Date(k.resolvedAt).getTime() > 3 * 86400000) delete state.incidents[link];

    // 2) the status message
    const embeds = statusEmbeds(systems, active, texts);
    const hash = sha(embeds);
    if (state.statusHash !== hash || !state.statusMsgId) {
      const ok = state.statusMsgId ? await edit(state.statusMsgId, { embeds }) : false;
      if (!ok) state.statusMsgId = await post({ embeds });
      state.statusHash = hash;
      log("[status] status message updated");
    }
    setMeta("rsi_status_state", JSON.stringify(state));
  } catch (e) {
    log(`[status] ${e.message}`);
  } finally {
    running = false;
  }
}

/** One-time clean slate: deletes every message this monitor posted and forgets its state (runs when RESET_TOKEN changes). */
async function resetIfRequested(log) {
  const token = (process.env.DISCORD_STATUS_RESET_TOKEN || "").trim();
  if (!token || getMeta("rsi_status_reset_done") === token) return;
  const state = JSON.parse(getMeta("rsi_status_state") || "{}");
  const ids = [state.statusMsgId, ...Object.values(state.incidents || {}).map((i) => i.msgId)].filter(Boolean);
  for (const id of ids) {
    const res = await send("DELETE", `${WEBHOOK}/messages/${id}`);
    log(`[status] reset: deleted message ${id} (HTTP ${res.status})`);
  }
  setMeta("rsi_status_state", "{}");
  setMeta("rsi_status_reset_done", token);
}

async function startStatusMonitor(log = console.log) {
  if (!WEBHOOK) return log("[status] no DISCORD_STATUS_WEBHOOK_URL, monitor off");
  await resetIfRequested(log).catch((e) => log(`[status] reset failed: ${e.message}`));
  setTimeout(() => checkStatus(log), 3000);
  setInterval(() => checkStatus(log), INTERVAL_MS);
  log(`[status] monitor on, every ${INTERVAL_MS / 1000}s`);
}

module.exports = { startStatusMonitor, checkStatus };
