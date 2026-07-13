# HelioSat internal research module: LEO thermospheric density and drag

## How to use this document

Place this file in the repository root. Then give Codex this instruction:

> Read `HELIOSAT_CODEX_LEO_DRAG_IMPLEMENTATION.md` completely before changing any code. Inspect the existing repository, architecture, routes, data pipelines, styling system, authentication and scientific scripts. Then implement the work in the phases described below. Preserve all current L1 to bow shock functionality. Continue autonomously through the phases without waiting for confirmation, unless access credentials, external data permissions or a licensing issue make a phase impossible. Never fabricate scientific data or present test fixtures as observations.

## 1. Project context

HelioSat currently has two product surfaces.

### Public dashboard

The public dashboard shows:

- Current solar wind and IMF observations at L1
- Forecast propagation from L1 to the Earth bow shock
- Estimated geomagnetic severity
- NOAA alerts
- A three dimensional Earth and satellite orbit view
- A list of user selected satellites
- A satellite operator report panel

### Authenticated internal console

The internal console is the research and validation environment. It currently contains:

- Real Time Forecast
- Data Archive
- Validation and Studies

The current scientific pipeline includes:

- Historical and live L1 solar wind ingestion
- Ballistic propagation from L1 to the Earth bow shock
- An ML residual correction for arrival time
- Historical ACE and OMNI archives
- Validation of arrival time and propagated variables
- Experimental geomagnetic severity estimates
- GOES context when available

The new module must extend the current work into LEO without replacing or weakening the existing pipeline.

## 2. Main objective

Build an internal research module that predicts thermospheric mass density along a LEO satellite trajectory, converts that density into expected drag acceleration, and estimates a first order orbital impact.

The scientific chain is:

\[
\text{L1 solar wind}
\rightarrow
\text{predicted arrival at the Earth bow shock}
\rightarrow
\text{causal magnetosphere coupling proxies}
\rightarrow
\text{thermospheric density}
\rightarrow
\text{drag acceleration}
\rightarrow
\text{orbital impact estimate}
\]

The primary research question is:

> Does a physics informed model using solar wind measured at L1 and propagated by HelioSat improve thermospheric density forecasts over a standard empirical atmosphere baseline?

The secondary product question is:

> Can the density forecast be translated into a useful and transparent drag advisory for a selected LEO satellite or operator defined spacecraft scenario?

## 3. Scientific scope decision

Do not attempt to build a complete first principles magnetosphere and thermosphere simulation in the first implementation.

Do not model magnetospheric energy deposition as a fully independent physical state unless the repository already contains a validated implementation.

Represent the coupling between the solar wind, magnetosphere and thermosphere with interpretable causal features:

- Dynamic pressure
- Southward IMF
- \(E_m\)
- Newell coupling
- Optional epsilon coupling
- Rolling means, minima, maxima and standard deviations
- Time integrated coupling over several causal windows
- Time since shock or threshold crossing
- Geomagnetic history that was genuinely available at forecast issuance time

Use these variables to correct a physical or empirical atmospheric density baseline.

The recommended model form is:

\[
y =
\log \rho_{\mathrm{obs}}
-
\log \rho_{\mathrm{baseline}}
\]

\[
\widehat{\log \rho}
=
\log \rho_{\mathrm{baseline}}
+
f_{\mathrm{ML}}(x)
\]

This keeps the result interpretable and follows the existing HelioSat pattern of a transparent baseline plus a learned residual correction.

## 4. Product and navigation changes

Preserve the current left navigation:

- Real Time Forecast
- Data Archive
- Validation and Studies

Add page level tabs inside each section.

### 4.1 Real Time Forecast

Add two tabs:

1. `L1 to Bow Shock`
2. `LEO Density and Drag`

The first tab must preserve the current page and behavior.

The second tab must initially be marked:

`Research model, not operational`

### 4.2 Data Archive

Add two tabs or clear internal subsections:

1. `L1 and Bow Shock`
2. `Thermosphere and LEO`

The L1 subsection preserves the existing ACE and OMNI inventory.

The Thermosphere and LEO subsection must support:

- Swarm density products
- GRACE FO density products
- Raw file inventory
- Processed Parquet inventory
- Mission, spacecraft and product identifiers
- Coverage timeline
- Row count
- Local storage size
- Last successful ingestion
- Data quality summary
- Download or import status
- Processing status
- Error log
- Data lineage

### 4.3 Validation and Studies

Add two tabs:

