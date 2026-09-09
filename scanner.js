const { upsertItem, addSnapshot, setMeta, upsertAnnouncementIfNew, replaceShipsInDevelopment } = require("./db");

// Deutsche Umsatzsteuer -- RSI ist ein US-Unternehmen, die angezeigten
// USD-Preise sind Netto-Preise ohne Steuer (in den USA gibt es keine MwSt).
// Für DE-Kunden kommt die 19% MwSt. beim tatsächlichen Checkout dazu.
const GERMAN_VAT_RATE = 0.19;

const USER_AGENT =
  "sc-sales-scanner/1.0 (privater Preis-Tracker; kontakt siehe robertsspaceindustries.com Forum-Profil baris.kilic)";
const REQUEST_DELAY_MS = Number(process.env.SCAN_REQUEST_DELAY_MS || 400);
const PAGE_SIZE = 10; // von RSI fest vorgegeben, nicht konfigurierbar

// Titel-Schlagworte bekannter Events -- ein Comm-Link-Artikel, dessen Titel
// eines davon enthält, ist mit hoher Wahrscheinlichkeit eine echte
// Termin-Ankündigung, kein reiner Status-Post ("This Week in Star Citizen").
const EVENT_KEYWORDS = [
  "Invictus",
  "Alien Week",
  "Foundation Festival",
  "Pirate Week",
  "CitizenCon",
  "Intergalactic Aerospace Expo",
  "IAE",
  "Luminalia",
  "AnniVERSEary",
  "Anniversary",
  "Free Fly",
  "Red Festival",
  "Coramor",
  "Stella Fortuna",
  "Day of Vara",
  "Siege of Orison",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchListingPage(page) {
  const res = await fetch("https://robertsspaceindustries.com/api/store/getShips", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      classification: [],
      itemType: "ships",
      length: [],
      manufacturer_id: [],
      mass: [],
      max_crew: [],
      msrp: [],
      search: "",
      page,
      sort: "id",
      storefront: "pledge",
      type: "",
    }),
  });
  if (!res.ok) throw new Error(`getShips page ${page} failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.success !== 1) throw new Error(`getShips page ${page} unsuccessful response`);
  return data.data; // { html, rowcount, totalrows }
}

function extractListingItems(html) {
  const items = [];
  const liRe = /<li class="ship-item" data-ship-id="(\d+)">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html))) {
    const [, id, block] = m;
    const urlMatch = block.match(/href="(\/pledge\/ships\/[^"]+)"/);
    const nameMatch = block.match(/<span class="name trans-02s">([^<]+)/);
    const imgMatch = block.match(/<img src="([^"]+)" class="ship/);
    const manufacturerMatch = block.match(/manufacturer spec">Manufacturer\s*:\s*<img[^>]*src="([^"]+)"/);
    if (!urlMatch || !nameMatch) continue;
    const manufacturerLogo = manufacturerMatch
      ? manufacturerMatch[1].startsWith("http")
        ? manufacturerMatch[1]
        : "https://robertsspaceindustries.com" + manufacturerMatch[1]
      : null;
    items.push({
      id,
      url: "https://robertsspaceindustries.com" + urlMatch[1],
      name: nameMatch[1].trim(),
      image: imgMatch ? imgMatch[1] : null,
      manufacturer: manufacturerLogo,
    });
  }
  return items;
}

async function fetchAllListingItems() {
  const first = await fetchListingPage(1);
  const total = first.data ? first.data.totalrows : first.totalrows;
  const totalRows = first.totalrows;
  const pages = Math.ceil(totalRows / PAGE_SIZE);
  let items = extractListingItems(first.html);

  for (let page = 2; page <= pages; page++) {
    await sleep(REQUEST_DELAY_MS);
    const data = await fetchListingPage(page);
    items = items.concat(extractListingItems(data.html));
  }
  return items;
}

async function fetchItemDetail(item) {
  const res = await fetch(item.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`detail fetch failed for ${item.id}: HTTP ${res.status}`);
  const html = await res.text();

  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let product = null;
  for (const [, block] of ldBlocks) {
    try {
      const parsed = JSON.parse(block);
      if (parsed["@type"] === "Product") {
        product = parsed;
        break;
      }
    } catch {
      // ignorieren: nicht jedes ld+json-Blob ist gültiges/erwartetes JSON
    }
  }
  if (!product) return { price: null, availability: null, currentPrice: null, referencePrice: null };

  const offer = product.offers;
  let currentPrice = null;
  let referencePrice = null;
  let availability = null;

  if (offer && offer["@type"] === "AggregateOffer") {
    // Ein Schiff kann mehrere Einzelangebote haben (Standalone-Ships +
    // Upgrades, je nochmal mit/ohne "Warbond" -- ein günstigerer, nicht
    // erstattungsfähiger Echtgeld-Preis, der nur während einer aktiven
    // Promotion angeboten wird). Nur "Standalone-Ships"-Angebote zählen als
    // eigentlicher Schiffspreis, nicht der CCU-/Upgrade-Preis. Gibt es davon
    // mehrere Preis-Tiers, ist der höchste der Streichpreis (MSRP) und der
    // niedrigste der tatsächlich zahlbare Preis -- unabhängig davon, wie die
    // billigere Variante benannt ist (Warbond oder sonst eine Aktion).
    const standaloneOffers = (offer.offers || []).filter((o) => o.url && o.url.includes("/Standalone-Ships/"));
    const pool = standaloneOffers.length > 0 ? standaloneOffers : offer.offers || [];
    const withPrices = pool.filter((o) => o.price != null && !Number.isNaN(Number(o.price)));

    if (withPrices.length > 0) {
      const cheapest = withPrices.reduce((a, b) => (Number(a.price) <= Number(b.price) ? a : b));
      const priciest = withPrices.reduce((a, b) => (Number(a.price) >= Number(b.price) ? a : b));
      currentPrice = Number(cheapest.price);
      referencePrice = Number(priciest.price);
      availability = cheapest.availability ? cheapest.availability.replace("https://schema.org/", "") : null;
    }
  } else if (offer) {
    currentPrice = offer.price != null ? Number(offer.price) : null;
    referencePrice = currentPrice;
    availability = offer.availability ? offer.availability.replace("https://schema.org/", "") : null;
  }

  return { price: currentPrice, availability, currentPrice, referencePrice };
}

async function runScan(log = console.log) {
  const startedAt = Date.now();
  log(`[scan] Starte Scan…`);
  const listingItems = await fetchAllListingItems();
  log(`[scan] ${listingItems.length} Store-Items gefunden.`);

  let ok = 0;
  let failed = 0;
  for (const item of listingItems) {
    try {
      await sleep(REQUEST_DELAY_MS);
      const detail = await fetchItemDetail(item);
      upsertItem({ ...item, classification: detail.classification || null });
      addSnapshot(item.id, detail.price, detail.availability, detail.currentPrice, detail.referencePrice);
      ok++;
    } catch (err) {
      failed++;
      log(`[scan] Fehler bei Item ${item.id} (${item.name}): ${err.message}`);
    }
  }

  setMeta("last_scan_at", new Date().toISOString());
  setMeta("last_scan_ok", ok);
  setMeta("last_scan_failed", failed);
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  log(`[scan] Fertig in ${seconds}s. ok=${ok} failed=${failed}`);
}

function extractCommLinkArticles(html) {
  const articles = [];
  const linkRe =
    /href="(\/comm-link\/[a-zA-Z0-9/_-]+)"[^>]*data-original_class="[^"]*"[\s\S]*?background-image:url\('([^']+)'\)[\s\S]*?<div class="title-holder">\s*<div class="title[^"]*">([^<]+)</g;
  let m;
  while ((m = linkRe.exec(html))) {
    const [, path, image, title] = m;
    articles.push({
      id: path.replace(/^\/comm-link\//, ""),
      url: "https://robertsspaceindustries.com" + path,
      image,
      title: title.trim(),
    });
  }
  return articles;
}

function matchEventKeywords(title) {
  return EVENT_KEYWORDS.filter((kw) => title.toLowerCase().includes(kw.toLowerCase()));
}

// Scannt die Comm-Link-Newsliste nach neuen Artikeln. Läuft inkrementell:
// sobald ein bereits bekannter Artikel auftaucht, wird die jeweilige Seite
// nicht weiter zurückverfolgt (Listing ist zeitlich absteigend sortiert).
// `maxPages` begrenzt trotzdem nach oben, falls z.B. beim allerersten Lauf
// noch nichts bekannt ist (Backfill).
async function scanCommLink(log = console.log, maxPages = 5) {
  let newCount = 0;
  for (let page = 1; page <= maxPages; page++) {
    await sleep(REQUEST_DELAY_MS);
    const url = page === 1 ? "https://robertsspaceindustries.com/en/comm-link" : `https://robertsspaceindustries.com/en/comm-link?page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`comm-link page ${page} failed: HTTP ${res.status}`);
    const html = await res.text();
    const articles = extractCommLinkArticles(html);
    if (articles.length === 0) break;

    let sawKnown = false;
    for (const article of articles) {
      const isNew = upsertAnnouncementIfNew({ ...article, matchedKeywords: matchEventKeywords(article.title) });
      if (isNew) newCount++;
      else sawKnown = true;
    }
    if (sawKnown) break; // Rest der Liste war beim letzten Scan schon bekannt
  }
  log(`[comm-link] ${newCount} neue Artikel gefunden.`);
  return newCount;
}

