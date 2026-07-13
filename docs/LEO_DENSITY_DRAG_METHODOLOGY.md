# HelioSat LEO density and drag methodology

Status: internal staged multi-year research, not operational.  
Implementation updated: 2026-07-13.  
Scope: authenticated Internal Console only.

## Evidence classes and claim boundary

The module keeps four classes separate in contracts, artifacts and UI:

- `observed_retrospective_product`: official ESA/VirES density observations.
- `retrospective_reference_archive`: NASA SPDF OMNI data aligned with information that is only known after the event.
- `experimental_forecast`: a point estimate produced at a recorded issuance time from already measured L1 parcels plus explicit assumptions.
- `scenario`: drag and orbital-impact sensitivity using a declared ballistic coefficient; never a measured satellite property.

No retrospective result is described as operational. Missing observations, forcing, model artifacts, trajectory states or license acknowledgement produce null/status output rather than a numeric fallback.

## Observations and normalization

The canonical density schema is `thermosphere-density-v1` in `leo_drag/schema.py`. The ingestion adapter downloads official HAPI responses from ESA VirES, preserves the exact response bytes and SHA-256 digest, validates the collection contract, and maps timestamp, GRS80 geodetic position, local solar time, density and available quality flags. Values with absolute density at or above `1e30 kg m-3` are treated as fill.

Native observations remain in checksum-addressed raw responses. A conflicting revision for an already ingested collection/interval is rejected instead of overwritten. The processed product is a one-minute median within each mission/spacecraft stream; longitude and local solar time use circular means so dateline/midnight crossings remain physical. Resampling never bridges long gaps and does not turn absent quality metadata into a nominal flag. Each raw chunk, processed partition and status is recorded in `data/processed/thermosphere/manifest.v1.json`.

The completed pilot contains 2022-02-03 00:00 UTC through 2022-02-08 00:00 UTC (stop exclusive):

| Product | Native rows | One-minute rows | Evidence |
| --- | ---: | ---: | --- |
| Swarm A `SW_OPER_DNSAPOD_2_` | 14,400 | 7,200 | official retrospective POD density |
| Swarm B `SW_OPER_DNSBPOD_2_` | 14,400 | 7,200 | official retrospective POD density |
| Swarm C `SW_OPER_DNSCPOD_2_` | 14,400 | 7,200 | official retrospective POD density |
| GRACE-FO 1 `GF_OPER_DNS1ACC_2_` | 43,200 | 7,200 | official retrospective ACC density |
| Total | 86,400 | 28,800 | — |

GRACE-FO 2 remains explicitly unavailable because the official catalog has no usable density collection.

The primary multi-year extension is an immutable event/season sample from 2021–2025: 236 plan-tagged chunks, 10,167,120 native rows and 3,389,040 one-minute rows across the same four spacecraft. Analysis retains 600,441 rows on exact five-minute UTC timestamps that are common to all arrival modes. Its 606 distinct days are discontinuous and storm-enriched; they are not described as continuous climatology.

## Physical atmosphere baseline

`AtmosphereBaseline` is replaceable. The implemented adapter is NRLMSIS 2.1 through `pymsis==0.12.0`; every successful row records model/version, UTC, geodetic coordinates and explicit F10.7/F10.7a/seven-element Ap forcing. It does not invoke an implicit ancillary downloader.

For the retrospective pilot, NASA SPDF OMNI2 hourly files provide previous-day F10.7, a centered 81-day F10.7 mean and storm-time Ap history. The centered mean uses future data and is therefore labelled retrospective only. All 28,800 pilot rows received a valid baseline result.

The multi-year study instead requires `trailing_81_day`: F10.7a ends at D−1 and is stored in a separate baseline tree. This is causal by observation time, while OMNI publication latency remains explicit. The centered pilot baseline is never silently reused for this study.

For an experimental issuance, NOAA SWPC supplies previous-day F10.7 and planetary three-hour `a_running`; a saved current NASA OMNI2 snapshot supplies a causal trailing 81-day F10.7 mean. Retrieval time, source URL, checksum and age are retained. This live baseline is deliberately not numerically identical to the retrospective centered-mean baseline.

NRLMSIS 2.x use is gated. `HELIOSAT_ENABLE_NRLMSIS_RESEARCH=true` plus an explicit CLI acknowledgement records internal-research intent but does not grant commercial or redistribution rights.

## Solar-wind timelines and causal features

The same NASA SPDF high-resolution OMNI five-minute source is transformed into three experiments:

1. `reference_aligned`: retrospective OMNI phase-front/bow-shock alignment, used to test the physical response model under favorable timing.
2. `heliosat_mru_arrival`: source measurement time plus HelioSat MRU travel time from measured spacecraft position to a fixed 13.5 Rₑ bow-shock nose.
3. `heliosat_mru_ml_arrival`: strict MRU plus the compatible v2 arrival-residual artifact; rows without an ML correction are unavailable rather than falling back to MRU.

The HelioSat experiments use a retrospective OMNI archive and assume each upstream value was available at its source-measurement timestamp because historical HelioSat reception snapshots do not exist. They are therefore issuance-logic replays, not proof of historical operational availability. The earlier pilot's incompatible legacy artifact/MRU fallback remains historical evidence only; the multi-year run uses `arrival-residual-v2-a898ef84a1a4b53d` without fallback.

