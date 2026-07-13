#!/usr/bin/env python3
"""Run the reproducible official-data LEO density/drag pilot study."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from leo_drag.study import run_pilot_study


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Train and validate M0-M4 on local official Swarm/GRACE-FO data."
    )
    parser.add_argument("--data-root", default="data")
    parser.add_argument("--model-root", default="data/model-runs/leo-density")
    parser.add_argument("--run-id", default="pilot-20220203-20220208-v1")
    parser.add_argument("--bootstrap-resamples", type=int, default=200)
    parser.add_argument("--random-seed", type=int, default=42)
    parser.add_argument(
        "--arrival-model", default="data/ml-model/arrival-residual/model.joblib"
    )
    parser.add_argument("--arrival-metrics", default="data/console/ml_metrics.json")
    parser.add_argument("--kp-archive", default="data/console/omni-archive.json")
    parser.add_argument(
        "--overwrite-run",
        action="store_true",
        help="explicitly replace an existing run id; prefer a new immutable versioned id",
    )
    args = parser.parse_args()
    report = run_pilot_study(
        data_root=args.data_root,
        model_root=args.model_root,
        run_id=args.run_id,
        bootstrap_resamples=args.bootstrap_resamples,
        random_seed=args.random_seed,
        arrival_model_path=args.arrival_model,
        arrival_metrics_path=args.arrival_metrics,
        kp_archive_path=args.kp_archive,
        overwrite_run=args.overwrite_run,
    )
    print(json.dumps(report, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
