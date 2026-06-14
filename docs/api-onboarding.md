# Onboarding a company onto the HELIOSAT Public API

You do **not** distribute the API as a file — it is a hosted HTTP service. Onboarding a
client is three things: deploy, issue a key, hand over the docs.

## What a client receives

1. **Base URL** of your deployment (e.g. `https://heliosat-live.vercel.app`).
2. **An API key** (`hsk_live_…`), issued per company, shown once.
3. **Docs**: the live reference at `<base>/api/v1/docs`, the machine-readable
   `<base>/api/v1/openapi.json` (import into Postman/Insomnia or generate a client), and
   [docs/api-v1.md](api-v1.md) / the PDF manual.

## 1. Prerequisites (one-time)

- The app is deployed and reachable over HTTPS.
- Supabase is configured with the `api_keys` table and the `consume_api_key` SQL function.
- These env vars are available to the key scripts (from the environment or `.env.local`):
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` (service role — the `api_keys` table is locked down)

## 2. Issue a key per company

```bash
node scripts/mint-api-key.mjs --company "Acme Corp" --name prod --rate 60 --expires-days 365
```

- `--rate` is the per-minute request budget (rate limiting is enforced server-side).
- The raw token is printed **once** and never recoverable — only its SHA-256 hash is stored.

Manage keys:

```bash
node scripts/list-api-keys.mjs            # list issued keys (prefix, company, rate, active)
node scripts/revoke-api-key.mjs --company "Acme Corp"   # deactivate
```

## 3. Hand over + test

The client authenticates with a bearer token and calls the endpoints:

```bash
curl -H "Authorization: Bearer hsk_live_xxx" https://<base>/api/v1/forecast/realtime
```

Endpoints (all `GET`, all require the key except `/status`):

| Endpoint | Purpose |
| --- | --- |
| `/api/v1/forecast/realtime` | The core real-time physical-driver forecast. |
| `/api/v1/hazard/latest` · `/hazard/window?minutes=N` | Operational hazard assessment. |
| `/api/v1/events/latest` · `/events/window?minutes=N` | Discrete hazard events. |
| `/api/v1/status` | Unauthenticated health (200 fresh / 503 stale) — for their uptime monitor. |

Rate-limit feedback is in the response headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`,
and `Retry-After` on `429`).

## How clients consume it

- **Server-to-server (recommended).** The client's backend stores the key and calls the API.
  The key never reaches a browser. This is how it works today — nothing else required.
- **From a browser.** Direct browser calls from another origin would need **CORS** headers on
  `/api/v1/*`, which are **not** enabled (and would expose the key client-side). If a client
  needs this, add CORS deliberately and consider a per-origin key — ask first.

## Versioning

The v1 contract is **additive-only** (fields are never renamed/removed within v1). Breaking
changes ship under `/api/v2/...`. See the `Versioning` section of [docs/api-v1.md](api-v1.md).
