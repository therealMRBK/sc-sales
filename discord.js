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

function keyOf(item) {
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
  if (item.newlyAvailable) lines.push("Can be bought on its own again.");
  const title = `${item.name}${item.discountPct ? ` -${item.discountPct}%` : item.newlyAvailable ? " is available again" : ""}`;
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
  const items = getItemsWithSaleInfo().filter((i) => (i.onSale || i.newlyAvailable) && i.url);
  const old = readPosted();
  const next = {};
  const todo = [];
  for (const item of items) {
    const k = keyOf(item);
    if (old[k]) next[k] = old[k];
    else todo.push({ item, k });
  }
  let posted = 0;
  for (const { item, k } of todo.slice(0, MAX_PER_RUN)) {
    try {
      await post(item, rate);
      next[k] = new Date().toISOString();
      posted++;
      log(`[discord] gepostet: ${item.name}`);
      await sleep(1200);
    } catch (e) {
      console.error("[discord] Fehler:", e.message);
    }
  }
  // Der Rest kommt beim nächsten Lauf. Was nicht mehr im Sale ist, fällt aus der Liste und kann später neu gemeldet werden.
  setMeta("discord_posted", JSON.stringify(next));
  return { posted, pending: Math.max(0, todo.length - posted) };
}

module.exports = { postNewSales };
