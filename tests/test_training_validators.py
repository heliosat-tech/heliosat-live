import pandas as pd

from training.validators import build_event_holdout_mask, build_walk_forward_splits


def test_walk_forward_splits_expand_training_window():
    frame = pd.DataFrame({
        "timestamp_utc": pd.date_range("2024-01-01", periods=12, freq="1h", tz="UTC"),
        "y": range(12),
    })

    splits = build_walk_forward_splits(frame, n_folds=3)

    assert len(splits) == 3
    assert len(splits[0].train_index) < len(splits[1].train_index) < len(splits[2].train_index)
    assert all(len(split.val_index) > 0 for split in splits)


def test_event_holdout_masks_storm_window():
    frame = pd.DataFrame({
        "timestamp_utc": pd.date_range("2024-01-01", periods=7, freq="24h", tz="UTC"),
        "sym_h": [0, -20, -120, -30, 5, -150, 0],
    })

    mask = build_event_holdout_mask(frame, threshold=-100, window_hours=24)

    assert mask.sum() >= 5
    assert bool(mask.iloc[2])
    assert bool(mask.iloc[5])

