from __future__ import annotations

import math
from statistics import median
from typing import Iterable


def _finite_pairs(y_true: Iterable[float], y_pred: Iterable[float]) -> list[tuple[float, float]]:
    pairs: list[tuple[float, float]] = []

    for actual, predicted in zip(y_true, y_pred, strict=False):
        if math.isfinite(actual) and math.isfinite(predicted):
            pairs.append((float(actual), float(predicted)))

    return pairs


def regression_metrics(
    y_true: Iterable[float],
    y_pred: Iterable[float],
    persistence_rmse: float | None = None,
) -> dict[str, float | None]:
    pairs = _finite_pairs(y_true, y_pred)

    if not pairs:
        return {
            "rmse": None,
            "mae": None,
            "r2": None,
            "bias": None,
            "median_absolute_error": None,
            "p95_absolute_error": None,
            "skill_vs_persistence": None,
            "peak_error": None,
        }

    residuals = [predicted - actual for actual, predicted in pairs]
    absolute_errors = sorted(abs(error) for error in residuals)
    squared_errors = [error * error for error in residuals]
    actual_values = [actual for actual, _ in pairs]
    actual_mean = sum(actual_values) / len(actual_values)
    total_sum_squares = sum((actual - actual_mean) ** 2 for actual in actual_values)
    residual_sum_squares = sum(squared_errors)
    rmse = math.sqrt(sum(squared_errors) / len(squared_errors))
    mae = sum(absolute_errors) / len(absolute_errors)
    p95_index = min(len(absolute_errors) - 1, math.ceil(0.95 * len(absolute_errors)) - 1)
    skill = None

    if persistence_rmse and persistence_rmse > 0:
        skill = 1 - (rmse / persistence_rmse)

    return {
        "rmse": rmse,
        "mae": mae,
        "r2": None if total_sum_squares == 0 else 1 - (residual_sum_squares / total_sum_squares),
        "bias": sum(residuals) / len(residuals),
        "median_absolute_error": median(absolute_errors),
        "p95_absolute_error": absolute_errors[p95_index],
        "skill_vs_persistence": skill,
        "peak_error": max(absolute_errors),
    }

