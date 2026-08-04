#!/usr/bin/env python3
"""Generate the versioned geomagnetic-storm validation report artifact.

This is an operationally-causal replay of the current HelioSat L1 -> Earth
storm heuristic.  High-resolution OMNI supplies the upstream parcel values and
its retrospective phase-front time shift.  The time shift is used only to
recover when the parcel was observed at L1; the forecast arrival is recomputed
with HelioSat's deployable MRU geometry.  The resulting Kp estimate is scored
against definitive GFZ Kp in native three-hour bins.

The output is intentionally UI-ready JSON so the console can render a technical
report without doing expensive scientific processing in a request handler.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OMNI_DIR = PROJECT_ROOT / "data" / "cache" / "omni_high_res"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "console" / "geomagnetic-storm-study.json"
NOAA_CACHE = PROJECT_ROOT / "data" / "cache" / "noaa_0030_kp_forecasts_2025_2026.json"
GFZ_NOWCAST_CACHE = PROJECT_ROOT / "data" / "cache" / "gfz_nowcast_kp_2025_2026.json"
NOAA_ARCHIVE_ROOT = "https://www.ngdc.noaa.gov/stp/space-weather/swpc-products/daily_reports/3day_forecast"
GFZ_NOWCAST_ROOT = "https://datapub.gfz.de/download/10.5880.Kp.0001/Kp_nowcast"

SPAN_START = pd.Timestamp("2021-01-01T00:00:00Z")
SPAN_STOP = pd.Timestamp("2026-05-01T00:00:00Z")
EVALUATION_START = pd.Timestamp("2025-01-01T00:00:00Z")
BIN = pd.Timedelta(hours=3)
MIN_FORECAST_ROWS_PER_BIN = 18
EVENT_MATCH_TOLERANCE = BIN

RE_KM = 6371.2
NOMINAL_BOW_SHOCK_X_RE = 13.5

# 0-based columns in SPDF high-resolution OMNI 5-minute ASCII files.
COLS = {
    "year": 0,
    "doy": 1,
    "hour": 2,
    "minute": 3,
    "timeshift_s": 9,
    "bmag_nt": 13,
    "bz_gsm_nt": 18,
    "speed_km_s": 21,
    "density_p_cc": 25,
    "sc_x_re": 31,
}

EM_KP_ANCHORS = [(0.0, 1.0), (0.5, 3.0), (1.5, 4.0), (2.5, 5.0), (4.0, 6.0), (6.0, 7.0), (9.0, 8.0), (13.0, 9.0)]
SPEED_KP_ANCHORS = [(350.0, 0.0), (450.0, 2.0), (550.0, 3.0), (650.0, 4.0), (800.0, 5.0)]


@dataclass(frozen=True)
class Episode:
    start: pd.Timestamp
    end: pd.Timestamp
    peak_kp: float


def _round(value: float | int | None, digits: int = 3) -> float | int | None:
    if value is None or not math.isfinite(float(value)):
        return None
    return round(float(value), digits)


def _pct(numerator: int, denominator: int) -> float | None:
    return _round(100.0 * numerator / denominator, 1) if denominator else None


def _wilson_pct(successes: int, total: int, z: float = 1.959963984540054) -> list[float] | None:
    """Wilson 95% interval for a binomial proportion, returned in percent."""
    if total <= 0:
        return None
    proportion = successes / total
    denominator = 1 + z**2 / total
    centre = (proportion + z**2 / (2 * total)) / denominator
    margin = z * math.sqrt(proportion * (1 - proportion) / total + z**2 / (4 * total**2)) / denominator
    return [round(100 * max(0.0, centre - margin), 1), round(100 * min(1.0, centre + margin), 1)]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_omni(path: Path) -> pd.DataFrame:
    usecols = sorted(COLS.values())
    names = {index: name for name, index in COLS.items()}
    frame = pd.read_csv(path, sep=r"\s+", header=None, usecols=usecols, engine="c")
    frame.columns = [names[index] for index in usecols]
    target_time = (
        pd.to_datetime(frame["year"] * 1000 + frame["doy"], format="%Y%j", utc=True)
        + pd.to_timedelta(frame["hour"], unit="h")
        + pd.to_timedelta(frame["minute"], unit="m")
    )
    frame = frame.drop(columns=["year", "doy", "hour", "minute"])
    frame.insert(0, "target_time", target_time)
    return frame


def _load_omni() -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    files = [OMNI_DIR / f"omni_5min{year}.asc" for year in range(SPAN_START.year, SPAN_STOP.year + 1)]
    missing = [path for path in files if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing OMNI files: {', '.join(str(path) for path in missing)}")
    frames = [_parse_omni(path) for path in files]
    frame = pd.concat(frames, ignore_index=True)
    frame = frame[(frame["target_time"] >= SPAN_START) & (frame["target_time"] < SPAN_STOP)].copy()

    valid = (
        frame["timeshift_s"].between(1, 899_999)
        & frame["speed_km_s"].between(1, 89_999)
        & frame["sc_x_re"].abs().lt(9_999)
    )
    frame = frame[valid].copy()
    frame.loc[frame["bz_gsm_nt"].abs().ge(9_999), "bz_gsm_nt"] = np.nan
    frame.loc[frame["bmag_nt"].abs().ge(9_999), "bmag_nt"] = np.nan
    frame.loc[frame["density_p_cc"].abs().ge(999), "density_p_cc"] = np.nan

    provenance = [
        {"file": path.name, "sha256": _sha256(path), "bytes": path.stat().st_size}
        for path in files
    ]
    return frame, provenance


def _fetch_gfz_definitive(cache_path: Path | None = None) -> tuple[pd.DataFrame, dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "start": SPAN_START.isoformat().replace("+00:00", "Z"),
            "end": (SPAN_STOP - pd.Timedelta(seconds=1)).isoformat().replace("+00:00", "Z"),
            "index": "Kp",
            "status": "def",
        }
    )
    url = f"https://kp.gfz.de/app/json/?{params}"
    if cache_path and cache_path.exists():
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        with urllib.request.urlopen(url, timeout=90) as response:
            payload = json.load(response)
        if cache_path:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

    frame = pd.DataFrame(
        {
            "bin_start": pd.to_datetime(payload.get("datetime", []), utc=True),
            "gfz_kp": pd.to_numeric(payload.get("Kp", []), errors="coerce"),
            "gfz_status": payload.get("status", []),
        }
    )
    frame = frame[(frame["gfz_status"] == "def") & frame["gfz_kp"].notna()].sort_values("bin_start")
    return frame, {
        "provider": "GFZ Helmholtz Centre for Geosciences",
        "dataset": "Definitive planetary Kp",
        "url": url,
        "license": (payload.get("meta") or {}).get("license", "CC BY 4.0"),
        "rows": int(len(frame)),
    }


def _parse_noaa_0030_product(text: str, issue_time: pd.Timestamp) -> list[dict[str, Any]]:
    header = re.search(
        r"NOAA Kp index breakdown\s+([A-Z][a-z]{2})\s+(\d{2})-[A-Z][a-z]{2}\s+\d{2}\s+(\d{4})",
        text,
    )
    if not header:
        return []
    first_day = pd.Timestamp(
        datetime.strptime(f"{header.group(3)} {header.group(1)} {header.group(2)}", "%Y %b %d"),
        tz="UTC",
    )
    row_pattern = re.compile(
        r"^\s*(\d{2})-(\d{2})UT\s+"
        r"(\d+(?:\.\d+)?)(?:\s+\(G\d\))?\s+"
        r"(\d+(?:\.\d+)?)(?:\s+\(G\d\))?\s+"
        r"(\d+(?:\.\d+)?)(?:\s+\(G\d\))?\s*$",
        re.MULTILINE,
    )
    rows: list[dict[str, Any]] = []
    for match in row_pattern.finditer(text):
        hour = int(match.group(1))
        for day_offset, group in enumerate((3, 4, 5)):
            target = first_day + pd.Timedelta(days=day_offset, hours=hour)
            rows.append(
                {
                    "issue_time": issue_time.isoformat(),
                    "bin_start": target.isoformat(),
                    "day_offset": day_offset,
                    "lead_hours": (target - issue_time).total_seconds() / 3600,
                    "noaa_kp": float(match.group(group)),
                }
            )
    return rows


def _fetch_noaa_forecast_archive(cache_path: Path = NOAA_CACHE) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load one immutable 0030 UTC NOAA forecast per day to avoid duplicate target bins."""
    if cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        rows = cached["rows"]
        downloaded = int(cached["issuesDownloaded"])
        missing = int(cached["issuesMissing"])
    else:
        days = pd.date_range(EVALUATION_START, SPAN_STOP - pd.Timedelta(days=1), freq="1D")

        def fetch_day(day: pd.Timestamp) -> tuple[list[dict[str, Any]], bool]:
            filename = f"{day:%Y%m%d}0030three_day_forecast.txt"
            url = f"{NOAA_ARCHIVE_ROOT}/{day:%Y/%m}/{filename}"
            try:
                with urllib.request.urlopen(url, timeout=30) as response:
                    text = response.read().decode("utf-8", errors="replace")
                issue_time = day + pd.Timedelta(minutes=30)
                parsed = _parse_noaa_0030_product(text, issue_time)
                return parsed, bool(parsed)
            except Exception:
                return [], False

        rows = []
        downloaded = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
            for parsed, ok in executor.map(fetch_day, days):
                rows.extend(parsed)
                downloaded += int(ok)
        missing = int(len(days) - downloaded)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps({"issuesDownloaded": downloaded, "issuesMissing": missing, "rows": rows}, separators=(",", ":")),
            encoding="utf-8",
        )

    frame = pd.DataFrame(rows)
    if frame.empty:
        raise RuntimeError("No NOAA 3-day forecast rows were parsed")
    frame["issue_time"] = pd.to_datetime(frame["issue_time"], utc=True)
    frame["bin_start"] = pd.to_datetime(frame["bin_start"], utc=True)
    frame = frame[(frame["bin_start"] >= EVALUATION_START) & (frame["bin_start"] < SPAN_STOP)].copy()
    return frame, {
        "provider": "NOAA SWPC / NCEI archive",
        "dataset": "Issued 3-day planetary Kp forecast",
        "url": f"{NOAA_ARCHIVE_ROOT}/",
        "selection": "0030 UTC issue only; next-day and two-day target columns",
        "issuesDownloaded": downloaded,
        "issuesMissing": missing,
        "rows": int(len(frame)),
    }


