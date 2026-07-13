# HelioSat Mission Control

> **This MVP does not use mock, synthetic, interpolated, or forecasted data.**

A real-time aerospace telemetry dashboard for monitoring live space weather and satellite positions. Every value shown is sourced directly from live external APIs or computed via physics-based algorithms from real orbital data. If a source is unavailable, the dashboard displays "Unavailable" or "Not available" — it never fills gaps with synthetic values.

This statement describes the public dashboard. The authenticated Internal Console now also contains a clearly separated, versioned **experimental** LEO density/drag research module. Its retrospective observations, experimental point forecasts, explicit persistence assumptions and generic drag scenarios are labelled as different evidence classes and are never exposed as public operational data.

---

## Data Sources

| Panel | Source | Endpoint |
|---|---|---|
| L1 Solar Wind — Magnetometer | NOAA SWPC | `https://services.swpc.noaa.gov/products/solar-wind/mag-2-hour.json` |
| L1 Solar Wind — Plasma | NOAA SWPC | `https://services.swpc.noaa.gov/products/solar-wind/plasma-2-hour.json` |
| NOAA Alerts | NOAA SWPC | `https://services.swpc.noaa.gov/products/alerts.json` |
| Satellite TLE Catalog | CelesTrak | `https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle` |

---

## What Is Directly Fetched

The following values are **parsed directly from API responses** with no transformation beyond unit-preserving field extraction:

- **Magnetometer**: `time_tag`, `bx_gsm`, `by_gsm`, `bz_gsm`, `lon_gsm`, `lat_gsm`, `bt`
- **Plasma**: `time_tag`, `density`, `speed`, `temperature`
- **Alerts**: `product_id`, `issue_datetime`, `message`
- **TLE catalog**: satellite name, TLE Line 1, TLE Line 2 (validated format only)

---

## What Is Computed from Real TLE via SGP4

The following values are **derived by propagating real TLEs** using the `satellite.js` SGP4 implementation. No fictional positions, altitudes, or velocities are generated:

- **Latitude / Longitude**: ECI → Geodetic conversion via `satellite.eciToGeodetic` at current UTC
- **Altitude (km)**: Geodetic height from SGP4 propagation result
- **Velocity (km/s)**: Euclidean magnitude of ECI velocity vector `√(vx² + vy² + vz²)`
- **Inclination (deg)**: Extracted directly from the `satrec.inclo` field (radians → degrees), not inferred
- **Orbit path**: 100-point forward-propagation trace from the TLE, one minute per step

If SGP4 propagation fails for a satellite (e.g., TLE is too old or degenerate), all availability flags are set to `false` and no value is displayed.

---

## Hard Rules Enforced Throughout the Codebase

- ❌ No `Math.random()` anywhere
- ❌ No mock or synthetic data files
- ❌ No hardcoded fake numerical values (solar wind speed, altitude, velocity, etc.)
- ❌ No interpolation of missing data points
- ❌ No smoothing of time series
- ❌ No extrapolation or forecasting from current conditions
- ❌ No artificial risk scores or storm scenarios
- ❌ No `|| 'fallback-string'` masking of absent API fields (fields are exposed as `null`)
- ✅ Missing values explicitly shown as **"Not available"**
- ✅ Failed sources explicitly shown as **"Unavailable"**
- ✅ Disconnected modules explicitly shown as **"Not connected"**

---

## Known Limitations

- **No real-time auto-refresh**: The dashboard is server-rendered on each page load. Client-side live updates for satellite positions use a 1-second `setInterval` running `satellite.js` locally — no polling of the API. NOAA/CelesTrak data is fetched fresh on each browser navigation.
- **SGP4 accuracy**: SGP4 is the standard orbital model for NORAD TLEs. It is accurate for low-to-medium Earth orbit over short time spans. It does not account for atmospheric drag beyond the TLE epoch or high-precision manoeuvre modelling.
- **Inclination extraction**: `inclinationDeg` is taken from `satrec.inclo` (stored in radians by `satellite.js`), which is the direct TLE field — not computed from the propagated position.
- **L1 Monitor Marker**: The L1 position shown in the 3D view is a **conceptual indicator** at a fixed Sun-facing point. No actual spacecraft ephemeris (e.g., DSCOVR or ACE) is connected.
- **Solar wind and B-field vectors**: These are rendered in the 3D scene only when real NOAA data is available. Direction and magnitude are qualitative visual aids — they are not precision-scaled physical vectors.
- **Forecast Module**: Entirely disabled. No synthetic forecast is generated. The panel will remain in a "not connected" state until a real NOAA/NASA forecast endpoint is integrated.
- **Mobile**: The layout is desktop-first. Tablet is usable. Mobile screens may have horizontal overflow.
- **CelesTrak group**: Only the `stations` group (ISS, CSS, etc.) is fetched by default. The service layer supports dynamic group names (`starlink`, `weather`, `active`) but they are not enabled in the UI.

---

## Setup Instructions

### Prerequisites

- Node.js ≥ 20
- npm ≥ 10

### Install

```bash
cd HelioSAT
npm install
```

### Run (development)

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Authenticated administrators can open `/console`. LEO research setup, official data ingestion and exact reproduction commands are documented in [`docs/LEO_REPRODUCIBILITY.md`](docs/LEO_REPRODUCIBILITY.md); scientific boundaries and licensing are in [`docs/LEO_DENSITY_DRAG_METHODOLOGY.md`](docs/LEO_DENSITY_DRAG_METHODOLOGY.md) and [`docs/LEO_DATA_SOURCES_AND_LICENSES.md`](docs/LEO_DATA_SOURCES_AND_LICENSES.md). The staged 2021–2025 evidence and delivery audit are recorded in [`docs/LEO_MULTIYEAR_MODEL_CARD.md`](docs/LEO_MULTIYEAR_MODEL_CARD.md) and [`docs/LEO_MULTIYEAR_IMPLEMENTATION_REPORT.md`](docs/LEO_MULTIYEAR_IMPLEMENTATION_REPORT.md).

### Build (production)

```bash
npm run build
npm start
```

### Environment

No API keys required. All data sources are public NOAA SWPC and CelesTrak endpoints. Internet access is required at runtime.

---

## Architecture

```
src/
├── app/
│   └── page.tsx                   # Server component — parallel data fetch entry point
├── services/
│   ├── noaaSolarWindService.ts    # Magnetometer + plasma fetch and parse
│   ├── noaaAlertsService.ts       # Space weather alerts fetch and parse
│   ├── celestrakService.ts        # TLE group fetch and format validation
│   ├── satellitePropagationService.ts  # SGP4 via satellite.js
│   └── dataAvailability.ts        # Boolean readiness checks (no scoring)
├── components/
│   ├── layout/                    # AppShell, TopStatusBar
│   ├── panels/                    # SolarWindPanel, AlertsPanel, SelectedSatellitePanel,
│   │                              #   DataReadinessPanel, ForecastModulePanel
│   ├── earth/                     # EarthScene3D, SatelliteMarker, OrbitPath,
│   │                              #   L1MonitorMarker, SolarWindVector
│   └── ui/                        # GlassCard, DataField, SourceStatusBadge
└── contexts/
    └── SatelliteSelectionContext.tsx  # Shared selected satellite state
```

---

## License

Internal research prototype. Not for operational use.
