# HelioSat LEO density and drag implementation report

Completed: 2026-07-12  
Scope: authenticated Internal Console only  
Scientific run: `pilot-20220203-20220208-v2-circular`  
Status: retrospective pilot available; experimental live forecast code available but current issuance blocked by missing real TLE.

## Summary

The Internal Console now has a separate LEO research surface in each existing section while every L1 page remains the default. It ingests official ESA/VirES Swarm and GRACE-FO density, applies an explicit NRLMSIS 2.1 baseline, joins two distinct solar-wind timing experiments, trains/evaluates M0–M4, calculates generic Level-1 drag/orbital-impact scenarios, renders the saved validation artifacts, and exposes an issuance-atomic experimental live-snapshot contract.

The public dashboard, public API v1 and existing L1-to-bow-shock contracts were not changed. Every new endpoint is admin-only and `no-store`. No synthetic fixture is exposed as an observation, and no live density/drag value is published when trajectory/model inputs are absent.

A final scientific audit found and corrected a dateline resampling defect before delivery. The invalidated v1 local run is superseded by v2, which uses circular longitude/local-time aggregation and an orbital-speed guardrail. The corrected derived velocities are 7.68–7.72 km/s rather than the non-physical values in the discarded run.

## Phases

| Phase | Result |
| --- | --- |
| 0 — repository audit | Complete; frontend/backend/auth/science/storage/trajectory architecture and baseline checks documented. |
| 1 — navigation/scaffolding | Complete; L1 remains default in Real Time, Archive and Validation; isolated LEO panels added. |
| 2 — canonical schema/inventory | Complete; versioned contracts, five mission cards, lineage and explicit GRACE-FO 2 unavailable state. |
| 3 — ingestion | Complete; restartable official VirES HAPI adapter, strict manual import, checksummed raw bytes, circular one-minute processing. |
| 4 — atmosphere baseline | Complete for internal research; replaceable interface and explicit NRLMSIS 2.1 forcing/status. |
| 5 — features/joins | Complete; reference-aligned and predicted-arrival replay remain separate, with causal backward joins and five-minute coverage. |
| 6 — density studies | Complete as a short pilot; M0–M3 available, M4 honestly unavailable, year walk-forward implemented but not executable on one year. |
| 7 — drag/orbital impact | Complete at Level 1 using declared generic scenarios, co-rotation and physical-speed guardrails; Level 2 was optional and is not claimed. |
| 8 — experimental realtime | Implementation complete; live snapshot was not produced because CelesTrak returned no real TLE. Null/partial behavior verified. |
| 9 — validation/archive UI | Complete; 18 verified plots, two event selectors, six regime dimensions, sanitized lineage and interpretation sidecars. |
| 10 — documentation/checks | Complete; methodology, model card, sources/licensing, reproduction, deployment checklist, tests, lint/typecheck/build and route smoke checks. |

## Files created

- Scientific package: `leo_drag/{schema,manifest,ingestion,inventory,ancillary,baseline,baseline_processing,drivers,features,metrics,models,drag,trajectory,study,plots,forecast}.py` and `leo_drag/__init__.py`.
- Commands: `scripts/ingest_leo_density.py`, `scripts/run_leo_density_study.py`, `scripts/collect-leo-live-context.mts`, `scripts/generate_leo_forecast_snapshot.py`.
- Internal routes: `src/app/api/console/leo/inventory/route.ts`, `validation/route.ts`, `validation/artifact/route.ts`, and `forecast/route.ts`.
- Internal UI: `src/components/console/ConsoleSectionTabs.tsx` and `src/components/console/leo/{LeoArchivePanel,LeoValidationPanel,LeoRealtimePanel}.tsx`.
- Contracts/services: `src/lib/leo/{contracts,navigation}.ts`, its navigation test, and `src/services/leo/{leoInventoryService,leoValidationService,leoTrajectoryService,leoForecastService}.ts` plus service tests.
- Scientific tests: `tests/test_leo_{ingestion,baseline,ancillary,drivers,features_models,density_metrics,drag,trajectory,forecast,study}.py`.
- Documentation: `LEO_DRAG_IMPLEMENTATION_PLAN.md`, `LEO_DATA_SOURCES_AND_LICENSES.md`, `LEO_DENSITY_DRAG_METHODOLOGY.md`, `LEO_DENSITY_MODEL_CARD.md`, `LEO_REPRODUCIBILITY.md`, `LEO_PUBLIC_DEPLOYMENT_CHECKLIST.md`, and this report.
- Environment: `requirements-pipeline.lock.txt`.

