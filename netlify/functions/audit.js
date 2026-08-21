// Proxies LinkedIn-audit requests to the Anthropic API.
// Keeps the real API key server-side (set as ANTHROPIC_API_KEY in Netlify's
// Site settings -> Environment variables) instead of exposing it in the browser.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Server is missing ANTHROPIC_API_KEY. Add it in Netlify: Site settings -> Environment variables.'
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!payload.system || !payload.messages) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing system or messages' }) };
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        // Update this if you want to point at a different model.
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: payload.system,
        messages: payload.messages
      })
    });

    const data = await anthropicRes.json();
    return {
      statusCode: anthropicRes.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not reach Anthropic API: ' + (err.message || 'unknown error') })
    };
  }
};