def _kp_from_wdc_code(code: int) -> float | None:
    if code == 99:
        return None
    whole, suffix = divmod(code, 10)
    return whole + (1 / 3 if suffix == 3 else 2 / 3 if suffix == 7 else 0)


def _parse_gfz_nowcast_wdc(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line or line.startswith("#") or len(line) < 28:
            continue
        try:
            year = 2000 + int(line[0:2])
            month = int(line[2:4])
            day = int(line[4:6])
            codes = [int(line[12 + index * 2:14 + index * 2]) for index in range(8)]
        except ValueError:
            continue
        for index, code in enumerate(codes):
            value = _kp_from_wdc_code(code)
            if value is not None:
                rows.append(
                    {
                        "bin_start": pd.Timestamp(year=year, month=month, day=day, hour=index * 3, tz="UTC").isoformat(),
                        "gfz_nowcast_kp": value,
                    }
                )
    return rows


def _fetch_gfz_nowcast_archive(cache_path: Path = GFZ_NOWCAST_CACHE) -> tuple[pd.DataFrame, dict[str, Any]]:
    if cache_path.exists():
        rows = json.loads(cache_path.read_text(encoding="utf-8"))["rows"]
    else:
        rows: list[dict[str, Any]] = []
        for year in range(EVALUATION_START.year, SPAN_STOP.year + 1):
            url = f"{GFZ_NOWCAST_ROOT}/Kp_now{year}.wdc"
            with urllib.request.urlopen(url, timeout=60) as response:
                rows.extend(_parse_gfz_nowcast_wdc(response.read().decode("utf-8", errors="replace")))
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({"rows": rows}, separators=(",", ":")), encoding="utf-8")
    frame = pd.DataFrame(rows)
    frame["bin_start"] = pd.to_datetime(frame["bin_start"], utc=True)
    frame = frame[(frame["bin_start"] >= EVALUATION_START) & (frame["bin_start"] < SPAN_STOP)].copy()
    return frame, {
        "provider": "GFZ Data Services",
        "dataset": "Archived nowcast planetary Kp",
        "url": f"{GFZ_NOWCAST_ROOT}/",
        "doi": "10.5880/Kp.0001",
        "license": "CC BY 4.0",
        "rows": int(len(frame)),
    }


