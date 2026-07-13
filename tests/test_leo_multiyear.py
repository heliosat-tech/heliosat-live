import pandas as pd

from leo_drag.multiyear import (
    CorpusInterval,
    merged_download_ranges,
    normalise_kp_archive,
    select_staged_intervals,
)


def test_missing_kp_is_not_relabelled_quiet():
    frame = normalise_kp_archive({"rows": [[1609459200000, None, None, None, None, None]]})
    assert frame["kp"].isna().all()


def test_staged_selection_covers_each_season_and_ranks_storms():
    time = pd.date_range("2021-01-01", "2021-12-31 23:00", freq="1h", tz="UTC")
    kp = pd.DataFrame({"timestamp_utc": time, "kp": 1.0})
    for when, peak in (("2021-05-10 00:00", 6.0), ("2021-08-10 00:00", 6.2), ("2021-11-03 00:00", 7.7)):
        mask = kp["timestamp_utc"].between(pd.Timestamp(when, tz="UTC"), pd.Timestamp(when, tz="UTC") + pd.Timedelta(hours=6))
        kp.loc[mask, "kp"] = peak
    intervals = select_staged_intervals(kp, start_year=2021, stop_year=2021)
    assert {item.season for item in intervals if item.kind == "quiet"} == {"DJF", "MAM", "JJA", "SON"}
    assert sum(item.kind == "moderate_storm" for item in intervals) == 2
    severe = [item for item in intervals if item.kind == "severe_storm"]
    assert len(severe) == 1 and severe[0].peak_kp == 7.7
    assert all(item.duration_days == 14.0 for item in intervals if item.kind == "quiet")


def test_download_ranges_union_overlaps_and_keep_interval_ids():
    intervals = [
        CorpusInterval("a", "quiet", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", 2024, "DJF", 1.0, 1.0, 24, "test"),
        CorpusInterval("b", "moderate_storm", "2024-01-01T12:00:00Z", "2024-01-03T00:00:00Z", 2024, "DJF", 5.0, 5.0, 2, "test"),
    ]
    merged = merged_download_ranges(intervals)
    assert len(merged) == 1
    assert merged[0]["interval_ids"] == ["a", "b"]
    assert merged[0]["duration_days"] == 2.0