1. `L1 Arrival Time`
2. `Thermospheric Density and Drag`

The first tab preserves the existing arrival time study.

The second tab contains the complete new scientific study.

Use the existing design system, typography, spacing, borders, cards and chart style. Do not redesign the internal console.

## 5. Data sources and ingestion

### 5.1 Initial density targets

Support these official product families through configurable adapters:

- Swarm `SW_DNSxPOD_2_`
- Swarm `SW_DNSxACC_2_`, where available and scientifically usable
- GRACE FO `GF_DNSxACC_2_`

Start with Swarm and GRACE FO only.

Do not add CHAMP, GRACE or GOCE until the initial pipeline works end to end.

### 5.2 Download rules

Before implementing a remote downloader:

- Verify the official source and current access method
- Do not invent endpoints
- Do not scrape an interactive page when an official API, FTP service or downloadable archive exists
- Respect rate limits and terms of use
- Store source metadata and product version
- Save checksums when possible
- Make ingestion restartable
- Make ingestion idempotent
- Keep raw data separate from processed data
- Never commit large raw datasets to Git

If unattended download is not possible, implement:

- A documented manual import path
- A strict expected directory structure
- A file validator
- A parser
- A local data inventory
- Clear UI status explaining what is missing

### 5.3 Canonical raw density schema

Normalize all missions to a canonical table with at least:

```text
timestamp_utc
mission
spacecraft_id
source_product
source_version
latitude_deg
longitude_deg
altitude_km
local_solar_time_h
rho_obs_kg_m3
rho_uncertainty_kg_m3
quality_flag
orbit_direction
source_file
ingested_at_utc
```

Preserve additional mission specific variables in a namespaced structure or separate table.

### 5.4 Storage layout

Use the repository's existing storage conventions. If no suitable convention exists, use partitioned Parquet:

```text
data/
  raw/
    thermosphere/
      swarm/
      grace_fo/
  processed/
    thermosphere/
      mission=<mission>/
        year=<year>/
          month=<month>/
```

Create a machine readable manifest with:

- Source
- Product
- Version
- File
- Checksum
- Time coverage
- Row count
- Processing status
- Schema version

### 5.5 Temporal normalization

Preserve native cadence in raw storage.

Create a configurable processed cadence, initially one minute, using scientifically appropriate aggregation:

- Median density inside each bin
- Mean position only when the bin is short enough
- Quality flags propagated conservatively
- No interpolation through long gaps
- Gap duration stored explicitly

All timestamps must be UTC.

## 6. Atmospheric baseline

Create a replaceable interface:

```text
AtmosphereBaseline
  predict_density(inputs) -> density and metadata
```

Implement an internal research baseline using NRLMSIS through an appropriate Python wrapper if licensing and installation permit.

The interface must allow a later replacement by another baseline such as DTM2020 or another licensed model.

The baseline input set should include:

- UTC time
- Geodetic latitude
- Geodetic longitude
- Geodetic altitude
- Local solar time when required
- Daily F10.7
- 81 day F10.7 average
- Geomagnetic activity input required by the selected baseline

Store:

```text
rho_baseline_kg_m3
baseline_model_name
baseline_model_version
baseline_input_status
```

Important licensing rule:

- Treat NRLMSIS 2.x as internal research software until commercial licensing has been reviewed
- Do not expose a public commercial product that depends on a model with unresolved commercial use restrictions
- Keep the baseline abstraction modular so another model can be substituted

## 7. Solar wind and coupling features

Reuse the current HelioSat L1 and bow shock pipeline.

Create a bow shock time indexed driver table containing:

```text
arrival_time_bow_shock_utc
source_measurement_time_l1_utc
arrival_model
arrival_uncertainty_min
vsw_km_s
np_cm3
bx_gsm_nt
by_gsm_nt
bz_gsm_nt
bmag_nt
pdyn_npa
em_mv_m
newell_coupling
epsilon_coupling
```

Calculate causal rolling features over configurable windows:

- 15 minutes
- 30 minutes
- 1 hour
- 3 hours
- 6 hours
- 12 hours

Include:

- Mean
- Minimum
- Maximum
- Standard deviation
- Linear trend
- Time integral
- Time since threshold crossing

Examples:

```text
bz_min_1h_nt
pdyn_max_3h_npa
newell_integral_3h
em_integral_6h
vsw_mean_6h_km_s
time_since_bz_below_minus_10_min
```

No future sample may enter a feature.

