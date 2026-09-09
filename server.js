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
  addHangarItem,
  updateHangarItem,
  deleteHangarItem,
  getHangarItems,
} = require("./db");
const { runScan, scanCommLink, scanShipsInDevelopment, scanExchangeRate, GERMAN_VAT_RATE } = require("./scanner");
const { hashPassword, verifyPassword, issueSession, getUserFromToken, revokeSession, isValidEmail, checkRateLimit, createUser, getUserByEmail } = require("./auth");
const RECURRING_EVENTS = require("./events");

const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 60);
const SHIP_MATRIX_INTERVAL_HOURS = Number(process.env.SHIP_MATRIX_INTERVAL_HOURS || 24);
const FX_INTERVAL_HOURS = Number(process.env.FX_INTERVAL_HOURS || 24);

const app = express();
// Hinter Reverse-Proxies (NPM) noetig, damit req.ip/req.secure den echten
// Client statt den Proxy widerspiegeln -- relevant fuers Login-Rate-Limiting
// und die Secure-Cookie-Entscheidung.
app.set("trust proxy", true);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// Lokal gecachtes Schiffs-Artwork + Hersteller-Logos -- Besucher laden das
// von uns, nicht von RSIs CDN (siehe scanner.js: downloadImageIfMissing).
app.use("/media", express.static(MEDIA_DIR, { maxAge: "30d", immutable: true }));

// -------------------------------------------------------------------------
// Auth: manuelles, schlankes Cookie-Session-Handling -- kein zusaetzliches
// cookie-parser/express-session-Paket, nur Node-Bordmittel.
// -------------------------------------------------------------------------
function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function setSessionCookie(req, res, token, expiresAt) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

app.use((req, res, next) => {
  req.user = getUserFromToken(parseCookies(req).sid);
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "not authenticated" });
  next();
}

app.get("/healthz", (req, res) => res.send("ok"));

app.post("/api/auth/register", (req, res) => {
  if (!checkRateLimit(req.ip)) return res.status(429).json({ error: "too many attempts, please wait" });
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: "invalid email" });
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  if (getUserByEmail(email)) return res.status(409).json({ error: "email already registered" });

  const userId = createUser(email, hashPassword(password));
  const { token, expiresAt } = issueSession(userId);
  setSessionCookie(req, res, token, expiresAt);
  res.json({ user: { id: userId, email } });
});

app.post("/api/auth/login", (req, res) => {
  if (!checkRateLimit(req.ip)) return res.status(429).json({ error: "too many attempts, please wait" });
  const { email, password } = req.body || {};
  const user = getUserByEmail(email || "");
  if (!user || !verifyPassword(password || "", user.password_hash)) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const { token, expiresAt } = issueSession(user.id);
  setSessionCookie(req, res, token, expiresAt);
  res.json({ user: { id: user.id, email: user.email } });
});

app.post("/api/auth/logout", (req, res) => {
  revokeSession(parseCookies(req).sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, email: req.user.email } : null });
});

// -------------------------------------------------------------------------
// Hangar
// -------------------------------------------------------------------------
app.get("/api/hangar", requireAuth, (req, res) => {
  res.json({ items: getHangarItems(req.user.id) });
});

// Kaufpreis kann in USD (netto, direkt vergleichbar mit Store Credit) oder
// EUR (brutto, inkl. 19% dt. MwSt., wie tatsächlich bezahlt) eingegeben
// werden. Store Credit ist bei RSI grundsätzlich immer netto -- ein
// EUR-Kaufpreis muss deshalb für den Wertvergleich in sein netto-USD-
// Äquivalent zurückgerechnet werden (Näherung mit dem AKTUELLEN Wechselkurs,
// nicht dem zum Kaufzeitpunkt, da wir den nicht kennen).
function toNetUsd(amount, currency) {
  if (amount == null) return null;
  if (currency === "EUR") {
    const fx = getExchangeRate();
    if (!fx) return null;
    return amount / fx.usdToEur / (1 + GERMAN_VAT_RATE);
  }
  return amount;
}

app.post("/api/hangar", requireAuth, (req, res) => {
  const { itemId, customName, purchasePrice, purchasePriceCurrency, manualCurrentValueUsd, insuranceType, insuranceMonths, acquiredAt } =
    req.body || {};
  if (!itemId && !customName) return res.status(400).json({ error: "itemId or customName required" });
  const currency = purchasePriceCurrency === "EUR" ? "EUR" : "USD";
  const purchasePriceUsd = toNetUsd(purchasePrice, currency);
  const id = addHangarItem(req.user.id, {
    itemId,
    customName,
    purchasePriceUsd,
    purchasePriceOriginal: purchasePrice ?? null,
    purchasePriceCurrency: purchasePrice != null ? currency : null,
    manualCurrentValueUsd,
    insuranceType,
    insuranceMonths,
    acquiredAt,
  });
  res.json({ id });
});

