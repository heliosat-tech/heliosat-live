from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from leo_drag.features import TARGET_COLUMN
from leo_drag.models import ModelSpecification, chronological_split
from leo_drag.response import (
    FixedLagEvaluationConfig,
    RegimeBreakdownConfig,
    build_distributed_lag_features,
    build_fixed_lag_features,
    distributed_lag_feature_name,
    evaluate_fixed_lag_models,
    fixed_lag_feature_name,
    lag_importance_breakdowns,
)


def _timeline(timestamp: pd.DatetimeIndex, driver: np.ndarray) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "arrival_time_bow_shock_utc": timestamp,
            "source_measurement_time_l1_utc": timestamp - pd.Timedelta("45min"),
            "available_at_utc": timestamp - pd.Timedelta("40min"),
            "newell_coupling": driver,
        }
    )


def _observations(timestamp: pd.DatetimeIndex) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "timestamp_utc": timestamp,
            "forecast_issuance_time_utc": timestamp,
        }
    )


def test_fixed_lag_features_do_not_change_when_future_driver_values_change() -> None:
    timeline_time = pd.date_range("2024-01-01", periods=40, freq="30min", tz="UTC")
    observation_time = timeline_time[12:24]
    original = np.arange(len(timeline_time), dtype=float)
    perturbed = original.copy()
    perturbed[timeline_time > observation_time.max()] = 1.0e12

    first = build_fixed_lag_features(
        _observations(observation_time),
        _timeline(timeline_time, original),
        driver_columns=["newell_coupling"],
        lags_hours=(0.0, 1.0, 3.0),
        tolerance="1min",
    )
    second = build_fixed_lag_features(
        _observations(observation_time),
        _timeline(timeline_time, perturbed),
        driver_columns=["newell_coupling"],
        lags_hours=(0.0, 1.0, 3.0),
        tolerance="1min",
    )

    columns = [fixed_lag_feature_name("newell_coupling", lag) for lag in (0.0, 1.0, 3.0)]
    pd.testing.assert_frame_equal(first[columns], second[columns])
    assert first.attrs["response_features"]["requires_availability_at_issuance"] is True


def test_fixed_lag_join_rejects_a_value_not_available_at_issuance() -> None:
    timestamp = pd.date_range("2024-01-01", periods=3, freq="1h", tz="UTC")
    timeline = _timeline(timestamp, np.asarray([1.0, 2.0, 3.0]))
    timeline.loc[1, "available_at_utc"] = timestamp[2] + pd.Timedelta("1h")
    observation = _observations(pd.DatetimeIndex([timestamp[1]]))

    result = build_fixed_lag_features(
        observation,
        timeline,
        driver_columns=["newell_coupling"],
        lags_hours=(0.0,),
        tolerance="2h",
    )

    assert result.loc[0, fixed_lag_feature_name("newell_coupling", 0.0)] == pytest.approx(1.0)


def test_distributed_bins_are_disjoint_and_include_the_outer_twelve_hour_edge() -> None:
    target = pd.Timestamp("2024-01-02T00:00:00Z")
    timestamp = pd.date_range(target - pd.Timedelta("12h"), target, freq="30min")
    age = (target - timestamp).total_seconds() / 3_600.0
    result = build_distributed_lag_features(
        _observations(pd.DatetimeIndex([target])),
        _timeline(timestamp, np.asarray(age, dtype=float)),
        driver_columns=["newell_coupling"],
        expected_cadence="30min",
    )

    expected_counts = {
        (0.0, 0.5): 1,
        (0.5, 1.0): 1,
        (1.0, 2.0): 2,
        (2.0, 3.0): 2,
        (3.0, 6.0): 6,
        (6.0, 9.0): 6,
        (9.0, 12.0): 7,
    }
    for (lower, upper), count in expected_counts.items():
        name = distributed_lag_feature_name(
            "newell_coupling", "count", lower, upper
        )
        assert result.loc[0, name] == count
    total = sum(
        result.loc[0, distributed_lag_feature_name("newell_coupling", "count", *bounds)]
        for bounds in expected_counts
    )
    assert total == len(timestamp)


