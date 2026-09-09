const path = require("path");
const express = require("express");
const {
  getItemsWithSaleInfo,
  getMeta,
  setMeta,
  getRecentAnnouncements,
  getShipsInDevelopment,
  getItemHistory,
  getStats,
  getExchangeRate,
  MEDIA_DIR,
} = require("./db");
const { runScan, scanCommLink, scanShipsInDevelopment, scanExchangeRate, GERMAN_VAT_RATE } = require("./scanner");
const RECURRING_EVENTS = require("./events");

const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 60);
const SHIP_MATRIX_INTERVAL_HOURS = Number(process.env.SHIP_MATRIX_INTERVAL_HOURS || 24);
const FX_INTERVAL_HOURS = Number(process.env.FX_INTERVAL_HOURS || 24);

const app = express();
app.use(express.static(path.join(__dirname, "public")));
// Lokal gecachtes Schiffs-Artwork + Hersteller-Logos -- Besucher laden das
// von uns, nicht von RSIs CDN (siehe scanner.js: downloadImageIfMissing).
app.use("/media", express.static(MEDIA_DIR, { maxAge: "30d", immutable: true }));

app.get("/healthz", (req, res) => res.send("ok"));

// Rechnet einen USD-Betrag in einen deutschen Brutto-EUR-Betrag um (aktueller
// EZB-Referenzkurs * 1 + 19% MwSt.). RSI selbst zeigt keine EUR-Preise ohne
// eingeloggten Account -- das hier ist eine transparent gekennzeichnete
// Schätzung, keine von RSI übernommene Zahl. `null`, solange noch kein
// Wechselkurs abgerufen wurde (kurz nach dem allerersten Start).
function toEurInclVat(usd, rate) {
  if (usd == null || rate == null) return null;
  return Math.round(usd * rate * (1 + GERMAN_VAT_RATE) * 100) / 100;
}

function withGermanPricing(obj, rate, fields) {
  const out = { ...obj };
  for (const [srcField, destField] of fields) {
    out[destField] = toEurInclVat(obj[srcField], rate);
  }
  return out;
}

// Leichter Endpoint zum Pollen -- Frontend fragt das häufiger ab als /api/items
// und lädt die volle Liste nur neu, wenn sich lastScanAt geändert hat.
app.get("/api/status", (req, res) => {
  const fx = getExchangeRate();
  res.json({
    lastScanAt: getMeta("last_scan_at"),
    lastScanOk: Number(getMeta("last_scan_ok") || 0),
    lastScanFailed: Number(getMeta("last_scan_failed") || 0),
    scanIntervalMinutes: SCAN_INTERVAL_MINUTES,
    // Roh-Kurse (USD-Basis) fürs Frontend -- Preis-/Währungsumschalten
    // (USD/EUR/GBP) rechnet clientseitig direkt aus den USD-Rohwerten der
    // Items, damit ein Wechsel sofort greift statt einen neuen /api/items-
    // Request zu brauchen.
    fxRates: fx ? { eur: fx.usdToEur, gbp: fx.usdToGbp } : null,
    fxRateUpdatedAt: fx ? fx.updatedAt : null,
    // Rückwärtskompatibel für ältere Frontend-Versionen / andere Konsumenten:
    fxRate: fx ? fx.usdToEur : null,
    germanVatRate: GERMAN_VAT_RATE,
  });
});

app.get("/api/items", (req, res) => {
  const fx = getExchangeRate();
  const rate = fx ? fx.usdToEur : null;
  const items = getItemsWithSaleInfo().map((item) =>
    withGermanPricing(item, rate, [
      ["price", "priceEurInclVat"],
      ["baselinePrice", "baselinePriceEurInclVat"],
      ["warbondPriceUsd", "warbondPriceEurInclVat"],
      ["storeCreditPriceUsd", "storeCreditPriceEurInclVat"],
    ])
  );
  items.sort((a, b) => {
    if (a.onSale !== b.onSale) return a.onSale ? -1 : 1;
    if (a.newlyAvailable !== b.newlyAvailable) return a.newlyAvailable ? -1 : 1;
    return (a.name || "").localeCompare(b.name || "");
  });
  res.json({ items, fxRate: rate });
});

