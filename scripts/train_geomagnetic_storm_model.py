#!/usr/bin/env python3
"""Train and evaluate HelioSat's short-lead geomagnetic-storm candidate.

The predictor ingests every valid five-minute High Resolution OMNI parcel, but
the supervised target remains the native three-hour definitive planetary Kp
index. Five-minute records are causally reconstructed at their L1 issue time,
propagated with the deployable MRU geometry, and summarized into physics-aware
features for the Kp interval in which the parcel is predicted to arrive.

Model and alert thresholds are selected without looking at 2024 onward. The
entire 2024-01-01 through 2026-04-30 interval is reserved for the final score.
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

import lightgbm as lgb
import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OMNI_DIR = PROJECT_ROOT / "data" / "cache" / "omni_high_res"
DEFAULT_REPORT = PROJECT_ROOT / "data" / "console" / "geomagnetic-storm-study.json"
DEFAULT_MODEL = PROJECT_ROOT / "data" / "ml-model" / "geomagnetic-storm-candidate.json"
GFZ_CACHE = PROJECT_ROOT / "data" / "cache" / "gfz_definitive_kp_1995_2026.json"
FEATURE_CACHE = PROJECT_ROOT / "data" / "cache" / "geomagnetic_features_1995_2026.parquet"
FEATURE_META_CACHE = PROJECT_ROOT / "data" / "cache" / "geomagnetic_features_1995_2026.meta.json"
NOAA_CACHE = PROJECT_ROOT / "data" / "cache" / "noaa_0030_kp_forecasts_2025_2026.json"
GFZ_NOWCAST_CACHE = PROJECT_ROOT / "data" / "cache" / "gfz_nowcast_kp_2025_2026.json"
NOAA_ARCHIVE_ROOT = "https://www.ngdc.noaa.gov/stp/space-weather/swpc-products/daily_reports/3day_forecast"
GFZ_NOWCAST_ROOT = "https://datapub.gfz.de/download/10.5880.Kp.0001/Kp_nowcast"

SPAN_START = pd.Timestamp("1995-01-01T00:00:00Z")
SPAN_STOP = pd.Timestamp("2026-05-01T00:00:00Z")
HELDOUT_START = pd.Timestamp("2024-01-01T00:00:00Z")
EXTERNAL_COMPARISON_START = pd.Timestamp("2025-01-01T00:00:00Z")
BIN = pd.Timedelta(hours=3)
MIN_FORECAST_ROWS_PER_BIN = 18
MIN_BZ_ROWS_PER_BIN = 12
EVENT_MATCH_TOLERANCE = BIN

RE_KM = 6371.2
NOMINAL_BOW_SHOCK_X_RE = 13.5

COLS = {
    "year": 0,
    "doy": 1,
    "hour": 2,
    "minute": 3,
    "imf_spacecraft_id": 4,
    "plasma_spacecraft_id": 5,
    "timeshift_s": 9,
    "bmag_nt": 13,
    "bx_gse_nt": 14,
    "by_gsm_nt": 17,
    "bz_gsm_nt": 18,
    "speed_km_s": 21,
    "vx_gse_km_s": 22,
    "density_p_cc": 25,
    "temperature_k": 26,
    "pressure_npa": 27,
    "beta": 29,
    "alfven_mach": 30,
    "sc_x_re": 31,
}

FEATURE_COLUMNS = [
    "speed_mean", "speed_max", "speed_std",
    "bz_mean", "bz_min", "bz_std", "south_fraction", "bz_le_minus5_fraction", "bz_le_minus10_fraction",
    "by_abs_mean", "bmag_mean", "bmag_max",
    "density_mean", "density_max", "pressure_mean", "pressure_max",
    "em_mean", "em_max", "em_sum",
    "newell_mean", "newell_max", "newell_sum",
    "epsilon_mean", "epsilon_max", "viscous_mean", "viscous_max",
    "temperature_mean", "beta_mean", "alfven_mach_mean",
    "forecast_rows", "bz_rows", "coverage_fraction",
    "lead_median_min", "lead_p10_min", "lead_p90_min",
    "speed_mean_lag1", "speed_mean_lag2",
    "bz_mean_lag1", "bz_mean_lag2", "bz_min_lag1", "bz_min_lag2",
    "em_mean_lag1", "em_mean_lag2", "em_max_lag1", "em_max_lag2",
    "newell_mean_lag1", "newell_mean_lag2", "newell_max_lag1", "newell_max_lag2",
    "pressure_mean_lag1", "pressure_mean_lag2",
    "em_mean_6h", "em_mean_9h", "newell_mean_6h", "newell_mean_9h",
    "ut_sin", "ut_cos", "doy_sin", "doy_cos",
]

CV_FOLDS = [
    (pd.Timestamp("2001-01-01T00:00:00Z"), pd.Timestamp("2007-01-01T00:00:00Z")),
    (pd.Timestamp("2007-01-01T00:00:00Z"), pd.Timestamp("2013-01-01T00:00:00Z")),
    (pd.Timestamp("2013-01-01T00:00:00Z"), pd.Timestamp("2019-01-01T00:00:00Z")),
    (pd.Timestamp("2019-01-01T00:00:00Z"), HELDOUT_START),
]

CLASSIFIER_CANDIDATES = [
    {"id": "compact-balanced", "num_leaves": 15, "min_child_samples": 60, "positive_weight": 4.0},
    {"id": "compact-recall", "num_leaves": 15, "min_child_samples": 45, "positive_weight": 8.0},
    {"id": "medium-balanced", "num_leaves": 31, "min_child_samples": 60, "positive_weight": 5.0},
    {"id": "medium-recall", "num_leaves": 31, "min_child_samples": 45, "positive_weight": 10.0},
]

EM_KP_ANCHORS = [(0.0, 1.0), (0.5, 3.0), (1.5, 4.0), (2.5, 5.0), (4.0, 6.0), (6.0, 7.0), (9.0, 8.0), (13.0, 9.0)]
SPEED_KP_ANCHORS = [(350.0, 0.0), (450.0, 2.0), (550.0, 3.0), (650.0, 4.0), (800.0, 5.0)]


@dataclass(frozen=True)
class Episode:
    start: pd.Timestamp
    end: pd.Timestamp
    peak: float


def _round(value: float | int | None, digits: int = 3) -> float | int | None:
    if value is None or not math.isfinite(float(value)):
        return None
    return round(float(value), digits)


def _pct(numerator: int, denominator: int) -> float | None:
    return _round(100.0 * numerator / denominator, 1) if denominator else None


def _wilson_pct(successes: int, total: int, z: float = 1.959963984540054) -> list[float] | None:
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
        & frame["speed_km_s"].between(150, 2_500)
        & frame["sc_x_re"].abs().lt(9_999)
    )
    frame = frame[valid].copy()
    fill_limits = {
        "bmag_nt": 9_999,
        "bx_gse_nt": 9_999,
        "by_gsm_nt": 9_999,
        "bz_gsm_nt": 9_999,
        "density_p_cc": 999,
        "temperature_k": 9_999_999,
        "pressure_npa": 99,
        "beta": 999,
        "alfven_mach": 999,
    }
    for column, limit in fill_limits.items():
        frame.loc[frame[column].abs().ge(limit), column] = np.nan
    provenance = [
        {"file": path.name, "sha256": _sha256(path), "bytes": path.stat().st_size}
        for path in files
    ]
    return frame, provenance


def _omni_provenance() -> list[dict[str, Any]]:
    files = [OMNI_DIR / f"omni_5min{year}.asc" for year in range(SPAN_START.year, SPAN_STOP.year + 1)]
    missing = [path for path in files if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing OMNI files: {', '.join(str(path) for path in missing)}")
    return [{"file": path.name, "sha256": _sha256(path), "bytes": path.stat().st_size} for path in files]


def _fetch_gfz_definitive() -> tuple[pd.DataFrame, dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "start": SPAN_START.isoformat().replace("+00:00", "Z"),
            "end": (SPAN_STOP - pd.Timedelta(seconds=1)).isoformat().replace("+00:00", "Z"),
            "index": "Kp",
            "status": "def",
        }
    )
    url = f"https://kp.gfz.de/app/json/?{params}"
    if GFZ_CACHE.exists():
        payload = json.loads(GFZ_CACHE.read_text(encoding="utf-8"))
    else:
        with urllib.request.urlopen(url, timeout=120) as response:
            payload = json.load(response)
        GFZ_CACHE.parent.mkdir(parents=True, exist_ok=True)
        GFZ_CACHE.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    frame = pd.DataFrame(
        {
            "bin_start": pd.to_datetime(payload.get("datetime", []), utc=True),
            "gfz_kp": pd.to_numeric(payload.get("Kp", []), errors="coerce"),
            "status": payload.get("status", []),
        }
    )
    frame = frame[frame["status"].eq("def") & frame["gfz_kp"].notna()].sort_values("bin_start")
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
            rows.append({
                "issue_time": issue_time.isoformat(), "bin_start": target.isoformat(),
                "day_offset": day_offset, "lead_hours": (target - issue_time).total_seconds() / 3600,
                "noaa_kp": float(match.group(group)),
            })
    return rows


def _fetch_noaa_forecast_archive() -> tuple[pd.DataFrame, dict[str, Any]]:
    if NOAA_CACHE.exists():
        cached = json.loads(NOAA_CACHE.read_text(encoding="utf-8"))
        rows = cached["rows"]
        downloaded = int(cached["issuesDownloaded"])
        missing = int(cached["issuesMissing"])
    else:
        days = pd.date_range(EXTERNAL_COMPARISON_START, SPAN_STOP - pd.Timedelta(days=1), freq="1D")

        def fetch_day(day: pd.Timestamp) -> tuple[list[dict[str, Any]], bool]:
            filename = f"{day:%Y%m%d}0030three_day_forecast.txt"
            url = f"{NOAA_ARCHIVE_ROOT}/{day:%Y/%m}/{filename}"
            try:
                with urllib.request.urlopen(url, timeout=30) as response:
                    product = response.read().decode("utf-8", errors="replace")
                parsed = _parse_noaa_0030_product(product, day + pd.Timedelta(minutes=30))
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
        NOAA_CACHE.parent.mkdir(parents=True, exist_ok=True)
        NOAA_CACHE.write_text(
            json.dumps({"issuesDownloaded": downloaded, "issuesMissing": missing, "rows": rows}, separators=(",", ":")),
            encoding="utf-8",
        )
    frame = pd.DataFrame(rows)
    if frame.empty:
        raise RuntimeError("No NOAA three-day forecast rows were parsed")
    frame["issue_time"] = pd.to_datetime(frame["issue_time"], utc=True)
    frame["bin_start"] = pd.to_datetime(frame["bin_start"], utc=True)
    frame = frame[frame["bin_start"].between(EXTERNAL_COMPARISON_START, SPAN_STOP, inclusive="left")].copy()
    return frame, {
        "provider": "NOAA SWPC / NCEI archive", "dataset": "Issued 3-day planetary Kp forecast",
        "url": f"{NOAA_ARCHIVE_ROOT}/", "selection": "0030 UTC issue only; next-day and two-day target columns",
        "issuesDownloaded": downloaded, "issuesMissing": missing, "rows": int(len(frame)),
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
                rows.append({
                    "bin_start": pd.Timestamp(year=year, month=month, day=day, hour=index * 3, tz="UTC").isoformat(),
                    "gfz_nowcast_kp": value,
                })
    return rows


def _fetch_gfz_nowcast_archive() -> tuple[pd.DataFrame, dict[str, Any]]:
    if GFZ_NOWCAST_CACHE.exists():
        rows = json.loads(GFZ_NOWCAST_CACHE.read_text(encoding="utf-8"))["rows"]
    else:
        rows: list[dict[str, Any]] = []
        for year in range(EXTERNAL_COMPARISON_START.year, SPAN_STOP.year + 1):
            with urllib.request.urlopen(f"{GFZ_NOWCAST_ROOT}/Kp_now{year}.wdc", timeout=60) as response:
                rows.extend(_parse_gfz_nowcast_wdc(response.read().decode("utf-8", errors="replace")))
        GFZ_NOWCAST_CACHE.parent.mkdir(parents=True, exist_ok=True)
        GFZ_NOWCAST_CACHE.write_text(json.dumps({"rows": rows}, separators=(",", ":")), encoding="utf-8")
    frame = pd.DataFrame(rows)
    frame["bin_start"] = pd.to_datetime(frame["bin_start"], utc=True)
    frame = frame[frame["bin_start"].between(EXTERNAL_COMPARISON_START, SPAN_STOP, inclusive="left")].copy()
    return frame, {
        "provider": "GFZ Data Services", "dataset": "Archived nowcast planetary Kp",
        "url": f"{GFZ_NOWCAST_ROOT}/", "doi": "10.5880/Kp.0001", "license": "CC BY 4.0", "rows": int(len(frame)),
    }


def _build_features(omni: pd.DataFrame, truth: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    frame = omni.copy()
    frame["issue_time"] = frame["target_time"] - pd.to_timedelta(frame["timeshift_s"], unit="s")
    frame["lead_min"] = (frame["sc_x_re"] - NOMINAL_BOW_SHOCK_X_RE) * RE_KM / frame["speed_km_s"] / 60.0
    frame = frame[frame["lead_min"].between(5, 180)].copy()
    frame["predicted_arrival"] = frame["issue_time"] + pd.to_timedelta(frame["lead_min"], unit="m")
    frame["bin_start"] = frame["predicted_arrival"].dt.floor("3h")

    bz = frame["bz_gsm_nt"]
    by = frame["by_gsm_nt"]
    bt = np.hypot(by, bz)
    clock = np.mod(np.arctan2(by, bz), 2 * np.pi)
    clock_term = np.abs(np.sin(clock / 2))
    south = np.maximum(0.0, -bz)
    frame["by_abs"] = by.abs()
    frame["em"] = frame["speed_km_s"] * south * 1e-3
    frame["newell"] = np.power(frame["speed_km_s"], 4 / 3) * np.power(bt, 2 / 3) * np.power(clock_term, 8 / 3)
    frame["epsilon"] = frame["speed_km_s"] * np.square(frame["bmag_nt"]) * np.power(clock_term, 4)
    frame["viscous"] = np.sqrt(frame["density_p_cc"].clip(lower=0)) * np.square(frame["speed_km_s"])
    frame["south"] = np.where(bz.notna(), bz.lt(0).astype(float), np.nan)
    frame["bz_le_minus5"] = np.where(bz.notna(), bz.le(-5).astype(float), np.nan)
    frame["bz_le_minus10"] = np.where(bz.notna(), bz.le(-10).astype(float), np.nan)

    grouped = frame.groupby("bin_start", sort=True)
    features = grouped.agg(
        speed_mean=("speed_km_s", "mean"), speed_max=("speed_km_s", "max"), speed_std=("speed_km_s", "std"),
        bz_mean=("bz_gsm_nt", "mean"), bz_min=("bz_gsm_nt", "min"), bz_std=("bz_gsm_nt", "std"),
        south_fraction=("south", "mean"), bz_le_minus5_fraction=("bz_le_minus5", "mean"), bz_le_minus10_fraction=("bz_le_minus10", "mean"),
        by_abs_mean=("by_abs", "mean"), bmag_mean=("bmag_nt", "mean"), bmag_max=("bmag_nt", "max"),
        density_mean=("density_p_cc", "mean"), density_max=("density_p_cc", "max"),
        pressure_mean=("pressure_npa", "mean"), pressure_max=("pressure_npa", "max"),
        em_mean=("em", "mean"), em_max=("em", "max"), em_sum=("em", "sum"),
        newell_mean=("newell", "mean"), newell_max=("newell", "max"), newell_sum=("newell", "sum"),
        epsilon_mean=("epsilon", "mean"), epsilon_max=("epsilon", "max"),
        viscous_mean=("viscous", "mean"), viscous_max=("viscous", "max"),
        temperature_mean=("temperature_k", "mean"), beta_mean=("beta", "mean"), alfven_mach_mean=("alfven_mach", "mean"),
        forecast_rows=("speed_km_s", "size"), bz_rows=("bz_gsm_nt", "count"),
        lead_median_min=("lead_min", "median"), lead_p10_min=("lead_min", lambda values: values.quantile(0.1)), lead_p90_min=("lead_min", lambda values: values.quantile(0.9)),
    ).reset_index()
    features["coverage_fraction"] = (features["forecast_rows"] / 36.0).clip(upper=1.0)
    features = features[
        features["forecast_rows"].ge(MIN_FORECAST_ROWS_PER_BIN)
        & features["bz_rows"].ge(MIN_BZ_ROWS_PER_BIN)
    ].sort_values("bin_start").reset_index(drop=True)

    lag_sources = ["speed_mean", "bz_mean", "bz_min", "em_mean", "em_max", "newell_mean", "newell_max", "pressure_mean"]
    for column in lag_sources:
        features[f"{column}_lag1"] = features[column].shift(1)
        features[f"{column}_lag2"] = features[column].shift(2)
    exact_lag1 = features["bin_start"].diff().eq(BIN)
    exact_lag2 = features["bin_start"].diff(2).eq(2 * BIN)
    for column in lag_sources:
        features.loc[~exact_lag1, f"{column}_lag1"] = np.nan
        features.loc[~exact_lag2, f"{column}_lag2"] = np.nan
    features["em_mean_6h"] = features[["em_mean", "em_mean_lag1"]].mean(axis=1)
    features["em_mean_9h"] = features[["em_mean", "em_mean_lag1", "em_mean_lag2"]].mean(axis=1)
    features["newell_mean_6h"] = features[["newell_mean", "newell_mean_lag1"]].mean(axis=1)
    features["newell_mean_9h"] = features[["newell_mean", "newell_mean_lag1", "newell_mean_lag2"]].mean(axis=1)
    hour = features["bin_start"].dt.hour
    day = features["bin_start"].dt.dayofyear
    features["ut_sin"] = np.sin(2 * np.pi * hour / 24)
    features["ut_cos"] = np.cos(2 * np.pi * hour / 24)
    features["doy_sin"] = np.sin(2 * np.pi * day / 365.25)
    features["doy_cos"] = np.cos(2 * np.pi * day / 365.25)
    features = features.merge(truth[["bin_start", "gfz_kp"]], on="bin_start", how="inner")
    return features, {
        "rawRows": int(len(omni)),
        "eligibleBins": int(len(features)),
        "inputCadenceMinutes": 5,
        "targetCadenceHours": 3,
        "features": len(FEATURE_COLUMNS),
    }


def _g_level(values: Iterable[float]) -> np.ndarray:
    values = np.asarray(list(values), dtype=float)
    return np.select([values >= 9, values >= 8, values >= 7, values >= 6, values >= 5], [5, 4, 3, 2, 1], default=0)


def _binary_metrics(predicted: Iterable[bool], observed: Iterable[bool]) -> dict[str, Any]:
    pred = np.asarray(list(predicted), dtype=bool)
    obs = np.asarray(list(observed), dtype=bool)
    tp = int(np.sum(pred & obs))
    fp = int(np.sum(pred & ~obs))
    fn = int(np.sum(~pred & obs))
    tn = int(np.sum(~pred & ~obs))
    recall = tp / (tp + fn) if tp + fn else None
    fpr = fp / (fp + tn) if fp + tn else None
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precisionPct": _pct(tp, tp + fp), "precisionCi95Pct": _wilson_pct(tp, tp + fp),
        "recallPct": _pct(tp, tp + fn), "recallCi95Pct": _wilson_pct(tp, tp + fn),
        "falseAlarmRatioPct": _pct(fp, tp + fp), "falsePositiveRatePct": _pct(fp, fp + tn),
        "specificityPct": _pct(tn, tn + fp), "csiPct": _pct(tp, tp + fp + fn),
        "tss": _round(recall - fpr, 3) if recall is not None and fpr is not None else None,
        "accuracyPct": _pct(tp + tn, len(pred)), "baseRatePct": _pct(tp + fn, len(pred)),
    }


def _episodes(times: pd.Series, values: Iterable[float], threshold: float) -> list[Episode]:
    time_array = pd.to_datetime(times, utc=True).to_numpy()
    value_array = np.asarray(list(values), dtype=float)
    valid = np.isfinite(value_array)
    time_array = time_array[valid]
    value_array = value_array[valid]
    if not len(value_array):
        return []
    active = value_array >= threshold
    contiguous = np.zeros(len(active), dtype=bool)
    contiguous[1:] = np.diff(time_array) == np.timedelta64(3, "h")
    starts = np.flatnonzero(active & ~(np.r_[False, active[:-1]] & contiguous))
    stops = np.flatnonzero(active & ~(np.r_[active[1:], False] & np.r_[contiguous[1:], False]))
    return [
        Episode(
            pd.Timestamp(time_array[start]),
            pd.Timestamp(time_array[stop]) + BIN,
            float(np.max(value_array[start:stop + 1])),
        )
        for start, stop in zip(starts, stops, strict=True)
    ]


def _event_metrics(times: pd.Series, predicted: Iterable[bool], observed: Iterable[bool]) -> dict[str, Any]:
    predicted_episodes = _episodes(times, np.asarray(list(predicted), dtype=int), 1)
    observed_episodes = _episodes(times, np.asarray(list(observed), dtype=int), 1)
    matched_pred: set[int] = set()
    matched_obs: set[int] = set()
    onset_errors: list[float] = []
    p_index = 0
    o_index = 0
    while p_index < len(predicted_episodes) and o_index < len(observed_episodes):
        pred = predicted_episodes[p_index]
        obs = observed_episodes[o_index]
        if pred.end <= obs.start - EVENT_MATCH_TOLERANCE:
            p_index += 1
        elif obs.end <= pred.start - EVENT_MATCH_TOLERANCE:
            o_index += 1
        else:
            matched_pred.add(p_index)
            matched_obs.add(o_index)
            onset_errors.append((pred.start - obs.start).total_seconds() / 3600)
            p_index += 1
            o_index += 1
    tp = len(matched_pred)
    fp = len(predicted_episodes) - tp
    fn = len(observed_episodes) - tp
    return {
        "predictedEvents": len(predicted_episodes), "observedEvents": len(observed_episodes),
        "tp": tp, "fp": fp, "fn": fn,
        "precisionPct": _pct(tp, tp + fp), "precisionCi95Pct": _wilson_pct(tp, tp + fp),
        "recallPct": _pct(tp, tp + fn), "recallCi95Pct": _wilson_pct(tp, tp + fn),
        "falseAlarmRatioPct": _pct(fp, tp + fp), "csiPct": _pct(tp, tp + fp + fn),
        "matchingToleranceHours": int(EVENT_MATCH_TOLERANCE.total_seconds() / 3600),
        "medianOnsetErrorHours": _round(float(np.median(onset_errors)), 1) if onset_errors else None,
    }


def _classifier(params: dict[str, Any]) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary", n_estimators=350, learning_rate=0.035,
        num_leaves=params["num_leaves"], min_child_samples=params["min_child_samples"],
        subsample=0.85, colsample_bytree=0.82, reg_alpha=0.15, reg_lambda=0.8,
        random_state=42, n_jobs=-1, verbosity=-1,
    )


def _choose_threshold(frame: pd.DataFrame, probability_column: str, observed_column: str) -> tuple[float, dict[str, Any], list[dict[str, Any]]]:
    curve: list[dict[str, Any]] = []
    best: tuple[float, float, dict[str, Any]] | None = None
    for threshold in np.linspace(0.03, 0.97, 95):
        predicted = frame[probability_column].ge(threshold)
        metrics = _event_metrics(frame["bin_start"], predicted, frame[observed_column])
        precision = float(metrics["precisionPct"] or 0) / 100
        recall = float(metrics["recallPct"] or 0) / 100
        csi = float(metrics["csiPct"] or 0) / 100
        score = csi + 0.12 * recall - 0.05 * max(0.0, 0.25 - precision)
        curve.append({"threshold": _round(threshold, 2), "precisionPct": metrics["precisionPct"], "recallPct": metrics["recallPct"], "csiPct": metrics["csiPct"]})
        if best is None or score > best[0]:
            best = (score, float(threshold), metrics)
    assert best is not None
    return best[1], best[2], curve


def _select_classifier(data: pd.DataFrame, kp_threshold: float) -> tuple[dict[str, Any], float, list[dict[str, Any]]]:
    observed_column = "observed"
    candidate_results: list[dict[str, Any]] = []
    best_result: tuple[float, dict[str, Any], float, list[dict[str, Any]]] | None = None
    for params in CLASSIFIER_CANDIDATES:
        fold_predictions: list[pd.DataFrame] = []
        for validation_start, validation_stop in CV_FOLDS:
            train = data[data["bin_start"].lt(validation_start)]
            validation = data[data["bin_start"].ge(validation_start) & data["bin_start"].lt(validation_stop)]
            if train.empty or validation.empty:
                continue
            y_train = train["gfz_kp"].ge(kp_threshold).astype(int)
            weights = np.where(y_train.eq(1), params["positive_weight"], 1.0)
            model = _classifier(params)
            model.fit(train[FEATURE_COLUMNS], y_train, sample_weight=weights)
            fold_predictions.append(pd.DataFrame({
                "bin_start": validation["bin_start"].to_numpy(),
                "probability": model.predict_proba(validation[FEATURE_COLUMNS])[:, 1],
                observed_column: validation["gfz_kp"].ge(kp_threshold).to_numpy(),
            }))
        oof = pd.concat(fold_predictions, ignore_index=True).sort_values("bin_start")
        threshold, metrics, curve = _choose_threshold(oof, "probability", observed_column)
        score = float(metrics["csiPct"] or 0) + 0.12 * float(metrics["recallPct"] or 0)
        result = {
            "id": params["id"], "params": params, "threshold": _round(threshold, 2),
            "oofBins": int(len(oof)), "oofEvents": metrics,
        }
        candidate_results.append(result)
        if best_result is None or score > best_result[0]:
            best_result = (score, params, threshold, curve)
    assert best_result is not None
    selected = {"params": best_result[1], "candidates": candidate_results}
    return selected, best_result[2], best_result[3]


def _fit_final_classifier(data: pd.DataFrame, kp_threshold: float, selection: dict[str, Any]) -> lgb.LGBMClassifier:
    params = selection["params"]
    y = data["gfz_kp"].ge(kp_threshold).astype(int)
    weights = np.where(y.eq(1), params["positive_weight"], 1.0)
    model = _classifier(params)
    model.fit(data[FEATURE_COLUMNS], y, sample_weight=weights)
    return model


def _fit_regressor(data: pd.DataFrame) -> lgb.LGBMRegressor:
    weights = np.select([data["gfz_kp"].ge(7), data["gfz_kp"].ge(5)], [7.0, 3.0], default=1.0)
    model = lgb.LGBMRegressor(
        objective="huber", n_estimators=450, learning_rate=0.03, num_leaves=25,
        min_child_samples=55, subsample=0.85, colsample_bytree=0.85,
        reg_alpha=0.1, reg_lambda=1.0, random_state=42, n_jobs=-1, verbosity=-1,
    )
    model.fit(data[FEATURE_COLUMNS], data["gfz_kp"], sample_weight=weights)
    return model


def _heuristic_kp(frame: pd.DataFrame) -> np.ndarray:
    em_x = np.array([x for x, _ in EM_KP_ANCHORS])
    em_y = np.array([y for _, y in EM_KP_ANCHORS])
    speed_x = np.array([x for x, _ in SPEED_KP_ANCHORS])
    speed_y = np.array([y for _, y in SPEED_KP_ANCHORS])
    return np.maximum(
        np.interp(frame["em_mean"], em_x, em_y),
        np.interp(frame["speed_mean"], speed_x, speed_y),
    ).clip(0, 9)


def _regression_metrics(predicted: Iterable[float], observed: Iterable[float]) -> dict[str, Any]:
    pred = np.asarray(list(predicted), dtype=float)
    obs = np.asarray(list(observed), dtype=float)
    error = pred - obs
    correlation = np.corrcoef(pred, obs)[0, 1] if len(pred) > 1 else math.nan
    return {
        "n": int(len(pred)), "maeKp": _round(np.mean(np.abs(error)), 2),
        "rmseKp": _round(np.sqrt(np.mean(np.square(error))), 2), "biasKp": _round(np.mean(error), 2),
        "correlation": _round(correlation, 3),
        "exactGLevelPct": _pct(int(np.sum(_g_level(pred) == _g_level(obs))), len(pred)),
        "withinOneGLevelPct": _pct(int(np.sum(np.abs(_g_level(pred) - _g_level(obs)) <= 1)), len(pred)),
    }


def _confusion_matrix(predicted: Iterable[float], observed: Iterable[float]) -> list[list[int]]:
    matrix = np.zeros((6, 6), dtype=int)
    for observed_level, predicted_level in zip(_g_level(observed), _g_level(predicted), strict=True):
        matrix[int(observed_level), int(predicted_level)] += 1
    return matrix.tolist()


def _metric_bundle(frame: pd.DataFrame, predicted: Iterable[bool], threshold: float) -> tuple[dict[str, Any], dict[str, Any]]:
    observed = frame["gfz_kp"].ge(threshold)
    bin_metrics = _binary_metrics(predicted, observed)
    event_metrics = _event_metrics(frame["bin_start"], predicted, observed)
    bin_metrics["thresholdKp"] = threshold
    event_metrics["thresholdKp"] = threshold
    return bin_metrics, event_metrics


def _yearly(frame: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for year, subset in frame.groupby(frame["bin_start"].dt.year):
        g1_bin, g1_event = _metric_bundle(subset, subset["g1_alert"], 5)
        g3_bin, g3_event = _metric_bundle(subset, subset["g3_alert"], 7)
        rows.append({
            "year": int(year), "bins": int(len(subset)),
            "g1ObservedEvents": g1_event["observedEvents"], "g1PrecisionPct": g1_event["precisionPct"], "g1RecallPct": g1_event["recallPct"],
            "g3ObservedEvents": g3_event["observedEvents"], "g3PrecisionPct": g3_event["precisionPct"], "g3RecallPct": g3_event["recallPct"],
            "g1BinCsiPct": g1_bin["csiPct"], "g3BinCsiPct": g3_bin["csiPct"],
        })
    return rows


def _evaluation_window_sensitivity(frame: pd.DataFrame) -> list[dict[str, Any]]:
    """Describe sample-size trade-offs without rescoring or moving the held-out cut."""
    rows: list[dict[str, Any]] = []
    for year in (2021, 2022, 2023, 2024):
        start = pd.Timestamp(f"{year}-01-01T00:00:00Z")
        subset = frame[frame["bin_start"].ge(start)]
        observed = subset["gfz_kp"].ge(7)
        events = _event_metrics(subset["bin_start"], observed, observed)["observedEvents"]
        rows.append({
            "startUtc": start.isoformat().replace("+00:00", "Z"),
            "eligibleBins": int(len(subset)),
            "g3Bins": int(observed.sum()),
            "g3Events": int(events),
            "eligibleAsFinalTest": year >= HELDOUT_START.year,
        })
    return rows


def _comparison_product(
    frame: pd.DataFrame,
    product_id: str,
    name: str,
    timing: str,
    kp_column: str,
    g1_alert_column: str | None = None,
    g3_alert_column: str | None = None,
) -> dict[str, Any]:
    g1_alert = frame[g1_alert_column] if g1_alert_column else frame[kp_column].ge(5)
    g3_alert = frame[g3_alert_column] if g3_alert_column else frame[kp_column].ge(7)
    g1_bin, g1_event = _metric_bundle(frame, g1_alert, 5)
    g3_bin, g3_event = _metric_bundle(frame, g3_alert, 7)
    return {
        "id": product_id, "name": name, "timing": timing,
        "regression": _regression_metrics(frame[kp_column], frame["gfz_kp"]),
        "g1Bin": g1_bin, "g1Event": g1_event, "g3Bin": g3_bin, "g3Event": g3_event,
    }


def _external_comparison(heldout: pd.DataFrame) -> tuple[dict[str, Any], dict[str, Any]]:
    noaa, noaa_provenance = _fetch_noaa_forecast_archive()
    gfz_nowcast, gfz_nowcast_provenance = _fetch_gfz_nowcast_archive()
    next_day = noaa.loc[noaa["day_offset"].eq(1), ["bin_start", "noaa_kp"]].rename(columns={"noaa_kp": "noaa_next_day_kp"})
    two_day = noaa.loc[noaa["day_offset"].eq(2), ["bin_start", "noaa_kp"]].rename(columns={"noaa_kp": "noaa_two_day_kp"})
    common = (
        heldout[heldout["bin_start"].ge(EXTERNAL_COMPARISON_START)]
        .merge(next_day, on="bin_start", how="inner")
        .merge(two_day, on="bin_start", how="inner")
        .merge(gfz_nowcast[["bin_start", "gfz_nowcast_kp"]], on="bin_start", how="inner")
        .dropna(subset=["gfz_kp", "model_kp", "noaa_next_day_kp", "noaa_two_day_kp", "gfz_nowcast_kp"])
        .sort_values("bin_start")
        .reset_index(drop=True)
    )
    if common.empty:
        raise RuntimeError("No common bins for the NOAA/GFZ/HelioSat comparison")
    observed_g1 = common["gfz_kp"].ge(5)
    observed_g3 = common["gfz_kp"].ge(7)
    result = {
        "scope": {
            "startUtc": common["bin_start"].min().isoformat().replace("+00:00", "Z"),
            "stopUtc": (common["bin_start"].max() + BIN).isoformat().replace("+00:00", "Z"),
            "commonBins": int(len(common)),
            "observedG1Events": _event_metrics(common["bin_start"], observed_g1, observed_g1)["observedEvents"],
            "observedG3Events": _event_metrics(common["bin_start"], observed_g3, observed_g3)["observedEvents"],
            "fairness": "All four products are scored on the exact same bins against GFZ definitive Kp.",
        },
        "products": [
            _comparison_product(common, "noaa_next_day", "NOAA next-day forecast", "23.5-44.5 h lead from the fixed 0030 UTC issue", "noaa_next_day_kp"),
            _comparison_product(common, "noaa_two_day", "NOAA two-day forecast", "47.5-68.5 h lead from the fixed 0030 UTC issue", "noaa_two_day_kp"),
            _comparison_product(common, "heliosat", "HelioSat trained candidate", f"median {float(common['lead_median_min'].median()):.1f} min L1-to-Earth parcel lead", "model_kp", "g1_alert", "g3_alert"),
            _comparison_product(common, "gfz_nowcast", "GFZ archived nowcast", "no positive forecast lead; archived provisional value", "gfz_nowcast_kp"),
        ],
    }
    return result, {"noaaForecast": noaa_provenance, "gfzNowcast": gfz_nowcast_provenance}


def _example_window(frame: pd.DataFrame) -> dict[str, Any]:
    strongest = frame.loc[frame["gfz_kp"].idxmax()]
    start = strongest["bin_start"] - pd.Timedelta(days=2)
    stop = strongest["bin_start"] + pd.Timedelta(days=2)
    window = frame[frame["bin_start"].between(start, stop)]
    return {
        "title": f"Strongest definitive-Kp interval in held-out evaluation · {strongest['bin_start'].date().isoformat()}",
        "peakGfzKp": _round(strongest["gfz_kp"], 2), "peakHeliosatKpSameBin": _round(strongest["model_kp"], 2),
        "points": [
            {
                "t": int(row.bin_start.timestamp() * 1000), "gfzKp": _round(row.gfz_kp, 2),
                "heliosatKp": _round(row.model_kp, 2), "heuristicKp": _round(row.heuristic_kp, 2),
                "g1ProbabilityPct": _round(100 * row.g1_probability, 1), "g3ProbabilityPct": _round(100 * row.g3_probability, 1),
            }
            for row in window.itertuples(index=False)
        ],
    }


def _feature_importance(model: lgb.LGBMModel, limit: int = 15) -> list[dict[str, Any]]:
    values = model.booster_.feature_importance(importance_type="gain")
    total = float(values.sum()) or 1.0
    rows = sorted(zip(FEATURE_COLUMNS, values, strict=True), key=lambda row: row[1], reverse=True)[:limit]
    return [{"feature": feature, "gainPct": _round(100 * value / total, 1)} for feature, value in rows]


def train(report_path: Path, model_path: Path) -> dict[str, Any]:
    truth, truth_provenance = _fetch_gfz_definitive()
    if FEATURE_CACHE.exists() and FEATURE_META_CACHE.exists():
        data = pd.read_parquet(FEATURE_CACHE)
        build_summary = json.loads(FEATURE_META_CACHE.read_text(encoding="utf-8"))
        omni_provenance = _omni_provenance()
    else:
        omni, omni_provenance = _load_omni()
        data, build_summary = _build_features(omni, truth)
        FEATURE_CACHE.parent.mkdir(parents=True, exist_ok=True)
        data.to_parquet(FEATURE_CACHE, index=False)
        FEATURE_META_CACHE.write_text(json.dumps(build_summary, indent=2) + "\n", encoding="utf-8")
    development = data[data["bin_start"].lt(HELDOUT_START)].copy()
    heldout = data[data["bin_start"].ge(HELDOUT_START) & data["bin_start"].lt(SPAN_STOP)].copy()
    if development.empty or heldout.empty:
        raise RuntimeError("Development or held-out data is empty")

    g1_selection, g1_threshold, g1_curve = _select_classifier(development, 5)
    g3_selection, g3_threshold, g3_curve = _select_classifier(development, 7)
    g1_model = _fit_final_classifier(development, 5, g1_selection)
    g3_model = _fit_final_classifier(development, 7, g3_selection)
    kp_model = _fit_regressor(development)

    heldout["g1_probability"] = g1_model.predict_proba(heldout[FEATURE_COLUMNS])[:, 1]
    heldout["g3_probability"] = g3_model.predict_proba(heldout[FEATURE_COLUMNS])[:, 1]
    heldout["model_kp"] = np.clip(kp_model.predict(heldout[FEATURE_COLUMNS]), 0, 9)
    heldout["heuristic_kp"] = _heuristic_kp(heldout)
    heldout["g1_alert"] = heldout["g1_probability"].ge(g1_threshold)
    heldout["g3_alert"] = heldout["g3_probability"].ge(g3_threshold)
    external_comparison, external_provenance = _external_comparison(heldout)

    g1_bin, g1_event = _metric_bundle(heldout, heldout["g1_alert"], 5)
    g3_bin, g3_event = _metric_bundle(heldout, heldout["g3_alert"], 7)
    baseline_g1_bin, baseline_g1_event = _metric_bundle(heldout, heldout["heuristic_kp"].ge(5), 5)
    baseline_g3_bin, baseline_g3_event = _metric_bundle(heldout, heldout["heuristic_kp"].ge(7), 7)
    regression = _regression_metrics(heldout["model_kp"], heldout["gfz_kp"])
    baseline_regression = _regression_metrics(heldout["heuristic_kp"], heldout["gfz_kp"])

    lead_values = heldout["lead_median_min"].dropna()
    lead = {
        "medianMin": _round(lead_values.median(), 1), "p10Min": _round(lead_values.quantile(0.1), 1),
        "p90Min": _round(lead_values.quantile(0.9), 1), "samples": int(len(lead_values)),
    }

    report = {
        "schemaVersion": "heliosat-geomagnetic-storm-study-v2",
        "generatedAtUtc": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "modelVersion": "gbdt-coupling-probability-v2",
        "status": "candidate-retrospective-held-out",
        "objective": "Train a storm-focused probabilistic model from five-minute L1 solar-wind observations, prioritize G3+ detection, and evaluate every claim on a never-seen 2024–2026 interval.",
        "scope": {
            "developmentStartUtc": SPAN_START.isoformat().replace("+00:00", "Z"),
            "developmentStopUtc": HELDOUT_START.isoformat().replace("+00:00", "Z"),
            "evaluationStartUtc": HELDOUT_START.isoformat().replace("+00:00", "Z"),
            "evaluationStopUtc": SPAN_STOP.isoformat().replace("+00:00", "Z"),
            "developmentBins": int(len(development)), "evaluationBins": int(len(heldout)),
            "nativeTruthCadenceHours": 3, "inputCadenceMinutes": 5,
            "minimumForecastRowsPerBin": MIN_FORECAST_ROWS_PER_BIN,
            "evaluationWindowSensitivity": _evaluation_window_sensitivity(data),
        },
        "resolution": {
            "input": "Every valid five-minute OMNI solar-wind record is used to construct the predictors.",
            "target": "Definitive planetary Kp has one official value per fixed three-hour interval; a minute-by-minute Kp label does not exist.",
            "independence": "Counts and confidence intervals use three-hour bins or contiguous storm episodes, never millions of repeated five-minute pseudo-labels.",
            "higherCadenceOption": "GFZ Hp30 can support a separate 30-minute response-timing study, but it is not the official NOAA G scale target.",
            "incumbentLimitation": "Kp is the internationally recognised incumbent, but its three-hour aggregation blurs onset time and sub-bin peaks; it limits how precisely any Kp model can be trained and scored in time.",
        },
        "data": {
            "upstream": {
                "provider": "NASA/SPDF", "dataset": "High Resolution OMNI 5-minute", "url": "https://omniweb.gsfc.nasa.gov/html/HROdocum.html",
                "role": "Five-minute L1 IMF and plasma values; OMNI Timeshift is used only to reconstruct issue time.",
                "files": omni_provenance, "validRows": int(build_summary["rawRows"]),
                "caveat": "OMNI phase-front shifting is a retrospective propagation reference; it is not an independent bow-shock detector.",
            },
            "truth": truth_provenance,
            "build": build_summary,
            "externalBenchmarks": external_provenance,
        },
        "method": {
            "issueTime": "OMNI target timestamp minus OMNI Timeshift; Timeshift is excluded from model features.",
            "arrival": "Issue time plus MRU travel from measured spacecraft X to a 13.5 Re bow-shock nose.",
            "features": "Five-minute speed, IMF, density and pressure summarized with southward-field, Newell, epsilon and viscous coupling features plus causal 3–9 h memory.",
            "model": "Separate gradient-boosted probability models for G1+ and G3+, plus a storm-weighted Kp regressor.",
            "selection": "Four expanding chronological validation folds from 2001–2023 select tree complexity and alert thresholds; 2024+ remains untouched.",
            "eventDefinition": "One or more contiguous official Kp bins at or above 5 (G1+) or 7 (G3+).",
            "eventMatching": "One-to-one chronological overlap matching with a predeclared ±3 h tolerance.",
        },
        "training": {
            "rawFiveMinuteRows": int(build_summary["rawRows"]), "developmentBins": int(len(development)),
            "developmentG1Bins": int(development["gfz_kp"].ge(5).sum()), "developmentG3Bins": int(development["gfz_kp"].ge(7).sum()),
            "developmentG1Events": _event_metrics(development["bin_start"], development["gfz_kp"].ge(5), development["gfz_kp"].ge(5))["observedEvents"],
            "developmentG3Events": _event_metrics(development["bin_start"], development["gfz_kp"].ge(7), development["gfz_kp"].ge(7))["observedEvents"],
            "featureCount": len(FEATURE_COLUMNS), "features": FEATURE_COLUMNS,
            "g1Selection": g1_selection, "g3Selection": g3_selection,
            "g1ProbabilityThreshold": _round(g1_threshold, 2), "g3ProbabilityThreshold": _round(g3_threshold, 2),
            "g1FeatureImportance": _feature_importance(g1_model), "g3FeatureImportance": _feature_importance(g3_model),
        },
        "leadTime": lead,
        "kpSources": [
            {
                "id": "noaa_forecast", "name": "NOAA 3-day Kp forecast", "kind": "Forecast",
                "producer": "NOAA SWPC", "cadence": "8 × 3 h / day", "timing": "Issued ahead of the target day (roughly 0–72 h)",
                "role": "Long-lead operational context", "scoredHere": True,
                "reason": "Separately scored from immutable 0030 UTC archive issues on common 2025–2026 bins; not mixed into the 2024+ headline score.",
                "url": "https://www.swpc.noaa.gov/products/3-day-forecast",
            },
            {
                "id": "heliosat", "name": "HelioSat GBDT candidate", "kind": "Forecast",
                "producer": "HelioSat", "cadence": "5 min input → 3 h Kp", "timing": f"Short L1-to-Earth lead; median {lead['medianMin']} min",
                "role": "Candidate being validated", "scoredHere": True,
                "reason": "Scored on every eligible held-out bin against GFZ definitive Kp.", "url": None,
            },
            {
                "id": "noaa_estimated", "name": "NOAA estimated planetary Kp", "kind": "Estimate / nowcast",
                "producer": "NOAA SWPC", "cadence": "3 h", "timing": "During or after the target interval; no positive forecast lead",
                "role": "Near-real-time situational awareness", "scoredHere": False,
                "reason": "It is an estimate of the response already occurring, not a like-for-like forecast.",
                "url": "https://www.swpc.noaa.gov/products/planetary-k-index",
            },
            {
                "id": "gfz_nowcast", "name": "GFZ Kp nowcast", "kind": "Nowcast",
                "producer": "GFZ", "cadence": "3 h", "timing": "Available around/after interval completion; no L1 warning time",
                "role": "Provisional operational Kp", "scoredHere": True,
                "reason": "Separately scored as a no-lead reference ceiling on the same common bins; not presented as a forecast.",
                "url": "https://kp.gfz.de/en/data",
            },
            {
                "id": "gfz_definitive", "name": "GFZ definitive Kp", "kind": "Definitive observation",
                "producer": "GFZ", "cadence": "3 h", "timing": "Final retrospective value",
                "role": "Validation truth", "scoredHere": True,
                "reason": "Independent ground-response target used for all headline scores.",
                "url": "https://kp.gfz.de/en/data",
            },
        ],
        "results": {
            "regression": regression, "g1Bin": g1_bin, "g1Event": g1_event, "g3Bin": g3_bin, "g3Event": g3_event,
            "confusionG": _confusion_matrix(heldout["model_kp"], heldout["gfz_kp"]),
            "probabilityCurves": {"g1": g1_curve, "g3": g3_curve},
            "yearly": _yearly(heldout),
            "externalComparison": external_comparison,
            "baseline": {
                "name": "Previous fixed V×Bs heuristic", "regression": baseline_regression,
                "g1Bin": baseline_g1_bin, "g1Event": baseline_g1_event,
                "g3Bin": baseline_g3_bin, "g3Event": baseline_g3_event,
            },
        },
        "examples": {"strongestWindow": _example_window(heldout)},
        "limitations": [
            "The official Kp target is three-hourly; five-minute inputs improve feature fidelity but do not create additional independent storm labels.",
            "Only 2024 onward is used for the final score, and no parameter or alert threshold is changed after viewing it.",
            "The candidate is retrospective and must accumulate immutable live issue-time forecasts before operational performance can be claimed.",
            "G3+ remains rare, so its event confidence intervals are materially wider than G1+ intervals even after extending to 1995.",
            "OMNI uses retrospective phase-front processing; forward validation with the actual live L1 feed remains essential.",
        ],
    }

    model_bundle = {
        "schemaVersion": "heliosat-geomagnetic-model-v2",
        "modelVersion": report["modelVersion"], "trainedAtUtc": report["generatedAtUtc"],
        "operationalStatus": "candidate-not-live", "featureColumns": FEATURE_COLUMNS,
        "g1": {"threshold": _round(g1_threshold, 4), "model": g1_model.booster_.dump_model()},
        "g3": {"threshold": _round(g3_threshold, 4), "model": g3_model.booster_.dump_model()},
        "kp": {"model": kp_model.booster_.dump_model()},
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    model_path.parent.mkdir(parents=True, exist_ok=True)
    model_path.write_text(json.dumps(model_bundle, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    args = parser.parse_args()
    report = train(args.report, args.model)
    print(f"wrote {args.report}")
    print(f"wrote {args.model}")
    for level in ("g1", "g3"):
        metric = report["results"][f"{level}Event"]
        print(f"{level.upper()}+ event: TP={metric['tp']} FP={metric['fp']} FN={metric['fn']} precision={metric['precisionPct']}% recall={metric['recallPct']}%")


if __name__ == "__main__":
    main()
