// Countdown für die Intergalactic Aerospace Expo im Event-Channel (Webhook, nur Englisch).
// Eine einzige Nachricht, die fortlaufend bearbeitet wird: vor dem Start "Starts in ...", während der Expo "Ends in ...",
// danach ein letztes "has ended" und Schluss. Alle Zeitpunkte sind feste UTC-Instants (Unix-Zeit); Discord zeigt
// <t:..:F> und <t:..:R> in der Zeitzone jedes Betrachters, die Zeitzonen-Tabelle rechnet mit Intl inklusive Sommerzeit.
const crypto = require("crypto");

const WEBHOOK = (process.env.DISCORD_CALENDAR_WEBHOOK_URL || "").trim();
const NAME = process.env.DISCORD_POST_NAME || "URMTeK Sales";
const AVATAR = process.env.DISCORD_AVATAR_URL || "https://urmtek.org/discord-app-icon.png";
const SITE = (process.env.MEMBERS_CALENDAR_URL || "https://urmtek.org/members/calendar").trim();

// IAE 2956 laut RSI: Start 13. Nov 2026 16:00 UTC, Ende 27. Nov 2026 20:00 UTC (Free Fly im selben Fenster).
// Falls RSI die Zeiten ändert: IAE_START_UTC / IAE_END_UTC im Stack setzen (ISO, z. B. 2026-11-13T16:00:00Z).
const START = new Date(process.env.IAE_START_UTC || "2026-11-13T16:00:00Z");
const END = new Date(process.env.IAE_END_UTC || "2026-11-27T20:00:00Z");
const TITLE = process.env.IAE_TITLE || "Intergalactic Aerospace Expo 2956";
// [Bezeichnung, IANA-Zone, Locale für das Kürzel (PST statt GMT-8)]
const ZONES = [
  ["UTC", "UTC", "en-GB"],
  ["US Pacific", "America/Los_Angeles", "en-US"],
  ["US Eastern", "America/New_York", "en-US"],
  ["UK", "Europe/London", "en-GB"],
  ["Central Europe", "Europe/Berlin", "en-GB"],
  ["Japan", "Asia/Tokyo", "ja-JP"],
  ["Australia East", "Australia/Sydney", "en-AU"],
];

const ts = (d) => Math.floor(d.getTime() / 1000);

