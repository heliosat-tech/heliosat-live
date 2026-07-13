#!/usr/bin/env python3
"""CLI for official thermospheric-density ingestion and baseline processing."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from leo_drag.baseline_processing import process_all_baselines
from leo_drag.ingestion import discover_collections, import_hapi_files, ingest_collection
from leo_drag.inventory import build_inventory


def _print(payload: Any) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True, default=str))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Ingest official ESA/VirES LEO density products. Raw bytes, checksums, "
            "canonical one-minute Parquet and lineage are stored under --data-root."
        )
    )
    parser.add_argument("--data-root", default="data", help="HelioSat data root (default: data)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("discover", help="Query official VirES metadata for supported products")
    subparsers.add_parser("inventory", help="Print the local manifest-derived inventory")

    ingest = subparsers.add_parser("ingest", help="Download one official collection")
    ingest.add_argument("collection_id")
    ingest.add_argument("--start", required=True, help="inclusive timezone-aware UTC timestamp")
    ingest.add_argument("--stop", required=True, help="exclusive timezone-aware UTC timestamp")
    ingest.add_argument("--chunk-days", type=int, default=7)

    manual = subparsers.add_parser(
        "import", help="Validate and import previously downloaded official HAPI JSON"
    )
    manual.add_argument("collection_id")
    manual.add_argument("--data-file", required=True)
    manual.add_argument("--info-file", required=True)
    manual.add_argument("--source-url", required=True)
    manual.add_argument("--start", required=True)
    manual.add_argument("--stop", required=True)

    baseline = subparsers.add_parser(
        "baseline", help="Apply NRLMSIS 2.1 to locally processed observations"
    )
    baseline.add_argument(
        "--collection", action="append", default=[],
        help="collection id to process; repeat or omit for every local entry",
    )
    baseline.add_argument(
        "--acknowledge-research-license",
        action="store_true",
        help=(
            "explicitly enable the internal-research NRLMSIS run; this is not a "
            "commercial-use authorization"
        ),
    )
    baseline.add_argument("--refresh-ancillary", action="store_true")
    baseline.add_argument(
        "--f107a-mode",
        choices=("trailing_81_day", "centered_81_day_retrospective"),
        default="trailing_81_day",
        help=(
            "F10.7a definition. The default trailing 81-day mean is the only "
            "mode eligible for deployable/headline experiments."
        ),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    data_root = Path(args.data_root)
    if args.command == "discover":
        _print({"datasets": discover_collections()})
        return 0
    if args.command == "inventory":
        _print(build_inventory(data_root))
        return 0
    if args.command == "ingest":
        reports = ingest_collection(
            args.collection_id,
            args.start,
            args.stop,
            data_root=data_root,
            chunk_days=args.chunk_days,
        )
        _print({"results": [asdict(report) for report in reports]})
        return 0
    if args.command == "import":
        report = import_hapi_files(
            args.collection_id,
            data_file=args.data_file,
            info_file=args.info_file,
            source_url=args.source_url,
            start=args.start,
            stop=args.stop,
            data_root=data_root,
        )
        _print(asdict(report))
        return 0
    if args.command == "baseline":
        reports = process_all_baselines(
            data_root=data_root,
            collection_ids=args.collection,
            acknowledge_research_license=args.acknowledge_research_license,
            refresh_ancillary=args.refresh_ancillary,
            f107a_mode=args.f107a_mode,
        )
        _print({"results": [report.to_dict() for report in reports]})
        return 0
    raise AssertionError(f"unhandled command {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
