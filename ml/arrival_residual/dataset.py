"""Build the paired ACE<->OMNI arrival-time record for the residual model.

This reuses the EXACT pairing of the existing Arrival-time validation study
(`src/services/mruArrivalAccuracyService.ts`): every OMNI high-res 5-min row
carries the upstream L1 measurement of one solar-wind parcel (the plasma and
field values ACE/Wind/DSCOVR saw at L1) together with `Timeshift`, the
propagation delay OMNI actually computed for that parcel (phase-front
technique). The MRU benchmark delay is the simple ballistic transit

    mru_delay_s = (x_sc - BSN_x) * Re_km / flow_speed

and the residual target is

    y = Timeshift/60 - mru_delay_min        [minutes]

i.e. how much longer (positive) or shorter (negative) the real propagation was
than flat radial ballistic propagation. The benchmark arrival error of the
existing study is exactly -y.

Data source: SPDF pre-generated yearly files `omni_5min_YYYY.asc` (the same
"static files beat slow HAPI" choice `omniArchiveStore.ts` already makes). The
span and validity filters replicate the study (2021-01-01 .. 2026-05-01,
Timeshift in (0, 900000) s, speed in (0, 90000) km/s, |x| and |BSN_x| < 9999),
so the record is the same population as the published 443k-sample study.

Storm-regime labels (G0 / G1-G2 / G3-G5) come from the local hourly Kp archive
`data/console/omni-archive.json`, classified with the same thresholds as
`stormScaleService.classifyGFromKp` and the same 3 h 30 m staleness rule as the
study's `gAt` lookup.
"""

from __future__ import annotations

import json
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = PROJECT_ROOT / "data" / "cache" / "omni_high_res"
KP_ARCHIVE_PATH = PROJECT_ROOT / "data" / "console" / "omni-archive.json"

SPDF_BASE = "https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni"
RE_KM = 6371.2
NOMINAL_BOW_SHOCK_X_RE = 13.5

# Same span as the existing multi-year arrival study (STATS_SPAN).
SPAN_START = "2021-01-01T00:00:00Z"
SPAN_STOP = "2026-05-01T00:00:00Z"

# omni_5min ASCII word indices (0-based). Format: 46 standard words plus three
# 5-min proton-flux words. Verified against a downloaded file (49 columns).
COLS = {
    "year": 0,
    "doy": 1,
    "hour": 2,
    "minute": 3,
    "timeshift_s": 9,
    "bmag_nt": 13,
    "by_gsm_nt": 17,
    "bz_gsm_nt": 18,
    "speed_km_s": 21,
    "density_p_cc": 25,
    "sc_x_re": 31,
    "sc_y_re": 32,
    "sc_z_re": 33,
    "bsn_x_re": 34,
}

# Fill thresholds per field (values at or above are missing). The target-side
# filters reproduce the study exactly; feature fills become NaN and are left to
# the models (HistGBR handles NaN natively, ridge imputes).
FEATURE_FILL_LIMITS = {
    "bmag_nt": 9_999.0,
    "by_gsm_nt": 9_999.0,
    "bz_gsm_nt": 9_999.0,
    "density_p_cc": 999.0,
    "sc_y_re": 9_999.0,
    "sc_z_re": 9_999.0,
}

DOWNLOAD_TIMEOUT_S = 300
DOWNLOAD_RETRIES = 3


@dataclass(frozen=True)
class PairedRecord:
    """The paired record plus provenance facts the artifacts must report."""

    frame: pd.DataFrame
    span_start_utc: str
    span_stop_utc: str
    source_files: list[str]
    kp_coverage_start_utc: str | None
    kp_coverage_end_utc: str | None
    rows_without_kp_label: int


def _year_file_name(year: int) -> str:
    return f"omni_5min{year}.asc"


