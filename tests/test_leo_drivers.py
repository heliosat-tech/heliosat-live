from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from leo_drag.drivers import (
    HELIOSAT_MRU_ARRIVAL,
    HELIOSAT_MRU_ML_ARRIVAL,
    NOMINAL_BOW_SHOCK_DISTANCE_KM,
    PDYN_COEFFICIENT,
    add_causal_rolling_features,
    assert_causal_timeline,
    build_heliosat_mru_ml_timeline,
    build_heliosat_mru_timeline,
    build_heliosat_predicted_timeline,
    build_reference_aligned_timeline,
    causal_backward_join,
)


def _drivers() -> pd.DataFrame:
    time = pd.date_range("2022-02-03", periods=12, freq="5min", tz="UTC")
    return pd.DataFrame({
        "time": time,
        "timeshift_s": 3600,
        "speed_km_s": np.linspace(400, 510, len(time)),
        "density_p_cc": 5.0,
        "bx_gsm_nt": 1.0,
        "by_gsm_nt": 2.0,
        "bz_gsm_nt": np.linspace(-12, -1, len(time)),
        "bmag_nt": 13.0,
    })


def test_reference_driver_units_and_alignment() -> None:
    timeline, report = build_reference_aligned_timeline(_drivers())
    expected = PDYN_COEFFICIENT * 5.0 * 400.0**2
    assert timeline.loc[0, "pdyn_npa"] == pytest.approx(expected)
    assert timeline.loc[0, "em_mv_m"] == pytest.approx(400 * 12 * 1e-3)
    assert timeline.loc[0, "source_measurement_time_l1_utc"] == (
        timeline.loc[0, "arrival_time_bow_shock_utc"] - pd.Timedelta(hours=1)
    )
    assert report.mode == "reference_aligned"
    assert set(timeline["feature_availability"]) == {"retrospective_only"}


def test_heliosat_timeline_uses_honest_nominal_mru_fallback() -> None:
    source = _drivers().drop(columns=["timeshift_s"])
    source = source.rename(columns={"time": "source_time_utc"})
    timeline, report = build_heliosat_predicted_timeline(source)
    expected_minutes = NOMINAL_BOW_SHOCK_DISTANCE_KM / 400.0 / 60.0
    assert timeline.loc[0, "mru_delay_min"] == pytest.approx(expected_minutes)
    assert timeline.loc[0, "arrival_model"] == "mru_ballistic"
    assert timeline.loc[0, "distance_basis"] == "nominal_l1_to_bow_shock"
    assert report.mru_fallback_rows == len(timeline)
    assert report.arrival_ml_status == "unavailable"
    assert "path was not supplied" in str(report.arrival_ml_error)


def test_arrival_residual_is_applied_only_where_predictor_supplies_it() -> None:
    source = _drivers().drop(columns=["timeshift_s"]).rename(columns={"time": "source_time_utc"})
    timeline, report = build_heliosat_predicted_timeline(
        source,
        residual_predictor=lambda frame: [2.0] + [np.nan] * (len(frame) - 1),
    )
    assert timeline.loc[0, "arrival_model"] == "mru_ballistic_plus_arrival_residual_ml"
    assert timeline.loc[0, "arrival_residual_min"] == pytest.approx(2.0)
    assert report.ml_corrected_rows == 1


def test_explicit_mru_mode_never_attempts_to_load_arrival_ml() -> None:
    timeline, report = build_heliosat_mru_timeline(_drivers())

    assert set(timeline["experiment_mode"]) == {HELIOSAT_MRU_ARRIVAL}
    assert set(timeline["arrival_model"]) == {"mru_ballistic"}
    assert report.arrival_ml_status == "not_requested"
    assert report.arrival_ml_error is None


