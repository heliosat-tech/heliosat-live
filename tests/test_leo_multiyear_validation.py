from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from leo_drag.features import FEATURE_SCHEMA_VERSION, TARGET_COLUMN
from leo_drag.models import build_model_specifications, make_model_pipeline
from leo_drag.validation import (
    add_spacecraft_key,
    align_common_matched_rows,
    assert_mission_agnostic_features,
    build_ablation_specifications,
    calibrate_and_evaluate_density_intervals,
    cross_mission_indices,
    leave_one_spacecraft_out_indices,
    paired_block_bootstrap_delta,
)


def _model_frame(rows: int = 80) -> pd.DataFrame:
    timestamp = pd.date_range("2021-01-01", periods=rows, freq="12h", tz="UTC")
    phase = np.linspace(0.0, 6.0, rows)
    baseline = 1.0e-12 * (1.0 + 0.05 * np.cos(phase))
    residual = 0.1 * np.sin(phase)
    frame = pd.DataFrame(
        {
            "timestamp_utc": timestamp,
            "forecast_issuance_time_utc": timestamp,
            "mission": np.where(np.arange(rows) % 4 == 0, "GRACE-FO", "Swarm"),
            "spacecraft_id": np.asarray(["1", "A", "B", "C"] * (rows // 4)),
            "source_product": "official-fixture",
            "orbit_direction": np.where(np.arange(rows) % 2, "ascending", "descending"),
            "rho_obs_kg_m3": baseline * np.exp(residual),
            "rho_baseline_kg_m3": baseline,
            TARGET_COLUMN: residual,
            "altitude_km": 460.0 + np.sin(phase),
            "latitude_deg": 60.0 * np.sin(phase),
            "longitude_sin": np.sin(phase),
            "longitude_cos": np.cos(phase),
            "local_solar_time_sin": np.sin(phase / 2),
            "local_solar_time_cos": np.cos(phase / 2),
            "day_of_year_sin": np.sin(phase / 3),
            "day_of_year_cos": np.cos(phase / 3),
            "f107_sfu": 110.0,
            "f107a_sfu": 105.0,
            "log_rho_baseline": np.log(baseline),
            "vsw_km_s": 420.0 + phase,
            "bz_gsm_nt": -2.0 - phase,
            "drv__vsw_km_s__mean__1h": 415.0 + phase,
            "drv__newell_coupling__integral_h__3h": 10_000.0 + phase,
            "newell_coupling": 3_000.0 + phase,
            "driver_join_status": "matched",
        }
    )
    frame.attrs["feature_dataset_metadata"] = {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "dataset_version": "multi-year-fixture-v1",
        "geomagnetic_availability": {},
        "feature_definitions": [
            {"name": "mission", "group": "context"},
            {"name": "spacecraft_id", "group": "context"},
            {"name": "orbit_direction", "group": "context"},
            {"name": "altitude_km", "group": "context"},
            {"name": "log_rho_baseline", "group": "baseline"},
            {"name": "vsw_km_s", "group": "solar_wind"},
            {"name": "bz_gsm_nt", "group": "solar_wind"},
            {"name": "drv__vsw_km_s__mean__1h", "group": "solar_wind"},
            {"name": "drv__newell_coupling__integral_h__3h", "group": "solar_wind"},
            {"name": "newell_coupling", "group": "solar_wind"},
        ],
    }
    return frame


def test_deployable_m3_is_mission_agnostic_and_m5_is_identity_diagnostic() -> None:
    by_id = {item.model_id: item for item in build_model_specifications(_model_frame())}
    assert "mission" not in by_id["M3"].feature_columns
    assert "spacecraft_id" not in by_id["M3"].feature_columns
    assert by_id["M3"].deployable is True
    assert {"mission", "spacecraft_id"}.issubset(by_id["M5"].categorical_features)
    assert by_id["M5"].numeric_features
    assert by_id["M5"].deployable is False
    assert_mission_agnostic_features(by_id["M3"].feature_columns)
    with pytest.raises(AssertionError, match="identity"):
        assert_mission_agnostic_features(by_id["M5"].feature_columns)


def test_tree_estimators_disable_random_internal_early_stopping() -> None:
    by_id = {item.model_id: item for item in build_model_specifications(_model_frame())}
    for model_id in ("M2", "M3", "M5"):
        pipeline = make_model_pipeline(by_id[model_id])
        assert pipeline.named_steps["estimator"].get_params()["early_stopping"] is False


def test_arrival_modes_are_restricted_to_one_stable_common_row_population() -> None:
    reference, mru, ml = _model_frame(), _model_frame(), _model_frame()
    reference.loc[0, "driver_join_status"] = "missing"
    mru.loc[1, "driver_join_status"] = "missing"
    ml.loc[2, "driver_join_status"] = "missing"
    mru["vsw_km_s"] += 10.0
    ml["vsw_km_s"] += 20.0

    aligned, report = align_common_matched_rows(
        {"reference": reference, "mru": mru, "mru_ml": ml}
    )
    assert report.common_rows == 77
    expected = aligned["reference"]["comparison_row_id"].tolist()
    assert aligned["mru"]["comparison_row_id"].tolist() == expected
    assert aligned["mru_ml"]["comparison_row_id"].tolist() == expected
    assert aligned["reference"].index.tolist() == list(range(77))


def test_common_rows_reject_a_mode_that_changes_the_observation() -> None:
    reference, changed = _model_frame(), _model_frame()
    changed.loc[10, "rho_obs_kg_m3"] *= 2.0
    with pytest.raises(AssertionError, match="rho_obs"):
        align_common_matched_rows({"reference": reference, "changed": changed})


def test_loso_and_cross_mission_partitions_keep_complete_groups_out() -> None:
    frame = add_spacecraft_key(_model_frame())
    development, test = leave_one_spacecraft_out_indices(frame, "Swarm:A")
    assert set(frame.loc[list(test), "spacecraft_key"]) == {"Swarm:A"}
    assert "Swarm:A" not in set(frame.loc[list(development), "spacecraft_key"])
    train, grace = cross_mission_indices(
        frame, train_missions=["Swarm"], test_missions=["GRACE-FO"]
    )
    assert set(frame.loc[list(train), "mission"]) == {"Swarm"}
    assert set(frame.loc[list(grace), "mission"]) == {"GRACE-FO"}


def test_paired_day_block_bootstrap_reports_b_minus_a_deterministically() -> None:
    frame = pd.DataFrame(
        {
            "timestamp_utc": pd.date_range("2024-01-01", periods=24, freq="6h", tz="UTC"),
            "rho_obs_kg_m3": np.linspace(1.0e-12, 2.0e-12, 24),
        }
    )
    frame["rho_baseline_kg_m3"] = frame["rho_obs_kg_m3"] * 0.8
    frame["prediction_a"] = frame["rho_obs_kg_m3"] * 1.05
    frame["prediction_b"] = frame["rho_obs_kg_m3"] * 1.20
    first = paired_block_bootstrap_delta(
        frame, prediction_a_column="prediction_a", prediction_b_column="prediction_b",
        n_resamples=50, random_seed=7,
    )
    second = paired_block_bootstrap_delta(
        frame, prediction_a_column="prediction_a", prediction_b_column="prediction_b",
        n_resamples=50, random_seed=7,
    )
    assert first == second
    assert first["status"] == "available"
    assert first["method"] == "paired_utc_day_block_bootstrap"
    assert first["delta_estimate"] > 0.0
    assert first["successful_resamples"] == 50


def test_held_out_log_residual_calibration_emits_ordered_p10_p50_p90() -> None:
    calibration_time = pd.date_range("2022-01-01", periods=20, freq="1D", tz="UTC")
    test_time = pd.date_range("2022-02-01", periods=12, freq="1D", tz="UTC")
    calibration = pd.DataFrame(
        {
            "timestamp_utc": calibration_time,
            "comparison_row_id": [f"cal-{i}" for i in range(20)],
            "rho_p50_kg_m3": 1.0e-12,
            "rho_obs_kg_m3": 1.0e-12 * np.exp(np.linspace(-0.3, 0.3, 20)),
        }
    )
    test = pd.DataFrame(
        {
            "timestamp_utc": test_time,
            "comparison_row_id": [f"test-{i}" for i in range(12)],
            "rho_p50_kg_m3": 1.2e-12,
            "rho_obs_kg_m3": 1.2e-12 * np.exp(np.linspace(-0.25, 0.25, 12)),
        }
    )
    fitted, predictions, metrics = calibrate_and_evaluate_density_intervals(calibration, test)
    assert fitted.calibration_rows == 20
    assert (predictions["rho_p10_kg_m3"] <= predictions["rho_p50_kg_m3"]).all()
    assert (predictions["rho_p50_kg_m3"] <= predictions["rho_p90_kg_m3"]).all()
    assert 0.0 <= metrics["central_interval_empirical_coverage"] <= 1.0
    assert metrics["test_period"]["rows"] == 12
    overlapping = test.copy()
    overlapping["timestamp_utc"] = calibration_time[:12]
    with pytest.raises(ValueError, match="strictly before"):
        calibrate_and_evaluate_density_intervals(calibration, overlapping)


def test_ablation_contract_is_mission_agnostic_and_keeps_missing_geomagnetic_visible() -> None:
    by_id = {item.ablation_id: item for item in build_ablation_specifications(_model_frame())}
    assert list(by_id) == ["A0", "A1", "A2", "A3", "A4", "A5", "A6"]
    for item in by_id.values():
        assert "mission" not in item.feature_columns
        assert "spacecraft_id" not in item.feature_columns
    assert "vsw_km_s" in by_id["A2"].feature_columns
    assert "drv__vsw_km_s__mean__1h" in by_id["A3"].feature_columns
    assert "drv__newell_coupling__integral_h__3h" in by_id["A4"].feature_columns
    assert by_id["A6"].status == "unavailable"
    assert "issuance-safe" in str(by_id["A6"].unavailable_reason)
