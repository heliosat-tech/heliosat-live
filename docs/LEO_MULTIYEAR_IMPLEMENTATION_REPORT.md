# HelioSat LEO multi-year implementation report

Completed: 2026-07-13  
Scope: authenticated Internal Console only  
Primary run: `staged-2021-2025-v1`  
Status: retrospective staged study available; experimental live code available; current live issuance unavailable because no real future TLE trajectory was obtained.

## Summary

The Internal Console now connects the existing L1-to-bow-shock pipeline to official Swarm/GRACE-FO density ingestion, a causal-by-observation-time NRLMSIS baseline, three explicitly separated arrival timelines, mission-agnostic density correction, drag/orbit-scenario infrastructure, staged multi-year validation and an experimental fail-closed live forecast contract.

The final multi-year study uses 600,441 identical five-minute rows across OMNI reference, MRU and MRU+ML modes. It persists models, metadata, calibrated predictions, checksums, code-state fingerprints and 13 scientific plots. The Internal Console successfully normalizes the real v2 artifact into three arrival modes, five transfer experiments, seven lag experiments, 24 event studies and five regime dimensions.

No public dashboard component or public API contract was changed. No synthetic fixture is exposed as an observation. Retrospective, observed, experimental, scenario and unavailable values remain distinct.

## Phases completed

| Phase | Result |
| --- | --- |
| 0 — document/repository audit | Complete; frontend, backend, auth routes, scientific scripts, dataset/model storage and trajectory system identified before implementation. |
| 1 — Internal Console structure | Complete; L1 remains the default surface, with isolated LEO tabs in Real Time, Archive and Validation. |
| 2 — canonical schema/inventory | Complete; v2 contracts, official lineage, effective coverage and explicit unavailable states. |
| 3 — official ingestion | Complete for the immutable staged plan; restartable, checksum-addressed VirES HAPI ingestion with fill/coordinate guards. |
| 4 — physical baseline | Complete for permitted research; NRLMSIS 2.1 with D−1 F10.7 and trailing 81-day F10.7a in a separate tree. |
| 5 — arrival/features | Complete; reference, causal MRU and strict MRU+ML timelines use a common feature/split contract. |
| 6 — multi-year density models | Complete for M3 plus A0–A6; year walk-forward, LOSO, Swarm→GRACE and identity diagnostics executed. |
| 7 — lag/events/uncertainty | Complete as retrospective diagnostics; fixed/distributed lags, block bootstrap, calibrated quantiles and per-spacecraft event timing. |
| 8 — drag/orbit boundary | Existing Level-1 generic scenario implementation preserved; no new orbit-accuracy claim was added to the multi-year study. |
| 9 — live experimental forecast | Code and contracts complete; the real snapshot attempt failed closed on missing future TLE trajectory and wrote no snapshot. |
| 10 — figures/UI/docs/verification | Complete; 13 multi-year plots, v2 Internal Console adapter, model card, provenance/licensing docs, tests and production build. |

## Files created or materially extended

Multi-year scientific layer:

- `leo_drag/multiyear.py`, `leo_drag/multiyear_study.py`, `leo_drag/response.py`, `leo_drag/validation.py`.
- Extended `leo_drag/{ingestion,schema,ancillary,baseline_processing,drivers,features,models,metrics,plots,forecast}.py`.
- `scripts/plan_leo_multiyear_study.py` and `scripts/run_leo_multiyear_study.py`.
- `tests/test_leo_{multiyear,multiyear_study,multiyear_validation,response,event_timing}.py`, plus extended ingestion/baseline/driver/forecast tests.

Arrival residual:

- Extended `ml/arrival_residual/{dataset,features,train}.py` and its tests.
- Rebuilt `data/console/ml_metrics.json` and `data/console/ml_data_split.json`.

Authenticated application:

- `src/app/api/console/leo/{inventory,validation,validation/artifact,forecast}/route.ts`.
- `src/components/console/leo/{LeoArchivePanel,LeoValidationPanel,LeoRealtimePanel}.tsx`.
- `src/lib/leo/{contracts,navigation}.ts` and tests.
- `src/services/leo/{leoInventoryService,leoValidationService,leoTrajectoryService,leoForecastService}.ts` and tests.
- Extended internal-only `src/components/console/ConsoleScreen.tsx`, `ConsoleSectionTabs.tsx` and `next.config.ts`.

Documentation/artifacts:

- `docs/LEO_MULTIYEAR_IMPLEMENTATION_PLAN.md`.
- `docs/LEO_MULTIYEAR_MODEL_CARD.md`.
- Updated `docs/LEO_DATA_SOURCES_AND_LICENSES.md` and `docs/LEO_REPRODUCIBILITY.md`.
- Immutable plan and lineage under `data/studies/leo-density/staged-2021-2025/`.
- This report. The earlier five-day foundation remains documented in `docs/LEO_DRAG_IMPLEMENTATION_REPORT.md` and `docs/LEO_DENSITY_MODEL_CARD.md`.

Configuration/dependencies were extended in `.env.example`, `.gitignore`, `requirements-pipeline.txt`, `requirements-pipeline.lock.txt`, `README.md` and `next.config.ts`. The public dashboard was not modified.

## Official data downloaded or imported

Immutable plan: `staged-2021-2025-9f13ff6639f5`; 20 quiet seasonal intervals, 46 moderate episodes and 23 severe episodes, merged into 53 download ranges covering 616 distinct UTC dates (588.375 exact range-days).

| Official ESA/VirES product | Entries | Raw rows | One-minute rows | Baseline OK | Baseline unavailable |
| --- | ---: | ---: | ---: | ---: | ---: |
| GRACE-FO 1 `GF_OPER_DNS1ACC_2_` | 59 | 5,083,560 | 847,260 | 836,100 | 11,160 |
| Swarm A `SW_OPER_DNSAPOD_2_` | 59 | 1,694,520 | 847,260 | 835,912 | 11,348 |
| Swarm B `SW_OPER_DNSBPOD_2_` | 59 | 1,694,520 | 847,260 | 836,100 | 11,160 |
| Swarm C `SW_OPER_DNSCPOD_2_` | 59 | 1,694,520 | 847,260 | 836,100 | 11,160 |
| Total | 236 | 10,167,120 | 3,389,040 | 3,344,212 | 44,828 |

The one historical auxiliary-fill validation error is retained in the manifest with its resolution timestamp. The second restart pass skipped all completed chunks and marked it resolved; there are no unresolved plan ingestion errors.

NASA SPDF official inputs:

- High-resolution OMNI five-minute files 2021–2025 for the density study; checksums are embedded in the summary.
- High-resolution OMNI 2021–2026 for arrival-residual training/validation.
- Low-resolution OMNI2 yearly files for NRLMSIS forcing, with per-file checksums in baseline lineage.

Approximate local disk use (`du -sk`): raw thermosphere 1,641,192 KiB; processed one-minute 276,948 KiB; causal baseline 302,500 KiB; multi-year run 73,196 KiB; arrival artifact 3,452 KiB. Manifest-tracked staged raw+processed storage is 1,911,093,546 bytes.

Key artifact SHA-256:

- `corpus-plan.v1.json`: `643a3ab581106d0cba809255f2756be25127486422d33f2d7a6fb43c7a9caf88`.
- `corpus-plan.v1.lineage.json`: `ec29e8c70a3a6afc7b59440be011062ff3e5236d7f90b7061746ead2b4e7d855`.
- `study-summary.v2.json`: `d1af6a66696306cb5a9407ddacf4ad73699e0be05691c447d9b5d94d2666f330`.
- Arrival model joblib: `ff43af09a2453553fa5dda84508a48c3c5b307b85ae41a6b97de59d5e410b5d7`.

## Data still pending

- Continuous climatological coverage and a second fully independent solar-cycle test; the present corpus is event/season staged.
- A versioned continuity/quality study before adding Swarm ACC as a primary target.
- An official GRACE-FO 2 density product; none exists in the current VirES HAPI catalog and no substitution is made.
- Historical HelioSat feed reception/publication snapshots for a strict issuance-time replay.
- Issuance-safe geomagnetic inputs for A6/M4.
- Real operator mass, area, Cd, attitude and precision ephemerides.
- A fresh supported CelesTrak/Space-Track trajectory source for live issuance.

## Models implemented and executed