The user-provided `docs/HELIOSAT_CODEX_LEO_DRAG_IMPLEMENTATION.md` was read and not modified.

## Existing files modified

- `.env.example`, `.gitignore`, `requirements-pipeline.txt`: internal roots, license/forecast settings, ignored scientific data and dependencies.
- `README.md`: clarifies the public-vs-internal evidence boundary and links the research documentation.
- `next.config.ts`: output tracing for bounded local LEO summaries/plots.
- `scripts/test-extension-hook.mjs`: test loader support for the project's aliases.
- `src/components/console/ConsoleScreen.tsx`: internal secondary domain tabs only.

No public dashboard component or public API route was modified.

## Official data imported or downloaded

Mission observations, stop exclusive, 2022-02-03 00:00 through 2022-02-08 00:00 UTC:

| ESA/VirES collection | Raw rows | One-minute rows | Baseline OK |
| --- | ---: | ---: | ---: |
| Swarm A `SW_OPER_DNSAPOD_2_` | 14,400 | 7,200 | 7,200 |
| Swarm B `SW_OPER_DNSBPOD_2_` | 14,400 | 7,200 | 7,200 |
| Swarm C `SW_OPER_DNSCPOD_2_` | 14,400 | 7,200 | 7,200 |
| GRACE-FO 1 `GF_OPER_DNS1ACC_2_` | 43,200 | 7,200 | 7,200 |
| Total | 86,400 | 28,800 | 28,800 |

There are six logical HAPI chunks. Content-addressing migration retained the six legacy local raw/info copies and added six checksum-named copies; the manifest references only the latter. All official pilot rows passed the available quality policy; no fill/anomalous row entered the study.

Ancillary/driver files:

- NASA SPDF OMNI2 2021: SHA-256 `c7a68a97abddd6842f26225b6ac5761cdb2f375aca2b5f53b752f7158ed2f211`.
- NASA SPDF OMNI2 2022: `413ac4895d24cab0af4861710c437f12efab44f3cd6c814a614815fa0f2c8d88`.
- NASA SPDF OMNI2 2026 live attempt: `b60dfa8c6da1fdbed8e843571c1d4f4bde0c4dc9619a49894d566bce9d9a3b99`.
- NASA SPDF high-resolution OMNI five-minute 2022: `d3db85d0041dab7e815921456e6f95a68da01f3ae8cd0bb1418b7a2d668a2eea`.
- Four exact NOAA F10.7 and four NOAA planetary K/a JSON retrievals were retained from live verification attempts. Identical responses share checksums; changing K/a responses remain separate snapshots.

Raw/processed/model files are local and Git-ignored.

## Data still pending

- Multi-season/multi-year Swarm and GRACE-FO coverage; the current study is five days in 2022.
- Swarm ACC products as an independent target family and any future official GRACE-FO 2 density product. GRACE-FO 2 is currently unavailable, not substituted.
- Historical HelioSat feed reception/publication timestamps. The predicted-arrival experiment currently assumes OMNI source-time availability and is a retrospective replay.
- Issuance-safe ground geomagnetic history for M4.
- A fresh real CelesTrak TLE/cached catalog for live snapshot publication.
- Operator mass, area, Cd, attitude and precision ephemerides.
- Calibrated live p10/p90 uncertainty.