def download_year(year: int, refresh: bool = False) -> Path:
    """Download (or reuse) one SPDF yearly 5-min file into the local cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / _year_file_name(year)
    if path.exists() and path.stat().st_size > 1_000_000 and not refresh:
        return path

    url = f"{SPDF_BASE}/{_year_file_name(year)}"
    last_error: Exception | None = None
    for attempt in range(1, DOWNLOAD_RETRIES + 1):
        try:
            print(f"  downloading {url} (attempt {attempt}) ...", flush=True)
            with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_S) as response:
                payload = response.read()
            if len(payload) < 1_000_000:
                raise IOError(f"suspiciously small download ({len(payload)} bytes)")
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(payload)
            tmp.rename(path)
            return path
        except Exception as exc:  # noqa: BLE001 - retried, then surfaced
            last_error = exc
            time.sleep(5 * attempt)
    raise RuntimeError(f"Could not download {url}: {last_error}")


def _parse_year_file(path: Path) -> pd.DataFrame:
    usecols = sorted(COLS.values())
    names_by_index = {idx: name for name, idx in COLS.items()}
    frame = pd.read_csv(path, sep=r"\s+", header=None, usecols=usecols, engine="c")
    frame.columns = [names_by_index[idx] for idx in usecols]
    epoch = (
        pd.to_datetime(frame["year"] * 1000 + frame["doy"], format="%Y%j", utc=True)
        + pd.to_timedelta(frame["hour"], unit="h")
        + pd.to_timedelta(frame["minute"], unit="m")
    )
    frame = frame.drop(columns=["year", "doy", "hour", "minute"])
    frame.insert(0, "time", epoch)
    return frame


def _load_kp_series() -> pd.DataFrame | None:
    """Hourly Kp from the local console archive (rows: [t, v, n, bt, bz, kp, dst])."""
    if not KP_ARCHIVE_PATH.exists():
        return None
    with KP_ARCHIVE_PATH.open() as handle:
        archive = json.load(handle)
    rows = archive.get("rows") or []
    records = [(row[0], row[5]) for row in rows if row[5] is not None]
    if not records:
        return None
    kp = pd.DataFrame(records, columns=["ms", "kp"])
    # pandas 3 preserves the input unit in timezone-aware datetime dtypes.
    # ``merge_asof`` requires both keys to have the exact same precision, so
    # normalise the archive timestamps to the canonical nanosecond UTC dtype.
    kp["time"] = pd.to_datetime(kp["ms"], unit="ms", utc=True).astype(
        "datetime64[ns, UTC]"
    )
    return kp[["time", "kp"]].sort_values("time").reset_index(drop=True)


def _g_level_from_kp(kp: pd.Series) -> pd.Series:
    """Same thresholds as stormScaleService.classifyGFromKp."""
    conditions = [kp >= 9, kp >= 8, kp >= 7, kp >= 6, kp >= 5]
    return pd.Series(
        np.select(conditions, [5, 4, 3, 2, 1], default=0),
        index=kp.index,
        dtype="int64",
    )


def build_paired_record(refresh_downloads: bool = False) -> PairedRecord:
    """Assemble the full paired record over the study span, with G labels."""
    start = pd.Timestamp(SPAN_START)
    stop = pd.Timestamp(SPAN_STOP)
    years = range(start.year, stop.year + 1)

    frames: list[pd.DataFrame] = []
    source_files: list[str] = []
    for year in years:
        path = download_year(year, refresh=refresh_downloads)
        source_files.append(path.name)
        frames.append(_parse_year_file(path))
    frame = pd.concat(frames, ignore_index=True)
    frame["time"] = pd.to_datetime(frame["time"], utc=True).astype(
        "datetime64[ns, UTC]"
    )
    frame = frame[(frame["time"] >= start) & (frame["time"] < stop)].copy()

    # --- Target-side validity: identical to the existing study's filters. ---
    valid = (
        (frame["timeshift_s"] > 0)
        & (frame["timeshift_s"] < 900_000)
        & (frame["speed_km_s"] > 0)
        & (frame["speed_km_s"] < 90_000)
        & (frame["sc_x_re"].abs() < 9_999)
        & (frame["bsn_x_re"].abs() < 9_999)
    )
    frame = frame[valid].sort_values("time").reset_index(drop=True)

    # --- Feature fills -> NaN (never invented values). ---
    for column, limit in FEATURE_FILL_LIMITS.items():
        frame.loc[frame[column].abs() >= limit, column] = np.nan

    # --- Benchmark, target and warning lead, exactly as the study defines. ---
    # The deployable benchmark cannot use OMNI's retrospective BSN_x.  Keep
    # that column only as target/reference lineage and use the same nominal
    # bow-shock geometry as the live HelioSat MRU implementation.
    frame["reference_bsn_x_re"] = frame["bsn_x_re"]
    frame["benchmark_bsn_x_re"] = NOMINAL_BOW_SHOCK_X_RE
    mru_delay_min = (
        (frame["sc_x_re"] - frame["benchmark_bsn_x_re"])
        * RE_KM
        / frame["speed_km_s"]
        / 60.0
    )
    frame["mru_delay_min"] = mru_delay_min
    frame["lead_min"] = frame["timeshift_s"] / 60.0
    frame["target_resid_min"] = frame["timeshift_s"] / 60.0 - mru_delay_min
    frame["benchmark_err_min"] = -frame["target_resid_min"]

    # --- Observed storm regime at each sample from the local Kp archive. ---
    kp = _load_kp_series()
    kp_start = kp["time"].iloc[0].isoformat() if kp is not None else None
    kp_end = kp["time"].iloc[-1].isoformat() if kp is not None else None
    if kp is None:
        frame["kp"] = np.nan
        frame["g_level"] = 0
        rows_without_kp = len(frame)
    else:
        merged = pd.merge_asof(
            frame[["time"]],
            kp.rename(columns={"kp": "kp_lookup"}),
            on="time",
            direction="backward",
            tolerance=pd.Timedelta(hours=3, minutes=30),
        )
        frame["kp"] = merged["kp_lookup"].to_numpy()
        rows_without_kp = int(frame["kp"].isna().sum())
        levels = _g_level_from_kp(frame["kp"].fillna(0.0)).astype("Int64")
        levels.loc[frame["kp"].isna()] = pd.NA
        frame["g_level"] = levels

    frame["regime"] = np.select(
        [
            frame["g_level"].isna().to_numpy(bool),
            frame["g_level"].ge(3).fillna(False).to_numpy(bool),
            frame["g_level"].ge(1).fillna(False).to_numpy(bool),
        ],
        ["unavailable", "severe", "storm"],
        default="quiet",
    )

    return PairedRecord(
        frame=frame,
        span_start_utc=SPAN_START,
        span_stop_utc=SPAN_STOP,
        source_files=source_files,
        kp_coverage_start_utc=kp_start,
        kp_coverage_end_utc=kp_end,
        rows_without_kp_label=rows_without_kp,
    )
