// Shared auth helpers used by auth.js, audit.js, and data.js.
//
// Passwords: hashed with Node's built-in crypto.scrypt (a random salt per
// user, stored alongside the hash). Plaintext passwords are never stored.
//
// Sessions: a stateless signed token (similar in spirit to a JWT, but
// hand-rolled with no dependency): base64url(payload) + "." + HMAC-SHA256
// signature, signed with SESSION_SECRET. Verifying a token is pure
// cryptography (no database lookup), so every function can check it cheaply.
// There's no server-side revocation list, so "logging out" just discards the
// token client-side - a stolen token remains valid until it expires (7 days).

const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashPassword(password, existingSalt) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPasswordHash(password, salt, hash) {
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function base64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
}

function createSessionToken(user, secret) {
  const payload = { email: user.email, role: user.role, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS };
  const payloadB64 = base64url(JSON.stringify(payload));
  return payloadB64 + '.' + sign(payloadB64, secret);
}

function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const idx = token.indexOf('.');
  const payloadB64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expectedSig = sign(payloadB64, secret);
  const a = Buffer.from(sig || '', 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(base64urlDecode(payloadB64)); } catch (e) { return null; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload; // { email, role, iat, exp }
}

function getBearerToken(event) {
  const header = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function requireAuth(event, secret) {
  const token = getBearerToken(event);
  const payload = verifySessionToken(token, secret);
  if (!payload) return { ok: false };
  return { ok: true, email: payload.email, role: payload.role };
}

module.exports = {
  hashPassword,
  verifyPasswordHash,
  createSessionToken,
  verifySessionToken,
  requireAuth,
  getBearerToken
};