Dynamic pressure, southward-IMF electric-field coupling, Newell coupling and Akasofu epsilon are centralized in `leo_drag/drivers.py`. Trailing windows of 15 min, 30 min, 1 h, 3 h, 6 h and 12 h include only the current/past propagated parcels. Coverage is the valid count divided by the full-window count expected at five-minute cadence. Every join is backward/as-of with a 15-minute tolerance and checks both physical arrival time and assumed availability at issuance.

Join results:

- reference-aligned: 28,752 of 28,800 rows matched;
- HelioSat predicted-arrival: 28,760 of 28,800 rows matched.

## Target, models and validation

The learned target is the log-density residual:

```text
y = ln(rho_observed) - ln(rho_baseline)
rho_predicted = rho_baseline * exp(y_hat)
```

The suite uses identical matched rows for active comparisons:

- M0: NRLMSIS baseline, no learned correction;
- M1: Ridge residual correction from orbital/solar context;
- M2: HistGradientBoosting residual correction from orbital/solar context;
- M3: M2 context plus causal propagated L1 features;
- M4: M3 plus genuinely issuance-safe ground geomagnetic history; unavailable in this pilot because per-value publication times were not proven.

The primary split is chronological, never random by row. In the predicted-arrival replay it is approximately 50% train (through 2022-02-05 12:04), 10% validation (through 2022-02-06 00:03) and 40% held-out test (through 2022-02-07 23:59), with 11,504 test rows. The study also emits mission-transfer diagnostics and a whole-event holdout. Year walk-forward is implemented but unavailable with a single year of local observations.

For the multi-year M3 comparison, fixed calendar roles replace that pilot split: 2021–2022 train, 2023 validation, 2024 uncertainty calibration and 2025 test. Mission/spacecraft identity is forbidden from M3. LOSO, Swarm→GRACE, expanding-year, A0–A6 and identity-only diagnostics are separate saved experiments. The run does not claim that every M0–M5 model was fitted for every timing mode.

Metrics include MAE/RMSE/bias/correlation in log10 density, median absolute relative error, predicted/observed density ratio, M0 skill on identical rows, UTC-day block-bootstrap intervals, mission/local-time/latitude/altitude/geomagnetic breakdowns and required plots. Event peaks are evaluated per spacecraft before aggregation so simultaneous missions cannot form a non-physical mixed peak.

## Drag and first-order orbital impact

The convention is:

```text
B = Cd * A / m                         [m2 kg-1]
v_rel = v_inertial - omega_Earth x r  [m s-1]
a_drag = -0.5 * rho * B * |v_rel| * v_rel
```

Neutral atmosphere rigid co-rotation is included; detailed winds and attitude changes are not. The pilot uses only generic sensitivity scenarios (`B = 0.002`, `0.01`, or `0.03 m2 kg-1`) and never infers mass, area or Cd from a TLE. Derived retrospective state samples above 15 km/s are rejected; the corrected run has per-spacecraft maxima of 7.68–7.72 km/s.

Level-1 impact integrates drag acceleration along supplied state samples to cumulative delta-v loss and a first-order along-track displacement. Retrospective positions from density products are geodetic-to-inertial finite-difference states, not precise orbit determination. Live future states use a real CelesTrak TLE propagated with SGP4/satellite.js.

## Experimental live forecast

The versioned snapshot generator requires all of the following:

- a real, fresh or explicitly degraded CelesTrak TLE and complete future SGP4 state vectors;
- real HelioSat live L1 history propagated to the bow shock;
- explicit official NOAA/NASA atmosphere forcing retrieved before issuance;
- the held-out M3 artifact and NRLMSIS research acknowledgement;
- a declared generic drag scenario.

Already measured L1 parcels whose arrival is in the future form `confirmed_inbound`. Live samples are aggregated without interpolation to the five-minute training cadence; a complete fresh 12-hour history is mandatory. After the last such parcel, the last driver is carried forward as `assumption_extension`. The boundary is present on every timeline point and rendered separately. Calibrated p10/p50/p90 are emitted only when the saved calibration is valid and its model version exactly matches the loaded artifact; otherwise the interval is suppressed. A snapshot older than 30 minutes is rejected by default.

The snapshot is issuance-atomic: it embeds the exact trajectory, forcing and density grids. The API validates NORAD, group, horizon, cadence and timestamps and serves that stored physical context instead of combining density with a later request. The current multi-year M3 is identity-free; numeric features and the remaining categorical orbit-direction domain are checked against fitted training limits.

At the final implementation check, no real future CelesTrak TLE trajectory was available. Consequently the generator returned `unavailable`, wrote no `forecast-latest.v1.json` and did not publish density or drag values.

## Artifacts

Local-only artifacts live under:

- `data/raw/thermosphere/`: exact ESA, NOAA and NASA responses plus metadata/checksums;
- `data/processed/thermosphere/`: canonical one-minute observations and manifest;
- `data/processed/thermosphere-baseline/`: explicit NRLMSIS outputs;
- `data/processed/thermosphere-features/`: persisted pilot feature datasets; the multi-year three-mode frames are constructed reproducibly and matched in memory;
- `data/model-runs/leo-density/<run-id>/`: fitted models, predictions, metrics, plots, interpretations and model card.

These paths are ignored by Git. The Internal Console reads bounded summary artifacts; it is not a raw-data distribution endpoint.
