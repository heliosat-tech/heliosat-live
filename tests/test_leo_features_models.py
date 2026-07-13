from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
import pytest

from leo_drag.features import (
    FEATURE_SCHEMA_VERSION,
    TARGET_COLUMN,
    assert_no_target_leakage,
    build_feature_dataset,
    density_residual_target,
    read_feature_dataset,
    write_feature_dataset,
)
from leo_drag.models import (
    MODEL_ARTIFACT_SCHEMA_VERSION,
    build_model_specifications,
    chronological_split,
    evaluate_year_walk_forward,
    load_model_artifact,
    make_model_pipeline,
    predict_density_from_artifact,
    prepare_matched_rows,
    train_model_suite,
    write_study_summary,
    year_walk_forward_splits,
)


def test_density_residual_target_uses_log_ratio_and_rejects_nonphysical_values():
    target = density_residual_target(
        pd.Series([2.0e-12, 0.0, 3.0e-12]),
        pd.Series([1.0e-12, 1.0e-12, -1.0]),
    )

    assert target.iloc[0] == pytest.approx(math.log(2.0))
    assert math.isnan(target.iloc[1])
    assert math.isnan(target.iloc[2])


def test_target_and_future_columns_are_rejected_as_features():
    assert_no_target_leakage(["altitude_km", "drv__bz_gsm_nt__min__1h"])

    with pytest.raises(AssertionError, match="leakage"):
        assert_no_target_leakage(["rho_obs_kg_m3"])
    with pytest.raises(AssertionError, match="leakage"):
        assert_no_target_leakage(["future_kp"])


def test_feature_dataset_joins_only_arrived_and_available_driver():
    observations = pd.DataFrame(
        {
            "timestamp_utc": ["2024-01-01T10:05:00Z"],
            "mission": ["Swarm"],
            "spacecraft_id": ["A"],
            "orbit_direction": ["ascending"],
            "latitude_deg": [30.0],
            "longitude_deg": [45.0],
            "altitude_km": [460.0],
            "local_solar_time_h": [6.0],
            "rho_obs_kg_m3": [2.0e-12],
            "rho_baseline_kg_m3": [1.0e-12],
            "f107_sfu": [120.0],
            "f107a_sfu": [115.0],
        }
    )
    timeline = pd.DataFrame(
        {
            "arrival_time_bow_shock_utc": pd.to_datetime(
                ["2024-01-01T10:00:00Z", "2024-01-01T09:55:00Z", "2024-01-01T10:10:00Z"],
                utc=True,
            ),
            "source_measurement_time_l1_utc": pd.to_datetime(
                ["2024-01-01T09:20:00Z", "2024-01-01T09:15:00Z", "2024-01-01T09:30:00Z"],
                utc=True,
            ),
            # Row two had physically arrived but was not published at issuance.
            "available_at_utc": pd.to_datetime(
                ["2024-01-01T10:00:00Z", "2024-01-01T10:10:00Z", "2024-01-01T10:00:00Z"],
                utc=True,
            ),
            "vsw_km_s": [410.0, 999.0, 888.0],
            "bz_gsm_nt": [-4.0, -20.0, -15.0],
        }
    )

    features, metadata = build_feature_dataset(
        observations,
        timeline,
        experiment_mode="heliosat_predicted_arrival",
        tolerance="30min",
    )

    assert features.loc[0, "driver_join_status"] == "matched"
    assert features.loc[0, "vsw_km_s"] == pytest.approx(410.0)
    assert features.loc[0, TARGET_COLUMN] == pytest.approx(math.log(2.0))
    assert features.loc[0, "driver_arrival_time_bow_shock_utc"] <= features.loc[0, "timestamp_utc"]
    assert features.loc[0, "driver_available_at_utc"] <= features.loc[0, "forecast_issuance_time_utc"]
    assert metadata.feature_schema_version == FEATURE_SCHEMA_VERSION
    assert metadata.driver_matched_rows == 1