def test_strict_mru_ml_mode_drops_incomplete_rows_instead_of_mru_fallback() -> None:
    residuals = [2.0, None, *([3.0] * 10)]
    timeline, report = build_heliosat_mru_ml_timeline(
        _drivers(), residual_predictor=lambda _: residuals
    )

    assert set(timeline["experiment_mode"]) == {HELIOSAT_MRU_ML_ARRIVAL}
    assert set(timeline["arrival_model"]) == {"mru_ballistic_plus_arrival_residual_ml"}
    assert len(timeline) == 11
    assert report.ml_corrected_rows == 11
    assert report.mru_fallback_rows == 0
    assert report.strict_ml_rejected_rows == 1
    assert report.arrival_ml_status == "partial"


def test_strict_mru_ml_mode_surfaces_missing_artifact_and_returns_no_fake_mode(tmp_path) -> None:
    timeline, report = build_heliosat_mru_ml_timeline(
        _drivers(), arrival_model_path=tmp_path / "missing.joblib"
    )

    assert timeline.empty
    assert report.arrival_ml_status == "unavailable"
    assert report.strict_ml_rejected_rows == len(_drivers())
    assert "missing" in str(report.arrival_ml_error)


def test_rolling_features_are_causal_under_future_perturbation() -> None:
    timeline, _ = build_reference_aligned_timeline(_drivers())
    original = add_causal_rolling_features(timeline, windows=[("30m", "30min")])
    changed_timeline = timeline.copy()
    changed_timeline.loc[8:, "bz_gsm_nt"] = -1000
    changed = add_causal_rolling_features(changed_timeline, windows=[("30m", "30min")])
    column = "drv__bz_gsm_nt__mean__30m"
    np.testing.assert_allclose(original.loc[:7, column], changed.loc[:7, column])
    assert original.loc[5, column] == pytest.approx(timeline.loc[:5, "bz_gsm_nt"].mean())
    assert original.loc[0, "drv__bz_gsm_nt__coverage_fraction__30m"] == pytest.approx(1 / 7)
    assert original.loc[6, "drv__bz_gsm_nt__coverage_fraction__30m"] == pytest.approx(1.0)


def test_backward_join_requires_both_arrival_and_availability() -> None:
    timeline, _ = build_reference_aligned_timeline(_drivers().iloc[:2])
    timeline.loc[0, "available_at_utc"] = pd.Timestamp("2022-02-03T02:00:00Z")
    observations = pd.DataFrame({
        "timestamp_utc": [
            pd.Timestamp("2022-02-03T00:03:00Z"),
            pd.Timestamp("2022-02-03T00:10:00Z"),
            pd.NaT,
        ]
    })
    joined = causal_backward_join(observations, timeline, tolerance="20min")
    assert joined.loc[0, "driver_join_status"] == "missing"
    assert joined.loc[1, "driver_join_status"] == "matched"
    assert joined.loc[2, "driver_join_status"] == "missing"


def test_future_target_can_use_parcel_measured_before_issuance_and_still_inbound() -> None:
    timeline = pd.DataFrame({
        "source_measurement_time_l1_utc": [pd.Timestamp("2022-02-03T00:00:00Z")],
        "available_at_utc": [pd.Timestamp("2022-02-03T00:01:00Z")],
        "arrival_time_bow_shock_utc": [pd.Timestamp("2022-02-03T00:30:00Z")],
        "vsw_km_s": [500.0],
    })
    observations = pd.DataFrame({
        "timestamp_utc": [pd.Timestamp("2022-02-03T00:45:00Z")],
        "issued_at_utc": [pd.Timestamp("2022-02-03T00:05:00Z")],
    })
    joined = causal_backward_join(
        observations,
        timeline,
        issuance_time_column="issued_at_utc",
        tolerance="30min",
    )
    assert joined.loc[0, "driver_join_status"] == "matched"
    assert joined.loc[0, "arrival_time_bow_shock_utc"] == pd.Timestamp("2022-02-03T00:30:00Z")


def test_causal_timeline_rejects_pre_measurement_availability() -> None:
    timeline = pd.DataFrame({
        "source_measurement_time_l1_utc": ["2022-02-03T00:05:00Z"],
        "available_at_utc": ["2022-02-03T00:04:00Z"],
        "arrival_time_bow_shock_utc": ["2022-02-03T01:00:00Z"],
    })
    with pytest.raises(AssertionError, match="available before"):
        assert_causal_timeline(timeline)