- NRLMSIS 2.1 physical baseline through pymsis 0.12.0, gated for research.
- Arrival-residual v2: `HistGradientBoostingRegressor(loss="absolute_error")`, 20 causal upstream features, fixed 13.5 Rₑ bow-shock geometry, no retrospective `bsn_x_re` feature.
- Density M3: mission-agnostic `HistGradientBoostingRegressor(loss="absolute_error")` on log-density residuals, fitted separately for reference, MRU and MRU+ML on identical rows.
- A0–A6 feature-group ablations; A6/M4 remains honestly unavailable.
- Expanding-year, LOSO, cross-mission and M5 identity-only/full+identity diagnostics.
- Fixed Newell/Em lag scan and predeclared distributed 0–12 h response bins.
- Held-out signed-log-residual p10/p50/p90 calibration.
- Existing Level-1 drag/orbital-impact scenario code remains tested but was not recomputed as a new multi-year result.

The multi-year summary does not claim a complete M0–M5 suite per timing mode. M1 remains part of the pilot framework; M3 and the predeclared ablations are the executed multi-year models.

## Scientific results

Arrival-residual held-out validation (151,981 rows): MRU MAE/RMSE 12.13/16.94 min; ML 10.38/14.73 min; ML MAE is 14.4% lower. ML is worse in severe G3–G5 MAE (9.54 versus 8.84 min), so the global timing result is not universal.

Density test 2025 (144,344 rows), using the 2024-calibrated p50:

| Mode | MAE dex | RMSE dex | Median absolute relative error | RMSE skill vs M0 |
| --- | ---: | ---: | ---: | ---: |
| M0 NRLMSIS | 0.086134 | 0.107016 | — | 0% |
| MRU M3 | 0.083612 | 0.103204 | 16.96% | 3.56% |
| MRU+ML M3 | 0.082581 | 0.102076 | 16.74% | 4.62% |
| Reference M3 | 0.082439 | 0.101969 | 16.68% | 4.72% |

Every global day-block skill interval crosses zero. On uncalibrated point predictions, MRU+ML improves MRU by −0.001307 dex RMSE (95% day-block interval −0.001960 to −0.000777) and is indistinguishable from reference (−0.000146; −0.000632 to +0.000384).

The strongest physical ablation is context plus instantaneous L1 (A2), RMSE 0.100381 and 6.20% skill. Full rolling features are worse. Quiet skill is −27.59%, while moderate/severe storm skill is +24.84%/+7.15%; 67.8% of test rows are storm-labelled, so the global headline is event-dominated.

Walk-forward skill is negative in 2022/2023, positive in 2024 and approximately zero for the 2025 refit. LOSO intervals all cross zero. Swarm→GRACE duplicates the GRACE LOSO population because only one GRACE density spacecraft exists.

The nominal 80% MRU+ML interval covers 85.62%; observations fall below p10/p50/p90 at 4.45%/58.15%/90.07%, with 66.35% median relative width. It is conservative and p50 is biased high.

Validation selects Newell 5 h and Em 6.5 h on only 34,413 test rows; the distributed-lag model is worse than M0. For 24 held-out events, median peak timing error is 63.75 min and peak magnitude error 17.13%; onset/recovery are available for only 14/15 events and lack event-bootstrap confidence intervals.

The defensible current finding is that instantaneous L1 adds signal during the staged storm sample. The study does not establish robust global, quiet-regime, temporal-transfer or operational forecast skill.

## Artifacts, pages and routes

The run directory contains 23 files: three joblib models, three metadata sidecars, three test-prediction Parquets, 13 PNG figures and the v2 summary. Figures cover baseline/corrected density, scatter/residuals, orbit/mission/storm regimes, ablation, coupling response, fixed-lag scan, uncertainty, arrival-mode comparison and three severe-event windows.

Authenticated Internal Console page: `/console`, with LEO surfaces under Real Time Forecast, Data Archive and Validation and Studies.

Admin-only, `no-store` routes:

- `GET /api/console/leo/inventory`
- `GET /api/console/leo/validation`
- `GET /api/console/leo/validation/artifact?id=<opaque-id>`
- `GET /api/console/leo/forecast?group=stations&horizon_minutes=180&cadence_minutes=5`

The real v2 adapter check returned `available`, the correct 2021-04-28 → 2025-12-16 coverage, all three arrival modes, 24 events, 13 allowlisted plots and no warnings.

## Exact reproduction commands

