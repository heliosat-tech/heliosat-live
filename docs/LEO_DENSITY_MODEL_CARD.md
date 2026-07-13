# Model card: HelioSat LEO density pilot M3

Model version: `m3-pilot-20220203-20220208-v2-circular`  
Artifact schema: `leo-density-model-artifact-v1`  
Status: research pilot; not operational; not approved for the public dashboard.

## Intended use

M3 estimates a thermospheric log-density residual over NRLMSIS 2.1 for authenticated HelioSat research. It is intended to test whether causal L1 solar-wind information propagated by the current HelioSat pipeline improves a physical atmosphere baseline, and to drive generic first-order drag sensitivity studies.

It is not intended for precise orbit determination, collision avoidance, manoeuvre decisions, public/customer forecasts or inference of real spacecraft mass/area/attitude.

## Training data and split

- Observations: official ESA/VirES Swarm A/B/C POD density and GRACE-FO 1 ACC density.
- Coverage: 2022-02-03 through 2022-02-07 inclusive.
- Processed cadence: one-minute medians, 28,800 rows before driver matching.
- Baseline: NRLMSIS 2.1 via pymsis 0.12.0 with explicit retrospective NASA OMNI2 forcing.
- Primary deployability experiment: `heliosat_predicted_arrival`; current arrival residual artifact was incompatible, so its timing is MRU-only.
- Held-out test: 11,504 matched rows, 2022-02-06 00:04 through 2022-02-07 23:59 UTC.
- Validated pilot altitude range: 427.012 to 532.050 km.
- Missions seen: Swarm and GRACE-FO; spacecraft A/B/C/1.

The estimator is a scikit-learn `HistGradientBoostingRegressor(loss="absolute_error")` inside a fitted preprocessing pipeline. Features include orbital/solar context, log baseline density, current propagated drivers and strictly trailing driver statistics. The fitted target is `ln(rho_observed) - ln(rho_baseline)`; evaluation metrics are reported in log10 density where labelled dex.

## Held-out pilot results

All entries below use the same chronological test rows. Skill is `1 - RMSE_model / RMSE_M0`; negative values are worse than M0.

| End-to-end model | MAE log10 [dex] | RMSE log10 [dex] | Median absolute relative error | RMSE skill vs M0 |
| --- | ---: | ---: | ---: | ---: |
| M0 physical baseline | 0.058869 | 0.070195 | 0.130831 | 0.000000 |
| M1 linear correction | 0.093941 | 0.103396 | 0.246653 | -0.472995 |
| M2 tree/context | 0.079684 | 0.090105 | 0.200654 | -0.283646 |
| M3 context + causal L1 | 0.037934 | 0.047976 | 0.074840 | 0.316523 |
| M4 + safe ground indices | unavailable | unavailable | unavailable | unavailable |

The separate retrospective reference-aligned M3 result is MAE 0.040755 dex, RMSE 0.050869 dex and RMSE skill 0.275648. It is a response diagnostic and is not substituted for the predicted-arrival replay.

A whole-event holdout for the retrospective Kp >= 5 interval 2022-02-04 15:00–21:00 UTC produced predicted-arrival M3 RMSE 0.063665 dex and RMSE skill 0.304407 versus M0 across 1,440 mission/spacecraft rows. Event peaks are computed per spacecraft. This is an additional retrospective diagnostic, not the primary chronological split.

## Drag scenario result boundary

Retrospective M3 densities were translated with the generic nominal `B=0.01 m2/kg` scenario. The resulting drag acceleration and cumulative delta-v numbers are scenario sensitivities. They are not observations of drag and are not estimates using real spacecraft geometry. Density-product geodetic positions were finite-differenced and therefore do not constitute precise ephemerides.

## Known limitations

- Only five days and one year are represented; seasonal, solar-cycle and rare-storm generalization are untested.
- The test interval has few independent UTC-day blocks, so bootstrap intervals remain pilot estimates.
- Current live F10.7a is causal trailing; training used a centered retrospective mean. This creates a baseline-distribution mismatch.
- The predicted-arrival experiment is a retrospective OMNI replay that assumes source-time availability; it is not a historical replay of received HelioSat feed snapshots.
- Arrival-residual ML did not load in the current scikit-learn runtime; end-to-end timing used explicit MRU fallback.
- M4 is unavailable because the ground geomagnetic archive lacks proven per-value issuance timestamps.
- p10/p90 live uncertainty is not calibrated and is emitted as null.
- Neutral winds, attitude variation, manoeuvres and operator ephemerides are absent.
- Predictions outside 427.012–532.050 km, with unseen mission/spacecraft categories, or beyond fitted numeric-feature ranges are out of distribution. A generic TLE is categorically OOD for this artifact.
- NRLMSIS 2.x commercial/onward-distribution rights are unresolved.

## Reproducibility and lineage

The versioned local run is `data/model-runs/leo-density/pilot-20220203-20220208-v2-circular/`. New runs refuse a non-empty run ID unless replacement is explicitly acknowledged. `study-summary.v1.json` contains checksums, split dates, metrics, artifacts, event-label lineage, exact runtime versions and a hash of the dirty working-tree state; each joblib stores its feature list, dataset version/hash, fitted feature ranges/categories and preprocessing. Exact commands are in `docs/LEO_REPRODUCIBILITY.md`.

## Deployment decision

Internal retrospective study: allowed with the research-license gate.  
Internal experimental point forecast: allowed only when every real input is available and with OOD/assumption warnings.  
Public or operational deployment: blocked pending multi-season validation, calibrated uncertainty, compatible arrival artifact, spacecraft parameters and legal review.
