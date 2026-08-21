// Proxies LinkedIn-audit requests to the Anthropic API, STREAMING the
// response back to the browser.
//
// Why streaming: a full audit can take 40+ seconds for the model to
// generate. Netlify's synchronous functions are capped at 10s, so a normal
// "await the whole response, then return it" function gets killed with a 504
// long before the model finishes. A streaming function starts sending bytes
// immediately (the first token arrives in ~1-2s) and keeps the connection
// alive as the rest flows, which sidesteps the 10s synchronous ceiling.
//
// The key stays server-side (ANTHROPIC_API_KEY). Auth + per-user rate limit
// still run first (they're fast); only the model response is streamed.

const { stream } = require('@netlify/functions');
const { getNamedStore } = require('./lib/blobs');
const { requireAuth } = require('./lib/auth');

const RATE_LIMIT_MAX_PER_HOUR = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

async function checkAndIncrementRateLimit(userEmail) {
  try {
    const store = getNamedStore('rate-limits');
    const bucket = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
    const key = `${userEmail}:${bucket}`;
    const current = (await store.get(key, { type: 'json' })) || { count: 0 };
    if (current.count >= RATE_LIMIT_MAX_PER_HOUR) {
      return { allowed: false, count: current.count };
    }
    current.count += 1;
    await store.setJSON(key, current);
    return { allowed: true, count: current.count };
  } catch (e) {
    console.error('Rate limit check failed:', e.message);
    return { allowed: true, count: 0 };
  }
}

// Small helper to return an ordinary (non-streamed) JSON error via the
// streaming interface, so the browser always gets valid JSON on failure.
function errorResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}

exports.handler = stream(async function (event) {
  if (event.httpMethod !== 'POST') {
    return errorResponse(405, { error: 'Method not allowed' });
  }

  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!SESSION_SECRET) {
    return errorResponse(500, { error: 'Server is missing SESSION_SECRET. Add it in Netlify: Site settings -> Environment variables.' });
  }
  const auth = requireAuth(event, SESSION_SECRET);
  if (!auth.ok) {
    return errorResponse(401, { error: 'Not authorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse(500, { error: 'Server is missing ANTHROPIC_API_KEY. Add it in Netlify: Site settings -> Environment variables.' });
  }

  const rate = await checkAndIncrementRateLimit(auth.email);
  if (!rate.allowed) {
    return errorResponse(429, { error: `Rate limit reached (${RATE_LIMIT_MAX_PER_HOUR} audits/hour). Try again later.` });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return errorResponse(400, { error: 'Invalid JSON body' });
  }
  if (!payload.system || !payload.messages) {
    return errorResponse(400, { error: 'Missing system or messages' });
  }

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        stream: true,
        // Explicitly disable extended thinking: this endpoint needs clean JSON
        // output, and thinking blocks stream as thinking_delta events (not
        // text_delta), which would otherwise come back as empty text.
        thinking: { type: 'disabled' },
        system: payload.system,
        messages: payload.messages
      })
    });
  } catch (err) {
    return errorResponse(502, { error: 'Could not reach Anthropic API: ' + (err.message || 'unknown error') });
  }

  // If Anthropic rejected the request (bad key, overload, etc.), it responds
  // with a normal JSON error (not a stream). Pass that through as-is so the
  // browser can show a clear message instead of a broken stream.
  if (!anthropicRes.ok) {
    let detail = '';
    try { const eb = await anthropicRes.json(); detail = (eb && eb.error && eb.error.message) ? ' — ' + eb.error.message : ''; } catch (e) {}
    return errorResponse(anthropicRes.status, { error: `Anthropic API returned ${anthropicRes.status}${detail}` });
  }

  // Stream the Server-Sent-Events body straight through to the browser.
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    },
    body: anthropicRes.body
  };
});
