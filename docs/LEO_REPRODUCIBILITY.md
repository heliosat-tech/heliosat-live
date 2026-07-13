# Reproducing the HelioSat LEO studies

Run every command from the repository root. Source data and generated artifacts are intentionally local-only and ignored by Git.

## 1. Install

```bash
npm ci
python -m pip install -r requirements-pipeline.lock.txt
```

`requirements-pipeline.txt` remains the compatible-range development specification. The lock pins the direct scientific packages used by the reported run; it is not a hash-locked resolution of every transitive dependency. Each study artifact separately embeds runtime versions, the Git commit when available and dirty-working-tree fingerprints.

NRLMSIS 2.x has separate research/non-commercial terms. Review `docs/LEO_DATA_SOURCES_AND_LICENSES.md` before enabling it.

## 2. Discover official ESA/VirES products

```bash
python scripts/ingest_leo_density.py --data-root data discover
```

The pilot download commands are:

```bash
python scripts/ingest_leo_density.py --data-root data ingest SW_OPER_DNSAPOD_2_ --start 2022-02-03T00:00:00Z --stop 2022-02-08T00:00:00Z
python scripts/ingest_leo_density.py --data-root data ingest SW_OPER_DNSBPOD_2_ --start 2022-02-03T00:00:00Z --stop 2022-02-08T00:00:00Z
python scripts/ingest_leo_density.py --data-root data ingest SW_OPER_DNSCPOD_2_ --start 2022-02-03T00:00:00Z --stop 2022-02-08T00:00:00Z
python scripts/ingest_leo_density.py --data-root data ingest GF_OPER_DNS1ACC_2_ --start 2022-02-03T00:00:00Z --stop 2022-02-08T00:00:00Z
```

Each request is restartable. Raw data/info filenames are checksum-addressed, and a changed official response for an existing interval is rejected rather than overwritten. Inspect the manifest with:

```bash
python scripts/ingest_leo_density.py --data-root data inventory
```

For an official response downloaded through an approved/manual path, import both the exact HAPI data and info documents; never convert a CSV and call it raw HAPI:

```bash
python scripts/ingest_leo_density.py --data-root data import COLLECTION_ID \
  --data-file /absolute/path/data.hapi.json \
  --info-file /absolute/path/info.json \
  --source-url 'https://vires.services/hapi/data?...' \
  --start 2022-02-03T00:00:00Z \
  --stop 2022-02-08T00:00:00Z
```

## 3. Apply the physical baseline

This downloads/reuses exact NASA SPDF OMNI2 yearly files, saves checksums and applies NRLMSIS 2.1 only after both acknowledgement mechanisms are present:

```bash
HELIOSAT_ENABLE_NRLMSIS_RESEARCH=true \
python scripts/ingest_leo_density.py --data-root data baseline \
  --acknowledge-research-license \
  --f107a-mode trailing_81_day
```

Add `--refresh-ancillary` only when deliberately creating a new source snapshot. A refreshed checksum changes lineage.

## 4. Rebuild the arrival-residual artifact

The recorded direct-package environment rebuilds the v2 nominal-geometry artifact from the cached or downloaded official SPDF five-minute OMNI files. It does not load the incompatible legacy `_loss` joblib.

```bash
python -m ml.arrival_residual.train --max-iter 400
```

The joblib, model card, source checksums, feature/schema/model versions, train/validation dates, fixed 13.5 Rₑ bow-shock assumption, metrics and walk-forward results are written under `data/ml-model/arrival-residual` and `data/console/ml_{metrics,data_split}.json`.

## 5. Plan and execute the staged multi-year study

Planning performs no mission download and does not modify any observation. It deterministically selects intervals from the official local Kp archive and writes both `corpus-plan.v1.json` and `corpus-plan.v1.lineage.json`, including the expected transfer/storage cost.

```bash
python scripts/plan_leo_multiyear_study.py \
  --data-root data \
  --kp-archive data/console/omni-archive.json \
  --start-year 2021 \
  --stop-year 2025 \
  --output data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json
```

Execute the immutable plan. Both commands are restartable; the first skips completed content-addressed chunks and the second writes the causal baseline to its own `trailing_81_day` tree.

