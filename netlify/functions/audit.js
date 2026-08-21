// Proxies LinkedIn-audit requests to the Anthropic API.
// Keeps the real API key server-side (set as ANTHROPIC_API_KEY in Netlify's
// Site settings -> Environment variables) instead of exposing it in the browser.
//
// Also rate-limits by IP (using Netlify Blobs as a shared counter across
// function invocations) and retries once/twice on transient Anthropic
// overload responses before giving up.

const { getStore } = require('@netlify/blobs');
const { requireAuth } = require('./lib/auth');

const RATE_LIMIT_MAX_PER_HOUR = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function checkAndIncrementRateLimit(userEmail) {
  try {
    const store = getStore('rate-limits');
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
    // If the rate-limit store itself fails, fail open rather than blocking
    // legitimate use, but the request still logs to Netlify's function logs.
    console.error('Rate limit check failed:', e.message);
    return { allowed: true, count: 0 };
  }
}

async function callAnthropic(apiKey, system, messages) {
  let lastResponse = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 4096,
          system,
          messages
        })
      });
    } catch (networkErr) {
      // network-level failure (DNS, connection reset, etc.) - retry
      if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_DELAY_MS * Math.pow(3, attempt)); continue; }
      throw networkErr;
    }

    // Retry on transient overload/rate-limit responses from Anthropic itself.
    const transient = response.status === 429 || response.status === 503 || response.status === 529;
    if (transient && attempt < MAX_RETRIES) {
      lastResponse = response;
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(3, attempt));
      continue;
    }
    return response;
  }
  return lastResponse;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!SESSION_SECRET) {
    return json(500, { error: 'Server is missing SESSION_SECRET. Add it in Netlify: Site settings -> Environment variables.' });
  }
  const auth = requireAuth(event, SESSION_SECRET);
  if (!auth.ok) {
    return json(401, { error: 'Not authorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Server is missing ANTHROPIC_API_KEY. Add it in Netlify: Site settings -> Environment variables.' });
  }

  const rate = await checkAndIncrementRateLimit(auth.email);
  if (!rate.allowed) {
    return json(429, { error: `Rate limit reached (${RATE_LIMIT_MAX_PER_HOUR} audits/hour). Try again later.` });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid JSON body' });
  }
  if (!payload.system || !payload.messages) {
    return json(400, { error: 'Missing system or messages' });
  }

  try {
    const anthropicRes = await callAnthropic(apiKey, payload.system, payload.messages);
    if (!anthropicRes) {
      return json(502, { error: 'Anthropic API is currently overloaded and retries were exhausted. Try again in a minute.' });
    }
    const data = await anthropicRes.json();
    return json(anthropicRes.status, data);
  } catch (err) {
    return json(502, { error: 'Could not reach Anthropic API: ' + (err.message || 'unknown error') });
  }
};
