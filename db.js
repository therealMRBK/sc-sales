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
    checked_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_item_time ON snapshots(item_id, checked_at);

  CREATE TABLE IF NOT EXISTS scan_meta (
    key TEXT PRIMARY KEY,
    value TEXT
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

function addSnapshot(itemId, price, availability) {
  db.prepare(
    `INSERT INTO snapshots (item_id, price, availability, checked_at) VALUES (?, ?, ?, ?)`
  ).run(itemId, price, availability, new Date().toISOString());
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
    `SELECT price, availability, checked_at FROM snapshots
     WHERE item_id = ? ORDER BY checked_at DESC LIMIT 1`
  );
  const historyStmt = db.prepare(
    `SELECT price, availability FROM snapshots
     WHERE item_id = ? AND checked_at >= datetime('now', '-30 days')
     ORDER BY checked_at DESC`
  );

  return items.map((item) => {
    const latest = latestStmt.get(item.id);
    if (!latest) return { ...item, price: null, availability: null, onSale: false, discountPct: null, newlyAvailable: false };

    const history = historyStmt.all(item.id);
    const priorHistory = history.slice(1); // ohne den aktuellsten Snapshot

    let baselinePrice = latest.price;
    if (priorHistory.length > 0) {
      const counts = new Map();
      for (const h of priorHistory) {
        if (h.price == null) continue;
        counts.set(h.price, (counts.get(h.price) || 0) + 1);
      }
      let best = null;
      for (const [price, count] of counts) {
        if (!best || count > best.count) best = { price, count };
      }
      if (best) baselinePrice = best.price;
    }

    const onSale = latest.price != null && baselinePrice != null && latest.price < baselinePrice;
    const discountPct = onSale ? Math.round((1 - latest.price / baselinePrice) * 100) : null;

    // "neu verfügbar": aktuell InStock, war aber in den letzten 14 Tagen
    // (den aktuellsten Snapshot ausgenommen) durchgehend OutOfStock.
    const recentPrior = priorHistory.filter((h) => h.availability != null);
    const wasUnavailable = recentPrior.length > 0 && recentPrior.every((h) => h.availability === "OutOfStock");
    const newlyAvailable = latest.availability === "InStock" && wasUnavailable;

    return {
      ...item,
      price: latest.price,
      availability: latest.availability,
      baselinePrice,
      onSale,
      discountPct,
      newlyAvailable,
    };
  });
}

module.exports = { db, upsertItem, addSnapshot, setMeta, getMeta, getItemsWithSaleInfo };
