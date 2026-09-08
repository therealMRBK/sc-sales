const path = require("path");
const express = require("express");
const { getItemsWithSaleInfo, getMeta, setMeta, getRecentAnnouncements, getShipsInDevelopment, getItemHistory, getStats } = require("./db");
const { runScan, scanCommLink, scanShipsInDevelopment } = require("./scanner");
const RECURRING_EVENTS = require("./events");

const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 60);
const SHIP_MATRIX_INTERVAL_HOURS = Number(process.env.SHIP_MATRIX_INTERVAL_HOURS || 24);

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.send("ok"));

// Leichter Endpoint zum Pollen -- Frontend fragt das häufiger ab als /api/items
// und lädt die volle Liste nur neu, wenn sich lastScanAt geändert hat.
app.get("/api/status", (req, res) => {
  res.json({
    lastScanAt: getMeta("last_scan_at"),
    lastScanOk: Number(getMeta("last_scan_ok") || 0),
    lastScanFailed: Number(getMeta("last_scan_failed") || 0),
    scanIntervalMinutes: SCAN_INTERVAL_MINUTES,
  });
});

app.get("/api/items", (req, res) => {
  const items = getItemsWithSaleInfo();
  items.sort((a, b) => {
    if (a.onSale !== b.onSale) return a.onSale ? -1 : 1;
    if (a.newlyAvailable !== b.newlyAvailable) return a.newlyAvailable ? -1 : 1;
    return (a.name || "").localeCompare(b.name || "");
  });
  res.json({ items });
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
  res.json(result);
});

app.get("/api/stats", (req, res) => {
  res.json(getStats());
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
}

function scheduleScans() {
  const kickoffDelayMs = 5000; // kurz warten, bis der Server durchgestartet ist
  const intervalMs = SCAN_INTERVAL_MINUTES * 60 * 1000;

  function tick() {
    runCycle().finally(() => setTimeout(tick, intervalMs));
  }
  setTimeout(tick, kickoffDelayMs);
}