```bash
python scripts/run_leo_multiyear_study.py \
  --plan data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json \
  --data-root data ingest --chunk-days 14

HELIOSAT_ENABLE_NRLMSIS_RESEARCH=true \
python scripts/run_leo_multiyear_study.py \
  --plan data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json \
  --data-root data baseline \
  --acknowledge-research-license

python scripts/run_leo_multiyear_study.py \
  --plan data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json \
  --data-root data study \
  --model-root data/model-runs/leo-density \
  --run-id staged-2021-2025-v1 \
  --arrival-model data/ml-model/arrival-residual/model.joblib \
  --arrival-metrics data/console/ml_metrics.json \
  --bootstrap-resamples 200 \
  --random-seed 42
```

The fixed roles are 2021–2022 train, 2023 validation, 2024 calibration and 2025 test. The one-minute archive is retained, while analysis uses real rows exactly on five-minute UTC timestamps, without interpolation. The summary, model metadata, predictions and plots are under `data/model-runs/leo-density/staged-2021-2025-v1/`.

The commands above use the reported run ID and therefore assume a clean artifact root. On a workspace that already contains that immutable run, choose a new versioned `--run-id`; do not overwrite it merely to make a command succeed. Current entry/row/coverage counts must always be read from `data/processed/thermosphere/manifest.v1.json`, because restartable ingestion can extend the local corpus while this document remains static.

## 6. Run an updated five-day pilot

The study command obtains/reuses the official NASA SPDF OMNI five-minute driver file, creates both timing modes, fits M0–M4 on chronological splits, scores identical held-out rows, calculates drag scenarios and writes plots/interpretations:

```bash
python scripts/run_leo_density_study.py \
  --data-root data \
  --model-root data/model-runs/leo-density \
  --run-id pilot-20220203-20220208-v3-current \
  --bootstrap-resamples 200 \
  --random-seed 42 \
  --arrival-model data/ml-model/arrival-residual/model.joblib \
  --arrival-metrics data/console/ml_metrics.json \
  --kp-archive data/console/omni-archive.json
```

Primary outputs:

```text
data/processed/thermosphere/manifest.v1.json
data/processed/thermosphere-features/reference_aligned/*.parquet
data/processed/thermosphere-features/heliosat_predicted_arrival/*.parquet
data/model-runs/leo-density/pilot-20220203-20220208-v3-current/study-summary.v1.json
data/model-runs/leo-density/pilot-20220203-20220208-v3-current/model-card.md
data/model-runs/leo-density/pilot-20220203-20220208-v3-current/{reference_aligned,heliosat_predicted_arrival}/m3.joblib
```

This is an updated rerun, not a bit-for-bit reproduction of `pilot-20220203-20220208-v2-circular`. That historical artifact used the incompatible legacy arrival joblib and centered F10.7a; the current code uses the v2 nominal-geometry arrival artifact and the currently selected baseline tree. Preserve the historical run for audit. Choose a new `--run-id` for every scientific revision; `--overwrite-run` is reserved for an explicitly acknowledged local replacement.

## 7. Generate an experimental live snapshot

This command does not fabricate a TLE, forcing value or uncertainty interval. It exits nonzero without writing `forecast-latest.v1.json` when a required source is absent, when less than 12 hours of fresh L1 history are available, or when the five-minute feature contract is not met.

```bash
HELIOSAT_ENABLE_NRLMSIS_RESEARCH=true \
python scripts/generate_leo_forecast_snapshot.py \
  --data-root data \
  --model-root data/model-runs/leo-density \
  --group stations \
  --horizon-minutes 180 \
  --cadence-minutes 5 \
  --scenario nominal \
  --acknowledge-nrlmsis-research-license
```

Use `--norad-id <catalog-id>` to select a real object returned by the chosen CelesTrak group. The snapshot is served only for the same selected NORAD ID and while inside `HELIOSAT_LEO_FORECAST_MAX_AGE_MINUTES` (30 by default). Schedule this command outside the Next.js request path if continuous experimental updates are desired.

## 8. Run the app and internal routes

Configure Supabase admin authentication and the local roots from `.env.example`, then:

```bash
npm run dev
```

Authenticated Internal Console route: `/console`. Internal no-store endpoints:

```text
GET /api/console/leo/inventory
GET /api/console/leo/validation
GET /api/console/leo/forecast?group=stations&horizon_minutes=180&cadence_minutes=5
```

Unauthenticated requests return `403`. No new public API or dashboard route is created.

## 9. Verification

```bash
python -m pytest -q
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

Tests use explicitly labelled contract/scientific fixtures. They never write fixtures into observation manifests or expose them through the application.
