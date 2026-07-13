import numpy as np
import pandas as pd
import pytest

from ml.arrival_residual.features import (
    FEATURE_NAMES,
    assert_no_leakage,
    build_features,
)


def _frame(n: int = 8) -> pd.DataFrame:
    times = pd.date_range("2024-05-10", periods=n, freq="5min", tz="UTC")
    return pd.DataFrame(
        {
            "time": times,
            "speed_km_s": np.linspace(400.0, 750.0, n),
            "density_p_cc": np.full(n, 5.0),
            "bmag_nt": np.full(n, 10.0),
            "by_gsm_nt": np.full(n, 3.0),
            "bz_gsm_nt": np.linspace(2.0, -12.0, n),
            "sc_x_re": np.full(n, 250.0),
            "sc_y_re": np.full(n, 30.0),
            "sc_z_re": np.full(n, -40.0),
            "bsn_x_re": np.full(n, 14.0),
        }
    )


def test_derived_features_match_documented_formulas():
    out = build_features(_frame())
    last = out.iloc[-1]
    assert last["pdyn_npa"] == pytest.approx(1.6726e-6 * 5.0 * 750.0**2)
    # Em uses the repo convention V * max(0, -Bz) * 1e-3.
    assert last["em_mv_m"] == pytest.approx(750.0 * 12.0 * 1e-3)
    assert out.iloc[0]["em_mv_m"] == 0.0  # northward Bz contributes nothing
    assert last["sc_ryz_re"] == pytest.approx(np.hypot(30.0, -40.0))
    assert last["dist_re"] == pytest.approx(236.5)
    # Clock angle: northward start near atan2(3, 2), strongly southward end > 160 deg.
    assert out.iloc[0]["clock_angle_deg"] == pytest.approx(np.degrees(np.arctan2(3.0, 2.0)))
    assert last["clock_angle_deg"] > 160.0


def test_rolling_features_are_trailing_only():
    frame = _frame(n=40)
    out = build_features(frame)
    # A future spike must not affect earlier rolling values.
    spiked = frame.copy()
    spiked.loc[spiked.index[-1], "speed_km_s"] = 5000.0
    out_spiked = build_features(spiked)
    pd.testing.assert_series_equal(
        out["speed_mean_3h_km_s"].iloc[:-1], out_spiked["speed_mean_3h_km_s"].iloc[:-1]
    )


def test_rolling_features_restore_unsorted_input_order():
    frame = _frame(n=40)
    expected = build_features(frame).set_index("time")["speed_mean_3h_km_s"]
    shuffled = frame.sample(frac=1.0, random_state=42)
    actual = build_features(shuffled).set_index("time")["speed_mean_3h_km_s"]
    pd.testing.assert_series_equal(actual.sort_index(), expected.sort_index())


def test_leakage_guard_rejects_arrival_side_columns():
    assert_no_leakage(FEATURE_NAMES)
    with pytest.raises(AssertionError):
        assert_no_leakage(["timeshift_s"])
    with pytest.raises(AssertionError):
        assert_no_leakage(["target_resid_min"])
    with pytest.raises(AssertionError):
        assert_no_leakage(["some_unknown_column"])
