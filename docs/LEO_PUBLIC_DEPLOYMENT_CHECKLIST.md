# LEO public and operational deployment checklist

Current decision: **blocked**. The implemented module is restricted to the authenticated Internal Console.

## Data and legal

- [ ] ESA confirms intended commercial use and onward distribution of Swarm/GRACE-FO-derived information.
- [ ] Required ESA attribution/copyright notices have legal approval for every target surface.
- [ ] NRL grants the required NRLMSIS 2.x commercial/operational rights, or the baseline is replaced and revalidated.
- [ ] Terms and availability for live CelesTrak, NOAA and NASA sources are reviewed for the deployment architecture.
- [ ] Raw official source data remains access-controlled and is not mirrored through public endpoints.

## Scientific validation

- [ ] At least a multi-season, multi-year dataset supports year walk-forward evaluation.
- [ ] Quiet, moderate and rare severe-storm samples are adequately represented.
- [ ] M3 retains positive held-out skill over M0 across years, missions, altitude, latitude and local-time regimes.
- [ ] End-to-end arrival timing uses a compatible, versioned and independently validated artifact.
- [ ] Live trailing-F10.7a/baseline behavior is trained and validated without retrospective centered-mean leakage.
- [ ] Forecast p10/p50/p90 intervals are calibrated on issuance-realistic holdouts and pass coverage tests.
- [ ] Onset, peak and recovery timing metrics are defined and validated per spacecraft.
- [ ] Out-of-distribution rules cover altitude, mission, solar regime, source freshness and model age.

## Orbit and spacecraft physics

- [ ] Operator ephemerides or an approved orbit source replace density-product finite differences for impact validation.
- [ ] Mass, reference area, Cd, attitude/area mode and uncertainty come from an authorized source.
- [ ] Neutral winds and attitude variability are modeled or bounded.
- [ ] A higher-fidelity orbit propagator validates Level-1 delta-v/along-track approximations.
- [ ] Manoeuvres and stale/invalid TLEs are detected and handled.

## Operations and reliability

- [ ] A monitored scheduler produces signed/versioned forecast snapshots before their freshness deadline.
- [ ] CelesTrak, NOAA, NASA, L1 and model-artifact failure modes have alarms and runbooks.
- [ ] Provenance/checksums, issuance time, input availability and assumption boundary are immutable per forecast.
- [ ] Backfill/replay reproduces a historical issuance without accessing future data.
- [ ] Latency, availability and load tests pass in the target environment.
- [ ] Model/data rollback and artifact retention policies are defined.

## Product and governance

- [ ] Scientific review approves claim wording and prohibits conjunction/POD use.
- [ ] Independent review signs off leakage controls, metrics and uncertainty.
- [ ] Security review approves admin/public authorization boundaries.
- [ ] Public API versioning and rate limits are designed; no Internal Console contract is exposed accidentally.
- [ ] Monitoring identifies whether each value is observed, retrospective, experimental or scenario-based.
- [ ] Human owner, review cadence and retirement criteria are assigned.

Until every applicable item is complete, keep the LEO module internal and label it “Research model, not operational.”