def test_feature_dataset_versions_an_honest_empty_driver_join(tmp_path):
    observations = pd.DataFrame(
        {
            "timestamp_utc": ["2024-01-01T10:05:00Z"],
            "rho_obs_kg_m3": [2.0e-12],
            "rho_baseline_kg_m3": [1.0e-12],
        }
    )
    features, metadata = build_feature_dataset(
        observations,
        pd.DataFrame(),
        experiment_mode="heliosat_predicted_arrival",
    )
    parquet, sidecar = write_feature_dataset(features, metadata, tmp_path / "features.parquet")
    restored, restored_metadata = read_feature_dataset(parquet)

    assert features.loc[0, "driver_join_status"] == "missing"
    assert metadata.driver_matched_rows == 0
    assert metadata.driver_missing_rows == 1
    assert sidecar.exists()
    assert restored.loc[0, TARGET_COLUMN] == pytest.approx(math.log(2.0))
    assert restored_metadata["dataset_version"] == metadata.dataset_version


def _model_frame(rows: int = 60) -> pd.DataFrame:
    timestamp = pd.date_range("2020-01-01", periods=rows, freq="12h", tz="UTC")
    phase = np.linspace(0.0, 4.0 * np.pi, rows)
    baseline = 1.2e-12 * (1.0 + 0.05 * np.cos(phase))
    residual = 0.12 * np.sin(phase) + 0.0004 * np.arange(rows)
    observed = baseline * np.exp(residual)
    frame = pd.DataFrame(
        {
            "timestamp_utc": timestamp,
            "forecast_issuance_time_utc": timestamp,
            "rho_obs_kg_m3": observed,
            "rho_baseline_kg_m3": baseline,
            TARGET_COLUMN: residual,
            "altitude_km": 450.0 + 8.0 * np.sin(phase),
            "latitude_deg": 70.0 * np.sin(phase),
            "longitude_sin": np.sin(phase),
            "longitude_cos": np.cos(phase),
            "local_solar_time_sin": np.sin(phase / 2.0),
            "local_solar_time_cos": np.cos(phase / 2.0),
            "day_of_year_sin": np.sin(phase / 6.0),
            "day_of_year_cos": np.cos(phase / 6.0),
            "f107_sfu": 110.0 + np.arange(rows) * 0.1,
            "f107a_sfu": 108.0 + np.arange(rows) * 0.05,
            "log_rho_baseline": np.log(baseline),
            "mission": np.where(np.arange(rows) % 2, "Swarm", "GRACE-FO"),
            "spacecraft_id": np.where(np.arange(rows) % 2, "A", "1"),
            "orbit_direction": np.where(np.arange(rows) % 2, "ascending", "descending"),
            "vsw_km_s": 390.0 + 30.0 * np.sin(phase),
            "bz_gsm_nt": -3.0 + 2.0 * np.cos(phase),
            "drv__newell_coupling__mean__1h": 1.0e4 + 500.0 * np.sin(phase),
            "driver_join_status": "matched",
        }
    )
    frame.attrs["feature_dataset_metadata"] = {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "dataset_version": "fixture-feature-v1",
        "geomagnetic_availability": {},
        "feature_definitions": [],
    }
    return frame


def test_models_use_one_exact_matched_set_and_m4_is_honestly_unavailable():
    frame = _model_frame()
    frame.loc[5, "vsw_km_s"] = np.nan
    specifications = build_model_specifications(frame)
    matched, report = prepare_matched_rows(frame, specifications)

    statuses = {specification.model_id: specification.status for specification in specifications}
    assert statuses == {
        "M0": "available", "M1": "available", "M2": "available",
        "M3": "available", "M4": "unavailable", "M5": "available",
    }
    assert len(matched) == len(frame) - 1
    assert report.active_models == ("M0", "M1", "M2", "M3", "M5")
    assert "rho_obs_kg_m3" not in report.required_features


def test_m4_requires_per_value_availability_no_later_than_issuance():
    frame = _model_frame()
    frame["kp_history"] = 3.0
    frame.attrs["geomagnetic_availability"] = {"kp_history": "available_at_issuance"}
    frame["kp_history_available_at_utc"] = frame["forecast_issuance_time_utc"] + pd.Timedelta("1min")

    future_status = {item.model_id: item.status for item in build_model_specifications(frame)}
    assert future_status["M4"] == "unavailable"

    frame["kp_history_available_at_utc"] = frame["forecast_issuance_time_utc"] - pd.Timedelta("1min")
    safe_status = {item.model_id: item.status for item in build_model_specifications(frame)}
    assert safe_status["M4"] == "available"


