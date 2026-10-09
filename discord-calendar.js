// Hält im Discord-Channel eine einzige, schöne Event-Liste aktuell (Webhook, nur Englisch).
// Statt immer neue Nachrichten zu posten, wird die vorhandene Nachricht bearbeitet, sobald sich
// etwas ändert (neue RSI-Ankündigung, Jahreswechsel). Die Zeitangaben sind Discord-Zeitstempel
// (<t:..:R> = "in 3 months"), die Discord selbst fortlaufend aktuell hält.
const { getRecentAnnouncements, getMeta, setMeta } = require("./db");
const EVENTS = require("./events");

const WEBHOOK = (process.env.DISCORD_CALENDAR_WEBHOOK_URL || "").trim();
const NAME = process.env.DISCORD_POST_NAME || "URMTeK Sales";
const AVATAR = process.env.DISCORD_AVATAR_URL || "https://urmtek.org/discord-app-icon.png";
const SITE = (process.env.MEMBERS_CALENDAR_URL || "https://urmtek.org/members/calendar").trim();

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ts = (d) => Math.floor(d.getTime() / 1000);

/** Nächster üblicher Termin (UTC). Events ohne festen Tag zählen ab dem 1. des Monats, bleiben aber bis zum Monatsende "aktuell". */
function nextOccurrence(e, now) {
  const y = now.getUTCFullYear();
  const today = new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate()));
  const at = (yy) => new Date(Date.UTC(yy, e.month - 1, e.day || 1));
  const end = e.day ? at(y) : new Date(Date.UTC(y, e.month, 0));
  return end >= today ? { at: at(y), running: !e.day && at(y) <= today } : { at: at(y + 1), running: false };
}

function buildEmbeds(now = new Date()) {
  const list = EVENTS.map((e) => ({ e, ...nextOccurrence(e, now) })).sort((a, b) => a.at - b.at);
  const line = ({ e, at, running }) => {
    const date = e.day ? `<t:${ts(at)}:D>` : `Expected in **${MONTHS[e.month - 1]}** (exact days set by RSI)`;
    const when = running ? "this month" : e.day ? `<t:${ts(at)}:R>` : `from <t:${ts(at)}:R>`;
    const kind = e.majorSale ? "🛒 **big sale**" : "🎨 cosmetic";
    return `**${e.name}**\n${date} · ${when} · ${kind}`;
  };
  const soon = list.slice(0, 3).map(line).join("\n\n");
  const later = list.slice(3).map(line).join("\n\n");
  const announced = getRecentAnnouncements(30).filter((a) => a.matchedKeywords && a.matchedKeywords.length);
  const annText = announced.length
    ? announced
        .slice(0, 6)
        .map((a) => `• [${a.title}](${a.url}) · <t:${ts(new Date(a.first_seen_at))}:R>`)
        .join("\n")
    : "Nothing announced right now. We post it here as soon as RSI names a date.";
  return [
    {
      title: "📅 Star Citizen event calendar",
      description: "Store events and sales, nearest first. Dates of recurring events are expectations from past years; RSI sets the exact days shortly before.",
      url: SITE,
      color: 0xc0392b,
    },
    { title: "Next up", description: soon, color: 0xe67e22 },
    { title: "Later this year and beyond", description: later.slice(0, 4000), color: 0x34495e },
    { title: "📣 Announced by RSI", description: annText.slice(0, 4000), color: 0x2d9cdb, footer: { text: `Full calendar: ${SITE.replace(/^https?:\/\//, "")}` } },
  ];
}

async function send(method, url, body) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({}))).retry_after || 2);
    await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 200));
    return send(method, url, body);
  }
  return res;
}

async function updateCalendarPost(log = console.log) {
  if (!WEBHOOK) return { skipped: "no calendar webhook" };
  const embeds = buildEmbeds();
  // Die Zeitstempel ändern sich nicht (Discord rechnet "in 3 months" selbst) -- bearbeitet wird nur bei echten Änderungen.
  const hash = require("crypto").createHash("sha1").update(JSON.stringify(embeds)).digest("hex");
  const id = getMeta("discord_calendar_msg");
  if (id && getMeta("discord_calendar_hash") === hash) return { unchanged: true };
  const payload = { username: NAME, avatar_url: AVATAR, embeds, allowed_mentions: { parse: [] } };
  const base = WEBHOOK.split("?")[0];
  if (id) {
    const res = await send("PATCH", `${base}/messages/${id}`, { embeds });
    if (res.ok) {
      setMeta("discord_calendar_hash", hash);
      log("[discord] Event-Liste aktualisiert");
      return { edited: true };
    }
    if (res.status !== 404) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // Nachricht wurde gelöscht: neu anlegen
  }
  const res = await send("POST", `${base}?wait=true`, payload);
  if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const msg = await res.json();
  setMeta("discord_calendar_msg", msg.id);
  setMeta("discord_calendar_hash", hash);
  log("[discord] Event-Liste gepostet");
  return { posted: true };
}

module.exports = { updateCalendarPost, buildEmbeds };
