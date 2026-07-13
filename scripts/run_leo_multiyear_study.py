#!/usr/bin/env python3
"""Execute restartable data phases for an immutable LEO multi-year plan."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from leo_drag.baseline_processing import process_all_baselines
from leo_drag.ingestion import ingest_collection
from leo_drag.manifest import (
    load_manifest,
    upsert_manifest_entry,
    utc_now_iso,
    write_manifest_atomic,
)
from leo_drag.multiyear import MULTIYEAR_PLAN_SCHEMA_VERSION
from leo_drag.multiyear_study import run_multiyear_study


def _load_plan(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != MULTIYEAR_PLAN_SCHEMA_VERSION:
        raise ValueError(f"unsupported corpus plan schema: {payload.get('schema_version')}")
    core = {
        key: value
        for key, value in payload.items()
        if key not in {"plan_id", "plan_sha256", "generated_at_utc"}
    }
    digest = hashlib.sha256(
        json.dumps(core, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if digest != payload.get("plan_sha256"):
        raise ValueError("corpus plan checksum does not match its immutable content")
    return payload


def _tag_entry(
    data_root: Path,
    entry_id: str,
    *,
    plan: Mapping[str, Any],
    interval_ids: list[str],
) -> None:
    manifest_path = data_root / "processed" / "thermosphere" / "manifest.v1.json"
    manifest = load_manifest(manifest_path)
    entry = next(
        (
            item for item in manifest.get("entries", [])
            if isinstance(item, dict) and item.get("id") == entry_id
        ),
        None,
    )
    if entry is None:
        raise RuntimeError(f"ingested manifest entry disappeared: {entry_id}")
    updated = dict(entry)
    updated["corpus_plan_id"] = plan["plan_id"]
    updated["corpus_plan_sha256"] = plan["plan_sha256"]
    updated["study_interval_ids"] = sorted(set(interval_ids))
    updated["research_stage"] = "multi_year_study"
    upsert_manifest_entry(manifest_path, updated)


def _plan_entry_ids(data_root: Path, plan_id: str) -> list[str]:
    manifest = load_manifest(data_root / "processed" / "thermosphere" / "manifest.v1.json")
    return [
        str(entry["id"])
        for entry in manifest.get("entries", [])
        if isinstance(entry, dict) and entry.get("corpus_plan_id") == plan_id and entry.get("id")
    ]


def _mark_resolved_ingestion_errors(data_root: Path, plan_id: str) -> int:
    manifest_path = data_root / "processed" / "thermosphere" / "manifest.v1.json"
    manifest = load_manifest(manifest_path)
    completed = {
        (
            str(entry.get("source_product")),
            str(entry.get("start_utc")),
            str(entry.get("end_utc")),
        )
        for entry in manifest.get("entries", [])
        if isinstance(entry, dict) and entry.get("corpus_plan_id") == plan_id
    }
    count = 0
    errors = []
    for source in manifest.get("errors") or []:
        error = dict(source) if isinstance(source, Mapping) else {"error": str(source)}
        key = (
            str(error.get("collection_id")),
            str(error.get("start_utc")),
            str(error.get("stop_utc")),
        )
        if key in completed and not error.get("resolved_at_utc"):
            error["resolved_at_utc"] = utc_now_iso()
            error["resolution"] = "same immutable interval ingested and validated successfully"
            count += 1
        errors.append(error)
    if count:
        manifest["errors"] = errors
        manifest["generated_at_utc"] = utc_now_iso()
        write_manifest_atomic(manifest_path, manifest)
    return count


def ingest(plan: Mapping[str, Any], *, data_root: Path, chunk_days: int) -> dict[str, Any]:
    reports = []
    for collection_id in plan["collections"]:
        for download_range in plan["download_ranges"]:
            results = ingest_collection(
                str(collection_id),
                str(download_range["start_utc"]),
                str(download_range["stop_utc"]),
                data_root=data_root,
                chunk_days=chunk_days,
            )
            for result in results:
                _tag_entry(
                    data_root,
                    result.manifest_entry_id,
                    plan=plan,
                    interval_ids=[str(value) for value in download_range["interval_ids"]],
                )
                reports.append({
                    "collection_id": result.collection_id,
                    "start_utc": result.start_utc,
                    "stop_utc": result.stop_utc,
                    "manifest_entry_id": result.manifest_entry_id,
                    "row_count_raw": result.row_count_raw,
                    "row_count_processed": result.row_count_processed,
                    "skipped_existing": result.skipped_existing,
                })
            print(
                f"[{collection_id}] {download_range['start_utc']} -> "
                f"{download_range['stop_utc']}: {len(results)} chunk(s)",
                flush=True,
            )
    resolved_errors = _mark_resolved_ingestion_errors(data_root, str(plan["plan_id"]))
    return {
        "status": "complete",
        "plan_id": plan["plan_id"],
        "chunks": reports,
        "resolved_ingestion_errors": resolved_errors,
    }


def baseline(
    plan: Mapping[str, Any],
    *,
    data_root: Path,
    acknowledge_research_license: bool,
) -> dict[str, Any]:
    entry_ids = _plan_entry_ids(data_root, str(plan["plan_id"]))
    if not entry_ids:
        raise RuntimeError("no ingested manifest entries are tagged with this plan; run ingest first")
    reports = process_all_baselines(
        data_root=data_root,
        manifest_entry_ids=entry_ids,
        acknowledge_research_license=acknowledge_research_license,
        f107a_mode="trailing_81_day",
    )
    return {
        "status": "complete",
        "plan_id": plan["plan_id"],
        "entries": [report.to_dict() for report in reports],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--plan", default="data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json"
    )
    parser.add_argument("--data-root", default="data")
    subparsers = parser.add_subparsers(dest="command", required=True)
    ingest_parser = subparsers.add_parser("ingest")
    ingest_parser.add_argument("--chunk-days", type=int, default=14)
    baseline_parser = subparsers.add_parser("baseline")
    baseline_parser.add_argument(
        "--acknowledge-research-license",
        action="store_true",
        help="acknowledge that NRLMSIS is being used only for permitted research",
    )
    study_parser = subparsers.add_parser(
        "study", help="fit the immutable three-arrival-mode multi-year density study"
    )
    study_parser.add_argument("--model-root", default="data/model-runs/leo-density")
    study_parser.add_argument("--run-id", default="staged-2021-2025-v1")
    study_parser.add_argument(
        "--arrival-model", default="data/ml-model/arrival-residual/model.joblib"
    )
    study_parser.add_argument("--arrival-metrics", default="data/console/ml_metrics.json")
    study_parser.add_argument("--bootstrap-resamples", type=int, default=200)
    study_parser.add_argument("--random-seed", type=int, default=42)
    study_parser.add_argument("--overwrite-run", action="store_true")
    args = parser.parse_args()
    plan = _load_plan(Path(args.plan))
    data_root = Path(args.data_root).resolve()
    if args.command == "ingest":
        result = ingest(plan, data_root=data_root, chunk_days=args.chunk_days)
    elif args.command == "baseline":
        result = baseline(
            plan,
            data_root=data_root,
            acknowledge_research_license=args.acknowledge_research_license,
        )
    else:
        result = run_multiyear_study(
            data_root=data_root,
            model_root=args.model_root,
            plan=plan,
            run_id=args.run_id,
            arrival_model_path=args.arrival_model,
            arrival_metrics_path=args.arrival_metrics,
            bootstrap_resamples=args.bootstrap_resamples,
            random_seed=args.random_seed,
            overwrite_run=args.overwrite_run,
        )
    print(json.dumps(result, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
