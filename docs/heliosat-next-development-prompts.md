# HelioSat MVP - Next Development Prompts

Use these prompts sequentially with the current HelioSat repository. They are intentionally scoped to the existing Next.js/TypeScript MVP and must not trigger a rewrite to Python/FastAPI.

## Prompt 1 - Product And Architecture Audit

You are a senior scientific software engineer continuing the existing HelioSat MVP. Do not rewrite the project or introduce a new Python/FastAPI architecture. Work with the current Next.js 16, TypeScript, Supabase-compatible, API-route-based codebase.

First, inspect the current repository without modifying files. Map the existing product into these areas:

- Real-time Forecast console tab
- Training Data console tab
- Validation & Studies console tab
- Public API endpoints under `/api/v1`
- Internal console/admin endpoints under `/api/console`
- Core services under `src/services`
- Local/cached data under `data/console`
- Documentation under `docs`

Produce a concise but precise technical audit that answers:

- What does the MVP already do?
- Which endpoints and services provide each function?
- Which data sources are used: DSCOVR, ACE, OMNI, GOES, Kp, CelesTrak, Supabase?
- Which data is live, historical, cached, derived, or only contextual?
- Which assumptions are scientifically important?
- Where does the product still overemphasize G/Kp instead of physical solar-wind drivers?
- What should be kept, renamed, clarified, or hardened?

Important framing:

- The MVP core is physical-driver forecasting from L1 to near-Earth/bow-shock conditions.
- G/Kp is an operational proxy or validation response, not the primary forecast variable.
- OMNI is the near-Earth/time-shifted validation truth for solar wind.
- GOES is contextual magnetosphere/radiation response, not the truth for L1 solar wind.

End with a prioritized backlog of no more than 10 items, grouped by the current three-tab console structure.

## Prompt 2 - Physical Forecast API Contract Hardening

You are improving HelioSat's existing public forecast API, not designing a greenfield API. Work inside the current Next.js API route structure. The goal is to make the API contract scientifically clear, stable, and operator-facing.

Inspect the existing public API endpoints, especially:

- `/api/v1/forecast/realtime`
- `/api/v1/status`
- any forecast publishing/precompute paths
- `src/services/realtimeForecastService.ts`
- related Supabase forecast storage code
- `docs/api-v1.md` and operations docs

Design and implement a hardened API response contract for the physical forecast. Preserve backward compatibility where practical, but add clear fields if missing:

- `schema_version`
- `model_version`
- `issued_at` / `generated_at`
- `source`
- `target`
- `l1_sample_time_utc`
- `arrival_time_utc`
- `lead_time_minutes`
- `arrival_uncertainty_minutes`
- `distance_km`
- `distance_source`: measured ephemeris or nominal
- `propagated_variables`: `speed_km_s`, `density_cm3`, `bz_gsm_nt`, `bt_nt`
- `derived_features`: `dynamic_pressure_npa`, `coupling_electric_field_mv_m`, rolling min/max where available
- `quality_flags`
- `confidence`
- `limitations`
- `estimated_g_level_proxy`, explicitly labelled as a proxy if included

Add or update TypeScript types where useful. Avoid introducing Python or a parallel service. Keep the forecast deterministic and transparent.

Quality requirements:

- Missing speed must prevent physical arrival-time propagation or downgrade confidence.
- Stale source data and gaps must be represented in `quality_flags`.
- Arrival uncertainty should be explicit and configurable, initially around 10-15 minutes unless the existing code already provides a better estimate.
- The API must not imply that Kp/G is directly measured or directly predicted as the core product.

Update docs with one realistic JSON example and a short "scientific meaning" section. Run `npm run lint` and `npm run build`.

## Prompt 3 - Derived Features, Events, And Hazard Layer

You are adding a transparent hazard interpretation layer on top of the existing HelioSat physical forecast. Do not replace MRU or add ML. Reuse the current TypeScript services and data structures.

Inspect existing services first:

- `mruForecastService.ts`
- `realtimeForecastService.ts`
- `liveEventService.ts`
- `stormScaleService.ts`
- `consoleForecastLog.ts`
- `liveL1HistoryService.ts`
- any current event or hazard endpoints

Implement or consolidate physical derived features:

- Dynamic pressure `Pdyn` in nPa, using proton density in cm^-3 and speed in km/s.
- Coupling electric field `Em = Vsw * max(0, -Bz) * 1e-3` in mV/m.
- Rolling minimum Bz over 15/30/60 minutes.
- Rolling maximum Pdyn over 15/30/60 minutes.
- Rolling maximum Em over 15/30/60 minutes.
- Gradients for Vsw, density, Bz, Pdyn where enough samples exist.

