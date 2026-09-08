const path = require("path");
const express = require("express");
const { getItemsWithSaleInfo, getMeta, getRecentAnnouncements, getShipsInDevelopment } = require("./db");
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

app.listen(PORT, () => {
  console.log(`sc-sales läuft auf Port ${PORT}`);
  scheduleScans();
});

function scheduleScans() {
  const kickoffDelayMs = 5000; // kurz warten, bis der Server durchgestartet ist

  setTimeout(() => {
    runScan().catch((err) => console.error("[scan] fehlgeschlagen:", err));
    // Nacheinander, nicht parallel -- teilt sich denselben REQUEST_DELAY_MS-
    // Rhythmus und vermeidet, RSI gleichzeitig aus zwei Richtungen anzufragen.
    scanCommLink().catch((err) => console.error("[comm-link] fehlgeschlagen:", err));
    scanShipsInDevelopment().catch((err) => console.error("[ship-matrix] fehlgeschlagen:", err));
  }, kickoffDelayMs);

  setInterval(() => {
    runScan().catch((err) => console.error("[scan] fehlgeschlagen:", err));
  }, SCAN_INTERVAL_MINUTES * 60 * 1000);

  setInterval(() => {
    scanCommLink().catch((err) => console.error("[comm-link] fehlgeschlagen:", err));
  }, SCAN_INTERVAL_MINUTES * 60 * 1000);

  // Ship-Matrix ist ein ~5MB-Dump und ändert sich selten -- seltener pollen
  // als den Preis-Scan.
  setInterval(() => {
    scanShipsInDevelopment().catch((err) => console.error("[ship-matrix] fehlgeschlagen:", err));
  }, SHIP_MATRIX_INTERVAL_HOURS * 60 * 60 * 1000);
}