## Models implemented

- Physical baseline: NRLMSIS 2.1 through pymsis 0.12.0, explicit previous-day F10.7, centered/trailing F10.7a and seven-value Ap.
- M0: physical atmosphere baseline.
- M1: Ridge residual correction.
- M2: HistGradientBoosting context residual correction.
- M3: HistGradientBoosting context plus causal propagated-L1 features.
- M4: implemented contract but unavailable because no ground-index values have proven per-value issuance times.
- Drag: `B = CdA/m`, air-relative velocity with rigid Earth co-rotation, vector acceleration opposite velocity and three generic `B` scenarios.
- Orbital impact: Level-1 cumulative delta-v and first-order along-track displacement.

The M3 target is a natural-log residual; reported density metrics labelled dex are calculated in log10 space.

## Scientific results

These are retrospective five-day pilot results, not operational forecast skill. The primary predicted-arrival mode is an idealized issuance-logic replay using MRU because the existing arrival-residual joblib is incompatible with the installed scikit-learn runtime.

Held-out chronological test, 11,504 rows:

| Predicted-arrival replay model | MAE log10 [dex] | RMSE log10 [dex] | Median abs. relative error | RMSE skill vs M0 |
| --- | ---: | ---: | ---: | ---: |
| M0 | 0.058869 | 0.070195 | 0.130831 | 0.000000 |
| M1 | 0.093941 | 0.103396 | 0.246653 | -0.472995 |
| M2 | 0.079684 | 0.090105 | 0.200654 | -0.283646 |
| M3 | 0.037934 | 0.047976 | 0.074840 | 0.316523 |

Reference-aligned M3, kept separate: MAE 0.040755 dex, RMSE 0.050869 dex, median absolute relative error 0.084010 and RMSE skill 0.275648.

The retrospective Kp >= 5 whole-event holdout (2022-02-04 15:00–21:00 UTC) has predicted-arrival M3 RMSE 0.063665 dex and RMSE skill 0.304407 over 1,440 rows. Per-spacecraft peak aggregation gives median peak-density relative error 0.167999 and peak-timing error 139.5 min. Onset/recovery remain unavailable because no physical density threshold was defined.

Nominal generic `B=0.01 m2/kg` scenario over the held-out interval:

| Spacecraft density stream | Max derived speed [km/s] | Corrected-density cumulative delta-v [m/s] | Corrected-density along-track proxy [m] |
| --- | ---: | ---: | ---: |
| GRACE-FO 1 | 7.718 | 0.013833 | -1,237.9 |
| Swarm A | 7.706 | 0.044620 | -3,958.4 |
| Swarm B | 7.675 | 0.012415 | -1,112.4 |
| Swarm C | 7.705 | 0.044925 | -3,981.3 |

These are scenario calculations along finite-difference density-product states, not observed drag, real satellite coefficients or precise orbit determination.

## Artifacts and pages

The corrected run contains 51 files: six joblib models, 14 Parquet prediction/diagnostic files, 18 PNG plots and two interpretation JSON sidecars among the metadata. The Internal Validation surface exposes only 18 allowlisted PNGs through opaque IDs; joblib, Parquet, raw paths and raw breakdown JSON are not exposed.

Internal Console surfaces:

- `/console` → Real Time Forecast → `LEO density & drag`.
- `/console` → Data Archive → `LEO thermosphere`.
- `/console` → Validation and Studies → `LEO density & drag`.

Admin/no-store routes:

- `GET /api/console/leo/inventory`
- `GET /api/console/leo/validation`
- `GET /api/console/leo/validation/artifact?id=<opaque-id>`
- `GET /api/console/leo/forecast?group=stations&horizon_minutes=180&cadence_minutes=5`

## Tests and build

