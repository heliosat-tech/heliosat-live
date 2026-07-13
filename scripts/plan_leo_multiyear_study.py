#!/usr/bin/env python3
"""Create the deterministic staged multi-year corpus plan without downloading data."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from leo_drag.multiyear import build_corpus_plan, normalise_kp_archive, write_corpus_plan


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", default="data")
    parser.add_argument("--kp-archive", default="data/console/omni-archive.json")
    parser.add_argument("--start-year", type=int, default=2021)
    parser.add_argument("--stop-year", type=int, default=2025)
    parser.add_argument(
        "--output", default="data/studies/leo-density/staged-2021-2025/corpus-plan.v1.json"
    )
    args = parser.parse_args()
    payload = json.loads(Path(args.kp_archive).read_text(encoding="utf-8"))
    plan = build_corpus_plan(
        normalise_kp_archive(payload),
        data_root=args.data_root,
        start_year=args.start_year,
        stop_year=args.stop_year,
    )
    path = write_corpus_plan(plan, args.output)
    print(json.dumps({"path": str(path), **plan}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
