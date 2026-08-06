#!/usr/bin/env python3
"""Backward-compatible entry point for the trained geomagnetic study.

The original generator replayed a fixed heuristic.  The report is now produced
by the chronological training pipeline; keep this filename so existing runbooks
continue to work without silently recreating the obsolete artifact.
"""

from train_geomagnetic_storm_model import main


if __name__ == "__main__":
    main()
