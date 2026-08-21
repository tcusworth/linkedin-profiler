# Signal — LinkedIn Profile Audit

A LinkedIn profile audit tool: score a profile 0-100 against a stated ideal-client
brief, get section-by-section findings and rewrites, save audit history, save
reusable ICP profiles, and compare before/after audits.

## How it's wired

- `index.html` — the whole app (frontend), calls `/.netlify/functions/audit`
  to run an audit and `/.netlify/functions/data` to read/write history and
  saved ICP profiles.
- `netlify/functions/audit.js` — holds the real Anthropic API key
  server-side, proxies audit requests to `api.anthropic.com`, rate-limits by
  visitor IP (20/hour, via Netlify Blobs), and retries transient
  overload/503 responses from Anthropic with backoff before giving up.
- `netlify/functions/data.js` — stores audit history and saved ICP profiles
  in Netlify Blobs (a key-value store built into Netlify), so they sync
  across devices/browsers instead of living in one browser's `localStorage`.
  This is a single-operator tool, so all data lives in one shared store —
  there's no per-user separation beyond the site's visitor-access password.

## One-time setup after deploying

1. In the Netlify dashboard, go to **Site settings -> Environment variables**.
2. Add a variable: `ANTHROPIC_API_KEY` = your key from
   [console.anthropic.com](https://console.anthropic.com/settings/keys).
3. Redeploy (or trigger a new deploy) so the function picks up the variable
   and so the build step (`npm install`, set in `netlify.toml`) installs
   `@netlify/blobs`.
4. Recommended: turn on **Site settings -> Visitor access -> Password
   protection** so the "Run audit" button (which spends your API credits)
   isn't publicly reachable by anyone who finds the URL.

Without step 2, "Run audit" returns a clear error saying the key is missing
rather than failing silently.

## Local development

```
npm install
npm install -g netlify-cli
netlify dev
```

This serves `index.html` and runs both functions locally, using a `.env`
file (`ANTHROPIC_API_KEY=...`) for the key. Don't commit `.env`. Netlify Blobs
works locally under `netlify dev` too, backed by a local emulator.

## Notes

- Export/Import JSON in the app is still useful as a portable backup even
  with server-side storage — it's a plain file you can keep outside Netlify
  entirely.
- The function currently targets `claude-sonnet-5`. Change the `model` value
  in `netlify/functions/audit.js` if you want a different model.
- Rate limit (20 audits/hour/IP) and retry settings are constants at the top
  of `netlify/functions/audit.js` — adjust `RATE_LIMIT_MAX_PER_HOUR` if 20 is
  too low or too generous for how you use it.
