# Signal — LinkedIn Profile Audit

A LinkedIn profile audit tool: score a profile 0-100 against a stated ideal-client
brief, get section-by-section findings and rewrites, save audit history, save
reusable ICP profiles, and compare before/after audits.

## How it's wired

- `index.html` — the whole app (frontend), calls `/.netlify/functions/audit`
  to run an audit and uses the browser's `localStorage` to save history and
  saved ICP profiles (per-browser, not synced across devices).
- `netlify/functions/audit.js` — a serverless function that holds the real
  Anthropic API key server-side and proxies audit requests to
  `api.anthropic.com`. The browser never sees the key.

## One-time setup after deploying

1. In the Netlify dashboard, go to **Site settings -> Environment variables**.
2. Add a variable: `ANTHROPIC_API_KEY` = your key from
   [console.anthropic.com](https://console.anthropic.com/settings/keys).
3. Redeploy (or trigger a new deploy) so the function picks up the variable.

Without step 2, the "Run audit" button will return a clear error saying the
key is missing — it won't fail silently.

## Local development

```
npm install -g netlify-cli
netlify dev
```

This serves `index.html` and runs the function locally at
`/.netlify/functions/audit`, using a `.env` file (`ANTHROPIC_API_KEY=...`) for
the key. Don't commit `.env`.

## Notes

- History and saved ICP profiles live in `localStorage`, so they're
  per-browser. Use the "Export JSON" button in the app to back up or move an
  audit to another device.
- The function currently targets `claude-sonnet-5`. Change the `model` value
  in `netlify/functions/audit.js` if you want a different model.
