"""Trajectory-state helpers for retrospective density-product positions.

VirES density products provide geodetic positions, not inertial velocities.
For the Level-1 drag study only, this module derives an Earth-fixed velocity
by finite differences and rotates the state into a consistent inertial frame.
It does not replace orbit determination and is never used to infer spacecraft
mass, area or drag coefficient.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import pandas as pd

from .drag import EARTH_ROTATION_RATE_RAD_S

WGS84_SEMIMAJOR_AXIS_M = 6_378_137.0
WGS84_FLATTENING = 1.0 / 298.257223563
WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2.0 - WGS84_FLATTENING)


@dataclass(frozen=True)
class DerivedTrajectory:
    timestamps_utc: tuple[object, ...]
    position_inertial_m: np.ndarray
    velocity_inertial_m_s: np.ndarray
    velocity_ecef_m_s: np.ndarray
    valid_velocity: np.ndarray
    method: str = "GRS80-like geodetic samples mapped with WGS84 and finite-differenced"
    evidence_class: str = "retrospective_first_order_trajectory_derivation"
    warning: str = (
        "Finite-difference state from density-product positions; not precise orbit determination."
    )


def geodetic_to_ecef_m(
    latitude_deg: Iterable[float] | np.ndarray,
    longitude_deg: Iterable[float] | np.ndarray,
    altitude_km: Iterable[float] | np.ndarray,
) -> np.ndarray:
    latitude = np.asarray(latitude_deg, dtype=float)
    longitude = np.asarray(longitude_deg, dtype=float)
    altitude = np.asarray(altitude_km, dtype=float) * 1_000.0
    if not (latitude.shape == longitude.shape == altitude.shape):
        raise ValueError("latitude, longitude and altitude shapes must match")
    if np.any(~np.isfinite(latitude)) or np.any(~np.isfinite(longitude)) or np.any(~np.isfinite(altitude)):
        raise ValueError("geodetic coordinates must be finite")
    if np.any(np.abs(latitude) > 90) or np.any(altitude < -1_000):
        raise ValueError("geodetic coordinates are outside supported bounds")
    lat = np.radians(latitude)
    lon = np.radians(longitude)
    sin_lat = np.sin(lat)
    cos_lat = np.cos(lat)
    prime_vertical = WGS84_SEMIMAJOR_AXIS_M / np.sqrt(
        1.0 - WGS84_ECCENTRICITY_SQUARED * sin_lat**2
    )
    x = (prime_vertical + altitude) * cos_lat * np.cos(lon)
    y = (prime_vertical + altitude) * cos_lat * np.sin(lon)
    z = (
        prime_vertical * (1.0 - WGS84_ECCENTRICITY_SQUARED) + altitude
    ) * sin_lat
    return np.column_stack([x, y, z])


def _rotate_z(vectors: np.ndarray, angles_rad: np.ndarray) -> np.ndarray:
    cosine = np.cos(angles_rad)
    sine = np.sin(angles_rad)
    x = cosine * vectors[:, 0] - sine * vectors[:, 1]
    y = sine * vectors[:, 0] + cosine * vectors[:, 1]
    return np.column_stack([x, y, vectors[:, 2]])


def derive_inertial_trajectory(
    timestamps_utc: Iterable[object],
    latitude_deg: Iterable[float] | np.ndarray,
    longitude_deg: Iterable[float] | np.ndarray,
    altitude_km: Iterable[float] | np.ndarray,
    *,
    maximum_gap_seconds: float = 120.0,
    maximum_inertial_speed_m_s: float = 15_000.0,
    earth_rotation_rate_rad_s: float = EARTH_ROTATION_RATE_RAD_S,
) -> DerivedTrajectory:
    timestamps = pd.DatetimeIndex(
        pd.to_datetime(list(timestamps_utc), utc=True, errors="coerce")
    ).astype("datetime64[ns, UTC]")
    if len(timestamps) < 2 or timestamps.isna().any():
        raise ValueError("at least two valid UTC trajectory timestamps are required")
    epoch_seconds = timestamps.asi8.astype(float) / 1e9
    steps = np.diff(epoch_seconds)
    if np.any(steps <= 0):
        raise ValueError("trajectory timestamps must be strictly increasing")
    if maximum_gap_seconds <= 0:
        raise ValueError("maximum_gap_seconds must be positive")
    if maximum_inertial_speed_m_s <= 0:
        raise ValueError("maximum_inertial_speed_m_s must be positive")
    ecef = geodetic_to_ecef_m(latitude_deg, longitude_deg, altitude_km)
    if len(ecef) != len(timestamps):
        raise ValueError("coordinate and timestamp lengths must match")

    velocity_ecef = np.full_like(ecef, np.nan)
    valid = np.zeros(len(ecef), dtype=bool)
    if steps[0] <= maximum_gap_seconds:
        velocity_ecef[0] = (ecef[1] - ecef[0]) / steps[0]
        valid[0] = True
    if steps[-1] <= maximum_gap_seconds:
        velocity_ecef[-1] = (ecef[-1] - ecef[-2]) / steps[-1]
        valid[-1] = True
    for index in range(1, len(ecef) - 1):
        if steps[index - 1] <= maximum_gap_seconds and steps[index] <= maximum_gap_seconds:
            elapsed = epoch_seconds[index + 1] - epoch_seconds[index - 1]
            velocity_ecef[index] = (ecef[index + 1] - ecef[index - 1]) / elapsed
            valid[index] = True

    elapsed_from_start = epoch_seconds - epoch_seconds[0]
    angles = earth_rotation_rate_rad_s * elapsed_from_start
    inertial_position = _rotate_z(ecef, angles)
    omega_cross_r_ecef = np.column_stack([
        -earth_rotation_rate_rad_s * ecef[:, 1],
        earth_rotation_rate_rad_s * ecef[:, 0],
        np.zeros(len(ecef)),
    ])
    inertial_velocity = _rotate_z(velocity_ecef + omega_cross_r_ecef, angles)
    implausible = np.linalg.norm(inertial_velocity, axis=1) > maximum_inertial_speed_m_s
    valid &= ~implausible
    velocity_ecef[~valid] = np.nan
    inertial_velocity[~valid] = np.nan
    return DerivedTrajectory(
        timestamps_utc=tuple(timestamps.to_pydatetime()),
        position_inertial_m=inertial_position,
        velocity_inertial_m_s=inertial_velocity,
        velocity_ecef_m_s=velocity_ecef,
        valid_velocity=valid,
    )


__all__ = [
    "DerivedTrajectory",
    "WGS84_ECCENTRICITY_SQUARED",
    "WGS84_FLATTENING",
    "WGS84_SEMIMAJOR_AXIS_M",
    "derive_inertial_trajectory",
    "geodetic_to_ecef_m",
]
