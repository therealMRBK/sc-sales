// Postet neue Sales in einen Discord-Channel (Webhook). Läuft nach jedem Preis-Scan.
// Ohne DISCORD_WEBHOOK_URL passiert nichts. Was schon gepostet wurde, steht in der
// Meta-Tabelle ("discord_posted": Schlüssel -> Zeitpunkt), damit nichts doppelt kommt.
const { getItemsWithSaleInfo, getMeta, setMeta } = require("./db");

const RSI = "https://robertsspaceindustries.com";
const WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || "").trim();
const POST_NAME = process.env.DISCORD_POST_NAME || "URMTeK Sales";
const AVATAR = process.env.DISCORD_AVATAR_URL || "https://urmtek.org/discord-app-icon.png";
const MAX_PER_RUN = Number(process.env.DISCORD_MAX_PER_RUN || 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => (n == null ? "?" : `$${Number(n).toFixed(0)}`);
const eur = (usd_, rate) => (usd_ == null || !rate ? null : `${(usd_ * rate * 1.19).toFixed(0)} €`);
// Die Schiffsbilder liegen lokal im Tracker (der Scanner lädt sie von RSI und liefert sie unter /media/ships/ aus)
const PUBLIC = (process.env.PUBLIC_BASE_URL || "https://star.bravokilo.cloud").replace(/\/$/, "");
const imageUrl = (item) => (item.image ? (item.image.startsWith("http") ? item.image : PUBLIC + item.image) : null);

function readPosted() {
  try {
    return JSON.parse(getMeta("discord_posted") || "{}");
  } catch {
    return {};
  }
}

// New in the store: an item first seen after the bot started announcing new items (the baseline keeps the first
// import of a whole category quiet) and not older than a week. Each one is announced once, remembered by id.
const NEW_ITEM_DAYS = 7;
const NEW_ITEM_BULK = 15;
function readAnnouncedNew() {
  try {
    return new Set(JSON.parse(getMeta("discord_new_announced") || "[]"));
  } catch {
    return new Set();
  }
}
function isJustAdded(item, since, announced, now = Date.now()) {
  if (!since || !item.first_seen_at || announced.has(item.id)) return false;
  const seen = new Date(item.first_seen_at).getTime();
  return seen > new Date(since).getTime() && now - seen <= NEW_ITEM_DAYS * 86400000;
}

function keyOf(item) {
  if (item.justAdded && !item.onSale && !item.newlyAvailable) return `v2new:${item.id}`;
  // Preis, Art und ob neu verfügbar: ändert sich eines davon, ist es eine neue Meldung
  return `v2:${item.id}:${item.price}:${item.saleType || "-"}:${item.newlyAvailable ? "new" : "-"}`;
}

function embedOf(item, rate) {
  const lines = [];
  if (item.onSale) {
    const was = item.baselinePrice != null ? ` (was ${usd(item.baselinePrice)})` : "";
    lines.push(`**${usd(item.price)}**${was}${item.discountPct ? ` · **-${item.discountPct}%**` : ""}`);
    const e = eur(item.price, rate);
    if (e) lines.push(`≈ ${e} incl. VAT`);
    if (item.saleType === "listed_discount") lines.push("RSI lists two prices (discounted vs. store credit).");
    if (item.saleType === "price_drop") lines.push("The price dropped below its usual level.");
  }
  if (item.justAdded) {
    lines.unshift("New in the pledge store.");
    if (!item.onSale && item.price != null) lines.push(`**${usd(item.price)}**${eur(item.price, rate) ? ` · ≈ ${eur(item.price, rate)} incl. VAT` : ""}`);
  }
  const extra = String(item.classification || "").startsWith("extra:");
  if (item.newlyAvailable) lines.push(extra ? "Back in stock." : "Can be bought on its own again.");
  const title = `${item.name}${item.discountPct ? ` -${item.discountPct}%` : item.newlyAvailable ? " is available again" : item.justAdded ? " is new in the store" : ""}`;
  const embed = {
    title: title.slice(0, 250),
    url: item.url,
    description: `${lines.join("\n")}\n\n[Open in the RSI pledge store](${item.url})`.slice(0, 3900),
    color: item.onSale ? 0xc0392b : 0x2d9cdb,
    footer: { text: [item.manufacturer_name, item.focus].filter(Boolean).join(" · ") || "Star Citizen pledge store" },
  };
  const img = imageUrl(item);
  if (img) embed.image = { url: img };
  return embed;
}

async function post(item, rate) {
  const res = await fetch(WEBHOOK + (WEBHOOK.includes("?") ? "&" : "?") + "wait=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: POST_NAME,
      avatar_url: AVATAR,
      content: item.url, // der reine Link steht auch im Text
      embeds: [embedOf(item, rate)],
      allowed_mentions: { parse: [] },
    }),
  });
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({}))).retry_after || 2);
    await sleep(Math.ceil(wait * 1000) + 200);
    return post(item, rate);
  }
  if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function postNewSales(rate, log = console.log) {
  if (!WEBHOOK) return { posted: 0, skipped: "kein Webhook gesetzt" };
  // the first run only sets the baseline: what is in the store now is not "new"
  let since = getMeta("discord_new_since");
  if (!since) setMeta("discord_new_since", new Date().toISOString());
  const announced = readAnnouncedNew();
  const items = getItemsWithSaleInfo()
    .map((i) => ({ ...i, justAdded: isJustAdded(i, since, announced) }))
    .filter((i) => (i.onSale || i.newlyAvailable || i.justAdded) && i.url);
  // a whole category arriving at once (a first import after a failed scan) is not news: remember it, post nothing
  const fresh = items.filter((i) => i.justAdded);
  if (fresh.length > NEW_ITEM_BULK) {
    for (const i of fresh) {
      announced.add(i.id);
      i.justAdded = false;
    }
    log(`[discord] ${fresh.length} new items at once: taken as an import, not announced`);
  }
  const candidates = items.filter((i) => i.onSale || i.newlyAvailable || i.justAdded);
  const old = readPosted();
  const next = {};
  const todo = [];
  for (const item of candidates) {
    const k = keyOf(item);
    if (old[k]) next[k] = old[k];
    else todo.push({ item, k });
  }
  let posted = 0;
  for (const { item, k } of todo.slice(0, MAX_PER_RUN)) {
    try {
      await post(item, rate);
      next[k] = new Date().toISOString();
      if (item.justAdded) announced.add(item.id);
      posted++;
      log(`[discord] gepostet: ${item.name}`);
      await sleep(1200);
    } catch (e) {
      console.error("[discord] Fehler:", e.message);
    }
  }
  // Der Rest kommt beim nächsten Lauf. Was nicht mehr im Sale ist, fällt aus der Liste und kann später neu gemeldet werden.
  setMeta("discord_posted", JSON.stringify(next));
  setMeta("discord_new_announced", JSON.stringify([...announced]));
  return { posted, pending: Math.max(0, todo.length - posted) };
}

module.exports = {
  isJustAdded, postNewSales };