app.get("/api/calendar", (req, res) => {
  res.json({
    recurringEvents: RECURRING_EVENTS,
    announcements: getRecentAnnouncements(30),
    shipsInDevelopment: getShipsInDevelopment(),
  });
});

app.get("/api/items/:id/history", (req, res) => {
  const result = getItemHistory(req.params.id);
  if (!result) return res.status(404).json({ error: "unknown item" });

  const fx = getExchangeRate();
  const rate = fx ? fx.usdToEur : null;
  const events = result.events.map((e) => ({ ...e, priceEurInclVat: toEurInclVat(e.price, rate) }));
  const stats = result.stats
    ? {
        ...result.stats,
        allTimeLowEurInclVat: toEurInclVat(result.stats.allTimeLow, rate),
        allTimeHighEurInclVat: toEurInclVat(result.stats.allTimeHigh, rate),
        currentPriceEurInclVat: toEurInclVat(result.stats.currentPrice, rate),
      }
    : null;

  res.json({ ...result, events, stats, fxRate: rate });
});

app.get("/api/stats", (req, res) => {
  const fx = getExchangeRate();
  const rate = fx ? fx.usdToEur : null;
  const stats = getStats();
  const out = withGermanPricing(stats, rate, [
    ["totalCatalogValue", "totalCatalogValueEurInclVat"],
    ["avgPrice", "avgPriceEurInclVat"],
  ]);
  if (out.cheapest) out.cheapest = withGermanPricing(out.cheapest, rate, [["price", "priceEurInclVat"]]);
  if (out.priciest) out.priciest = withGermanPricing(out.priciest, rate, [["price", "priceEurInclVat"]]);
  if (out.biggestDiscount) out.biggestDiscount = withGermanPricing(out.biggestDiscount, rate, [["price", "priceEurInclVat"]]);
  out.fxRate = rate;
  res.json(out);
});

app.listen(PORT, () => {
  console.log(`sc-sales läuft auf Port ${PORT}`);
  scheduleScans();
});

// Ein einziger, selbst-nachplanender Zyklus statt mehrerer setInterval --
// garantiert, dass Preis-Scan, Comm-Link- und Ship-Matrix-Scan echt
// nacheinander laufen und niemals überlappen (ein vorheriger Bug feuerte
// alle drei gleichzeitig los, was RSI kurzzeitig mit parallelen Requests
// überlastete und zu vereinzelten Timeouts/Fehlern führte). setTimeout nach
// Abschluss statt setInterval verhindert außerdem ein Aufstauen, falls ein
// Zyklus mal länger als das Intervall dauert.
async function runCycle() {
  await runScan().catch((err) => console.error("[scan] fehlgeschlagen:", err));
  await scanCommLink().catch((err) => console.error("[comm-link] fehlgeschlagen:", err));

  const lastShipMatrixRun = getMeta("last_ship_matrix_run_at");
  const dueForShipMatrix =
    !lastShipMatrixRun || Date.now() - new Date(lastShipMatrixRun).getTime() >= SHIP_MATRIX_INTERVAL_HOURS * 60 * 60 * 1000;
  if (dueForShipMatrix) {
    await scanShipsInDevelopment().catch((err) => console.error("[ship-matrix] fehlgeschlagen:", err));
    setMeta("last_ship_matrix_run_at", new Date().toISOString());
  }

  const lastFxRun = getMeta("usd_eur_rate_at");
  const dueForFx = !lastFxRun || Date.now() - new Date(lastFxRun).getTime() >= FX_INTERVAL_HOURS * 60 * 60 * 1000;
  if (dueForFx) {
    await scanExchangeRate().catch((err) => console.error("[fx] fehlgeschlagen:", err));
  }
}

function scheduleScans() {
  const kickoffDelayMs = 5000; // kurz warten, bis der Server durchgestartet ist
  const intervalMs = SCAN_INTERVAL_MINUTES * 60 * 1000;

  function tick() {
    runCycle().finally(() => setTimeout(tick, intervalMs));
  }
  setTimeout(tick, kickoffDelayMs);
}
