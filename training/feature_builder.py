from __future__ import annotations

import math
from typing import Any

import pandas as pd

from .data_loader import LoadedDataset


def _find_column(columns: list[str], candidates: tuple[str, ...]) -> str | None:
    lowered = {column.lower(): column for column in columns}

    for candidate in candidates:
        for lowered_name, original in lowered.items():
            if candidate in lowered_name:
                return original

    return None


def _add_derived_physics(frame: pd.DataFrame, base_columns: list[str]) -> list[str]:
    created: list[str] = []
    bx = _find_column(base_columns, ("bx", "b_x", "br", "gsm_x"))
    by = _find_column(base_columns, ("by", "b_y", "bt", "gsm_y"))
    bz = _find_column(base_columns, ("bz", "b_z", "bn", "gsm_z"))
    speed = _find_column(base_columns, ("speed", "vp", "bulk"))
    density = _find_column(base_columns, ("density", "np", "proton_density"))

    if bx and by and bz:
        frame["derived__b_magnitude"] = (frame[bx] ** 2 + frame[by] ** 2 + frame[bz] ** 2) ** 0.5
        frame["derived__clock_angle"] = frame.apply(lambda row: math.atan2(row[by], row[bz]) if pd.notna(row[by]) and pd.notna(row[bz]) else pd.NA, axis=1)
        created.extend(["derived__b_magnitude", "derived__clock_angle"])

    if speed and bz:
        frame["derived__motional_electric_field"] = frame[speed] * frame[bz].abs() / 1000.0
        created.append("derived__motional_electric_field")

    if speed and density:
        frame["derived__dynamic_pressure"] = frame[density] * (frame[speed] ** 2)
        created.append("derived__dynamic_pressure")

    return created


def build_feature_matrix(loaded: LoadedDataset, config: dict[str, Any]) -> pd.DataFrame:
    frame = loaded.frame.sort_values("timestamp_utc").copy()
    feature_columns: list[str] = []
    base_columns = loaded.base_feature_columns.copy()
    feature_config = config["features"]

    if feature_config.get("derived_physics"):
        base_columns.extend(_add_derived_physics(frame, base_columns))

    if feature_config.get("lag_features"):
        for column in base_columns:
            for lag_minutes in feature_config.get("lag_steps_minutes", []):
                feature_name = f"{column}__lag_{lag_minutes}m"
                frame[feature_name] = frame[column].shift(lag_minutes)
                feature_columns.append(feature_name)

    if feature_config.get("rolling_stats"):
        for column in base_columns:
            for window_minutes in feature_config.get("rolling_windows_minutes", []):
                rolling = frame[column].rolling(window_minutes, min_periods=max(2, window_minutes // 3))
                for stat_name, values in {
                    "mean": rolling.mean(),
                    "std": rolling.std(),
                    "min": rolling.min(),
                    "max": rolling.max(),
                }.items():
                    feature_name = f"{column}__roll_{window_minutes}m_{stat_name}"
                    frame[feature_name] = values
                    feature_columns.append(feature_name)

    if feature_config.get("spectral"):
        for column in base_columns:
            feature_name = f"{column}__spectral_energy_60m"
            frame[feature_name] = frame[column].rolling(60, min_periods=20).apply(lambda values: float((values**2).mean()), raw=True)
            feature_columns.append(feature_name)

    if not feature_columns:
        feature_columns = base_columns

    horizon = int(config["horizon_minutes"])
    frame["y"] = frame[loaded.target_column].shift(-horizon)
    frame["y_current"] = frame[loaded.target_column]
    frame = frame.dropna(subset=feature_columns + ["y", "y_current"]).reset_index(drop=True)
    frame.attrs["feature_columns"] = feature_columns
    frame.attrs["target_column"] = loaded.target_column
    frame.attrs["horizon_minutes"] = horizon

    return frame