// Ship-Matrix ist ein einzelner ~5MB-JSON-Dump aller Schiffe inkl.
// Produktionsstatus (flight-ready / in-concept). Kein Datum enthalten --
// RSI veröffentlicht keine verbindlichen Release-Termine für Schiffe in
// Entwicklung, nur den groben Status + einen kurzen Freitext-Hinweis.
async function scanShipsInDevelopment(log = console.log) {
  const res = await fetch("https://robertsspaceindustries.com/ship-matrix/index", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`ship-matrix failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.success !== 1) throw new Error("ship-matrix unsuccessful response");

  // Kein flaches Bild-URL-Feld in dieser API (nur eine derived_data.sizes-
  // Struktur ohne direkte URLs) -- daher nur der Link zur Schiffsseite, kein
  // Vorschaubild.
  const inDev = data.data
    .filter((s) => s.production_status && s.production_status !== "flight-ready")
    .map((s) => ({
      id: s.id,
      name: s.name,
      status: s.production_status,
      note: s.production_note || null,
      image: null,
      url: s.url ? "https://robertsspaceindustries.com" + s.url : null,
    }));

  replaceShipsInDevelopment(inDev);
  log(`[ship-matrix] ${inDev.length} Schiffe in Entwicklung.`);
  return inDev.length;
}

// Kostenloser ECB-Referenzkurs (Frankfurter API, kein Key nötig) --
// aktualisiert einmal täglich, reicht für Preisanzeige völlig aus. RSI
// selbst würde beim tatsächlichen Checkout ggf. leicht abweichend runden.
async function scanExchangeRate(log = console.log) {
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Wechselkurs-Abruf fehlgeschlagen: HTTP ${res.status}`);
  const data = await res.json();
  const rate = data.rates && data.rates.EUR;
  if (!rate) throw new Error("Wechselkurs-Antwort ohne EUR-Rate");

  setMeta("usd_eur_rate", rate);
  setMeta("usd_eur_rate_at", new Date().toISOString());
  log(`[fx] 1 USD = ${rate} EUR`);
  return rate;
}

module.exports = { runScan, scanCommLink, scanShipsInDevelopment, scanExchangeRate, GERMAN_VAT_RATE };
