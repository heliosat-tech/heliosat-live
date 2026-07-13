"""Deterministic planning helpers for the staged multi-year LEO corpus.

The planner selects intervals from the local official Kp archive before any
mission download is attempted.  It deliberately keeps the scientific labels
(``quiet``, ``moderate_storm`` and ``severe_storm``) separate from the
download ranges and records the exact selection rule in a versioned manifest.
No density value is synthesized by this module.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping, Sequence

import numpy as np
import pandas as pd

from .schema import COLLECTIONS

MULTIYEAR_PLAN_SCHEMA_VERSION = "leo-multiyear-corpus-plan-v1"
DEFAULT_COLLECTION_IDS: tuple[str, ...] = (
    "SW_OPER_DNSAPOD_2_",
    "SW_OPER_DNSBPOD_2_",
    "SW_OPER_DNSCPOD_2_",
    "GF_OPER_DNS1ACC_2_",
)

IntervalKind = Literal["quiet", "moderate_storm", "severe_storm"]


def _iso(value: object) -> str:
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp.isoformat().replace("+00:00", "Z")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class CorpusInterval:
    interval_id: str
    kind: IntervalKind
    start_utc: str
    stop_utc: str
    year: int
    season: str | None
    peak_kp: float | None
    mean_kp: float | None
    kp_samples: int
    selection_rule: str

    @property
    def duration_days(self) -> float:
        start = pd.Timestamp(self.start_utc)
        stop = pd.Timestamp(self.stop_utc)
        return (stop - start).total_seconds() / 86_400.0


def normalise_kp_archive(payload: Mapping[str, Any] | pd.DataFrame) -> pd.DataFrame:
    """Return hourly UTC Kp without turning missing values into quiet values."""

    if isinstance(payload, pd.DataFrame):
        frame = payload.copy()
        time_column = "timestamp_utc" if "timestamp_utc" in frame else "time"
        if time_column not in frame or "kp" not in frame:
            raise ValueError("Kp frame requires timestamp_utc/time and kp")
        out = frame[[time_column, "kp"]].rename(columns={time_column: "timestamp_utc"})
    else:
        records = []
        for row in payload.get("rows") or []:
            if isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and len(row) >= 6:
                records.append((row[0], row[5]))
        out = pd.DataFrame(records, columns=["timestamp_ms", "kp"])
        out["timestamp_utc"] = pd.to_datetime(
            out.pop("timestamp_ms"), unit="ms", utc=True, errors="coerce"
        )
    out["timestamp_utc"] = pd.to_datetime(
        out["timestamp_utc"], utc=True, errors="coerce"
    ).astype("datetime64[ns, UTC]")
    out["kp"] = pd.to_numeric(out["kp"], errors="coerce")
    return (
        out.dropna(subset=["timestamp_utc"])
        .sort_values("timestamp_utc")
        .drop_duplicates("timestamp_utc", keep="last")
        .reset_index(drop=True)
    )


def _storm_events(kp: pd.DataFrame) -> pd.DataFrame:
    active = kp.loc[kp["kp"].ge(6.0) & kp["kp"].notna()].copy()
    if active.empty:
        return pd.DataFrame(
            columns=["start", "stop", "peak_kp", "mean_kp", "kp_samples", "year", "kind"]
        )
    # The archive repeats each three-hour planetary Kp value hourly.  A gap
    # greater than three hours therefore begins a new threshold episode.
    active["new_event"] = active["timestamp_utc"].diff().gt(pd.Timedelta(hours=3))
    active.loc[active.index[0], "new_event"] = True
    active["event_group"] = active["new_event"].cumsum()
    events = active.groupby("event_group", sort=True).agg(
        start=("timestamp_utc", "min"),
        stop=("timestamp_utc", "max"),
        peak_kp=("kp", "max"),
        mean_kp=("kp", "mean"),
        kp_samples=("kp", "count"),
    )
    events["year"] = events["start"].dt.year.astype(int)
    events["kind"] = np.where(events["peak_kp"].ge(7.0), "severe_storm", "moderate_storm")
    return events.reset_index(drop=True)


def _overlaps(start: pd.Timestamp, stop: pd.Timestamp, ranges: Iterable[tuple[pd.Timestamp, pd.Timestamp]]) -> bool:
    return any(start < right_stop and stop > right_start for right_start, right_stop in ranges)


def _season(month: int) -> str:
    if month in (12, 1, 2):
        return "DJF"
    if month in (3, 4, 5):
        return "MAM"
    if month in (6, 7, 8):
        return "JJA"
    return "SON"


def _quiet_intervals(
    kp: pd.DataFrame,
    *,
    years: Sequence[int],
    excluded: Sequence[tuple[pd.Timestamp, pd.Timestamp]],
) -> list[CorpusInterval]:
    intervals: list[CorpusInterval] = []
    for year in years:
        for season in ("DJF", "MAM", "JJA", "SON"):
            first = pd.Timestamp(f"{year}-01-01", tz="UTC")
            last = pd.Timestamp(f"{year + 1}-01-01", tz="UTC")
            candidates: list[tuple[float, float, pd.Timestamp, int]] = []
            duration = pd.Timedelta(days=14)
            for duration_days in (14, 7, 3):
                duration = pd.Timedelta(days=duration_days)
                candidates = []
                for start in pd.date_range(first, last - duration, freq="1D"):
                    if _season(int(start.month)) != season:
                        continue
                    stop = start + duration
                    # A seasonal block must remain within one meteorological
                    # season instead of crossing a boundary for a lower score.
                    if _season(int((stop - pd.Timedelta(hours=1)).month)) != season:
                        continue
                    if _overlaps(start, stop, excluded):
                        continue
                    window = kp.loc[
                        kp["timestamp_utc"].ge(start) & kp["timestamp_utc"].lt(stop), "kp"
                    ].dropna()
                    # A quiet block must contain at least 75% of its hourly labels;
                    # missing Kp is never interpreted as quiet.
                    if len(window) < duration_days * 18 or float(window.max()) >= 5.0:
                        continue
                    candidates.append((float(window.max()), float(window.mean()), start, len(window)))
                if candidates:
                    break
            if not candidates:
                continue
            maximum, mean, start, count = min(candidates, key=lambda item: (item[0], item[1], item[2]))
            intervals.append(CorpusInterval(
                interval_id=f"quiet-{year}-{season.lower()}-{start:%Y%m%d}",
                kind="quiet",
                start_utc=_iso(start),
                stop_utc=_iso(start + duration),
                year=year,
                season=season,
                peak_kp=maximum,
                mean_kp=mean,
                kp_samples=count,
                selection_rule=(
                    f"lowest ({duration.days}-day maximum Kp, mean Kp, UTC start date) among "
                    "at least 75%-complete Kp<5 candidates wholly inside the season and "
                    "not overlapping a Kp>=6 threshold episode; 14 days preferred with "
                    "documented 7/3-day fallback when solar activity leaves no quiet block"
                ),
            ))
    return intervals


def select_staged_intervals(
    kp: pd.DataFrame,
    *,
    start_year: int = 2021,
    stop_year: int = 2025,
    moderate_per_year: int | None = None,
) -> list[CorpusInterval]:
    """Select seasonal quiet days plus ranked moderate/severe storm windows.

    Every Kp >= 6 episode is retained with two days before onset and five days
    after the final threshold-labelled hour.  This avoids selecting storms by
    downstream model performance.  ``moderate_per_year`` is an optional
    deterministic cap for resource-constrained dry runs; the thesis-stage
    default is all events.
    """

    if start_year > stop_year:
        raise ValueError("start_year must not exceed stop_year")
    source = normalise_kp_archive(kp)
    start = pd.Timestamp(f"{start_year}-01-01", tz="UTC")
    stop = pd.Timestamp(f"{stop_year + 1}-01-01", tz="UTC")
    source = source[source["timestamp_utc"].ge(start) & source["timestamp_utc"].lt(stop)]
    events = _storm_events(source)
    selected_events: list[CorpusInterval] = []
    occupied: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    quiet_excluded: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    for year in range(start_year, stop_year + 1):
        annual = events.loc[events["year"].eq(year)].copy()
        annual = annual.sort_values("start")
        if moderate_per_year is not None:
            severe = annual.loc[annual["kind"].eq("severe_storm")]
            moderate = annual.loc[annual["kind"].eq("moderate_storm")].sort_values(
                ["peak_kp", "kp_samples", "start"], ascending=[False, False, True]
            ).head(max(0, moderate_per_year))
            annual = pd.concat([severe, moderate]).sort_values("start")
        for _, row in annual.iterrows():
            window_start = pd.Timestamp(row["start"]) - pd.Timedelta(days=2)
            window_stop = pd.Timestamp(row["stop"]) + pd.Timedelta(days=5, hours=1)
            occupied.append((window_start, window_stop))
            quiet_excluded.append((pd.Timestamp(row["start"]), pd.Timestamp(row["stop"]) + pd.Timedelta(hours=1)))
            kind: IntervalKind = str(row["kind"])  # type: ignore[assignment]
            selected_events.append(CorpusInterval(
                interval_id=f"{kind.replace('_storm', '')}-{year}-{pd.Timestamp(row['start']):%Y%m%dT%H%M}",
                kind=kind,
                start_utc=_iso(window_start),
                stop_utc=_iso(window_stop),
                year=year,
                season=_season(int(pd.Timestamp(row["start"]).month)),
                peak_kp=float(row["peak_kp"]),
                mean_kp=float(row["mean_kp"]),
                kp_samples=int(row["kp_samples"]),
                selection_rule=(
                    "all Kp >= 6 threshold episodes; two days pre-onset plus five days "
                    "after the final threshold-labelled hour"
                ),
            ))
    quiet = _quiet_intervals(
        source,
        years=list(range(start_year, stop_year + 1)),
        excluded=quiet_excluded,
    )
    return sorted([*selected_events, *quiet], key=lambda item: (item.start_utc, item.interval_id))


def merged_download_ranges(intervals: Sequence[CorpusInterval]) -> list[dict[str, Any]]:
    """Union overlapping scientific intervals without losing their labels."""

    ranges = sorted(
        [(pd.Timestamp(item.start_utc), pd.Timestamp(item.stop_utc), item.interval_id) for item in intervals],
        key=lambda item: item[0],
    )
    merged: list[dict[str, Any]] = []
    for start, stop, interval_id in ranges:
        if merged and start <= pd.Timestamp(merged[-1]["stop_utc"]):
            if stop > pd.Timestamp(merged[-1]["stop_utc"]):
                merged[-1]["stop_utc"] = _iso(stop)
            merged[-1]["interval_ids"].append(interval_id)
        else:
            merged.append({
                "start_utc": _iso(start),
                "stop_utc": _iso(stop),
                "interval_ids": [interval_id],
            })
    for item in merged:
        item["duration_days"] = (
            pd.Timestamp(item["stop_utc"]) - pd.Timestamp(item["start_utc"])
        ).total_seconds() / 86_400.0
    return merged


def _pilot_rates(data_root: Path) -> dict[str, float]:
    manifest_path = data_root / "processed" / "thermosphere" / "manifest.v1.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {"entries": []}

    def referenced_bytes(field: str) -> int:
        values: set[str] = set()
        for entry in manifest.get("entries") or []:
            if not isinstance(entry, Mapping):
                continue
            raw = entry.get(field)
            if isinstance(raw, str):
                values.add(raw)
            elif isinstance(raw, Sequence):
                values.update(str(item) for item in raw)
        total = 0
        for value in values:
            candidate = Path(value)
            path = candidate if candidate.is_absolute() else data_root / candidate
            if path.is_file():
                total += path.stat().st_size
        return total

    raw_bytes = referenced_bytes("raw_file")
    processed_bytes = referenced_bytes("processed_files")
    baseline_bytes = referenced_bytes("baseline_files")
    # The canonical pilot is five complete UTC days.  Rates are estimates, not
    # promises: HAPI JSON compressibility and product availability vary.
    days = 5.0
    return {
        "raw_bytes_per_day": raw_bytes / days,
        "processed_bytes_per_day": processed_bytes / days,
        "baseline_bytes_per_day": baseline_bytes / days,
    }


def build_corpus_plan(
    kp: pd.DataFrame,
    *,
    data_root: str | Path = "data",
    start_year: int = 2021,
    stop_year: int = 2025,
    collection_ids: Sequence[str] = DEFAULT_COLLECTION_IDS,
) -> dict[str, Any]:
    unknown = sorted(set(collection_ids) - set(COLLECTIONS))
    if unknown:
        raise ValueError(f"unsupported official collection(s): {unknown}")
    intervals = select_staged_intervals(kp, start_year=start_year, stop_year=stop_year)
    if not intervals:
        raise ValueError("the Kp archive yielded no staged intervals")
    downloads = merged_download_ranges(intervals)
    effective_days = len({
        day
        for item in downloads
        for day in pd.date_range(
            pd.Timestamp(item["start_utc"]).floor("D"),
            (pd.Timestamp(item["stop_utc"]) - pd.Timedelta(microseconds=1)).floor("D"),
            freq="1D",
        )
    })
    download_days = sum(float(item["duration_days"]) for item in downloads)
    rates = _pilot_rates(Path(data_root))
    estimated = {
        key.replace("_per_day", ""): int(math.ceil(value * download_days))
        for key, value in rates.items()
    }
    # Three one-minute feature timelines are estimated from the two current
    # pilot feature Parquets; models may downsample to five minutes in memory.
    feature_files = list((Path(data_root) / "processed" / "thermosphere-features").rglob("*.parquet"))
    feature_rate = (
        float(np.median([path.stat().st_size for path in feature_files])) / 5.0
        if feature_files else 1_750_000.0
    )
    estimated["three_mode_feature_bytes"] = int(math.ceil(feature_rate * download_days * 3.0))
    estimated["total_before_model_artifacts_bytes"] = int(sum(estimated.values()))
    interval_payload = [asdict(item) | {"duration_days": item.duration_days} for item in intervals]
    plan_core: dict[str, Any] = {
        "schema_version": MULTIYEAR_PLAN_SCHEMA_VERSION,
        "strategy": "thesis_stage_1_official_event_and_season_sample",
        "study_period": {
            "start_utc": f"{start_year}-01-01T00:00:00Z",
            "stop_utc": f"{stop_year + 1}-01-01T00:00:00Z",
            "calendar_years": list(range(start_year, stop_year + 1)),
        },
        "collections": list(collection_ids),
        "intervals": interval_payload,
        "download_ranges": downloads,
        "coverage_summary": {
            "effective_observation_days": effective_days,
            "download_duration_days": download_days,
            "quiet_intervals": sum(item.kind == "quiet" for item in intervals),
            "moderate_storms": sum(item.kind == "moderate_storm" for item in intervals),
            "severe_storms": sum(item.kind == "severe_storm" for item in intervals),
            "spacecraft_count": len(collection_ids),
        },
        "size_estimate": {
            "basis": "measured five-day local official pilot; decimal bytes",
            "rates": rates,
            **estimated,
        },
        "analysis_cadence": "5min",
        "retained_observation_cadence": "1min",
        "selection_source": {
            "name": "local official NASA OMNI/Kp archive used by the Internal Console",
            "missing_kp_policy": "unavailable; never relabelled quiet",
        },
    }
    digest = hashlib.sha256(
        json.dumps(plan_core, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        **plan_core,
        "plan_id": f"staged-{start_year}-{stop_year}-{digest[:12]}",
        "plan_sha256": digest,
        "generated_at_utc": _now(),
    }


def write_corpus_plan(plan: Mapping[str, Any], path: str | Path) -> Path:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(dict(plan), indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, destination)
    return destination


__all__ = [
    "CorpusInterval",
    "DEFAULT_COLLECTION_IDS",
    "MULTIYEAR_PLAN_SCHEMA_VERSION",
    "build_corpus_plan",
    "merged_download_ranges",
    "normalise_kp_archive",
    "select_staged_intervals",
    "write_corpus_plan",
]
