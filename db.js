const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "sc-sales.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    manufacturer TEXT,
    image TEXT,
    classification TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES items(id),
    price REAL,
    availability TEXT,
    current_price REAL,
    reference_price REAL,
    checked_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_item_time ON snapshots(item_id, checked_at);

  CREATE TABLE IF NOT EXISTS scan_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    image TEXT,
    matched_keywords TEXT,
    first_seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ships_in_development (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT,
    note TEXT,
    image TEXT,
    url TEXT,
    updated_at TEXT NOT NULL
  );
`);

function upsertItem(item) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM items WHERE id = ?").get(item.id);
  if (existing) {
    db.prepare(
      `UPDATE items SET name=?, url=?, manufacturer=?, image=?, classification=?, last_seen_at=? WHERE id=?`
    ).run(item.name, item.url, item.manufacturer, item.image, item.classification, now, item.id);
  } else {
    db.prepare(
      `INSERT INTO items (id, name, url, manufacturer, image, classification, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(item.id, item.name, item.url, item.manufacturer, item.image, item.classification, now, now);
  }
}

// Schreibt nur eine neue Zeile, wenn sich gegenüber dem letzten Snapshot
// etwas geändert hat (Preis, Verfügbarkeit oder Preis-Tiers). Bei stündlichem
// Scan wäre sonst nach kurzer Zeit fast die gesamte Tabelle reine
// "nichts geändert"-Zeilen -- so bleibt die Preis-Historie automatisch ein
// echtes Änderungs-Log ("upgraded", wenn sich der Preis ändert) statt eines
// dichten Zeitreihen-Dumps, und ist direkt als Chart-Datenpunkte nutzbar.
function addSnapshot(itemId, price, availability, currentPrice = null, referencePrice = null) {
  const last = db
    .prepare(
      `SELECT price, availability, current_price, reference_price FROM snapshots
       WHERE item_id = ? ORDER BY checked_at DESC LIMIT 1`
    )
    .get(itemId);

  const changed =
    !last ||
    last.price !== price ||
    last.availability !== availability ||
    last.current_price !== currentPrice ||
    last.reference_price !== referencePrice;

  if (changed) {
    db.prepare(
      `INSERT INTO snapshots (item_id, price, availability, current_price, reference_price, checked_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(itemId, price, availability, currentPrice, referencePrice, new Date().toISOString());
  }
  return changed;
}

function setMeta(key, value) {
  db.prepare(
    `INSERT INTO scan_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function getMeta(key) {
  const row = db.prepare("SELECT value FROM scan_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

// Referenzpreis je Item: häufigster ("mode") Preis der letzten 30 Tage, den
// aktuellsten Snapshot ausgenommen -- ein einzelner Ausschlag zählt so nicht
// sofort als "normal", sondern erst nachdem er sich als der übliche Preis
// etabliert hat. Fällt auf den aktuellen Preis zurück, wenn noch keine
// Historie existiert (erster Scan eines Items -> kein Sale erkennbar).
function getItemsWithSaleInfo() {
  const items = db.prepare("SELECT * FROM items ORDER BY name").all();
  const latestStmt = db.prepare(
    `SELECT price, availability, current_price, reference_price, checked_at FROM snapshots
     WHERE item_id = ? ORDER BY checked_at DESC LIMIT 1`
  );
  const historyStmt = db.prepare(
    `SELECT price, availability, checked_at FROM snapshots
     WHERE item_id = ? AND checked_at >= datetime('now', '-30 days')
     ORDER BY checked_at ASC`
  );

  return items.map((item) => {
    const latest = latestStmt.get(item.id);
    if (!latest) return { ...item, price: null, availability: null, onSale: false, discountPct: null, newlyAvailable: false, saleType: null };

    // Primäres Signal: RSI selbst liefert für dieses Item mehrere Preis-Tiers
    // unter den "Standalone-Ships"-Angeboten (z.B. ein günstigerer, nicht
    // erstattungsfähiger "Warbond"-Preis neben dem normalen Preis, oder jede
    // andere Rabatt-Variante). Der höchste Tier ist der Streichpreis (MSRP),
    // der niedrigste der tatsächlich zahlbare Preis -- unabhängig vom Namen
    // der SKU. Braucht keine eigene Preis-Historie.
    const hasTierDiscount =
      latest.current_price != null && latest.reference_price != null && latest.current_price < latest.reference_price;

    // Ab jetzt speichert addSnapshot nur noch Änderungs-Ereignisse, keine
    // dichte Zeitreihe mehr -- eine Zeile kann also tagelang gültig gewesen
    // sein. "Häufigster Preis" muss deshalb über die tatsächliche Dauer
    // jedes Preises gewichtet werden, nicht über die Zeilenanzahl.
    const history = historyStmt.all(item.id); // aufsteigend sortiert
    const priorHistory = history.slice(0, -1); // ohne das aktuell laufende Segment

    let onSale = false;
    let discountPct = null;
    let baselinePrice = latest.price;
    let saleType = null;

    if (hasTierDiscount) {
      onSale = true;
      baselinePrice = latest.reference_price;
      discountPct = Math.round((1 - latest.current_price / latest.reference_price) * 100);
      saleType = "listed_discount";
    } else {
      // Fallback: dauer-gewichteter häufigster Preis der letzten 30 Tage,
      // das aktuell laufende Segment ausgenommen. Fängt Fälle ab, wo RSI
      // selbst keinen zweiten Preis-Tier zeigt, der Preis aber trotzdem
      // gegenüber der eigenen Beobachtung gefallen ist.
      if (priorHistory.length > 0) {
        const durationByPrice = new Map();
        for (let i = 0; i < priorHistory.length; i++) {
          const row = priorHistory[i];
          if (row.price == null) continue;
          const start = new Date(row.checked_at).getTime();
          const end = new Date(history[i + 1].checked_at).getTime();
          durationByPrice.set(row.price, (durationByPrice.get(row.price) || 0) + Math.max(0, end - start));
        }
        let best = null;
        for (const [price, duration] of durationByPrice) {
          if (!best || duration > best.duration) best = { price, duration };
        }
        if (best) baselinePrice = best.price;
      }
      onSale = latest.price != null && baselinePrice != null && latest.price < baselinePrice;
      discountPct = onSale ? Math.round((1 - latest.price / baselinePrice) * 100) : null;
      saleType = onSale ? "price_drop" : null;
    }

    // "neu verfügbar": aktuell InStock, war aber in den letzten 14 Tagen
    // (das aktuell laufende Segment ausgenommen) durchgehend OutOfStock.
    const recentPrior = priorHistory.filter((h) => h.availability != null);
    const wasUnavailable = recentPrior.length > 0 && recentPrior.every((h) => h.availability === "OutOfStock");
    const newlyAvailable = latest.availability === "InStock" && wasUnavailable;

    return {
      ...item,
      price: hasTierDiscount ? latest.current_price : latest.price,
      availability: latest.availability,
      baselinePrice,
      onSale,
      discountPct,
      newlyAvailable,
      saleType,
    };
  });
}

// Gibt zurück, ob der Artikel neu war (für Logging/Zählung beim Scan).
function upsertAnnouncementIfNew(announcement) {
  const existing = db.prepare("SELECT id FROM announcements WHERE id = ?").get(announcement.id);
  if (existing) return false;
  db.prepare(
    `INSERT INTO announcements (id, title, url, image, matched_keywords, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    announcement.id,
    announcement.title,
    announcement.url,
    announcement.image,
    JSON.stringify(announcement.matchedKeywords || []),
    new Date().toISOString()
  );
  return true;
}

function getRecentAnnouncements(limit = 30) {
  const rows = db.prepare("SELECT * FROM announcements ORDER BY first_seen_at DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ ...r, matchedKeywords: JSON.parse(r.matched_keywords || "[]") }));
}

function replaceShipsInDevelopment(ships) {
  const now = new Date().toISOString();
  const tx = db.transaction((list) => {
    db.prepare("DELETE FROM ships_in_development").run();
    const insert = db.prepare(
      `INSERT INTO ships_in_development (id, name, status, note, image, url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of list) insert.run(String(s.id), s.name, s.status, s.note, s.image, s.url, now);
  });
  tx(ships);
}

function getShipsInDevelopment() {
  return db.prepare("SELECT * FROM ships_in_development ORDER BY name").all();
}

// Vollständige Änderungs-Historie eines Items -- dank Dedupe in addSnapshot
// ist jede Zeile bereits ein echtes Preis-/Verfügbarkeits-Änderungsereignis,
// keine weitere Verdichtung nötig. Berechnet zusätzlich ein paar Kennzahlen
// fürs Detail-Panel im Frontend.
function getItemHistory(itemId) {
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(itemId);
  if (!item) return null;

  const rows = db
    .prepare(
      `SELECT price, availability, current_price, reference_price, checked_at FROM snapshots
       WHERE item_id = ? ORDER BY checked_at ASC`
    )
    .all(itemId);

  const events = rows.map((r) => {
    const hasTier = r.current_price != null && r.reference_price != null && r.current_price < r.reference_price;
    return {
      price: hasTier ? r.current_price : r.price,
      referencePrice: hasTier ? r.reference_price : null,
      availability: r.availability,
      at: r.checked_at,
    };
  });

  const prices = events.map((e) => e.price).filter((p) => p != null);
  const stats =
    prices.length > 0
      ? {
          allTimeLow: Math.min(...prices),
          allTimeHigh: Math.max(...prices),
          currentPrice: events[events.length - 1].price,
          trackedSince: events[0].at,
          priceChangeCount: Math.max(0, events.length - 1),
          currentSince: events[events.length - 1].at,
        }
      : null;

  return { item, events, stats };
}

// Aggregierte Kennzahlen über den gesamten getrackten Katalog, fürs
// Statistik-Panel im Frontend.
function getStats() {
  const items = getItemsWithSaleInfo().filter((i) => i.price != null);
  const totalChanges = db.prepare("SELECT COUNT(*) AS c FROM snapshots").get().c;
  const totalAnnouncements = db.prepare("SELECT COUNT(*) AS c FROM announcements").get().c;

  if (items.length === 0) {
    return {
      totalItems: 0,
      onSaleCount: 0,
      totalPriceChangesTracked: totalChanges,
      totalAnnouncementsTracked: totalAnnouncements,
    };
  }

  const onSaleItems = items.filter((i) => i.onSale);
  const cheapest = items.reduce((a, b) => (a.price <= b.price ? a : b));
  const priciest = items.reduce((a, b) => (a.price >= b.price ? a : b));
  const biggestDiscount = onSaleItems.reduce(
    (a, b) => (!a || (b.discountPct || 0) > (a.discountPct || 0) ? b : a),
    null
  );
  const totalCatalogValue = items.reduce((sum, i) => sum + i.price, 0);
  const avgPrice = totalCatalogValue / items.length;

  return {
    totalItems: items.length,
    onSaleCount: onSaleItems.length,
    totalPriceChangesTracked: totalChanges,
    totalAnnouncementsTracked: totalAnnouncements,
    totalCatalogValue,
    avgPrice,
    cheapest: { name: cheapest.name, price: cheapest.price },
    priciest: { name: priciest.name, price: priciest.price },
    biggestDiscount: biggestDiscount
      ? { name: biggestDiscount.name, discountPct: biggestDiscount.discountPct, price: biggestDiscount.price }
      : null,
  };
}

module.exports = {
  db,
  upsertItem,
  addSnapshot,
  setMeta,
  getMeta,
  getItemsWithSaleInfo,
  upsertAnnouncementIfNew,
  getRecentAnnouncements,
  replaceShipsInDevelopment,
  getShipsInDevelopment,
  getItemHistory,
  getStats,
};
