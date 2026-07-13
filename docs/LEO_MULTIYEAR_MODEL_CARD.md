# Model card: HelioSat staged multi-year LEO density M3

Run: `staged-2021-2025-v1`  
Study schema: `leo-density-study-summary-v2`  
Status: retrospective staged research; not operational; public deployment blocked.

## Intended use and claim boundary

This study tests whether HelioSat's L1-to-bow-shock pipeline can improve an NRLMSIS 2.1 density baseline after causal MRU or MRU+ML solar-wind propagation. It is intended for authenticated research, ablation, transfer and storm-response analysis.

It is not approved for precise orbit determination, collision avoidance, manoeuvre decisions, customer/public forecasts or inference of real spacecraft mass, area, drag coefficient or attitude. The run does not recompute or validate higher-order orbital impact; the earlier Level-1 generic drag scenarios remain separate pilot evidence.

## Official observations and split

- ESA/VirES products: Swarm A/B/C POD density and GRACE-FO 1 accelerometer density.
- Staged event/season coverage: 2021-04-28 through 2025-12-16, 606 distinct UTC days; this is not continuous climatology.
- Common population: 600,441 exact five-minute rows, with no interpolation, shared by all three arrival modes.
- Spacecraft: `Swarm:A`, `Swarm:B`, `Swarm:C`, `GRACE-FO:1`.
- Fixed roles: 167,739 rows train (2021–2022), 132,473 validation (2023), 155,885 calibration (2024), 144,344 test (2025).
- Test composition: 46,474 quiet, 57,849 moderate-storm and 40,021 severe-storm rows.
- Baseline: NRLMSIS 2.1 through pymsis 0.12.0, previous-day F10.7 and trailing 81-day F10.7a ending at D−1.

The three M3 fits use the same comparison rows, split hashes, features, estimator hyperparameters and seed. Mission and spacecraft identity are forbidden from M3 and retained only for explicitly non-deployable diagnostics.

## Model and timing variants

M3 is a `HistGradientBoostingRegressor(loss="absolute_error")` over the natural-log density residual `ln(rho_observed) - ln(rho_NRLMSIS)`. Density metrics labelled dex are evaluated in log10 space.

Three timing modes are kept separate:

1. OMNI reference alignment: retrospective response reference; never deployable.
2. HelioSat MRU: propagation from measured spacecraft position to a fixed 13.5 Rₑ bow-shock nose.
3. HelioSat MRU+ML: the same causal geometry plus arrival-residual artifact `arrival-residual-v2-a898ef84a1a4b53d`.

The arrival artifact uses official five-minute OMNI 2021–2026, trains through 2024-10-04 and validates through 2026-04-30. Consequently the density walk-forward folds do not constitute a strict historical year-forward test of arrival ML. The saved study includes the artifact path, SHA-256, schema/model versions, train/validation ranges, geometry and source checksums.

## Held-out 2025 performance

Headline M3 metrics use the 2024-calibrated p50. M0 is the unchanged NRLMSIS baseline.

| Mode | MAE dex | RMSE dex | Median absolute relative error | RMSE skill vs M0 |
| --- | ---: | ---: | ---: | ---: |
| M0 | 0.086134 | 0.107016 | — | 0% |
| MRU M3 | 0.083612 | 0.103204 | 16.96% | 3.56% |
| MRU+ML M3 | 0.082581 | 0.102076 | 16.74% | 4.62% |
| Reference-aligned M3 | 0.082439 | 0.101969 | 16.68% | 4.72% |

All three day-block bootstrap confidence intervals for global RMSE skill cross zero. Therefore no global improvement over M0 is statistically robust in this staged sample.

Arrival-mode deltas intentionally use the uncalibrated point prediction so that mode-specific p50 bias corrections do not confound timing:

- MRU is worse than reference by 0.001162 dex RMSE; day-block 95% interval 0.000533 to 0.002076.
- MRU+ML improves MRU by 0.001307 dex; interval 0.000777 to 0.001960 in magnitude.
- MRU+ML and reference are indistinguishable: delta −0.000146 dex, interval −0.000632 to 0.000384.

The comparison shows a detectable ML improvement over MRU in this replay, not operational arrival-time truth.

## Ablation and identity findings

The multi-year run publishes M3 per timing mode and A0–A6 ablations on the primary MRU+ML timeline. It does **not** claim a complete M0–M5 fit for every timing mode. M1 is available in the pilot framework but was not fitted here; A6/M4 is unavailable because no geomagnetic feature has proven issuance-safe timestamps.

| Ablation | RMSE dex | RMSE skill vs M0 |
| --- | ---: | ---: |
| A0 baseline | 0.107016 | 0% |
| A1 context | 0.104939 | 1.94% |
| A2 context + instantaneous L1 | 0.100381 | 6.20% |
| A3 context + rolling L1 | 0.104041 | 2.78% |
| A4 context + integrated coupling | 0.102493 | 4.23% |
| A5 full causal M3 | 0.102350 | 4.36% |

A2 is the best physical ablation; the large rolling feature set does not improve it. Identity-only reaches RMSE 0.094631 and 11.57% skill, stronger than the causal model. This is correctly non-deployable and signals persistent spacecraft/product offsets that require calibration or hierarchical treatment.

## Generalization and regimes

Expanding-year MRU+ML RMSE skill is −3.61% (2022), −12.22% (2023), +5.43% (2024) and approximately 0.005% (2025). This is strong evidence of temporal non-stationarity.

LOSO skills range from 1.25% to 6.02%, but every 95% interval crosses zero and median density ratios are 1.10–1.12. Swarm-to-GRACE-FO is numerically identical to holding out the only GRACE-FO spacecraft and is not independent evidence.

In 2025, MRU+ML skill is +24.84% for moderate storms and +7.15% for severe storms, but −27.59% for quiet rows. Dawn, day and high-latitude subsets are also slightly worse than M0. Because 67.8% of test rows are storm-labelled, the global headline is event-sample dominated.

## Uncertainty, lag and events

The held-out p10–p90 interval covers 85.62% versus 80% nominal. Observations fall below p10/p50/p90 at 4.45%/58.15%/90.07%; the interval is conservative and p50 is biased high. Median relative width is 66.35%. The calibrated p50 worsens RMSE from 0.100985 to 0.102076 compared with the raw point estimate.

Validation-only lag selection chooses 5 h for Newell coupling and 6.5 h for Em, but evaluates only 34,413 test rows and lacks a context-only control on exactly those rows. The distributed-lag model is worse than M0 (RMSE 0.109154). These diagnostics suggest multi-hour response but do not identify a robust physical lag.

For 24 held-out 2025 events (96 spacecraft-event records), hierarchical median absolute errors are 63.75 min for peak timing and 17.13% for peak magnitude. Onset is 318.75 min for 14 available events; recovery is 415 min for 15. The threshold is the declared `rho/NRLMSIS >= 1.2`, not an independently estimated quiet physical onset. Event-timing confidence intervals are not yet published.

## Deployment decision

- Authenticated retrospective study: available.
- Experimental live artifact: technically loadable only for MRU+ML and only when every real source and range gate succeeds; not scientifically operational.
- Public/operational deployment: blocked by non-stationarity, quiet-regime degradation, uncertain transfer, arrival replay limitations, missing real spacecraft parameters and unresolved ESA/NRLMSIS/CelesTrak terms.

Exact lineage and machine-readable metrics are in `data/model-runs/leo-density/staged-2021-2025-v1/study-summary.v2.json`. Reproduction commands are in `docs/LEO_REPRODUCIBILITY.md`.
