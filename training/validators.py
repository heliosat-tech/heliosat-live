from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class FoldSplit:
    fold: int
    train_start: pd.Timestamp
    train_stop: pd.Timestamp
    val_start: pd.Timestamp
    val_stop: pd.Timestamp
    train_index: pd.Index
    val_index: pd.Index


def build_event_holdout_mask(
    frame: pd.DataFrame,
    threshold: int,
    timestamp_column: str = "timestamp_utc",
    symh_column: str = "sym_h",
    window_hours: int = 48,
) -> pd.Series:
    if symh_column not in frame.columns:
        return pd.Series(False, index=frame.index)

    timestamps = pd.to_datetime(frame[timestamp_column], utc=True)
    storm_times = timestamps[frame[symh_column] < threshold]
    mask = pd.Series(False, index=frame.index)

    for storm_time in storm_times:
        mask |= timestamps.between(
            storm_time - pd.Timedelta(hours=window_hours),
            storm_time + pd.Timedelta(hours=window_hours),
            inclusive="both",
        )

    return mask


def build_walk_forward_splits(
    frame: pd.DataFrame,
    n_folds: int,
    timestamp_column: str = "timestamp_utc",
    excluded_mask: pd.Series | None = None,
) -> list[FoldSplit]:
    if n_folds < 1:
        raise ValueError("n_folds must be >= 1")

    if frame.empty:
        raise ValueError("cannot split an empty dataset")

    timestamps = pd.to_datetime(frame[timestamp_column], utc=True)
    ordered = frame.assign(_timestamp=timestamps).sort_values("_timestamp")
    timestamps = ordered["_timestamp"]
    excluded = pd.Series(False, index=ordered.index) if excluded_mask is None else excluded_mask.reindex(ordered.index).fillna(False)
    start = timestamps.iloc[0]
    stop = timestamps.iloc[-1]

    if start >= stop:
        raise ValueError("training window must span more than one timestamp")

    boundaries = pd.date_range(start=start, end=stop, periods=n_folds + 2)
    splits: list[FoldSplit] = []

    for fold in range(1, n_folds + 1):
        train_start = boundaries[0]
        train_stop = boundaries[fold]
        val_start = boundaries[fold]
        val_stop = boundaries[fold + 1]
        train_mask = (timestamps >= train_start) & (timestamps < train_stop) & ~excluded
        val_mask = (timestamps >= val_start) & (timestamps < val_stop) & ~excluded

        if not train_mask.any() or not val_mask.any():
            continue

        splits.append(
            FoldSplit(
                fold=fold,
                train_start=train_start,
                train_stop=train_stop,
                val_start=val_start,
                val_stop=val_stop,
                train_index=ordered.index[train_mask],
                val_index=ordered.index[val_mask],
            )
        )

    if not splits:
        raise ValueError("walk-forward split produced no non-empty folds")

    return splits
