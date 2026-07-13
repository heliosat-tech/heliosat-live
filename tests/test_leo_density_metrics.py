from __future__ import annotations

import pandas as pd
import pytest

from leo_drag.metrics import EventWindow, block_bootstrap_density_metrics, density_metrics


def test_core_density_metrics_and_skill_against_m0():
    observed = pd.Series([1.0e-12, 2.0e-12, 4.0e-12, 8.0e-12])
    predicted = observed.copy()
    baseline = observed * 0.5

    metrics = density_metrics(observed, predicted, baseline_density=baseline)

    assert metrics["status"] == "available"
    assert metrics["mae_log10_rho"] == pytest.approx(0.0)
    assert metrics["rmse_log10_rho"] == pytest.approx(0.0)
    assert metrics["median_absolute_relative_error"] == pytest.approx(0.0)
    assert metrics["median_density_ratio"] == pytest.approx(1.0)
    assert metrics["bias_log10_rho"] == pytest.approx(0.0)
    assert metrics["correlation_log10_rho"] == pytest.approx(1.0)
    assert metrics["skill_vs_m0"]["rmse_skill"] == pytest.approx(1.0)
    assert metrics["events"]["status"] == "unavailable"
    assert "timestamps" in metrics["events"]["reason"]


def test_event_metrics_require_explicit_window_and_threshold_for_onset_recovery():
    timestamps = pd.date_range("2024-05-10T00:00:00Z", periods=6, freq="1h", tz="UTC")
    observed = pd.Series([1.0, 2.0, 5.0, 4.0, 1.5, 1.0]) * 1.0e-12
    predicted = pd.Series([1.0, 1.5, 2.0, 5.0, 2.0, 1.0]) * 1.0e-12
    events = [
        EventWindow(
            "explicit-test-event",
            timestamps[0],
            timestamps[-1],
            threshold_kg_m3=2.5e-12,
        )
    ]

    metrics = density_metrics(
        observed,
        predicted,
        baseline_density=observed * 0.8,
        timestamps=timestamps,
        event_windows=events,
    )

    event_metrics = metrics["events"]
    assert event_metrics["status"] == "available"
    assert event_metrics["event_count"] == 1
    assert event_metrics["peak_timing_mae_min"] == pytest.approx(60.0)
    assert event_metrics["onset_timing_mae_min"] == pytest.approx(60.0)


def test_day_block_bootstrap_resamples_whole_days():
    frame = pd.DataFrame(
        {
            "timestamp_utc": pd.date_range("2024-01-01", periods=12, freq="6h", tz="UTC"),
            "rho_obs_kg_m3": [1.0e-12 + index * 1.0e-14 for index in range(12)],
        }
    )
    frame["rho_predicted_kg_m3"] = frame["rho_obs_kg_m3"] * 1.1
    frame["rho_baseline_kg_m3"] = frame["rho_obs_kg_m3"] * 0.8

    result = block_bootstrap_density_metrics(frame, n_resamples=40, random_seed=7)

    assert result["status"] == "available"
    assert result["method"] == "utc_day_block_bootstrap"
    assert result["block_count"] == 3
    interval = result["intervals"]["mae_log10_rho"]
    assert interval["successful_resamples"] == 40
    assert interval["low"] <= interval["estimate"] <= interval["high"]