def test_chronological_and_year_walk_forward_splits_never_use_future_training_rows():
    frame = _model_frame()
    split = chronological_split(frame)
    timestamp = frame["timestamp_utc"]

    assert timestamp.loc[list(split.train_index)].max() < timestamp.loc[list(split.validation_index)].min()
    assert timestamp.loc[list(split.validation_index)].max() < timestamp.loc[list(split.test_index)].min()

    multi_year = frame.copy()
    multi_year["timestamp_utc"] = pd.to_datetime(
        [f"{2020 + index // 20}-01-{index % 20 + 1:02d}T00:00:00Z" for index in range(len(frame))],
        utc=True,
    )
    folds = year_walk_forward_splits(multi_year)
    assert [fold.validation_year for fold in folds] == [2021, 2022]
    for fold in folds:
        assert multi_year.loc[list(fold.train_index), "timestamp_utc"].dt.year.max() < fold.validation_year


def test_preprocessing_statistics_are_fit_on_training_rows_only():
    frame = _model_frame()
    specifications = build_model_specifications(frame)
    m1 = next(item for item in specifications if item.model_id == "M1")
    pipeline = make_model_pipeline(m1)
    training = frame.iloc[:20]
    held_out = frame.iloc[20:].copy()
    held_out["altitude_km"] = 50_000.0

    pipeline.fit(training[list(m1.feature_columns)], training[TARGET_COLUMN])
    numeric = list(m1.numeric_features)
    scaler = pipeline.named_steps["preprocessor"].named_transformers_["numeric"].named_steps["scaler"]

    assert scaler.mean_[numeric.index("altitude_km")] == pytest.approx(training["altitude_km"].mean())
    assert scaler.mean_[numeric.index("altitude_km")] != pytest.approx(
        pd.concat([training, held_out])["altitude_km"].mean()
    )


def test_year_walk_forward_refits_without_future_years():
    frame = _model_frame()
    frame["timestamp_utc"] = pd.to_datetime(
        [f"{2020 + index // 20}-02-{index % 20 + 1:02d}T00:00:00Z" for index in range(len(frame))],
        utc=True,
    )
    frame["forecast_issuance_time_utc"] = frame["timestamp_utc"]

    result = evaluate_year_walk_forward(frame, dataset_version="fixture-feature-v1")

    assert [fold["validation_year"] for fold in result["folds"]] == [2021, 2022]
    for model_id in ("M0", "M1", "M2", "M3"):
        model = result["models"][model_id]
        assert model["status"] == "available"
        assert model["aggregate_metrics"]["sample_count"] == 40
    assert result["models"]["M4"]["status"] == "unavailable"


def test_model_suite_scores_matched_rows_and_round_trips_artifact(tmp_path):
    frame = _model_frame()
    suite = train_model_suite(
        frame,
        experiment_mode="heliosat_predicted_arrival",
        dataset_version="fixture-feature-v1",
        artifact_root=tmp_path,
        run_id="test-run",
    )

    by_id = {model.model_id: model for model in suite.models}
    assert by_id["M4"].status == "unavailable"
    scored_counts = {
        int(model.test_metrics["sample_count"])
        for model in suite.models
        if model.status == "available" and model.test_metrics is not None
    }
    assert scored_counts == {len(suite.split.test_index)}

    artifact_path = tmp_path / str(by_id["M1"].artifact)
    payload = load_model_artifact(artifact_path)
    assert payload["artifact_schema_version"] == MODEL_ARTIFACT_SCHEMA_VERSION
    assert payload["runtime_versions"]["python"]
    assert len(payload["code_state"]["working_tree_sha256"]) == 64
    assert "altitude_km" in payload["validated_domain"]["numeric_feature_ranges"]
    assert "mission" not in payload["feature_columns"]
    assert "spacecraft_id" not in payload["feature_columns"]
    test_rows = frame.loc[list(suite.split.test_index)]
    prediction = predict_density_from_artifact(payload, test_rows)
    assert np.isfinite(prediction).all()
    assert (prediction > 0.0).all()
    assert (artifact_path.with_suffix(".joblib.metadata.json")).exists()

    summary_path = write_study_summary(
        tmp_path,
        "test-run",
        {"heliosat_predicted_arrival": suite},
        missions=["Swarm", "GRACE-FO"],
        limitations=["synthetic test fixture; never an observation"],
    )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert summary_path.name == "study-summary.v1.json"
    assert summary["status"] == "partial"
    assert summary["modes"]["reference_aligned"]["status"] == "unavailable"
    assert summary["modes"]["heliosat_predicted_arrival"]["status"] == "available"