def _interp(values: pd.Series, anchors: list[tuple[float, float]]) -> np.ndarray:
    xp = np.array([x for x, _ in anchors], dtype=float)
    fp = np.array([y for _, y in anchors], dtype=float)
    return np.interp(values.to_numpy(dtype=float), xp, fp)


def _build_forecast_bins(omni: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    frame = omni.copy()
    frame["issue_time"] = frame["target_time"] - pd.to_timedelta(frame["timeshift_s"], unit="s")
    frame["mru_lead_min"] = (
        (frame["sc_x_re"] - NOMINAL_BOW_SHOCK_X_RE) * RE_KM / frame["speed_km_s"] / 60.0
    )
    frame = frame[frame["mru_lead_min"].between(5, 180)].sort_values("issue_time").copy()
    frame["predicted_arrival"] = frame["issue_time"] + pd.to_timedelta(frame["mru_lead_min"], unit="m")

    # Exact current heuristic: Em=V*max(0,-Bz)*1e-3 and a speed floor.  The
    # event model documents a trailing three-hour mean to match Kp cadence.
    bz = frame["bz_gsm_nt"].fillna(0.0)
    frame["em_inst"] = frame["speed_km_s"] * np.maximum(0.0, -bz) * 1e-3
    indexed = frame.set_index("issue_time")
    frame["em_3h"] = indexed["em_inst"].rolling("3h", min_periods=1).mean().to_numpy()
    frame["speed_3h"] = indexed["speed_km_s"].rolling("3h", min_periods=1).mean().to_numpy()
    frame["heliosat_kp"] = np.maximum(
        _interp(frame["em_3h"], EM_KP_ANCHORS),
        _interp(frame["speed_3h"], SPEED_KP_ANCHORS),
    ).clip(0, 9)
    frame["bin_start"] = frame["predicted_arrival"].dt.floor("3h")

    bins = frame.groupby("bin_start", as_index=False).agg(
        heliosat_kp=("heliosat_kp", "max"),
        forecast_rows=("heliosat_kp", "size"),
        median_lead_min=("mru_lead_min", "median"),
        max_speed_km_s=("speed_km_s", "max"),
        min_bz_nt=("bz_gsm_nt", "min"),
    )
    bins = bins[bins["forecast_rows"] >= MIN_FORECAST_ROWS_PER_BIN].copy()
    leads = frame.loc[frame["target_time"] >= EVALUATION_START, "mru_lead_min"].dropna()
    lead_summary = {
        "medianMin": _round(leads.median(), 1),
        "p10Min": _round(leads.quantile(0.1), 1),
        "p90Min": _round(leads.quantile(0.9), 1),
        "samples": int(len(leads)),
    }
    return bins, lead_summary


def _g_level(values: Iterable[float]) -> np.ndarray:
    values = np.asarray(list(values), dtype=float)
    return np.select([values >= 9, values >= 8, values >= 7, values >= 6, values >= 5], [5, 4, 3, 2, 1], default=0)


def _binary_metrics(predicted: pd.Series, observed: pd.Series, threshold: float) -> dict[str, Any]:
    pred = predicted.ge(threshold)
    obs = observed.ge(threshold)
    tp = int((pred & obs).sum())
    fp = int((pred & ~obs).sum())
    fn = int((~pred & obs).sum())
    tn = int((~pred & ~obs).sum())
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    fpr = fp / (fp + tn) if fp + tn else None
    specificity = tn / (tn + fp) if tn + fp else None
    return {
        "thresholdKp": threshold,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precisionPct": _pct(tp, tp + fp),
        "precisionCi95Pct": _wilson_pct(tp, tp + fp),
        "recallPct": _pct(tp, tp + fn),
        "recallCi95Pct": _wilson_pct(tp, tp + fn),
        "falseAlarmRatioPct": _pct(fp, tp + fp),
        "falsePositiveRatePct": _pct(fp, fp + tn),
        "specificityPct": _pct(tn, tn + fp),
        "csiPct": _pct(tp, tp + fp + fn),
        "tss": _round((recall - fpr), 3) if recall is not None and fpr is not None else None,
        "accuracyPct": _pct(tp + tn, tp + fp + fn + tn),
        "baseRatePct": _pct(tp + fn, tp + fp + fn + tn),
    }


def _episodes(frame: pd.DataFrame, column: str, threshold: float) -> list[Episode]:
    rows = frame[["bin_start", column]].dropna().sort_values("bin_start")
    episodes: list[Episode] = []
    start: pd.Timestamp | None = None
    end: pd.Timestamp | None = None
    peak = -math.inf
    previous: pd.Timestamp | None = None
    for row in rows.itertuples(index=False):
        time = row.bin_start
        value = float(getattr(row, column))
        active = value >= threshold
        contiguous = previous is not None and time - previous == BIN
        if active and (start is None or not contiguous):
            if start is not None and end is not None:
                episodes.append(Episode(start, end, peak))
            start, end, peak = time, time + BIN, value
        elif active and start is not None:
            end = time + BIN
            peak = max(peak, value)
        elif not active and start is not None:
            episodes.append(Episode(start, end or time, peak))
            start, end, peak = None, None, -math.inf
        previous = time
    if start is not None and end is not None:
        episodes.append(Episode(start, end, peak))
    return episodes


def _event_metrics(
    frame: pd.DataFrame,
    threshold: float,
    predicted_column: str = "heliosat_kp",
) -> tuple[dict[str, Any], list[Episode], list[Episode], set[int], set[int]]:
    predicted = _episodes(frame, predicted_column, threshold)
    observed = _episodes(frame, "gfz_kp", threshold)
    candidates: list[tuple[float, int, int]] = []
    for p_index, pred in enumerate(predicted):
        for o_index, obs in enumerate(observed):
            if pred.start < obs.end + EVENT_MATCH_TOLERANCE and pred.end > obs.start - EVENT_MATCH_TOLERANCE:
                distance = abs((pred.start - obs.start).total_seconds())
                candidates.append((distance, p_index, o_index))
    matched_pred: set[int] = set()
    matched_obs: set[int] = set()
    for _, p_index, o_index in sorted(candidates):
        if p_index not in matched_pred and o_index not in matched_obs:
            matched_pred.add(p_index)
            matched_obs.add(o_index)
    tp = len(matched_pred)
    fp = len(predicted) - tp
    fn = len(observed) - tp
    return (
        {
            "thresholdKp": threshold,
            "predictedEvents": len(predicted),
            "observedEvents": len(observed),
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precisionPct": _pct(tp, tp + fp),
            "precisionCi95Pct": _wilson_pct(tp, tp + fp),
            "recallPct": _pct(tp, tp + fn),
            "recallCi95Pct": _wilson_pct(tp, tp + fn),
            "falseAlarmRatioPct": _pct(fp, tp + fp),
            "csiPct": _pct(tp, tp + fp + fn),
            "matchingToleranceHours": int(EVENT_MATCH_TOLERANCE.total_seconds() / 3600),
        },
        predicted,
        observed,
        matched_pred,
        matched_obs,
    )


def _regression_metrics(frame: pd.DataFrame, predicted_column: str = "heliosat_kp") -> dict[str, Any]:
    predicted = frame[predicted_column].to_numpy(dtype=float)
    observed = frame["gfz_kp"].to_numpy(dtype=float)
    error = predicted - observed
    corr = np.corrcoef(predicted, observed)[0, 1] if len(frame) > 1 else math.nan
    return {
        "n": int(len(frame)),
        "maeKp": _round(np.mean(np.abs(error)), 2),
        "rmseKp": _round(np.sqrt(np.mean(error**2)), 2),
        "biasKp": _round(np.mean(error), 2),
        "correlation": _round(corr, 3),
        "exactGLevelPct": _pct(int((_g_level(predicted) == _g_level(observed)).sum()), len(frame)),
        "withinOneGLevelPct": _pct(int((np.abs(_g_level(predicted) - _g_level(observed)) <= 1).sum()), len(frame)),
    }


def _confusion_matrix(frame: pd.DataFrame) -> list[list[int]]:
    pred = _g_level(frame["heliosat_kp"])
    obs = _g_level(frame["gfz_kp"])
    matrix = np.zeros((6, 6), dtype=int)
    for observed, predicted in zip(obs, pred, strict=True):
        matrix[int(observed), int(predicted)] += 1
    return matrix.tolist()


def _yearly(frame: pd.DataFrame) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for year, subset in frame.groupby(frame["bin_start"].dt.year):
        bin_metrics = _binary_metrics(subset["heliosat_kp"], subset["gfz_kp"], 5)
        event_metrics, *_ = _event_metrics(subset, 5)
        out.append(
            {
                "year": int(year),
                "bins": int(len(subset)),
                "stormBins": int(subset["gfz_kp"].ge(5).sum()),
                "binPrecisionPct": bin_metrics["precisionPct"],
                "binRecallPct": bin_metrics["recallPct"],
                "eventPrecisionPct": event_metrics["precisionPct"],
                "eventRecallPct": event_metrics["recallPct"],
                "observedEvents": event_metrics["observedEvents"],
            }
        )
    return out


def _comparison_result(
    frame: pd.DataFrame,
    product_id: str,
    name: str,
    timing: str,
    predicted_column: str,
) -> dict[str, Any]:
    clean = frame.dropna(subset=[predicted_column, "gfz_kp"]).copy()
    return {
        "id": product_id,
        "name": name,
        "timing": timing,
        "regression": _regression_metrics(clean, predicted_column),
        "g1Bin": _binary_metrics(clean[predicted_column], clean["gfz_kp"], 5),
        "g1Event": _event_metrics(clean, 5, predicted_column)[0],
    }


def _example_window(frame: pd.DataFrame) -> dict[str, Any]:
    strongest_index = frame["gfz_kp"].idxmax()
    strongest = frame.loc[strongest_index]
    start = strongest["bin_start"] - pd.Timedelta(days=2)
    stop = strongest["bin_start"] + pd.Timedelta(days=2)
    window = frame[(frame["bin_start"] >= start) & (frame["bin_start"] <= stop)]
    return {
        "title": f"Strongest definitive-Kp interval in the held-out evaluation · {strongest['bin_start'].date().isoformat()}",
        "peakGfzKp": _round(strongest["gfz_kp"], 2),
        "peakHeliosatKpSameBin": _round(strongest["heliosat_kp"], 2),
        "points": [
            {
                "t": int(row.bin_start.timestamp() * 1000),
                "gfzKp": _round(row.gfz_kp, 2),
                "heliosatKp": _round(row.heliosat_kp, 2),
                "noaaNextDayKp": _round(row.noaa_next_day_kp, 2),
                "gfzNowcastKp": _round(row.gfz_nowcast_kp, 2),
            }
            for row in window.itertuples(index=False)
        ],
    }


def _episode_rows(episodes: list[Episode], matched: set[int], kind: str, limit: int = 12) -> list[dict[str, Any]]:
    selected = [(index, episode) for index, episode in enumerate(episodes) if (index in matched) == (kind == "matched")]
    selected.sort(key=lambda pair: pair[1].start, reverse=True)
    return [
        {
            "startUtc": episode.start.isoformat().replace("+00:00", "Z"),
            "endUtc": episode.end.isoformat().replace("+00:00", "Z"),
            "peakKp": _round(episode.peak_kp, 2),
        }
        for _, episode in selected[:limit]
    ]


def generate(output_path: Path, gfz_cache: Path | None) -> dict[str, Any]:
    omni, omni_provenance = _load_omni()
    gfz, gfz_provenance = _fetch_gfz_definitive(gfz_cache)
    gfz_nowcast, gfz_nowcast_provenance = _fetch_gfz_nowcast_archive()
    noaa_forecasts, noaa_forecast_provenance = _fetch_noaa_forecast_archive()
    forecast_bins, lead = _build_forecast_bins(omni)
    scored = forecast_bins.merge(gfz[["bin_start", "gfz_kp"]], on="bin_start", how="inner")
    scored = scored.sort_values("bin_start").reset_index(drop=True)
    evaluation = scored[(scored["bin_start"] >= EVALUATION_START) & (scored["bin_start"] < SPAN_STOP)].copy()
    development = scored[scored["bin_start"] < EVALUATION_START].copy()
    if evaluation.empty:
        raise RuntimeError("No held-out evaluation bins were produced")

    noaa_next_day = noaa_forecasts.loc[noaa_forecasts["day_offset"].eq(1), ["bin_start", "noaa_kp"]].rename(
        columns={"noaa_kp": "noaa_next_day_kp"}
    )
    noaa_two_day = noaa_forecasts.loc[noaa_forecasts["day_offset"].eq(2), ["bin_start", "noaa_kp"]].rename(
        columns={"noaa_kp": "noaa_two_day_kp"}
    )
    comparison_frame = (
        evaluation
        .merge(noaa_next_day, on="bin_start", how="left")
        .merge(noaa_two_day, on="bin_start", how="left")
        .merge(gfz_nowcast[["bin_start", "gfz_nowcast_kp"]], on="bin_start", how="left")
    )

    g1_event, g1_predicted, g1_observed, g1_matched_pred, g1_matched_obs = _event_metrics(evaluation, 5)
    g3_event, *_ = _event_metrics(evaluation, 7)
    thresholds = []
    for threshold in [4, 5, 6, 7]:
        threshold_bin = _binary_metrics(evaluation["heliosat_kp"], evaluation["gfz_kp"], threshold)
        threshold_event, *_ = _event_metrics(evaluation, threshold)
        thresholds.append(
            {
                "thresholdKp": threshold,
                "label": "elevated Kp4+" if threshold == 4 else f"G{int(threshold - 4)}+",
                "binPrecisionPct": threshold_bin["precisionPct"],
                "binRecallPct": threshold_bin["recallPct"],
                "eventPrecisionPct": threshold_event["precisionPct"],
                "eventRecallPct": threshold_event["recallPct"],
                "observedEvents": threshold_event["observedEvents"],
            }
        )

    report = {
        "schemaVersion": "heliosat-geomagnetic-storm-study-v1",
        "generatedAtUtc": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "modelVersion": "mru-kp-heuristic-v1",
        "status": "retrospective-held-out",
        "objective": (
            "Measure whether the current HelioSat L1-to-Earth pipeline detects planetary geomagnetic storm episodes, "
            "how often it raises false alarms or misses storms, and what warning time it provides before the predicted bow-shock arrival."
        ),
        "scope": {
            "developmentStartUtc": SPAN_START.isoformat().replace("+00:00", "Z"),
            "developmentStopUtc": EVALUATION_START.isoformat().replace("+00:00", "Z"),
            "evaluationStartUtc": EVALUATION_START.isoformat().replace("+00:00", "Z"),
            "evaluationStopUtc": SPAN_STOP.isoformat().replace("+00:00", "Z"),
            "developmentBins": int(len(development)),
            "evaluationBins": int(len(evaluation)),
            "nativeTruthCadenceHours": 3,
            "minimumForecastRowsPerBin": MIN_FORECAST_ROWS_PER_BIN,
        },
        "data": {
            "upstream": {
                "provider": "NASA/SPDF",
                "dataset": "High Resolution OMNI 5-minute",
                "url": "https://omniweb.gsfc.nasa.gov/html/HROdocum.html",
                "role": "Upstream L1 speed, Bz and spacecraft position; Timeshift is used only to reconstruct causal issue time.",
                "files": omni_provenance,
                "validRows": int(len(omni)),
                "caveat": "OMNI time shifting is a modelled propagation reference, not an independent detector at Earth.",
            },
            "truth": gfz_provenance,
            "externalBenchmarks": {
                "noaaForecast": noaa_forecast_provenance,
                "gfzNowcast": gfz_nowcast_provenance,
            },
        },
        "method": {
            "issueTime": "OMNI target timestamp minus OMNI Timeshift; Timeshift is not a model feature.",
            "arrival": "issue time + (spacecraft X - 13.5 Re) * Re / measured speed",
            "intensity": "3 h trailing mean of Em=V*max(0,-Bz)*1e-3 plus the current speed-floor anchors; strongest parcel estimate in each 3 h bin.",
            "truth": "GFZ definitive Kp in the same predicted-arrival 3 h bin.",
            "eventDefinition": "One or more contiguous 3 h bins at or above the threshold.",
            "eventMatching": "One-to-one greedy matching; predicted and observed episodes may differ by at most one 3 h Kp bin.",
            "causality": "Every feature exists at issue time. Definitive Kp and OMNI Timeshift are used only after the forecast for alignment and scoring.",
        },
        "leadTime": lead,
        "results": {
            "regression": _regression_metrics(evaluation),
            "g1Bin": _binary_metrics(evaluation["heliosat_kp"], evaluation["gfz_kp"], 5),
            "g1Event": g1_event,
            "g3Bin": _binary_metrics(evaluation["heliosat_kp"], evaluation["gfz_kp"], 7),
            "g3Event": g3_event,
            "confusionG": _confusion_matrix(evaluation),
            "thresholds": thresholds,
            "yearly": _yearly(evaluation),
            "comparisons": [
                _comparison_result(
                    comparison_frame,
                    "noaa_next_day",
                    "NOAA next-day forecast",
                    "23.5–44.5 h lead from the fixed 0030 UTC issue",
                    "noaa_next_day_kp",
                ),
                _comparison_result(
                    comparison_frame,
                    "noaa_two_day",
                    "NOAA two-day forecast",
                    "47.5–68.5 h lead from the fixed 0030 UTC issue",
                    "noaa_two_day_kp",
                ),
                _comparison_result(
                    comparison_frame,
                    "heliosat",
                    "HelioSat L1 forecast",
                    f"median {lead['medianMin']} min lead",
                    "heliosat_kp",
                ),
                _comparison_result(
                    comparison_frame,
                    "gfz_nowcast",
                    "GFZ archived nowcast",
                    "no positive forecast lead; archived provisional value, not its first issue",
                    "gfz_nowcast_kp",
                ),
            ],
        },
        "examples": {
            "strongestWindow": _example_window(comparison_frame),
            "matchedObservedG1": _episode_rows(g1_observed, g1_matched_obs, "matched", 8),
            "missedObservedG1": _episode_rows(g1_observed, g1_matched_obs, "unmatched", 8),
            "falseAlarmG1": _episode_rows(g1_predicted, g1_matched_pred, "unmatched", 8),
        },
        "kpSources": [
            {
                "id": "noaa_forecast",
                "name": "NOAA planetary K forecast",
                "kind": "forecast",
                "producer": "NOAA SWPC",
                "cadence": "3 h",
                "timing": "roughly 0-72 h before target interval",
                "role": "External operational forecast benchmark",
                "scoredHere": True,
                "reason": "Scored from NOAA's immutable NCEI text-product archive at fixed 0030 UTC issuance.",
                "url": f"{NOAA_ARCHIVE_ROOT}/",
            },
            {
                "id": "heliosat",
                "name": "HelioSat Kp estimate",
                "kind": "L1-to-Earth forecast",
                "producer": "HelioSat",
                "cadence": "new L1 samples; evaluated in 3 h bins",
                "timing": f"median {lead['medianMin']} min; p10-p90 {lead['p10Min']}-{lead['p90Min']} min",
                "role": "Short-lead geomagnetic storm alert",
                "scoredHere": True,
                "reason": "Compared causally against GFZ definitive Kp.",
                "url": None,
            },
            {
                "id": "noaa_estimated",
                "name": "NOAA estimated planetary Kp",
                "kind": "near-real-time estimate",
                "producer": "NOAA SWPC",
                "cadence": "3 h",
                "timing": "no forecast lead; operational estimate from reporting ground magnetometers",
                "role": "Immediate live verification",
                "scoredHere": False,
                "reason": "It is provisional and historical revision vintages are not archived locally.",
                "url": "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
            },
            {
                "id": "gfz_nowcast",
                "name": "GFZ nowcast Kp",
                "kind": "nowcast",
                "producer": "GFZ",
                "cadence": "3 h",
                "timing": "first provisional estimate typically ~35 min after interval start; then updated",
                "role": "Rapid official-network response index",
                "scoredHere": True,
                "reason": "Archived yearly nowcast values are compared with definitive Kp; first-issue revisions are unavailable.",
                "url": f"{GFZ_NOWCAST_ROOT}/",
            },
            {
                "id": "gfz_definitive",
                "name": "GFZ definitive Kp",
                "kind": "post-event reference",
                "producer": "GFZ / IAGA service",
                "cadence": "3 h",
                "timing": "no operational lead; published after quality control",
                "role": "Primary truth for this study",
                "scoredHere": True,
                "reason": "Stable, reproducible planetary ground-response reference.",
                "url": "https://kp.gfz.de/en/data",
            },
        ],
        "limitations": [
            "This validates the frozen rules-based Kp heuristic, not a calibrated probabilistic storm classifier.",
            "High Resolution OMNI provides upstream parcel values and a retrospective phase-front shift; it is not an independent bow-shock measurement.",
            "Kp is a global three-hour index, so event onset and timing cannot be resolved below one bin in this study.",
            "NOAA comparison uses one fixed 0030 UTC issue per day; it does not pool the later 1230 UTC update or forecaster rationale.",
            "GFZ's DOI nowcast archive does not preserve every intra-interval revision; this cannot measure the error of the first ~35-minute issue.",
            "G3+ events are rare; their percentages have wider uncertainty than G1+ results.",
            "The live system must persist immutable issue-time forecasts and model versions before forward operational skill can be claimed.",
        ],
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--gfz-cache", type=Path, default=None)
    args = parser.parse_args()
    report = generate(args.output, args.gfz_cache)
    result = report["results"]["g1Event"]
    print(f"wrote {args.output}")
    print(
        "G1+ event skill: "
        f"TP={result['tp']} FP={result['fp']} FN={result['fn']} "
        f"precision={result['precisionPct']}% recall={result['recallPct']}%"
    )


if __name__ == "__main__":
    main()
