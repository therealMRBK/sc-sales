const crypto = require("crypto");
const { createUser, getUserByEmail, getUserById, createSession, getSession, deleteSession } = require("./db");

const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

// scrypt statt bcrypt -- in Node fest eingebaut (kein zusätzliches natives
// Modul neben better-sqlite3 nötig), kryptographisch als Passwort-Hash
// ebenbürtig geeignet.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  // Timing-sicherer Vergleich statt "===" -- verhindert, dass die Vergleichs-
  // dauer selbst Rückschlüsse auf den korrekten Hash zulässt.
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Der Klartext-Token geht als Cookie an den Client; in der DB liegt nur der
// Hash -- ein DB-Leak allein liefert keine gültigen Sessions.
function issueSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  createSession(userId, hashToken(token), expiresAt);
  return { token, expiresAt };
}

function getUserFromToken(token) {
  if (!token) return null;
  const session = getSession(hashToken(token));
  if (!session) return null;
  return getUserById(session.user_id);
}

function revokeSession(token) {
  if (!token) return;
  deleteSession(hashToken(token));
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// -------------------------------------------------------------------------
// Simples In-Memory-Rate-Limiting für Login/Registrierung -- vorher gab es
// in dieser App gar keine Nutzerkonten und damit keine Angriffsfläche für
// Credential-Stuffing/Brute-Force; jetzt schon, daher dieser einfache
// Schutz (kein Redis o.ä. nötig für diesen Umfang).
// -------------------------------------------------------------------------
const attemptsByIp = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = attemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attemptsByIp.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueSession,
  getUserFromToken,
  revokeSession,
  isValidEmail,
  checkRateLimit,
  createUser,
  getUserByEmail,
};