/** "5d 03h 12m" / "03h 12m" / "12m": Tage, Stunden und Minuten bis `ms` (aufgerundet auf volle Minuten, nie negativ). */
function span(ms) {
  const total = Math.max(0, Math.ceil(ms / 60000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return d ? `${d}d ${hh}h ${mm}m` : h ? `${hh}h ${mm}m` : `${m}m`;
}

/** Ein Zeitpunkt in einer festen Zeitzone, z. B. "Fri 13 Nov, 08:00 PST". */
function inZone(date, zone, abbrLocale = "en-GB") {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const abbr = new Intl.DateTimeFormat(abbrLocale, { timeZone: zone, timeZoneName: "short" }).formatToParts(date).find((x) => x.type === "timeZoneName").value;
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ${abbr}`;
}

/** Phase und Zustand der Nachricht für den Zeitpunkt `now`. */
function phaseAt(now, start = START, end = END) {
  if (now < start) return "before";
  if (now < end) return "live";
  return "ended";
}

function buildEmbed(now = new Date(), start = START, end = END) {
  const phase = phaseAt(now, start, end);
  const zoneRows = (date) => ZONES.map(([label, zone, loc]) => `${label}: **${inZone(date, zone, loc)}**`).join("\n");
  const fields = [
    { name: "Starts", value: `<t:${ts(start)}:F>\n(<t:${ts(start)}:R>)`, inline: true },
    { name: "Ends", value: `<t:${ts(end)}:F>\n(<t:${ts(end)}:R>)`, inline: true },
    { name: "Start in other time zones", value: zoneRows(start) },
    { name: "End in other time zones", value: zoneRows(end) },
  ];
  const base = { url: SITE, footer: { text: "Times as announced by RSI. The two dates above show in your own time zone." }, fields };
  if (phase === "before") {
    return { ...base, title: `⏳ ${TITLE}`, color: 0xe67e22, description: `**Starts in ${span(start - now)}**\nThe expo opens on <t:${ts(start)}:F> and runs for ${Math.round((end - start) / 86400000)} days.` };
  }
  if (phase === "live") {
    return { ...base, title: `🚀 ${TITLE} is live`, color: 0x2ecc71, description: `**Ends in ${span(end - now)}**\nThe expo closes on <t:${ts(end)}:F>.` };
  }
  return { ...base, title: `🏁 ${TITLE} has ended`, color: 0x7f8c8d, description: `The expo closed on <t:${ts(end)}:F>. See you at the next one!` };
}

/** Wie lange bis die Anzeige sich ändern muss: je näher der Termin, desto genauer (Minuten) -- sonst genügt alle 10 Minuten. */
function nextDelayMs(now, start = START, end = END) {
  const phase = phaseAt(now, start, end);
  if (phase === "ended") return null;
  const left = (phase === "before" ? start : end) - now;
  return left <= 2 * 86400000 ? 60000 : 600000;
}

async function send(method, url, body) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({}))).retry_after || 2);
    await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 200));
    return send(method, url, body);
  }
  return res;
}

/** Bringt die Nachricht auf den Stand von `now`; true, solange noch weiter getickt werden muss. */
async function updateTimer({ now = new Date(), webhook = WEBHOOK, getMeta, setMeta, log = console.log } = {}) {
  if (!webhook) return { skipped: "no calendar webhook" };
  const embeds = [buildEmbed(now)];
  const hash = crypto.createHash("sha1").update(JSON.stringify(embeds)).digest("hex");
  const id = getMeta("iae_timer_msg");
  if (id && getMeta("iae_timer_hash") === hash) return { unchanged: true };
  const base = webhook.split("?")[0];
  if (id) {
    const res = await send("PATCH", `${base}/messages/${id}`, { embeds, allowed_mentions: { parse: [] } });
    if (res.ok) {
      setMeta("iae_timer_hash", hash);
      return { edited: true };
    }
    if (res.status !== 404) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // von Hand gelöscht: neu anlegen
  }
  const res = await send("POST", `${base}?wait=true`, { username: NAME, avatar_url: AVATAR, embeds, allowed_mentions: { parse: [] } });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  setMeta("iae_timer_msg", (await res.json()).id);
  setMeta("iae_timer_hash", hash);
  log("[iae-timer] countdown posted");
  return { posted: true };
}

/** Selbst-nachplanende Schleife; nach dem Ende (und dem letzten Bearbeiten) hört sie von selbst auf. */
function startIaeTimer(log = console.log) {
  if (!WEBHOOK) return log("[iae-timer] no DISCORD_CALENDAR_WEBHOOK_URL, timer off");
  if (Number.isNaN(START.getTime()) || Number.isNaN(END.getTime()) || END <= START) return log("[iae-timer] invalid IAE_START_UTC / IAE_END_UTC, timer off");
  const { getMeta, setMeta } = require("./db");
  if (getMeta("iae_timer_done") === `${ts(START)}-${ts(END)}`) return log("[iae-timer] already finished");
  const tick = async () => {
    const now = new Date();
    try {
      await updateTimer({ now, getMeta, setMeta, log });
    } catch (err) {
      log(`[iae-timer] failed: ${err.message}`);
      return setTimeout(tick, 60000);
    }
    const delay = nextDelayMs(new Date());
    if (delay === null) {
      setMeta("iae_timer_done", `${ts(START)}-${ts(END)}`);
      return log("[iae-timer] expo over, timer stopped");
    }
    setTimeout(tick, delay);
  };
  setTimeout(tick, 4000);
  log("[iae-timer] on");
}

module.exports = { startIaeTimer, updateTimer, buildEmbed, nextDelayMs, phaseAt, span, inZone };
