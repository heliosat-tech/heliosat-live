# Historical Data Backfill

Use the NCEI GOES backfill when model training needs local, reusable historical GEO data instead of repeatedly fetching slow remote archives.

## What Gets Stored

- Raw NetCDF downloads: `.cache/goes_ncei/downloads/` only temporarily when `--delete-raw-after-process` is used
- NCEI directory listing cache: `data/cache/goes_ncei_archive_files.json`
- Processed training/query store: `data/parquet/source=goes_nccei/`
- Idempotency checkpoint: `data/checkpoints/goes_ncei_archive.json`

The Parquet store is the source the app and training pipeline should read. Keeping raw NetCDF files is optional. For local-disk efficiency, prefer deleting raw NetCDF after processing and keeping only Parquet plus checkpoints.

Deleting `.cache/goes_ncei/downloads/` keeps the processed Parquet usable, but a forced reprocess would need to fetch raw NetCDF files again. Future days cannot be present in the one-time pull, so use the incremental top-up only when you want newly published NCEI days.

## One-Time Historical Pull

Install the pipeline dependencies once:

```bash
python -m pip install -r requirements-pipeline.txt
```

Then run the full GOES-R historical pull:

```bash
python scripts/backfill_goes_ncei.py \
  --start 2017-01-01 \
  --stop 2026-06-04 \
  --spacecraft all \
  --product all \
  --workers 6 \
  --store-root data/parquet \
  --cache-path data/cache/goes_ncei_archive_files.json \
  --checkpoint data/checkpoints/goes_ncei_archive.json \
  --download-dir .cache/goes_ncei/downloads \
  --delete-raw-after-process
```

`--product all` includes MAG, SEISS MPSH electrons, SEISS SGPS protons, and EXIS XRS. Rerunning the same command is safe: processed files are skipped by checkpoint, and Parquet partitions are merged without duplicate timestamps. With `--delete-raw-after-process`, each NetCDF is removed after successful processing so the local dataset stays compact.

## Later Incremental Top-Up

For new days that appear after the historical pull:

```bash
python scripts/backfill_goes_ncei.py \
  --incremental \
  --stop 2026-06-04 \
  --spacecraft all \
  --product all \
  --workers 6 \
  --store-root data/parquet \
  --cache-path data/cache/goes_ncei_archive_files.json \
  --checkpoint data/checkpoints/goes_ncei_archive.json \
  --download-dir .cache/goes_ncei/downloads \
  --delete-raw-after-process
```

Update `--stop` to the new exclusive UTC date when topping up future data.
