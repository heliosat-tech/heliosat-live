from __future__ import annotations

import json

import pandas as pd
import pytest

from leo_drag.forecast import (
    _build_live_driver_timeline,
    _parse_noaa_ap,
    _parse_noaa_previous_day_f107,
    _trajectory_frame,
)


def test_noaa_f107_parser_selects_previous_day_noon_record() -> None:
    # Contract fixture only; it is never exported as an official observation.
    rows = [
        {"time_tag": "2026-07-11T17:00:00Z", "flux": 109.0, "reporting_schedule": "Morning"},
        {"time_tag": "2026-07-11T20:00:00Z", "flux": 112.0, "reporting_schedule": "Noon"},
        {"time_tag": "2026-07-12T17:00:00Z", "flux": 120.0, "reporting_schedule": "Morning"},
    ]
    value, metadata = _parse_noaa_previous_day_f107(
        json.dumps(rows).encode(), pd.Timestamp("2026-07-12T21:00:00Z")
    )
    assert value == 112.0
    assert metadata["f107_time_utc"] == "2026-07-11T20:00:00Z"


def test_noaa_ap_parser_builds_seven_element_causal_history() -> None:
    timestamps = pd.date_range("2026-07-10T00:00:00Z", periods=21, freq="3h")
    rows = [
        {"time_tag": timestamp.isoformat(), "Kp": index / 10, "a_running": float(index + 1)}
        for index, timestamp in enumerate(timestamps)
    ]
    values, metadata = _parse_noaa_ap(
        json.dumps(rows).encode(), pd.Timestamp("2026-07-12T12:30:00Z")
    )
    assert values[1:5] == [21.0, 20.0, 19.0, 18.0]
    assert values[5] == pytest.approx(13.5)
    assert values[6] == pytest.approx(5.5)
    assert metadata["latest_ap_time_utc"] == "2026-07-12T12:00:00Z"


def _live_context() -> dict[str, object]:
    source_times = pd.date_range("2026-07-12T07:55:00Z", "2026-07-12T19:55:00Z", freq="5min")
    return {
        "generated_at_utc": "2026-07-12T20:00:00Z",
        "selector": {"selected_norad_id": "25544"},
        "trajectory": {
            "points": [
                {
                    "timestamp_utc": "2026-07-12T20:10:00Z",
                    "latitude_deg": 10.0,
                    "longitude_deg": 20.0,
                    "altitude_km": 410.0,
                    "local_solar_time_h": 12.0,
                    "position_km": {"x": 6800.0, "y": 0.0, "z": 0.0},
                    "velocity_km_s": {"x": 0.0, "y": 7.7, "z": 0.1},
                }
            ]
        },
        "l1_drivers": [
            {
                "source_measurement_time_l1_utc": timestamp.isoformat(),
                "available_at_utc": (timestamp + pd.Timedelta(minutes=1)).isoformat(),
                "mru_distance_km": 540_000.0,
                "vsw_km_s": 450.0,
                "np_cm3": 6.0,
                "by_gsm_nt": 1.0,
                "bz_gsm_nt": -2.0,
                "bmag_nt": 5.0,
            }
            for timestamp in source_times
        ],
    }


def test_trajectory_frame_requires_real_complete_state_vectors() -> None:
    frame = _trajectory_frame(_live_context())
    assert frame.loc[0, "position_x_m"] == 6_800_000.0
    broken = _live_context()
    broken["trajectory"] = {"points": [{"timestamp_utc": "2026-07-12T20:10:00Z"}]}
    with pytest.raises(ValueError, match="complete state vectors"):
        _trajectory_frame(broken)


def test_live_timeline_preserves_inbound_parcel_after_issuance() -> None:
    context = _live_context()
    trajectory = _trajectory_frame(context)
    timeline, last_confirmed = _build_live_driver_timeline(context, trajectory)
    assert last_confirmed == pd.Timestamp("2026-07-12T20:15:00Z")
    assert timeline.iloc[-1]["source_measurement_time_l1_utc"] == pd.Timestamp(
        "2026-07-12T19:55:00Z"
    )
    assert timeline.iloc[-1]["available_at_utc"] <= pd.Timestamp(context["generated_at_utc"])
