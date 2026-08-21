// Stores audit history and saved ICP profiles server-side using Netlify
// Blobs, namespaced per authenticated user (via their email from the
// session token) so each person's history and ICPs are private to them.

const { getStore } = require('@netlify/blobs');
const { requireAuth } = require('./lib/auth');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function dataStore() {
  return getStore('audit-data');
}
function ns(email, key) {
  return `${email}::${key}`;
}

exports.handler = async function (event) {
  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!SESSION_SECRET) {
    return json(500, { error: 'Server is missing SESSION_SECRET. Add it in Netlify: Site settings -> Environment variables.' });
  }
  const auth = requireAuth(event, SESSION_SECRET);
  if (!auth.ok) {
    return json(401, { error: 'Not authorized' });
  }
  const email = auth.email;
  const store = dataStore();

  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};

      if (params.action === 'index') {
        const index = (await store.get(ns(email, 'index'), { type: 'json' })) || [];
        return json(200, { index });
      }

      if (params.action === 'audit' && params.id) {
        const record = await store.get(ns(email, 'audit:' + params.id), { type: 'json' });
        if (!record) return json(404, { error: 'Audit not found' });
        return json(200, { record });
      }

      if (params.action === 'icp-profiles') {
        const profiles = (await store.get(ns(email, 'icp-profiles'), { type: 'json' })) || [];
        return json(200, { profiles });
      }

      return json(400, { error: 'Unknown or missing action' });
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch (e) { return json(400, { error: 'Invalid JSON body' }); }

      if (body.action === 'save-audit') {
        const record = body.record;
        if (!record || !record.id) return json(400, { error: 'Missing record or record.id' });
        await store.setJSON(ns(email, 'audit:' + record.id), record);

        const index = (await store.get(ns(email, 'index'), { type: 'json' })) || [];
        const filtered = index.filter((a) => a.id !== record.id);
        filtered.unshift({
          id: record.id,
          clientName: record.clientName,
          createdAt: record.createdAt,
          overallScore: record.overallScore
        });
        await store.setJSON(ns(email, 'index'), filtered);
        return json(200, { ok: true });
      }

      if (body.action === 'delete-audit') {
        if (!body.id) return json(400, { error: 'Missing id' });
        await store.delete(ns(email, 'audit:' + body.id));
        const index = (await store.get(ns(email, 'index'), { type: 'json' })) || [];
        await store.setJSON(ns(email, 'index'), index.filter((a) => a.id !== body.id));
        return json(200, { ok: true });
      }

      if (body.action === 'save-icp-profiles') {
        await store.setJSON(ns(email, 'icp-profiles'), body.profiles || []);
        return json(200, { ok: true });
      }

      return json(400, { error: 'Unknown action' });
    }

    return { statusCode: 405, body: 'Method not allowed' };
  } catch (err) {
    return json(500, { error: err.message || 'Unknown server error' });
  }
};
