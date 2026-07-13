from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from leo_drag.drag import air_relative_velocity_m_s
from leo_drag.trajectory import (
    WGS84_SEMIMAJOR_AXIS_M,
    derive_inertial_trajectory,
    geodetic_to_ecef_m,
)


def test_geodetic_equator_maps_to_expected_ecef_radius() -> None:
    position = geodetic_to_ecef_m([0], [0], [400])[0]
    assert position[0] == pytest.approx(WGS84_SEMIMAJOR_AXIS_M + 400_000)
    assert position[1] == pytest.approx(0)
    assert position[2] == pytest.approx(0)


def test_stationary_earth_fixed_point_has_zero_air_relative_velocity() -> None:
    times = pd.date_range("2022-01-01", periods=3, freq="60s", tz="UTC")
    trajectory = derive_inertial_trajectory(times, [0, 0, 0], [0, 0, 0], [400, 400, 400])
    relative = air_relative_velocity_m_s(
        trajectory.position_inertial_m,
        trajectory.velocity_inertial_m_s,
    )
    assert trajectory.valid_velocity.all()
    np.testing.assert_allclose(relative, 0, atol=1e-10)


def test_long_gap_is_not_interpolated_into_velocity() -> None:
    times = ["2022-01-01T00:00:00Z", "2022-01-01T00:01:00Z", "2022-01-01T01:00:00Z"]
    trajectory = derive_inertial_trajectory(times, [0, 1, 2], [0, 1, 2], [400, 400, 400])
    assert trajectory.valid_velocity.tolist() == [True, False, False]
    assert np.isnan(trajectory.velocity_inertial_m_s[1:]).all()


def test_implausible_finite_difference_speed_is_rejected() -> None:
    times = pd.date_range("2022-01-01", periods=3, freq="60s", tz="UTC")
    trajectory = derive_inertial_trajectory(
        times,
        [0, 0, 0],
        [0, 179, -179],
        [400, 400, 400],
    )
    assert trajectory.valid_velocity.tolist() == [False, False, True]
    assert np.isnan(trajectory.velocity_inertial_m_s[:2]).all()
    assert np.linalg.norm(trajectory.velocity_inertial_m_s[2]) < 15_000
