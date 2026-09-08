const path = require("path");
const express = require("express");
const { getItemsWithSaleInfo, getMeta } = require("./db");
const { runScan } = require("./scanner");

const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 180);

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

app.listen(PORT, () => {
  console.log(`sc-sales läuft auf Port ${PORT}`);
  scheduleScans();
});

function scheduleScans() {
  const kickoffDelayMs = 5000; // kurz warten, bis der Server durchgestartet ist
  setTimeout(() => {
    runScan().catch((err) => console.error("[scan] fehlgeschlagen:", err));
  }, kickoffDelayMs);

  setInterval(() => {
    runScan().catch((err) => console.error("[scan] fehlgeschlagen:", err));
  }, SCAN_INTERVAL_MINUTES * 60 * 1000);
}
