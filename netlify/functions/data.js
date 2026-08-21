// Stores audit history and saved ICP profiles server-side using Netlify
// Blobs, so they sync across devices/browsers instead of living in
// localStorage. This is a single-operator tool (no login beyond the site's
// visitor-access password), so all data lives in one shared store.

const { getStore } = require('@netlify/blobs');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function dataStore() {
  return getStore('audit-data');
}

exports.handler = async function (event) {
  const store = dataStore();

  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};

      if (params.action === 'index') {
        const index = (await store.get('index', { type: 'json' })) || [];
        return json(200, { index });
      }

      if (params.action === 'audit' && params.id) {
        const record = await store.get('audit:' + params.id, { type: 'json' });
        if (!record) return json(404, { error: 'Audit not found' });
        return json(200, { record });
      }

      if (params.action === 'icp-profiles') {
        const profiles = (await store.get('icp-profiles', { type: 'json' })) || [];
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
        await store.setJSON('audit:' + record.id, record);

        const index = (await store.get('index', { type: 'json' })) || [];
        const filtered = index.filter((a) => a.id !== record.id);
        filtered.unshift({
          id: record.id,
          clientName: record.clientName,
          createdAt: record.createdAt,
          overallScore: record.overallScore
        });
        await store.setJSON('index', filtered);
        return json(200, { ok: true });
      }

      if (body.action === 'delete-audit') {
        if (!body.id) return json(400, { error: 'Missing id' });
        await store.delete('audit:' + body.id);
        const index = (await store.get('index', { type: 'json' })) || [];
        await store.setJSON('index', index.filter((a) => a.id !== body.id));
        return json(200, { ok: true });
      }

      if (body.action === 'save-icp-profiles') {
        await store.setJSON('icp-profiles', body.profiles || []);
        return json(200, { ok: true });
      }

      return json(400, { error: 'Unknown action' });
    }

    return { statusCode: 405, body: 'Method not allowed' };
  } catch (err) {
    return json(500, { error: err.message || 'Unknown server error' });
  }
};