## 8. Two scientific input timelines

Implement two parallel experiment modes.

### 8.1 Response model experiment

Use the best available historical bow shock aligned reference, such as OMNI shifted inputs.

Purpose:

- Isolate the thermospheric response model
- Measure how well upstream drivers explain density once arrival alignment is treated as known
- Establish an upper bound for the end to end system

Label this mode clearly:

`Reference aligned response study`

### 8.2 End to end HelioSat experiment

Use the arrival time produced by the current HelioSat MRU plus ML model.

Purpose:

- Measure the real end to end performance
- Include propagation timing error
- Match the future live pipeline

Label this mode clearly:

`HelioSat predicted arrival study`

Never mix the two modes in a single headline metric.

## 9. Feature dataset

For every density observation, join:

### Orbital and geophysical context

- Altitude
- Latitude
- Longitude encoded cyclically
- Local solar time encoded cyclically
- Day of year encoded cyclically
- Mission
- Spacecraft
- Orbit direction

### Solar activity

- Daily F10.7
- 81 day F10.7 average
- Other existing solar proxies only if their availability is documented

### Baseline atmosphere

- Baseline density
- Baseline metadata

### Causal bow shock drivers

- Instantaneous propagated drivers
- Rolling statistics
- Time integrals
- Shock and threshold features
- Arrival uncertainty

### Optional geomagnetic context

Separate features by operational validity.

Use these labels:

- `available_at_issuance`
- `delayed_nowcast`
- `retrospective_only`

Do not use a retrospective ground index as an operational input without explicitly accounting for its publication delay.

## 10. Models and experiments

Implement the following models on exactly matched rows.

### M0: empirical atmosphere baseline

\[
\hat{\rho} = \rho_{\mathrm{baseline}}
\]

### M1: baseline plus simple linear residual correction

Use a regularized linear model on log density residual.

Purpose:

- Interpretability
- Sanity check
- Linear benchmark

### M2: baseline plus tree based residual correction

Use the repository's existing scikit learn approach where practical, preferably a histogram based gradient boosted regressor.

Target:

\[
\log \rho_{\mathrm{obs}} - \log \rho_{\mathrm{baseline}}
\]

Use an absolute error or robust loss.

### M3: baseline plus L1 drivers without ground response indices

This is the main operational candidate.

### M4: baseline plus L1 drivers and genuinely available geomagnetic history

This tests whether current or delayed ground response adds useful skill.

### M5: retrospective diagnostic model

May include contemporaneous indices only as a scientific upper bound.

It must never be shown as a deployable forecast.

Do not add a neural network until M0 to M4 are complete and validated.

## 11. Training and validation rules

### 11.1 Splits

Use chronological splits only.

Also implement:

- Year by year walk forward validation
- Entire storm event holdout
- Per mission evaluation
- Cross mission transfer evaluation when possible

No random row level split is acceptable as the headline result.

### 11.2 Leakage controls

Add automated checks that:

- No target density enters features
- No future timestamp enters rolling windows
- No future geomagnetic index enters a forecast
- Data from the held out interval is not used for imputation, scaling or feature selection
- Mission metadata does not accidentally encode the target time period
- Forecast issuance time and data availability time are stored separately

### 11.3 Metrics for density

Report at least:

- MAE of \(\log_{10}\rho\)
- RMSE of \(\log_{10}\rho\)
- Median absolute relative error
- Density ratio error
- Bias
- Correlation
- Skill relative to M0
- Peak density error during storms
- Peak timing error
- Onset timing error
- Recovery timing error

Break metrics down by:

- Mission
- Spacecraft
- Altitude
- Latitude band
- Local solar time
- Solar activity
- Geomagnetic regime
- Quiet and storm intervals

Use event or day block bootstrap confidence intervals.

### 11.4 Required scientific plots

Implement plots for:

- Observed versus baseline density
- Observed versus corrected density
- Time series for selected storms
- Density residual distribution
- Predicted versus observed scatter
- Error by altitude
- Error by latitude
- Error by local solar time
- Error by mission
- Error by storm regime
- Feature importance
- Partial dependence or another interpretable response plot
- Coupling to density lag analysis
- Reference aligned versus end to end performance

## 12. Drag model

Define the ballistic coefficient convention explicitly:

\[
B = \frac{C_D A}{m}
\]

Calculate scalar drag acceleration:

\[
a_D =
\frac{1}{2}
\rho
\frac{C_D A}{m}
v_{\mathrm{rel}}^2
\]