Build event detection on propagated forecasts:

- `incoming_shock`: rapid increase in Vsw, density, Pdyn, or Bt.
- `southward_bz_interval`: sustained Bz below configurable thresholds.
- `high_dynamic_pressure_interval`: Pdyn above threshold.
- `high_coupling_interval`: Em above threshold.
- `geomagnetic_risk_window`: combined physical-driver risk window.

Build a rules-based hazard interpretation:

- severity: low, moderate, high, severe
- confidence: low, medium, high
- main_driver
- physical_drivers
- expected_start_utc
- expected_peak_utc
- expected_end_utc
- lead_time_minutes
- operator_message
- estimated_g_level_proxy as a clearly labelled proxy, not a direct forecasted measurement

Expose this through existing Next.js API routes, preferably under `/api/v1` for public-facing stable output and/or `/api/console` for internal UI.

Add focused tests or, if the project has no test runner, create pure functions that are easy to test and document manual verification. Run `npm run lint` and `npm run build`.

## Prompt 4 - Validation & Studies Clarification And Expansion

You are improving the existing `Validation & Studies` console tab. Keep the current tab structure. Do not remove existing validation panels unless replacing them with clearer equivalents.

Start by inspecting:

- `src/components/console/ConsoleScreen.tsx`
- `/api/console/arrival`
- `/api/console/backtest`
- `/api/console/timing`
- `mruArrivalAccuracyService.ts`
- `mruBacktestService.ts`
- `mruTimingService.ts`
- `aceArchiveStore.ts`
- `omniArchiveStore.ts`
- `geoArchiveStore.ts`

Make the validation story explicit and scientifically honest. The UI should clearly separate:

1. Arrival-time validation
   - Uses OMNI `Timeshift`.
   - Compares MRU delay against OMNI's measured/derived propagation delay.
   - Measures timing error: bias, MAE, RMSE, median absolute error, p90 absolute error, within 10/20/30 min.

2. Variable-alignment validation
   - Uses ACE upstream L1 as prediction input.
   - Uses OMNI shifted near-Earth as truth.
   - Compares propagated speed, density, Bt, Bz against OMNI at arrival time.

3. Event validation
   - Detects shocks, southward Bz windows, high Pdyn, high Em.
   - Scores onset-time error, duration error, peak-value error, precision/recall if reference windows exist.

4. G-level proxy validation
   - Optional and clearly framed.
   - Compares estimated response proxy against observed Kp/G bins.
   - Explain that Kp is a ground geomagnetic response index, not an in-situ solar-wind variable.

Add a compact "Data Used" section inside the tab that lists, for each validation study:

- Source dataset
- Resolution
- Date coverage available locally
- Role: L1 input, near-Earth truth, response context, or proxy label
- Known limitations

The current local archive status should be visible:

- ACE archive range and row count
- OMNI archive range and row count
- GOES/GEO archive range if available
- arrival cache span and sample count

Do not hide uncertainty or gaps. Run `npm run lint` and `npm run build`.

## Prompt 5 - Console UX And Documentation Polish

You are polishing the existing HelioSat operator console and documentation without changing the product architecture.

Keep the three main tabs:

- Real-time Forecast
- Training Data
- Validation & Studies

Improve the operator narrative across them:

Real-time Forecast:

- Show "what L1 is measuring now", "what is already inbound", "when it reaches Earth", and "which physical driver matters".
- Keep the visual L1-to-Earth transit graphic consistent with the same forecast data used by the charts and API.
- Avoid presenting G-level as the core truth. Phrase it as operational proxy/estimated response.

Training Data:

- Explain which datasets are used for training/experiments and which are only contextual.
- Separate live DSCOVR, historical ACE, OMNI near-Earth truth, GOES GEO response, and Kp labels.
- Show coverage, gaps, last update, and readiness.

Validation & Studies:

- Make benchmark results understandable to a non-expert operator without sacrificing scientific precision.
- Add tooltips or compact explanatory text for OMNI Timeshift, MRU, L1, bow shock, GOES, Kp/G.

Documentation:

- Update or add docs explaining the scientific MVP definition.
- Include examples of API outputs.
- Include "what HelioSat does not claim" section:
  - It does not directly command satellites.
  - It does not directly measure near-Earth solar wind except through OMNI historical validation.
  - It does not directly predict measured Kp as a core physical variable.
  - G-level output is a proxy derived from propagated physical drivers.

Before finishing:

- Verify desktop and mobile layout if UI changes are made.
- Run `npm run lint`.
- Run `npm run build`.
