from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PARQUET_ROOT = PROJECT_ROOT / "data" / "parquet"
SOURCE_MAP = {
    "omni_hro_1min": "omni_hro_1min",
    "dscovr_archive": "dscovr_archive",
    "ace_archive": "ace_archive",
}
TARGET_SPACECRAFT_MAP = {
    "goes16": "GOES-16",
    "goes17": "GOES-17",
    "goes18": "GOES-18",
    "goes19": "GOES-19",
}


@dataclass(frozen=True)
class LoadedDataset:
    frame: pd.DataFrame
    target_column: str
    base_feature_columns: list[str]


def _parse_utc(value: str) -> pd.Timestamp:
    return pd.Timestamp(value).tz_convert("UTC") if pd.Timestamp(value).tzinfo else pd.Timestamp(value, tz="UTC")


def _source_root(source: str, parquet_root: Path) -> Path:
    return parquet_root / f"source={source}"


def _find_parquet_files(source: str, parquet_root: Path, spacecraft: str | None = None) -> list[Path]:
    root = _source_root(source, parquet_root)

    if not root.exists():
        return []

    if spacecraft:
        spacecraft_root = root / f"spacecraft={spacecraft}"
        return sorted(spacecraft_root.glob("**/*.parquet"))

    return sorted(root.glob("**/*.parquet"))


def _choose_primary_goes(parquet_root: Path) -> str:
    for spacecraft in ("GOES-19", "GOES-18", "GOES-17", "GOES-16"):
        if _find_parquet_files("goes_nccei", parquet_root, spacecraft):
            return spacecraft

    raise FileNotFoundError("No GOES NCEI Parquet partitions found for primary target selection")


def _read_parquet_files(paths: list[Path], start: pd.Timestamp, stop: pd.Timestamp) -> pd.DataFrame:
    if not paths:
        raise FileNotFoundError("No Parquet files matched the requested source")

    frames = []

    for path in paths:
        frame = pd.read_parquet(path)

        if "timestamp_utc" not in frame.columns:
            raise ValueError(f"{path} is missing timestamp_utc")

        frame["timestamp_utc"] = pd.to_datetime(frame["timestamp_utc"], utc=True)
        frame = frame[(frame["timestamp_utc"] >= start) & (frame["timestamp_utc"] <= stop)]

        if not frame.empty:
            frames.append(frame)

    if not frames:
        raise ValueError("No rows found in the experiment training window")

    return pd.concat(frames, ignore_index=True)


def _long_to_wide(frame: pd.DataFrame, value_prefix: str = "") -> pd.DataFrame:
    if {"variable", "value"}.issubset(frame.columns):
        working = frame.copy()

        if "quality_flag" in working.columns:
            working.loc[working["quality_flag"].fillna(4).astype(float) > 1, "value"] = pd.NA

        wide = working.pivot_table(
            index="timestamp_utc",
            columns="variable",
            values="value",
            aggfunc="mean",
        )
        wide.columns = [f"{value_prefix}{column}" for column in wide.columns]
        return wide.sort_index()

    value_columns = [
        column
        for column in frame.columns
        if column not in {"timestamp_utc", "source", "spacecraft_id", "mission", "instrument", "quality_flag", "unit", "cadence_s"}
        and pd.api.types.is_numeric_dtype(frame[column])
    ]

    if not value_columns:
        raise ValueError("No numeric data columns found in source frame")

    return frame.set_index("timestamp_utc")[value_columns].sort_index().add_prefix(value_prefix)


def _resample_limited(frame: pd.DataFrame) -> pd.DataFrame:
    resampled = frame.resample("1min").mean()
    return resampled.interpolate(method="time", limit=2, limit_direction="both")


def load_training_dataset(config: dict[str, Any], parquet_root: Path = DEFAULT_PARQUET_ROOT) -> LoadedDataset:
    start = _parse_utc(config["training_window"]["start_utc"])
    stop = _parse_utc(config["training_window"]["stop_utc"])
    l1_source = SOURCE_MAP.get(config["l1_source"], config["l1_source"])
    target_source = config["target"]["source"]
    target_variable = config["target"]["variable"]
    target_spacecraft = config["target"]["spacecraft"]

    if target_source != "goes_nccei":
        raise ValueError(f"Unsupported target source: {target_source}")

    spacecraft = _choose_primary_goes(parquet_root) if target_spacecraft == "primary" else TARGET_SPACECRAFT_MAP[target_spacecraft]
    l1_paths = _find_parquet_files(l1_source, parquet_root)
    target_paths = _find_parquet_files("goes_nccei", parquet_root, spacecraft)

    if not l1_paths:
        raise FileNotFoundError(
            f"No local Parquet partitions found for L1 source '{l1_source}' under {parquet_root}. "
            "Backfill OMNI/DSCOVR/ACE before launching training."
        )

    l1_frame = _long_to_wide(_read_parquet_files(l1_paths, start, stop), "l1__")
    target_frame = _long_to_wide(_read_parquet_files(target_paths, start, stop), "target__")
    target_column = f"target__{target_variable}"

    if target_column not in target_frame.columns:
        available = ", ".join(sorted(column.replace("target__", "") for column in target_frame.columns[:20]))
        raise ValueError(f"Target variable '{target_variable}' not found in GOES data. Available sample: {available}")

    aligned = pd.concat([
        _resample_limited(l1_frame),
        _resample_limited(target_frame[[target_column]]),
    ], axis=1)
    aligned.index.name = "timestamp_utc"
    aligned = aligned.reset_index()

    base_feature_columns = [column for column in aligned.columns if column.startswith("l1__")]
    base_feature_columns.append(target_column)

    return LoadedDataset(
        frame=aligned,
        target_column=target_column,
        base_feature_columns=base_feature_columns,
    )