The drag vector is opposite the air relative velocity.

### 12.1 Spacecraft parameters

Support:

- Mass in kg
- Reference area in square metres
- Drag coefficient
- Optional direct ballistic coefficient
- Attitude or area mode
- Parameter source
- Parameter uncertainty

If the operator has not supplied real parameters, use clearly labeled scenarios:

- Low ballistic coefficient
- Nominal ballistic coefficient
- High ballistic coefficient

Never present a scenario as a property of the real satellite.

### 12.2 Relative velocity

For the first implementation:

- Include atmospheric co rotation with Earth
- Use the current orbit state from the existing satellite trajectory system
- Ignore detailed neutral winds unless a validated wind model is added
- Surface this assumption in the UI and metadata

### 12.3 Drag outputs

Calculate:

- Instantaneous drag acceleration
- Forecast p10, p50 and p90 when uncertainty is available
- Density enhancement relative to baseline or quiet reference
- Cumulative drag delta v
- First order along track displacement proxy
- Optional semi major axis change estimate

The first order orbital impact must be labeled as an estimate, not precise orbit determination.

## 13. Orbital impact implementation

Implement two levels.

### Level 1: scientific MVP

Use the existing trajectory points and integrate predicted drag acceleration along the trajectory.

Output:

- Cumulative delta v
- Cumulative drag impulse per unit mass
- First order along track displacement
- Comparison with baseline atmosphere

### Level 2: optional extension

If the repository already has a suitable numerical propagator, add two trajectories:

- Baseline density trajectory
- Corrected density trajectory

Do not introduce a large orbital dynamics dependency only for a visual demo.

Do not claim conjunction quality orbit prediction without operator ephemerides, attitude history and calibrated ballistic parameters.

## 14. Real time LEO forecast logic

The live density model must use:

- Past bow shock arrived drivers
- Solar wind parcels already measured at L1 and still inbound
- Their predicted bow shock arrival times
- Current orbital state or future trajectory
- Solar activity inputs
- The trained residual density model
- A versioned uncertainty model

Separate the forecast into:

### Confirmed inbound forcing

Based on solar wind already measured at L1.

### Assumption based extension

Beyond the known inbound queue, use a documented persistence or climatology assumption.

Visually separate these intervals. Do not imply that L1 provides a full day of upstream solar wind knowledge.

Calculate:

\[
t_{\mathrm{density\ onset}}
=
t_{\mathrm{bow\ shock\ arrival}}
+
\hat{\tau}_{\mathrm{thermosphere}}
\]

The thermospheric lag can be represented initially by distributed lag features instead of a single fixed delay.

## 15. Real Time Forecast UI for LEO

Create a page consistent with the current console.

### Header

Show:

- Model status
- Generated at UTC
- Selected spacecraft or scenario
- Forecast horizon
- Data source health
- Model version
- Validated altitude range
- Out of distribution warning

### Main cards

Show:

- Predicted density at current position
- Baseline density
- Density enhancement ratio
- Drag acceleration
- Cumulative delta v
- First order along track displacement
- Expected onset
- Expected peak
- Expected recovery
- Forecast confidence

### Main charts

Show:

1. Density forecast:
   - Baseline
   - Corrected p50
   - p10 and p90 interval
   - Observed density when available in retrospective mode

2. Drag acceleration forecast:
   - Baseline
   - Corrected
   - Thresholds only when scientifically justified

3. Orbital impact:
   - Cumulative delta v
   - Along track displacement estimate

4. Physical forcing:
   - Propagated \(B_z\)
   - Dynamic pressure
   - Newell or \(E_m\)
   - Integrated coupling

5. Trajectory context:
   - Altitude
   - Latitude
   - Local solar time

### Assumptions panel

Always show:

- Mass
- Area
- \(C_D\)
- Ballistic coefficient
- Atmosphere baseline
- Neutral wind assumption
- Orbit source
- Density model version
- Training data range
- Validated altitude range
- Whether results are observed, retrospective, experimental forecast or scenario

## 16. Validation and Studies UI for density and drag

Add sections for:

### Study overview

- Research question
- Dataset coverage
- Missions
- Training interval
- Validation interval
- Model versions
- Data lineage
- Main limitations

### Baseline versus augmented model

Cards:

- Log density MAE
- Relative error
- Peak density error
- Peak timing error
- Skill versus baseline
- Drag acceleration error for defined scenarios

### End to end penalty

