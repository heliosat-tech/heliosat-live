# HelioSat LEO multi-year implementation plan

Status: in progress, authenticated Internal Console and scientific pipeline only. The public dashboard is out of scope.

## Audited architecture

- Frontend: Next.js 16.2.6 / React 19. The authenticated LEO views are `src/components/console/leo/*`, reached through `ConsoleScreen`; their admin-only APIs are under `src/app/api/console/leo/*`.
- Backend/API: Next.js route handlers call the filesystem-backed services in `src/services/leo/*`. Scientific artifacts remain server-side and plots are exposed only through the validated opaque artifact route.
- Scientific pipeline: `leo_drag/*`, `ml/arrival_residual/*` and the Python CLIs in `scripts/*`.
- Datasets and lineage: content-addressed VirES HAPI bytes in `data/raw/thermosphere`, partitioned Parquet plus `manifest.v1.json` in `data/processed/thermosphere`, versioned model artifacts in `data/model-runs/leo-density`.
- Trajectories: `leo_drag/trajectory.py` for retrospective finite-difference states and `src/services/leo/leoTrajectoryService.ts` for authenticated experimental TLE trajectories. Drag remains Level 1.

## Staged corpus decision made before download

The nominal common official coverage of Swarm POD A/B/C and GRACE-FO 1 ACC is 2018-05-29 through 2026-04-30. A continuous load is deferred because the present one-process feature builder would exceed the 24 GiB RAM budget.

Stage 1 uses 2021–2025 and is selected independently of density/model errors from the official local Kp archive:

- one quiet block in every meteorological season and year (14 days preferred; documented 7/3-day fallback if no Kp<5 block exists);
- every Kp≥6 episode, with two days of pre-onset context and five days after the last threshold-labelled hour;
- Swarm A/B/C POD and GRACE-FO 1 ACC only; Swarm ACC stays a separate diagnostic family because nominal HAPI coverage does not prove continuity.

The immutable plan is `data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json` (`staged-2021-2025-9f13ff6639f5`). It contains 20 seasonal quiet intervals, 46 moderate and 23 severe threshold episodes, merged into 53 restartable download ranges covering 616 distinct UTC dates (588.375 exact range-days).

Pre-download estimate from the referenced five-day pilot:

- raw official JSON: 1.63 GB;
- one-minute processed Parquet: 285 MB;
- causal NRLMSIS baseline: 323 MB;
- three one-minute driver feature modes: 3.05 GB;
- total before model/prediction artifacts: 5.29 GB.

The source one-minute observations will be retained. Model matrices will be created/evaluated by interval at a five-minute analysis cadence to bound memory. A continuous 2019–2025 corpus remains a later phase.

## Ordered implementation

1. Rebuild and version the arrival residual in the pinned Python environment; retain MRU, MRU+ML and OMNI-reference modes separately.
2. Ingest the immutable Stage-1 ranges with raw bytes, info metadata, SHA-256 lineage, retry and restart semantics.
3. Recompute the atmosphere baseline with previous-day F10.7 and a trailing causal 81-day F10.7a; keep centered retrospective outputs physically separate.
4. Build a common matched-row intersection and one common set of year/event partitions for all arrival modes.
5. Train identity-free deployable ablations and identity-dependent diagnostic models; run LOSO and Swarm→GRACE-FO transfer.
6. Evaluate fixed/distributed 0–12 h response lags, event/day-block bootstrap intervals, held-out p10/p50/p90 calibration, storm timing and regime breakdowns.
7. Publish versioned scientific JSON/Parquet/PNG artifacts to the Internal Console with Pilot / Multi-year Study / Experimental Live distinctions. Unavailable results remain explicit and live quantiles stay null without valid calibration.
8. Run Python and TypeScript tests, lint, type checking and production build; update the implementation report and reproduction guide.

## Gates

No public or operational claim is authorized until all ten gates in the requested specification pass. In particular, retrospective official coverage is not proof of issuance-time data availability, NRLMSIS licensing remains under review, and a staged discontinuous corpus is not equivalent to a continuous climatological record.
