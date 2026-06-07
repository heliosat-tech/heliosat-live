# HELIOSAT Public API — v1

The public API exposes **one** product: the **Real-Time Forecast**. Everything else
(playground, training, pipelines) is internal. The API is authenticated by **API key**
(not the admin cookie), versioned, and served **precomputed** — it reads the latest
forecast row, it never computes in-request.

> Status: contract **v1 (draft)**. Once a client integrates, v1 fields are additive
> only; breaking changes ship as `/api/v2/...`.

## Authentication

Send your key as a bearer token:

```
Authorization: Bearer <api_key>
```

Keys are issued per client (see "Issuing keys"). The raw key is shown once at
creation; the server only stores its SHA-256 hash.

## Endpoint

```
GET /api/v1/forecast/realtime
```

```bash
curl -H "Authorization: Bearer hsk_live_xxxxx" https://<host>/api/v1/forecast/realtime
```

### Response `200`

```jsonc
{
  "schema_version": "1",
  "issued_at": "2026-06-07T12:00:30Z",   // when this forecast was published
  "observed_at": "2026-06-07T11:58:00Z", // latest L1 measurement used
  "l1_distance_km": 1492000,
  "observed": {
    "speed_km_s": 452.1,
    "bz_nt": -4.8,
    "density_p_cm3": 3.1,
    "g_level": 1                          // NOAA G-scale now (0–5)
  },
  "arrival": {
    "estimated_utc": "2026-06-07T12:43:00Z", // Earth-arrival of latest parcel
    "transit_lag_minutes": 45
  },
  "inbound_peak": {                        // worst parcel still inbound, or null
    "g_level": 2,
    "speed_km_s": 610,
    "min_bz_nt": -12,
    "eta_utc": "2026-06-07T13:10:00Z",
    "lead_minutes": 40
  }
}
```

Units: speed km/s, magnetic field nT, density particles/cm³, times ISO-8601 UTC.
`observed`, `arrival`, and `inbound_peak` may each be `null` when there is no data.

### Errors

| Status | Meaning                                   |
| ------ | ----------------------------------------- |
| `401`  | Missing/invalid/inactive/expired API key  |
| `429`  | Rate limit exceeded (see `Retry-After`)   |
| `503`  | No forecast published yet / not configured |

Rate-limit headers on success and on `429`: `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, and (on `429`) `Retry-After` (seconds). Default limit is
**per key, per minute** (configurable per key).

### Examples

```python
import requests
r = requests.get("https://<host>/api/v1/forecast/realtime",
                 headers={"Authorization": "Bearer hsk_live_xxxxx"}, timeout=10)
r.raise_for_status()
data = r.json()
```

```js
const r = await fetch("https://<host>/api/v1/forecast/realtime", {
  headers: { Authorization: "Bearer hsk_live_xxxxx" },
});
if (!r.ok) throw new Error(`API ${r.status}`);
const data = await r.json();
```

## Status / health

```
GET /api/v1/status
```

Unauthenticated. Reports whether a **fresh** forecast exists. Returns `200` when the
last publish is under 15 min old, `503` (`"status":"stale"` or `"no_data"`) otherwise —
so a plain HTTP uptime monitor catches both an API outage and a stopped cron.

```jsonc
{ "status": "ok", "schema_version": "1", "issued_at": "2026-06-07T12:00:30Z", "forecast_age_seconds": 92, "stale": false }
```

## Versioning policy

- The version lives in the **path** (`/api/v1/...`) and is echoed in `schema_version`.
- Within a major version, changes are **additive only**: new fields may appear; existing
  fields are never renamed, removed, or retyped, and `null`ability is not tightened.
  Clients **must ignore unknown fields**.
- A breaking change ships as a new major version under a new path (`/api/v2/...`). The
  previous version stays available during an announced deprecation window.
- Deprecations are communicated ahead of time (changelog + direct notice to active keys).

### Changelog

- **v1** (draft) — initial Real-Time Forecast contract.

## Operations (internal)

See `docs/operations.md` for the full runbook. Quick reference:

- **DB setup:** run `supabase/api-keys.sql` in the Supabase SQL editor (after
  `admin-profiles.sql`). Creates `api_keys`, `api_key_usage_daily`, `forecast_latest`,
  and `consume_api_key`, all locked down (RLS on, no policies → service-role only).
- **Env:** set `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` (server-side secrets) in
  addition to the two public vars. Without the service-role key the API returns `503`.
- **Issuing keys:** `node scripts/mint-api-key.mjs --company "Acme" --name prod --rate 60`
  (prints the token once).
- **Listing / usage:** `node scripts/list-api-keys.mjs --usage 30` (per-key lifetime +
  daily request counts for billing / abuse detection).
- **Revoking:** `node scripts/revoke-api-key.mjs --id <uuid>` (or `--prefix …`,
  `--delete`).
- **Publishing a forecast (manual):** `POST /api/console/forecast/publish` (admin).
- **Scheduled refresh (cron):** `GET /api/cron/publish-forecast`, authenticated by
  `Authorization: Bearer <CRON_SECRET>`, does precompute → store. Wired via **GitHub
  Actions** (`.github/workflows/publish-forecast.yml`, every ~5 min). Set repo secrets
  `HELIOSAT_BASE_URL` and `CRON_SECRET`. NOAA-only, serverless-safe. Until the first
  successful run, `/api/v1/...` returns `503`.
- **Monitoring:** point an uptime monitor at `GET /api/v1/status` (non-200 = down or
  stale cron). GitHub Actions emails on workflow failure by default.
