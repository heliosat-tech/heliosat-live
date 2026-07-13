from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from leo_drag.ancillary import build_msis_forcing_from_hourly, forcing_for_timestamps


def _synthetic_hourly() -> pd.DataFrame:
    # Scientific test fixture only; never exported as an observation artifact.
    timestamps = pd.date_range("2021-11-01", periods=130 * 24, freq="h", tz="UTC")
    three_hour_bin = ((timestamps.view("i8") // 3_600_000_000_000) // 3).astype(float)
    return pd.DataFrame({
        "timestamp_utc": timestamps,
        "ap_index_nt": three_hour_bin % 30,
        "f107_sfu": 100.0 + np.arange(len(timestamps)) // 24,
    })


def test_forcing_has_previous_day_f107_centered_mean_and_seven_ap_values() -> None:
    forcing = build_msis_forcing_from_hourly(_synthetic_hourly())
    complete = forcing.dropna(subset=[
        "f107_previous_day_sfu", "f107a_sfu", "ap_36_57h_mean"
    ])
    row = complete.iloc[len(complete) // 2]
    active = forcing.loc[forcing["forcing_time_utc"] == row["forcing_time_utc"]].iloc[0]
    current_index = forcing.index[forcing["forcing_time_utc"] == row["forcing_time_utc"]][0]
    assert active["ap_3h_before"] == pytest.approx(forcing.loc[current_index - 1, "ap_current"])
    assert active["ap_6h_before"] == pytest.approx(forcing.loc[current_index - 2, "ap_current"])
    assert active["ap_12_33h_mean"] == pytest.approx(
        forcing.loc[current_index - 11: current_index - 4, "ap_current"].mean()
    )
    timestamp = pd.Timestamp(active["forcing_time_utc"])
    day_number = (timestamp.floor("D") - pd.Timestamp("2021-11-01", tz="UTC")).days
    assert active["f107_previous_day_sfu"] == pytest.approx(100 + day_number - 1)
    assert active["f107a_sfu"] == pytest.approx(100 + day_number)
    assert active["ancillary_availability_class"] == "retrospective_only"


def test_forcing_join_is_backward_and_never_uses_next_bin() -> None:
    forcing = build_msis_forcing_from_hourly(_synthetic_hourly())
    query = [pd.Timestamp("2022-01-20T04:59:00Z")]
    aligned = forcing_for_timestamps(query, forcing)
    assert aligned.loc[0, "forcing_time_utc"] == pd.Timestamp("2022-01-20T03:00:00Z")
    assert aligned.loc[0, "forcing_time_utc"] <= aligned.loc[0, "timestamp_utc"]


def test_trailing_mean_needs_full_eighty_one_day_history() -> None:
    forcing = build_msis_forcing_from_hourly(
        _synthetic_hourly(), f107a_mode="trailing_81_day"
    )
    first_complete = forcing.loc[forcing["f107a_sfu"].notna()].iloc[0]
    first_day = pd.Timestamp(first_complete["forcing_time_utc"]).floor("D")
    assert first_day == pd.Timestamp("2022-01-21", tz="UTC")
    assert first_complete["f107a_sfu"] == pytest.approx(np.mean(np.arange(100.0, 181.0)))
    assert first_complete["ancillary_availability_class"] == "retrospective_only"
