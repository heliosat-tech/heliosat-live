# HELIOSAT Public API — v1

The public API exposes **one** product: the **Real-Time Physical Forecast**. Everything
else (playground, training, pipelines) is internal. The API is authenticated by
**API key** (not the admin cookie), versioned, and served **precomputed** — it reads
the latest forecast row, it never computes in-request.

HELIOSAT's core forecast is the L1 -> near-Earth/bow-shock propagation of physical
solar-wind and IMF drivers: speed, density, Bz, Bt, dynamic pressure and coupling
electric field. Any G/Kp output is an operational proxy derived from those propagated
drivers, not an official measured Kp/G value.

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
  "model_version": "mru-ballistic-v0.2",
  "issued_at": "2026-06-07T12:00:30Z",   // when this forecast was published
  "generated_at": "2026-06-07T12:00:30Z",
  "observed_at": "2026-06-07T11:58:00Z", // latest L1 measurement used
  "l1_sample_time_utc": "2026-06-07T11:58:00Z",
  "l1_distance_km": 1492000,
  "distance_km": 1492000,
  "distance_source": "measured_ephemeris",
  "source": {
    "id": "noaa_swpc_l1_realtime",
    "provider": "NOAA SWPC",
    "observatory": "L1 upstream monitor",
    "products": [
      "json/rtsw/rtsw_mag_1m.json",
      "json/rtsw/rtsw_wind_1m.json",
      "json/rtsw/rtsw_ephemerides_1h.json"
    ]
  },
  "target": {
    "id": "near_earth_bow_shock",
    "description": "Estimated solar-wind and IMF conditions at the near-Earth bow-shock environment."
  },

  // Core physical forecast: the latest L1 parcel propagated to near-Earth.
  "arrival_time_utc": "2026-06-07T12:43:00Z",
  "lead_time_minutes": 42,
  "arrival_uncertainty_minutes": 12,
  "propagated_variables": {
    "speed_km_s": 452.1,
    "density_cm3": 3.1,
    "bz_gsm_nt": -4.8,
    "bt_nt": 6.2
  },
  "derived_features": {
    "dynamic_pressure_npa": 1.06,
    "coupling_electric_field_mv_m": 2.17,
    "gradients_per_minute": {
      "speed_km_s": 1.8,
      "density_cm3": 0.02,
      "bz_gsm_nt": -0.08,
      "bt_nt": 0.04,
      "dynamic_pressure_npa": 0.01
    },
    "rolling_min_bz_gsm_nt": {
      "minutes_15": -5.3,
      "minutes_30": -6.1,
      "minutes_60": -6.1
    },
    "rolling_max_dynamic_pressure_npa": {
      "minutes_15": 1.23,
      "minutes_30": 1.4,
      "minutes_60": 1.4
    },
    "rolling_max_coupling_electric_field_mv_m": {
      "minutes_15": 2.41,
      "minutes_30": 2.76,
      "minutes_60": 2.76
    }
  },
  "quality_flags": [],
  "confidence": "high",
  "limitations": [
    "Ballistic MRU propagation assumes each L1 parcel keeps the measured bulk speed until near-Earth arrival.",
    "Arrival time is uncertain because phase-front orientation, acceleration, stream interaction and bow-shock geometry are simplified.",
    "Estimated G level is an operational proxy derived from propagated physical drivers; it is not an official measured Kp/G value."
  ],
  "estimated_g_level_proxy": {
    "level": 1,
    "code": "G1",
    "kp_estimate": 5.1,
    "method": "rules_based_coupling_proxy",
    "note": "Operational G-level proxy derived from propagated solar-wind drivers, not an official measured Kp/G value."
  },

  // Legacy v1 compatibility fields. Prefer the physical fields above for new clients.
  "observed": {
    "speed_km_s": 452.1,
    "bz_nt": -4.8,
    "density_p_cm3": 3.1,
    "g_level": 1                          // legacy proxy field, 0-5
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

Units: speed km/s, magnetic field nT, density particles/cm³, dynamic pressure nPa,
electric field mV/m, times ISO-8601 UTC. `observed`, `arrival`, `propagated_variables`,
`derived_features` and `inbound_peak` may each be `null` when there is no usable data.

### Scientific meaning

- `arrival_time_utc` is the estimated near-Earth/bow-shock arrival of the latest L1
  parcel using ballistic MRU propagation: `delta_t = distance_km / speed_km_s`.
- `arrival_uncertainty_minutes` is explicit because phase-front orientation and solar
  wind evolution are simplified. It is configurable and starts at a conservative
  baseline around 10-15 minutes.
- `distance_source` is `measured_ephemeris` when the live NOAA ephemeris is available
  and reliable; otherwise it is `nominal_l1_distance`.
- `quality_flags` explain missing, stale, gappy or out-of-range input conditions. If
  speed is missing, HELIOSAT does not produce a physical arrival time for that parcel.
- `estimated_g_level_proxy` is a derived operational risk proxy. It is not the official
  NOAA G scale and not a direct Kp measurement.

### Errors

| Status | Meaning                                   |
| ------ | ----------------------------------------- |
| `401`  | Missing/invalid/inactive/expired API key  |
| `429`  | Rate limit exceeded (see `Retry-After`)   |
| `503`  | No forecast published yet / not configured |

## Events and hazard interpretation

These endpoints read the same precomputed physical forecast as `/forecast/realtime`
and apply transparent rules. They do not run ML and do not claim an official Kp/G
measurement.

```
GET /api/v1/events/latest
GET /api/v1/events/window?minutes=90
GET /api/v1/hazard/latest
GET /api/v1/hazard/window?minutes=90
```

`events` returns detected physical-driver windows such as:

- `incoming_shock`
- `southward_bz_interval`
- `high_dynamic_pressure_interval`
- `high_coupling_interval`
- `geomagnetic_risk_window`

`hazard` returns the operator-facing summary:

```jsonc
{
  "hazard": {
    "generated_at": "2026-06-07T12:00:35Z",
    "model_version": "mru-ballistic-v0.2",
    "forecast_issued_at": "2026-06-07T12:00:30Z",
    "expected_start_utc": "2026-06-07T12:31:00Z",
    "expected_peak_utc": "2026-06-07T12:43:00Z",
    "expected_end_utc": "2026-06-07T12:55:00Z",
    "lead_time_minutes": 42,
    "severity": "moderate",
    "confidence": "high",
    "main_driver": "coupling electric field",
    "estimated_g_level_proxy": "G1 possible",
    "operator_message": "Moderate geomagnetic response proxy possible; dominant driver is coupling electric field. Monitor near ETA.",
    "quality_flags": []
  },
  "events": []
}
```

The `window` endpoints filter to events whose lead time is inside the requested
window. The current v1 implementation is based on the latest precomputed forecast
parcel; a future additive extension may include a full propagated forecast curve.

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
{
  "status": "ok",
  "schema_version": "1",
  "model_version": "mru-ballistic-v0.2",
  "issued_at": "2026-06-07T12:00:30Z",
  "confidence": "high",
  "forecast_age_seconds": 92,
  "stale": false
}
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