def test_known_three_hour_impulse_response_is_selected_on_validation_only() -> None:
    timestamp = pd.date_range("2024-01-01", periods=240, freq="30min", tz="UTC")
    driver = np.zeros(len(timestamp), dtype=float)
    driver[np.arange(4, len(timestamp), 11)] = np.linspace(0.5, 2.5, len(np.arange(4, len(timestamp), 11)))
    observations = _observations(timestamp)
    features = build_fixed_lag_features(
        observations,
        _timeline(timestamp, driver),
        driver_columns=["newell_coupling"],
        lags_hours=(0.0, 1.0, 2.0, 3.0, 4.0),
        tolerance="1min",
    )
    delayed = np.zeros(len(timestamp), dtype=float)
    delayed[6:] = driver[:-6]
    baseline = np.full(len(timestamp), 1.0e-12)
    features["rho_baseline_kg_m3"] = baseline
    features[TARGET_COLUMN] = 0.35 * delayed
    features["rho_obs_kg_m3"] = baseline * np.exp(features[TARGET_COLUMN])
    split = chronological_split(features, train_fraction=0.5, validation_fraction=0.25)
    specification = ModelSpecification(
        model_id="M1",
        label="linear fixed-lag response fixture",
        algorithm="sklearn Ridge",
        feature_group="single fixed lag",
    )

    result = evaluate_fixed_lag_models(
        features,
        driver_column="newell_coupling",
        model_specification=specification,
        split=split,
        config=FixedLagEvaluationConfig(
            candidate_lags_hours=(0.0, 1.0, 2.0, 3.0, 4.0),
            random_seed=7,
        ),
    )

    assert result.selected_lag_hours == pytest.approx(3.0)
    payload = result.to_dict()
    assert payload["selection_source"] == "validation_only"
    assert "test_metrics" not in payload["candidate_validation"][0]
    assert result.test_metrics["rmse_log10_rho"] < 0.01


def test_regime_importance_keeps_absent_storm_and_altitude_regimes_unavailable() -> None:
    timestamp = pd.date_range("2024-01-01", periods=80, freq="1h", tz="UTC")
    feature = fixed_lag_feature_name("newell_coupling", 2.0)
    values = np.sin(np.linspace(0.0, 10.0, len(timestamp)))
    frame = pd.DataFrame(
        {
            "timestamp_utc": timestamp,
            TARGET_COLUMN: values * 0.4,
            feature: values,
            "latitude_deg": np.linspace(-80.0, 80.0, len(timestamp)),
            "local_solar_time_h": np.arange(len(timestamp)) % 24,
            "altitude_km": 470.0,
            "geomagnetic_regime": "quiet",
        }
    )
    specification = ModelSpecification(
        model_id="M1",
        label="importance fixture",
        algorithm="sklearn Ridge",
        feature_group="lag",
        numeric_features=(feature,),
    )
    from leo_drag.models import make_model_pipeline

    estimator = make_model_pipeline(specification, random_seed=3)
    estimator.fit(frame[[feature]], frame[TARGET_COLUMN])
    result = lag_importance_breakdowns(
        estimator,
        frame,
        feature_columns=[feature],
        lag_feature_columns=[feature],
        config=RegimeBreakdownConfig(
            minimum_rows=5,
            permutation_repeats=3,
            storm_labels=("quiet", "moderate", "severe"),
        ),
    )

    storms = result["dimensions"]["storm"]["regimes"]
    assert storms["quiet"]["status"] == "available"
    assert storms["moderate"]["status"] == "unavailable"
    assert storms["severe"]["status"] == "unavailable"
    altitude = result["dimensions"]["altitude"]["regimes"]
    assert altitude["450to500km"]["status"] == "available"
    assert altitude["500to550km"]["status"] == "unavailable"
