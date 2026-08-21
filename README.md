# Signal — LinkedIn Profile Audit

A LinkedIn profile audit tool: score a profile 0-100 against a stated ideal-client
brief, get section-by-section findings and rewrites, save private audit
history per person, save reusable ICP profiles, and compare before/after
audits. Invite-only accounts, hashed passwords, private data per user.

## How it's wired

- `index.html` — the whole app (frontend). Calls `/.netlify/functions/auth`
  for login/account actions, `/.netlify/functions/audit` to run an audit, and
  `/.netlify/functions/data` to read/write each user's own history and saved
  ICP profiles.
- `netlify/functions/lib/auth.js` — shared helpers: password hashing
  (`crypto.scrypt`, a random salt per user, no plaintext ever stored) and
  signed session tokens (HMAC-SHA256, no external dependency).
- `netlify/functions/auth.js` — login, first-run admin bootstrap, invite-only
  user creation, password changes, and (admin-only) listing/removing users.
  All user records live in a Netlify Blobs store called `users`.
- `netlify/functions/audit.js` — holds the real Anthropic API key
  server-side, proxies audit requests to `api.anthropic.com`, rate-limits per
  user (20/hour, via Netlify Blobs), retries transient overload/503 responses
  from Anthropic with backoff, and requires a valid session token on every
  request.
- `netlify/functions/data.js` — stores each user's audit history and saved
  ICP profiles in Netlify Blobs, namespaced by their email, so one person
  never sees another's data. Also requires a valid session token.

## How accounts work

- **Invite-only.** There's no public signup form. New accounts are created by
  an admin from inside the app (sidebar → Team → Invite), which generates a
  temporary password to hand to that person out-of-band (Slack, in person,
  etc.) — the app doesn't send email itself.
- **Bootstrapping the first (admin) account.** Since invite-only needs an
  admin to invite anyone, the very first account is created differently: set
  `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` in Netlify's
  environment variables, then log in with those exact values once. That
  creates the account as an admin. After that first login, those two env
  vars are no longer consulted (the real stored password takes over) — you
  can leave them set or remove them, it only matters while zero accounts
  exist.
- **Roles.** `admin` can invite/remove users and see the team list. `member`
  can use the tool but not manage other accounts.
- **Sessions.** A signed token (like a hand-rolled JWT) valid for 7 days,
  stored in the browser's `localStorage`. There's no server-side revocation
  list, so removing a user takes away their ability to log in again, but
  doesn't invalidate a token they already have until it expires — for a
  small internal tool that's a reasonable tradeoff, but worth knowing if
  someone leaves under bad terms.

## One-time setup after deploying

1. In the Netlify dashboard, go to **Site settings -> Environment variables**
   and add:
   - `ANTHROPIC_API_KEY` — your key from
     [console.anthropic.com](https://console.anthropic.com/settings/keys)
   - `SESSION_SECRET` — any long random string (used to sign session
     tokens — treat it like a password; changing it later logs everyone out)
   - `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` — the email and
     password for your first (admin) account
   - `BLOBS_SITE_ID` and `BLOBS_TOKEN` — see below. Only needed if you hit
     a `MissingBlobsEnvironmentError` in the function logs; some deploys
     don't get Netlify's automatic Blobs context injected, so this passes
     it explicitly instead.
2. Redeploy (or trigger a new deploy) so the functions pick up the variables
   and so the build step (`npm install`, set in `netlify.toml`) installs
   `@netlify/blobs`.
3. Visit the site, log in with the bootstrap email/password — this creates
   your real admin account.
4. From the sidebar's Team section, invite anyone else who needs access.
   Share their temporary password with them directly; have them change it
   after their first login (Account → Change password).

Without `ANTHROPIC_API_KEY`, "Run audit" returns a clear error. Without
`SESSION_SECRET`, every auth-related request returns a clear 500 rather than
silently failing open.

### Getting BLOBS_SITE_ID and BLOBS_TOKEN

Only needed if the function logs show `MissingBlobsEnvironmentError`
(Site → Logs & metrics → Functions → click a function → real-time log).

- `BLOBS_SITE_ID`: **Site settings → General → Site details → Site ID**
  (a UUID, copy it as-is)
- `BLOBS_TOKEN`: a Netlify **personal access token**. Click your avatar
  (top right) → **User settings → Applications → Personal access tokens →
  New access token**. Give it a name, copy the token immediately (it's only
  shown once).

Add both as env vars, then **Deploys → Trigger deploy → Deploy site**.

## Local development

```
npm install
npm install -g netlify-cli
netlify dev
```

Serves `index.html` and all three functions locally, using a `.env` file
(`ANTHROPIC_API_KEY=...`, `SESSION_SECRET=...`, `ADMIN_BOOTSTRAP_EMAIL=...`,
`ADMIN_BOOTSTRAP_PASSWORD=...`). Don't commit `.env`. Netlify Blobs works
locally under `netlify dev` too, backed by a local emulator.

## Notes

- Export/Import JSON in the app is still useful as a portable backup — it's
  a plain file per audit you can keep outside Netlify entirely.
- The function currently targets `claude-sonnet-5`. Change the `model` value
  in `netlify/functions/audit.js` if you want a different model.
- Rate limit (20 audits/hour/user) and retry settings are constants at the
  top of `netlify/functions/audit.js`.
- Login attempts are separately rate-limited (10 per 15 minutes per IP) in
  `netlify/functions/auth.js`, to slow down password-guessing.
