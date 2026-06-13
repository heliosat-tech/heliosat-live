"""Arrival-error metrics, shared by the benchmark and the ML correction.

All metrics operate on SIGNED arrival-time errors in minutes
(predicted arrival minus observed arrival; positive = forecast was late):
- benchmark error = mru_delay - timeshift = -y
- ML error        = (mru_delay + y_hat) - timeshift = y_hat - y
"""

from __future__ import annotations

import numpy as np
import pandas as pd

REGIME_LABELS = {
    "severe": "Severe storm, G3-G5",
    "storm": "Storm, G1-G2",
    "quiet": "Quiet, G0",
}
REGIME_ORDER = ("severe", "storm", "quiet")


def summarize_errors(errors: np.ndarray) -> dict:
    """Distribution stats of signed arrival errors (minutes)."""
    abs_err = np.abs(errors)
    return {
        "samples": int(errors.size),
        "biasMin": round(float(errors.mean()), 2),
        "maeMin": round(float(abs_err.mean()), 2),
        "rmseMin": round(float(np.sqrt((errors**2).mean())), 2),
        "medianAbsMin": round(float(np.median(abs_err)), 2),
        "p90AbsMin": round(float(np.quantile(abs_err, 0.9)), 2),
        "within10Pct": round(float((abs_err <= 10).mean() * 100), 1),
        "within20Pct": round(float((abs_err <= 20).mean() * 100), 1),
        "within30Pct": round(float((abs_err <= 30).mean() * 100), 1),
    }


def stratify_by_regime(
    regimes: pd.Series,
    lead_min: pd.Series,
    benchmark_errors: np.ndarray,
    ml_errors: np.ndarray,
) -> list[dict]:
    """Benchmark-vs-ML metrics per observed storm regime."""
    total = len(regimes)
    rows: list[dict] = []
    for key in REGIME_ORDER:
        mask = (regimes == key).to_numpy()
        n = int(mask.sum())
        if n == 0:
            continue
        rows.append(
            {
                "key": key,
                "label": REGIME_LABELS[key],
                "n": n,
                "sharePct": round(n / total * 100, 1),
                "leadMin": round(float(lead_min.to_numpy()[mask].mean()), 1),
                "benchmark": summarize_errors(benchmark_errors[mask]),
                "ml": summarize_errors(ml_errors[mask]),
            }
        )
    return rows


def error_histogram(
    benchmark_errors: np.ndarray,
    ml_errors: np.ndarray,
    limit_min: float = 60.0,
    bin_width_min: float = 2.0,
) -> dict:
    """Shared-bin overlaid histogram of both error distributions (for UI + figure)."""
    edges = np.arange(-limit_min, limit_min + bin_width_min, bin_width_min)
    bench_counts, _ = np.histogram(benchmark_errors, bins=edges)
    ml_counts, _ = np.histogram(ml_errors, bins=edges)
    return {
        "binEdgesMin": [round(float(e), 1) for e in edges],
        "benchmarkCounts": bench_counts.astype(int).tolist(),
        "mlCounts": ml_counts.astype(int).tolist(),
        "benchmarkOutsidePct": round(
            float((np.abs(benchmark_errors) > limit_min).mean() * 100), 2
        ),
        "mlOutsidePct": round(float((np.abs(ml_errors) > limit_min).mean() * 100), 2),
    }