```bash
npm ci
python3 -m pip install -r requirements-pipeline.lock.txt

python3 -m ml.arrival_residual.train --max-iter 400

python3 scripts/plan_leo_multiyear_study.py \
  --data-root data \
  --kp-archive data/console/omni-archive.json \
  --start-year 2021 \
  --stop-year 2025 \
  --output data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json

python3 scripts/run_leo_multiyear_study.py \
  --plan data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json \
  --data-root data ingest --chunk-days 14

HELIOSAT_ENABLE_NRLMSIS_RESEARCH=true \
python3 scripts/run_leo_multiyear_study.py \
  --plan data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json \
  --data-root data baseline \
  --acknowledge-research-license

python3 scripts/run_leo_multiyear_study.py \
  --plan data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json \
  --data-root data study \
  --model-root data/model-runs/leo-density \
  --run-id staged-2021-2025-reproduction-v1 \
  --arrival-model data/ml-model/arrival-residual/model.joblib \
  --arrival-metrics data/console/ml_metrics.json \
  --bootstrap-resamples 200 \
  --random-seed 42

HELIOSAT_ENABLE_NRLMSIS_RESEARCH=true \
python3 scripts/generate_leo_forecast_snapshot.py \
  --data-root data \
  --model-root data/model-runs/leo-density \
  --group stations \
  --horizon-minutes 180 \
  --cadence-minutes 5 \
  --scenario nominal \
  --acknowledge-nrlmsis-research-license
```

Use a new immutable run ID for reproduction. The reported `staged-2021-2025-v1` was regenerated locally with `--overwrite-run` only while finalizing this implementation; routine reproduction must not overwrite it.

Verification:

```bash
python3 -m pytest -q
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

## Tests and build

- Python: 110 passed in 18.22 s. One existing GOES/NCEI test emitted a NumPy ABI runtime warning but passed.
- Node/TypeScript: 64 passed.
- ESLint: 0 errors, one pre-existing `no-img-element` warning in `TopStatusBar.tsx`.
- TypeScript `tsc --noEmit`: passed.
- Next.js 16.2.6 production webpack build: passed; all four LEO routes are dynamic.
- `git diff --check`: passed.
- Experimental live attempt: `unavailable`, `real future TLE trajectory is unavailable`, `snapshot_written=false`.

## Scientific limitations

- Staged/discontinuous sampling and strong storm enrichment; no continuous climatological claim.
- No robust global skill interval, severe quiet-regime degradation and temporal non-stationarity.
- MRU+ML arrival artifact trains through 2026, so density year folds are retrospective replay rather than strict historical issuance tests.
- Common-mode intersection can bias evaluation toward rows where every timing mode is available.
- Persistent spacecraft/product identity offsets exceed the physical-model gain.
- No conditional uncertainty intervals or bootstrap confidence intervals for event timing/ablations.
- Lag selection lacks an exactly matched context-only control and uses a subset of test rows.
- No neutral winds, attitude/manoeuvres, operator precision ephemerides or validated real ballistic coefficients.
- No new multi-year drag/orbital-impact validation; Level-1 values remain generic scenarios only.

## Licensing problems

- ESA/VirES attribution and internal handling are implemented, but raw onward redistribution and commercial/customer deployment require ESA/legal review.
- pymsis is MIT; NRLMSIS 2.x has separate academic/non-commercial terms. Commercial/operational authorization remains unresolved.
- NASA SPDF data are handled under the current SPDF data-use/citation policy and retain checksums/attribution.
- NOAA near-real-time products are preliminary, revision-prone public information with no accuracy warranty.
- CelesTrak/Space-Track redistribution history is non-trivial; public/commercial caching or redistribution remains pending explicit review.

## Pending blockers

- Operational/live: no real future TLE trajectory from the current CelesTrak attempt; no snapshot was written.
- Scientific: quiet performance, non-stationarity, uncertain independent transfer, issuance-history gaps and missing spacecraft calibration.
- Legal: NRLMSIS commercial rights, ESA onward redistribution and CelesTrak/Space-Track deployment terms.
- Public release: every deployment gate remains blocked; the public dashboard correctly remains unchanged.

## Next three recommended steps

1. Build a continuous, versioned quiet-plus-storm corpus and calibrate spacecraft/product offsets with hierarchical or per-product methods, then repeat pre-registered year/mission tests.
2. Begin archiving real HelioSat reception timestamps and use an operationally supported orbit source plus operator spacecraft parameters for a prospective shadow forecast with monitored failures.
3. Resolve ESA/NRLMSIS/CelesTrak rights, then run conditional uncertainty/event bootstrap and quiet-regime acceptance gates before considering any public surface.
