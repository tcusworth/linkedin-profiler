// Handles all auth actions: login, invite-only user creation, password
// changes, and (admin-only) user management. All user records live in a
// Netlify Blobs store ("users"), keyed by lowercased email.
//
// Bootstrapping the first account: set ADMIN_BOOTSTRAP_EMAIL and
// ADMIN_BOOTSTRAP_PASSWORD in Netlify's environment variables. The first
// successful login matching those exact values, while the users store is
// still empty, creates that account as an admin. After that it behaves like
// any other account (the bootstrap env vars are only consulted while no
// users exist yet).

const { getStore } = require('@netlify/blobs');
const { hashPassword, verifyPasswordHash, createSessionToken, requireAuth } = require('./lib/auth');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function normEmail(e) { return (e || '').trim().toLowerCase(); }
function usersStore() { return getStore('users'); }

const LOGIN_RATE_MAX = 10;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

function getClientIp(event) {
  return (
    event.headers['x-nf-client-connection-ip'] ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

async function checkLoginRateLimit(ip) {
  try {
    const store = getStore('rate-limits');
    const bucket = Math.floor(Date.now() / LOGIN_RATE_WINDOW_MS);
    const key = `login:${ip}:${bucket}`;
    const current = (await store.get(key, { type: 'json' })) || { count: 0 };
    if (current.count >= LOGIN_RATE_MAX) return false;
    current.count += 1;
    await store.setJSON(key, current);
    return true;
  } catch (e) {
    return true; // fail open on the limiter itself, not on login
  }
}

async function listAllUsers(store) {
  const result = await store.list();
  const blobs = (result && result.blobs) || [];
  const users = [];
  for (const b of blobs) {
    const u = await store.get(b.key, { type: 'json' });
    if (u) users.push(u);
  }
  return users;
}

function generateTempPassword() {
  return crypto_randomAlnum(10);
}
function crypto_randomAlnum(len) {
  const raw = require('crypto').randomBytes(len).toString('base64');
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '');
  return (cleaned + 'aB3xY9kP').slice(0, len);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!SESSION_SECRET) {
    return json(500, { error: 'Server is missing SESSION_SECRET. Add it in Netlify: Site settings -> Environment variables (any long random string).' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Invalid JSON body' }); }

  const store = usersStore();

  // ---- login (also handles first-run bootstrap) ----
  if (body.action === 'login') {
    const ip = getClientIp(event);
    if (!(await checkLoginRateLimit(ip))) {
      return json(429, { error: 'Too many login attempts. Try again in a few minutes.' });
    }

    const email = normEmail(body.email);
    const password = body.password || '';
    if (!email || !password) return json(400, { error: 'Email and password required' });

    let user = await store.get(email, { type: 'json' });

    if (!user) {
      const bootstrapEmail = normEmail(process.env.ADMIN_BOOTSTRAP_EMAIL);
      const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
      const existingUsers = await listAllUsers(store);
      const canBootstrap = existingUsers.length === 0 && bootstrapEmail && bootstrapPassword;
      if (canBootstrap && email === bootstrapEmail && password === bootstrapPassword) {
        const { salt, hash } = hashPassword(password);
        user = { email, salt, hash, role: 'admin', createdAt: new Date().toISOString() };
        await store.setJSON(email, user);
      } else {
        return json(401, { error: 'Incorrect email or password' });
      }
    } else {
      if (!verifyPasswordHash(password, user.salt, user.hash)) {
        return json(401, { error: 'Incorrect email or password' });
      }
    }

    const token = createSessionToken(user, SESSION_SECRET);
    return json(200, { token, email: user.email, role: user.role });
  }

  // ---- whoami: validate a stored token on page load ----
  if (body.action === 'whoami') {
    const auth = requireAuth(event, SESSION_SECRET);
    if (!auth.ok) return json(401, { error: 'Not authorized' });
    return json(200, { email: auth.email, role: auth.role });
  }

  // ---- change own password ----
  if (body.action === 'change-password') {
    const auth = requireAuth(event, SESSION_SECRET);
    if (!auth.ok) return json(401, { error: 'Not authorized' });
    const user = await store.get(auth.email, { type: 'json' });
    if (!user) return json(404, { error: 'User not found' });
    if (!verifyPasswordHash(body.currentPassword || '', user.salt, user.hash)) {
      return json(401, { error: 'Current password is incorrect' });
    }
    if (!body.newPassword || body.newPassword.length < 8) {
      return json(400, { error: 'New password must be at least 8 characters' });
    }
    const { salt, hash } = hashPassword(body.newPassword);
    user.salt = salt; user.hash = hash;
    await store.setJSON(auth.email, user);
    return json(200, { ok: true });
  }

  // ---- admin: invite a new user ----
  if (body.action === 'invite') {
    const auth = requireAuth(event, SESSION_SECRET);
    if (!auth.ok || auth.role !== 'admin') return json(403, { error: 'Admin access required' });
    const email = normEmail(body.email);
    if (!email || !email.includes('@')) return json(400, { error: 'A valid email is required' });
    const existing = await store.get(email, { type: 'json' });
    if (existing) return json(400, { error: 'That user already exists' });

    const tempPassword = generateTempPassword();
    const { salt, hash } = hashPassword(tempPassword);
    const newUser = {
      email, salt, hash,
      role: body.role === 'admin' ? 'admin' : 'member',
      createdAt: new Date().toISOString()
    };
    await store.setJSON(email, newUser);
    return json(200, { ok: true, email, tempPassword });
  }

  // ---- admin: list users ----
  if (body.action === 'list-users') {
    const auth = requireAuth(event, SESSION_SECRET);
    if (!auth.ok || auth.role !== 'admin') return json(403, { error: 'Admin access required' });
    const users = await listAllUsers(store);
    return json(200, { users: users.map((u) => ({ email: u.email, role: u.role, createdAt: u.createdAt })) });
  }

  // ---- admin: remove a user ----
  if (body.action === 'remove-user') {
    const auth = requireAuth(event, SESSION_SECRET);
    if (!auth.ok || auth.role !== 'admin') return json(403, { error: 'Admin access required' });
    const email = normEmail(body.email);
    if (email === auth.email) return json(400, { error: "You can't remove your own account" });
    await store.delete(email);
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action' });
};