app.put("/api/hangar/:id", requireAuth, (req, res) => {
  const body = { ...req.body };
  if (body.purchasePrice !== undefined) {
    const currency = body.purchasePriceCurrency === "EUR" ? "EUR" : "USD";
    body.purchasePriceUsd = toNetUsd(body.purchasePrice, currency);
    body.purchasePriceOriginal = body.purchasePrice;
    body.purchasePriceCurrency = body.purchasePrice != null ? currency : null;
  }
  const ok = updateHangarItem(req.user.id, Number(req.params.id), body);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.delete("/api/hangar/:id", requireAuth, (req, res) => {
  const ok = deleteHangarItem(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// -------------------------------------------------------------------------
// Upgrade-Kosten-Rechner -- bewusst NUR der direkte Store-Credit-
// Preisunterschied zwischen zwei Schiffen, keine Mehrfach-Hop-Optimierung.
// Echte CCU-Chain-Arbitrage (wie sie Community-Tools wie das "CCU Game"
// anbieten) braucht personalisierte, eingeloggte RSI-Upgrade-Preise und
// individuell gekaufte historische CCUs -- Daten, die ein anonymer Scanner
// grundsaetzlich nicht sehen kann.
// -------------------------------------------------------------------------
app.get("/api/upgrade-cost", (req, res) => {
  const items = getItemsWithSaleInfo();
  const from = items.find((i) => i.id === req.query.from);
  const to = items.find((i) => i.id === req.query.to);
  if (!from || !to) return res.status(404).json({ error: "unknown item(s)" });

  const fromPrice = from.storeCreditPriceUsd;
  const toPrice = to.storeCreditPriceUsd;
  const possible = fromPrice != null && toPrice != null && toPrice >= fromPrice;

  res.json({
    from: { id: from.id, name: from.name, priceUsd: fromPrice },
    to: { id: to.id, name: to.name, priceUsd: toPrice },
    upgradeCostUsd: possible ? Math.round((toPrice - fromPrice) * 100) / 100 : null,
    possible,
  });
});

// Automatische Vorschläge: für jedes Hangar-Schiff mit bekanntem Kaufpreis,
// welches JETZT ein Upgrade auf ein teureres, getracktes Schiff lohnender
// macht, als dieses Zielschiff direkt neu zu kaufen. "Lohnend" heißt hier
// konkret: (tatsächlicher Kaufpreis des eigenen Schiffs + heutiger CCU-
// Preisunterschied) < aktuellem Direktkaufpreis des Zielschiffs -- z.B. weil
// das eigene Schiff seinerzeit günstig/im Sale gekauft wurde. Bewusst
// dieselbe Einschränkung wie /api/upgrade-cost: nur der direkte
// Store-Credit-Preisunterschied, keine Mehrfach-Hop-Kette.
app.get("/api/hangar/upgrade-suggestions", requireAuth, (req, res) => {
  const hangarItems = getHangarItems(req.user.id).filter((h) => h.item_id && h.purchase_price_usd != null);
  const items = getItemsWithSaleInfo();
  const byId = new Map(items.map((i) => [i.id, i]));

  const suggestions = [];
  for (const h of hangarItems) {
    const source = byId.get(h.item_id);
    if (!source || source.storeCreditPriceUsd == null) continue;

    for (const target of items) {
      if (target.id === source.id) continue;
      if (target.storeCreditPriceUsd == null || target.price == null) continue;
      if (target.storeCreditPriceUsd <= source.storeCreditPriceUsd) continue; // kein Upgrade, nur nach oben moeglich

      const ccuCostNow = target.storeCreditPriceUsd - source.storeCreditPriceUsd;
      const totalIfUpgradeNow = h.purchase_price_usd + ccuCostNow;
      const savingsUsd = target.price - totalIfUpgradeNow;
      if (savingsUsd > 1) {
        suggestions.push({
          hangarItemId: h.id,
          sourceName: h.itemName,
          targetId: target.id,
          targetName: target.name,
          targetImage: target.image,
          purchasePriceUsd: h.purchase_price_usd,
          ccuCostNowUsd: Math.round(ccuCostNow * 100) / 100,
          totalIfUpgradeNowUsd: Math.round(totalIfUpgradeNow * 100) / 100,
          directBuyPriceUsd: target.price,
          savingsUsd: Math.round(savingsUsd * 100) / 100,
        });
      }
    }
  }

  suggestions.sort((a, b) => b.savingsUsd - a.savingsUsd);
  res.json({ suggestions: suggestions.slice(0, 10) });
});

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