Compare:

- Reference aligned response model
- HelioSat predicted arrival response model

This quantifies how much skill is lost because of arrival time uncertainty.

### Event studies

Provide a storm selector and detailed plots for several events.

### Regime analysis

Show performance by:

- Quiet
- Moderate storm
- Severe storm
- Altitude
- Latitude
- Local solar time
- Mission

### Model interpretation

Show:

- Feature importance
- Lag importance
- Coupling response
- Error attribution
- Out of distribution diagnostics

## 17. Data Archive UI for LEO

Replace the current empty LEO state once local data exist.

Create cards for:

- Swarm A
- Swarm B
- Swarm C
- GRACE FO 1
- GRACE FO 2

Group by product when needed.

Each card shows:

- Product
- Coverage
- Cadence
- Rows
- Local size
- Quality pass rate
- Last ingestion
- Processing status
- Baseline density completion
- L1 feature join completion
- Training or validation role

Add a coverage timeline that distinguishes:

- Raw
- Processed
- Joined
- Train
- Validation
- Test

## 18. Public dashboard boundary

Do not modify the public dashboard in the initial implementation.

Keep the new module inside the authenticated internal console until:

- Data provenance is complete
- Validation is reproducible
- The augmented model beats the baseline on held out data
- Uncertainty is calibrated
- Licensing is reviewed
- Operator assumptions are clearly defined
- Out of distribution behavior is understood

Prepare reusable API contracts and UI components so selected outputs can later be moved to the public dashboard.

## 19. API and model contracts

Adapt names to the existing repository, but expose equivalent internal contracts.

### Data inventory

```json
{
  "generated_at_utc": "",
  "datasets": [],
  "coverage": {},
  "errors": []
}
```

### Validation summary

```json
{
  "study_version": "",
  "dataset_version": "",
  "split": {},
  "models": [],
  "metrics": {},
  "breakdowns": {},
  "artifacts": []
}
```

### Real time density and drag forecast

```json
{
  "generated_at_utc": "",
  "forecast_mode": "experimental",
  "model_version": "",
  "satellite": {},
  "spacecraft_parameters": {},
  "assumptions": {},
  "validated_domain": {},
  "timeline": [],
  "summary": {
    "rho_baseline_kg_m3": null,
    "rho_p50_kg_m3": null,
    "rho_p10_kg_m3": null,
    "rho_p90_kg_m3": null,
    "density_enhancement": null,
    "drag_acceleration_p50_m_s2": null,
    "cumulative_delta_v_m_s": null,
    "along_track_estimate_m": null
  },
  "data_health": {},
  "warnings": []
}
```

## 20. Reproducibility and artifacts

Every training run must save:

- Model
- Hyperparameters
- Feature list
- Feature schema version
- Dataset version
- Train, validation and test dates
- Metrics
- Plots
- Code revision when available
- Random seed
- Baseline model and version
- Data quality report

Do not use a notebook as the only implementation.

Notebooks may be added for exploration, but production calculations must live in reusable modules and scripts.

## 21. Testing requirements

Add tests for:

- Raw file parser
- Unit conversion
- Timestamp normalization
- Quality flag filtering
- Baseline density adapter
- Causal rolling features
- No future leakage
- L1 arrival alignment
- Density residual target
- Model serialization
- Drag units and sign
- Ballistic coefficient handling
- Co rotation relative velocity
- API response schemas
- Empty data states
- Partial data states
- Out of distribution warnings
- Existing L1 page regression

Tests may use small synthetic fixtures, but fixtures must never appear as real observations in the application.

## 22. Error handling

The application must degrade gracefully when:

- Swarm data are unavailable
- GRACE FO data are unavailable
- F10.7 or geomagnetic input is missing
- The atmospheric baseline cannot run
- The ML artifact is missing
- A satellite lacks physical parameters
- The requested altitude is outside the validated range
- The L1 live feed is stale
- The future trajectory is unavailable

Display explicit status messages instead of zeros or invented values.

## 23. Implementation phases

### Phase 0: repository audit

Before editing:

- Inspect the complete repository
- Identify frontend framework and routing
- Identify Python and scientific code locations
- Identify data storage conventions
- Identify existing chart components
- Identify authentication boundaries
- Identify current satellite trajectory source
- Identify model artifact conventions
- Write a concise implementation plan in the repository

### Phase 1: navigation and empty UI scaffolding

Implement the new tabs with empty but polished states.

Acceptance criteria:

- Existing pages remain unchanged
- New tabs are accessible only where intended
- Layout matches the current internal console
- Empty states explain the scientific roadmap

### Phase 2: canonical data model and inventory

Implement:

- Canonical schema
- Raw and processed manifests
- Local file discovery
- LEO Data Archive cards
- Coverage timeline
- Parser unit tests

### Phase 3: data ingestion

Implement Swarm first.

Then implement GRACE FO.

Acceptance criteria:

- Restartable ingestion
- Validation of schema and units
- Quality flags retained
- Parquet output
- Inventory updates automatically
- Clear failure messages

### Phase 4: atmospheric baseline

Implement the baseline interface and internal research adapter.

Calculate baseline density on processed observations.

Acceptance criteria:

- Reproducible output
- Units verified
- Metadata stored
- Licensing warning documented
- Baseline plot available

### Phase 5: feature joining

Build the causal bow shock driver timeline.

Join density observations to:

- Reference aligned drivers
- HelioSat predicted arrival drivers

Generate lagged and integrated features.

Acceptance criteria:

- No leakage tests pass
- Join coverage is reported
- Missingness is quantified
- A processed feature dataset is versioned

### Phase 6: baseline and ML studies

Train M0 to M4.

Implement chronological and walk forward evaluation.

Generate metrics and plots.

Acceptance criteria:

- All models scored on matched samples
- Baseline comparison is visible
- Reference aligned and end to end results remain separate
- Model artifacts are versioned
- No public claim is made from in sample metrics

### Phase 7: drag and orbital impact

Implement spacecraft parameter scenarios.

Calculate drag acceleration, cumulative delta v and first order along track displacement.

Acceptance criteria:

- Units are tested
- Assumptions are visible
- Baseline and corrected impacts are compared
- No precise orbit determination claim is made

### Phase 8: real time experimental page

Connect the trained model to:

- Current and inbound L1 queue
- Future satellite trajectory
- Atmospheric baseline
- Drag scenario

Acceptance criteria:

- Experimental label visible
- Known inbound and assumption based horizons separated
- Missing data handled gracefully
- Model version and validated domain visible
- No fabricated output

### Phase 9: validation page completion

Add all scientific plots, breakdowns and event studies.

Acceptance criteria:

- A supervisor can understand the full experiment from the page
- Every metric states dataset, split and model
- Limitations are visible
- Data lineage is visible

### Phase 10: documentation and final checks

Add:

- Data download instructions
- Scientific methodology
- Model card
- Licensing notes
- Reproduction commands
- Test instructions
- Known limitations
- Public deployment checklist

Run:

- Existing tests
- New tests
- Type checks
- Linting
- Build
- A final manual review of all three internal console sections

## 24. Definition of done

The work is complete when:

1. Existing L1 functionality still works.
2. The internal console contains the planned tabs.
3. Swarm and GRACE FO adapters or fully documented import paths exist.
4. The LEO Data Archive displays real local inventory when data are present.
5. An atmospheric baseline is calculated reproducibly.
6. A causal L1 feature dataset is created.
7. M0 to M4 can be trained and validated.
8. Reference aligned and end to end performance are separate.
9. Density and drag validation plots are available.
10. A selected spacecraft or scenario can receive an experimental density and drag forecast.
11. Assumptions, uncertainty, licensing and validated altitude range are visible.
12. No synthetic data are presented as real.
13. All tests, type checks and builds pass.
14. A final Codex summary lists changed files, commands run, results, unresolved blockers and recommended next work.

## 25. Scientific guardrails

- Use the precise terms L1, Earth bow shock, thermosphere and LEO.
- Keep observed, baseline, retrospective, experimental forecast and scenario outputs visually distinct.
- Do not use future data in a forecast feature.
- Do not overstate skill during rare severe storms.
- Do not extrapolate beyond the validated altitude range without a warning.
- Do not treat a density model as an exact satellite orbit solution.
- Do not infer a real satellite mass, area or drag coefficient from its TLE.
- Do not move the module to the public dashboard until validation and licensing gates are passed.
- Prefer simple interpretable baselines before complex models.
- Record every scientific assumption in code metadata and the UI.

## 26. Final Codex response

At the end, provide:

- Summary of the architecture implemented
- Changed file list
- Data imported
- Data still missing
- Model results
- Tests and build results
- Screens or routes added
- Scientific limitations
- Licensing blockers
- Exact commands to reproduce the study
- Next three recommended implementation steps