- Python full suite: 79 passed. The existing GOES network integration test also ran; one NumPy binary-compatibility runtime warning was emitted, but the test passed.
- TypeScript/Node suite: 55 passed.
- TypeScript: passed (`tsc --noEmit`).
- ESLint: zero errors; one pre-existing `@next/next/no-img-element` warning in `TopStatusBar.tsx`.
- Production build: passed with Next.js 16.2.6/webpack; all four LEO routes are dynamic.
- `git diff --check`: passed.

Route smoke tests:

- Admin bypass: console/inventory/validation/forecast returned 200; inventory exposed four available official streams plus GRACE-FO 2 unavailable; validation exposed v2, 18 plots and two events; forecast returned `partial`, real L1 forcing and null density because TLE was unavailable.
- Artifact: valid opaque ID returned 200 `image/png`, `no-store`, `nosniff` and CSP sandbox; traversal returned 404.
- Admin gate enabled: all four LEO API routes returned 403 `Admin required` with `no-store`.

## Exact reproduction

All install, discover, download/import, baseline, study, forecast and verification commands are in `docs/LEO_REPRODUCIBILITY.md`. The canonical study command is:

```bash
python scripts/run_leo_density_study.py \
  --data-root data \
  --model-root data/model-runs/leo-density \
  --run-id pilot-20220203-20220208-v2-circular \
  --bootstrap-resamples 200 \
  --random-seed 42 \
  --arrival-model data/ml-model/arrival-residual/model.joblib \
  --arrival-metrics data/console/ml_metrics.json \
  --kp-archive data/console/omni-archive.json
```

New runs refuse a non-empty run ID by default. The artifact records exact runtime versions, the Git revision, dirty status and a working-tree hash.

## Scientific limitations

- Five days/one year cannot establish seasonal, solar-cycle or rare-storm generalization.
- The predicted-arrival replay does not prove historical feed availability and currently uses MRU fallback.
- Training uses centered retrospective F10.7a; live uses trailing causal F10.7a.
- The current M3 includes mission/spacecraft categories. Every generic selected TLE is categorically OOD; numeric features are also range-checked.
- p10/p90, onset and recovery uncertainty are not calibrated.
- No neutral winds, attitude variability, manoeuvres, operator ephemerides or Level-2 drag-aware propagation.
- First-order orbital impact uses a generic ballistic coefficient and finite-difference states.
- M4/year walk-forward are unavailable with current evidence/data, although implementations and tests exist.

## Licensing

- ESA/VirES: required attribution is implemented/documented; public/commercial onward distribution still needs ESA/legal review.
- pymsis wrapper: MIT, but NRLMSIS 2.x has separate academic/non-commercial terms. Both environment and per-run acknowledgement are required; commercial/operational rights remain unresolved.
- CelesTrak/NOAA/NASA operational terms still require deployment review.

## Pending blockers

- Live: CelesTrak timed out and no real cached TLE existed. Final check still had 774 fresh SWPC/SOLAR1 samples over 12.88 hours, so the missing trajectory—not L1 forcing—prevented snapshot publication.
- Scientific: short data span, mission-specific OOD, uncalibrated uncertainty and no issuance-safe M4 input.
- Compatibility: existing arrival-residual artifact raises `ModuleNotFoundError: No module named '_loss'`; MRU fallback is recorded.
- Legal/operational: NRLMSIS commercial rights, ESA redistribution and real spacecraft parameters/ephemerides.

## Next three recommended steps

1. Ingest at least one multi-season/multi-year official corpus, train a mission-agnostic deployable candidate without spacecraft IDs, and run year/mission/storm walk-forward plus calibrated uncertainty.
2. Rebuild/version the arrival-residual model in the pinned environment and begin retaining real HelioSat feed reception snapshots so issuance availability can be replayed rather than assumed.
3. Resolve ESA/NRL deployment rights and integrate an operationally supported orbit source plus operator spacecraft parameters; then run the public-deployment checklist and a monitored snapshot scheduler.
