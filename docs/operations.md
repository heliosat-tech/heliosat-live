# HELIOSAT API — Operations runbook

Operational guide for running and selling the public API. For the client-facing
contract see `docs/api-v1.md`.

## One-time setup

1. **Database.** In the Supabase SQL editor, run (in order):
   `supabase/admin-profiles.sql` → `supabase/training-experiments.sql` →
   `supabase/api-keys.sql`. The last creates `api_keys`, `api_key_usage_daily`,
   `forecast_latest`, and `consume_api_key` (RLS on, no policies → service-role only).
2. **Secrets.** Set these as env vars in **Vercel** (and in `.env.local` for local use):
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase → Project Settings → API. Server-side
     only; it bypasses RLS. Never expose to the browser.
   - `CRON_SECRET` — a long random string (e.g. `openssl rand -hex 32`).
3. **Scheduler (cron).** In the GitHub repo → Settings → Secrets and variables → Actions,
   add:
   - `HELIOSAT_BASE_URL` — e.g. `https://heliosat.vercel.app` (no trailing slash).
   - `CRON_SECRET` — the same value as in Vercel.
   The workflow `.github/workflows/publish-forecast.yml` then refreshes the forecast
   every ~5 min (free on this public repo). Run it once manually (Actions → Publish
   realtime forecast → Run workflow) to seed; after that `GET /api/v1/forecast/realtime`
   stops returning `503`.

## Issuing a key (onboarding a client)

1. Mint: `node scripts/mint-api-key.mjs --company "Acme Corp" --name prod --rate 60`
   (optionally `--expires-days 365`). It prints the raw token **once** — it is not
   recoverable (only the SHA-256 hash is stored).
2. Deliver the token to the client over a **secure channel** (password manager share /
   encrypted message), never plain email or chat.
3. Give them `docs/api-v1.md` (endpoint, auth, contract, errors, examples).
4. Verify together: `curl -H "Authorization: Bearer <token>" <host>/api/v1/forecast/realtime`
   returns `200` with a payload.

## Managing keys

- **List + usage:** `node scripts/list-api-keys.mjs --usage 30` — lifetime requests per
  key plus daily counts (for invoicing and spotting abuse / runaway clients).
- **Revoke** (stops auth immediately, keeps history):
  `node scripts/revoke-api-key.mjs --id <uuid>` (or `--prefix hsk_live_ab12`).
- **Delete** (also drops its usage rows): add `--delete`.
- **Rate limit** is per key (`rate_limit_per_min`, default 60); change it in the
  `api_keys` row.

## Billing & abuse

- Source of truth for usage is `api_key_usage_daily` (per key, per UTC day), incremented
  inside `consume_api_key` so it only counts authorized requests. `api_keys.request_count`
  is the lifetime total.
- For invoicing, sum `request_count` per `key_id` over the billing period
  (`list-api-keys.mjs --usage <days>`, or query the table directly).
- Abuse / runaway clients show up as a daily count spike or sustained `429`s; lower their
  `rate_limit_per_min` or revoke.

## Monitoring

- **Uptime:** point a monitor (UptimeRobot, etc.) at `GET /api/v1/status`. It returns
  non-`200` if the API is down **or** the forecast is stale (cron stopped) — one check
  covers both.
- **Cron failures:** GitHub Actions emails the repo owner when the workflow fails (the
  curl uses `-f`, so an API error fails the job).
- **Logs:** Vercel → Project → Logs for the `/api/v1/*` and `/api/cron/*` functions.

## Versioning

See "Versioning policy" in `docs/api-v1.md`. In short: additive-only within `v1`;
breaking changes go to `/api/v2`; deprecations are announced with a migration window.
