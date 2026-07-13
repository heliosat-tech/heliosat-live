# HelioSat LEO density and drag implementation plan

Date: 2026-07-12  
Scope: authenticated Internal Console only; the public dashboard and public API v1 remain unchanged.

## Phase 0 audit summary

- Frontend: Next.js 16.2.6 App Router, React 19, strict TypeScript, Tailwind 4 and Recharts. `/console` is a server-rendered, Supabase-admin-gated page mounting the client component `ConsoleScreen`.
- Internal navigation: the three existing sections are local UI state (`realtime`, `training`, `validation`) in `src/components/console/ConsoleScreen.tsx`; the new LEO choices will be page-level tabs inside those sections.
- Backend: Route Handlers under `src/app/api/**`. Every new `/api/console/leo/**` handler must repeat the admin check. `/api/console/corridor` is intentionally shared with the public dashboard and will not be changed.
- Scientific code: reusable Python lives in `ml/`, `training/` and `scripts/`. The production app has no persistent Python service; offline pipelines and bounded subprocess inference are the established pattern.
- Existing L1 pipeline: SWPC/IMAP ingestion, per-variable provenance, MRU propagation to the bow-shock nose and optional arrival-time residual ML. LEO work will consume this pipeline without changing its public contracts.
- Historical drivers: ACE, OMNI and GOES archives exist locally. OMNI is a retrospective bow-shock-aligned reference, never a live operational input.
- Storage: large GOES data use local, partitioned Parquet plus atomic checkpoints. `data/raw/thermosphere` and `data/processed/thermosphere` do not yet exist and must be ignored by Git.
- Artifacts: arrival-ML artifacts and console summaries are versioned separately. The generic `training/` feature builder is not safe for density work because it can derive features from the target; the LEO study gets a dedicated pipeline.
- Trajectories: CelesTrak TLE plus `satellite.js` SGP4. It currently exposes scalar state only; the LEO service will add ECI position/velocity and atmospheric co-rotation. There is no drag-aware numerical propagator, so orbital impact is Level 1 only.
- Baseline checks before modification: 33/33 TypeScript tests passed; 14/14 non-network Python tests passed (one slow test deselected); typecheck passed; lint passed with one pre-existing `no-img-element` warning.

## Verified data boundary

- Official retrieval service: ESA VirES for Swarm HAPI, `https://vires.services/hapi/`.
- Supported collections: Swarm A/B/C `DNSxPOD` and `DNSxACC`, plus GRACE-FO `GF_OPER_DNS1ACC_2_`. The catalog exposes a GRACE-FO 2 identifier but currently reports no time coverage; it must remain an explicit unavailable state.
- Raw HAPI responses, catalog metadata, query bounds and checksums will be retained. No unofficial endpoint or scraped page will be used.
- ESA/VirES attribution and use terms will be recorded. Data and the NRLMSIS 2.x baseline remain internal research inputs until commercial-use and onward-distribution review is complete.

## Implementation sequence

1. Navigation and contracts
   - Add secondary tabs while keeping each existing L1 view the default.
   - Add shared, versioned TypeScript contracts and honest empty/partial states.
   - Isolate new LEO components so the one-second console clock does not trigger unnecessary forecast work.

2. Canonical density data and inventory
   - Add the canonical observation schema, manifest/checkpoint schema, lineage and inventory reader.
   - Protect raw, processed and model-run directories in `.gitignore`.
   - Add Swarm A/B/C and GRACE-FO 1/2 archive cards and raw/processed/joined coverage states.

3. Restartable official ingestion
   - Implement a VirES HAPI adapter and a strict manual-import fallback.
   - Validate collection IDs, units, timestamps, density fill values and quality flags.
   - Preserve native cadence in raw data; create one-minute median Parquet partitions without bridging long gaps.

4. Replaceable atmosphere baseline
   - Define `AtmosphereBaseline` and implement an optional `pymsis`/NRLMSIS 2.x research adapter.
   - Require explicit, traceable F10.7/F10.7a/Ap inputs or record the exact ancillary source used.
   - Persist baseline density, model/version and input status; fail with null/status rather than a numeric fallback.

5. Causal bow-shock features and joins
   - Build separate `reference_aligned` and `heliosat_predicted_arrival` timelines.
   - Centralize Pdyn, southward-IMF Em and Newell coupling, with causal windows from 15 minutes to 12 hours.
   - Join only backward from each observation/issuance availability time; version the resulting feature dataset and quantify missingness.

6. Density residual studies
   - Target `log(rho_observed) - log(rho_baseline)`.
   - Implement M0-M4 feature groups, chronological/walk-forward/event/mission splits and matched-row scoring.
   - Save model, hyperparameters, feature schema, dataset hash, split dates, metrics, plots, uncertainty calibration and code revision.
   - Keep reference-aligned, end-to-end, retrospective and deployable-candidate results separate.

7. Drag and first-order orbital impact
   - Implement `B = Cd A / m`, drag opposite air-relative velocity, Earth co-rotation, parameter uncertainty and labeled scenarios.
   - Integrate acceleration along existing SGP4 trajectory points for delta-v and first-order along-track displacement.
   - Do not claim precise orbit determination or infer mass/area/Cd from a TLE.

8. Experimental real-time page
   - Add an Internal Console satellite/scenario selector independent of the public dashboard contexts.
   - Combine current/inbound L1 parcels, future SGP4 trajectory, baseline and a trained density artifact.
   - Visually split confirmed inbound forcing from persistence/climatology extension and suppress numeric output when required inputs/artifacts are absent.

9. Validation and archive completion
   - Render study overview, lineage, matched metrics, event/regime breakdowns, interpretation plots and limitations from saved artifacts only.
   - Never render test fixtures as observations.

10. Reproducibility and final checks
    - Document exact download/import, processing, baseline, join, training, validation and forecast commands.
    - Add parser, schema, causal/leakage, baseline, serialization, drag, co-rotation, API-state and L1-default regression tests.
    - Run all existing/new tests, slow integration test where reachable, lint, typecheck and production build.

## Scientific gates

- No headline skill metric without a held-out chronological interval and M0 on identical rows.
- No operational claim from OMNI-aligned or contemporaneous-index experiments.
- No live forecast beyond the trained altitude/time/mission domain without an out-of-distribution warning.
- Missing density, solar indices, model artifacts, physical spacecraft parameters or trajectory produce an explicit unavailable/partial state, never zero or fabricated data.
- Public deployment remains blocked until provenance, validation, uncertainty and licensing gates are reviewed.
