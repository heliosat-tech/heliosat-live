#!/usr/bin/env python3
"""Generate the Internal Console's experimental live LEO snapshot."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from leo_drag.forecast import generate_live_forecast_snapshot


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Combine real CelesTrak/SGP4 states, live HelioSat L1 parcels, "
            "official atmosphere forcing and a held-out M3 artifact."
        )
    )
    parser.add_argument("--data-root", default="data")
    parser.add_argument("--model-root", default="data/model-runs/leo-density")
    parser.add_argument("--group", choices=("stations", "weather"), default="stations")
    parser.add_argument("--norad-id")
    parser.add_argument("--horizon-minutes", type=int, default=180)
    parser.add_argument("--cadence-minutes", type=int, default=5)
    parser.add_argument(
        "--scenario",
        choices=("low-drag", "nominal", "high-drag"),
        default="nominal",
        help="Generic ballistic-coefficient sensitivity scenario, never satellite metadata.",
    )
    parser.add_argument(
        "--acknowledge-nrlmsis-research-license",
        action="store_true",
        help=(
            "Required acknowledgement for internal research use. This flag is not "
            "a commercial-use or redistribution licence."
        ),
    )
    parser.add_argument(
        "--reuse-current-omni2",
        action="store_true",
        help="Reuse a cached official current-year OMNI2 file instead of refreshing it.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = generate_live_forecast_snapshot(
            data_root=Path(args.data_root),
            model_root=Path(args.model_root),
            group=args.group,
            norad_id=args.norad_id,
            horizon_minutes=args.horizon_minutes,
            cadence_minutes=args.cadence_minutes,
            scenario_id=args.scenario,
            acknowledge_research_license=args.acknowledge_nrlmsis_research_license,
            refresh_omni2=not args.reuse_current_omni2,
        )
    except (FileNotFoundError, PermissionError, RuntimeError, ValueError) as exc:
        print(json.dumps({
            "status": "unavailable",
            "error_type": type(exc).__name__,
            "error": str(exc),
            "snapshot_written": False,
        }, indent=2, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
