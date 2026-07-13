"""Versioned F10.7/Ap forcing for the NRLMSIS research baseline.

The source is NASA SPDF's official pre-generated OMNI2 hourly archive.  Files
are kept byte-for-byte with SHA-256 sidecars.  The derived seven-element Ap
history follows the ordering required by NRLMSIS storm-time mode.  Centered
F10.7a is explicitly labelled retrospective because it contains future days;
it must not be used as a forecast-issuance feature.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Literal

import numpy as np
import pandas as pd

OMNI2_BASE_URL = "https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni"
OMNI2_FORMAT_URL = f"{OMNI2_BASE_URL}/omni2.text"
USER_AGENT = "heliosat-internal-leo-density-research/1.0"
AP_FILL = 999.0
F107_FILL = 999.9

F107aMode = Literal["centered_81_day_retrospective", "trailing_81_day"]


@dataclass(frozen=True)
class AncillarySnapshot:
    source_files: list[str]
    checksums_sha256: dict[str, str]
    source_urls: list[str]
    coverage_start_utc: str | None
    coverage_end_utc: str | None
    retrieved_at_utc: dict[str, str | None]
    f107a_mode: F107aMode
    availability_class: str

    def to_dict(self) -> dict[str, object]:
        return {
            "source": "NASA SPDF OMNI2 hourly",
            "format_documentation": OMNI2_FORMAT_URL,
            "source_files": self.source_files,
            "checksums_sha256": self.checksums_sha256,
            "source_urls": self.source_urls,
            "coverage_start_utc": self.coverage_start_utc,
            "coverage_end_utc": self.coverage_end_utc,
            "retrieved_at_utc": self.retrieved_at_utc,
            "f107a_mode": self.f107a_mode,
            "availability_class": self.availability_class,
            "warning": (
                "Centered 81-day F10.7a uses future days and is retrospective only."
                if self.f107a_mode == "centered_81_day_retrospective"
                else "Trailing F10.7a is causal, but OMNI2 publication latency remains retrospective."
            ),
        }


def _utc_iso(value: pd.Timestamp | datetime) -> str:
    parsed = pd.Timestamp(value)
    if parsed.tzinfo is None:
        parsed = parsed.tz_localize("UTC")
    else:
        parsed = parsed.tz_convert("UTC")
    return parsed.isoformat().replace("+00:00", "Z")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _sidecar_path(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".metadata.json")


def download_omni2_year(
    year: int,
    *,
    data_root: str | Path = "data",
    refresh: bool = False,
    timeout_seconds: float = 90.0,
    retries: int = 3,
) -> Path:
    """Download or reuse one exact official OMNI2 yearly file."""

    if year < 1963 or year > datetime.now(timezone.utc).year:
        raise ValueError("OMNI2 year is outside the supported archive range")
    root = Path(data_root).resolve()
    destination = root / "raw" / "thermosphere" / "ancillary" / "omni2" / f"omni2_{year}.dat"
    sidecar = _sidecar_path(destination)
    if destination.exists() and destination.stat().st_size > 1_000_000 and not refresh:
        return destination

    url = f"{OMNI2_BASE_URL}/omni2_{year}.dat"
    last_error: Exception | None = None
    for attempt in range(max(1, retries)):
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "text/plain"}
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = response.read()
            if len(payload) < 1_000_000:
                raise IOError(f"suspiciously small OMNI2 response ({len(payload)} bytes)")
            retrieved = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            checksum = _sha256(payload)
            _atomic_bytes(destination, payload)
            _atomic_bytes(
                sidecar,
                (json.dumps({
                    "source": "NASA SPDF OMNI2 hourly",
                    "source_url": url,
                    "format_documentation": OMNI2_FORMAT_URL,
                    "retrieved_at_utc": retrieved,
                    "checksum_sha256": checksum,
                    "bytes": len(payload),
                    "evidence_class": "retrospective_official_archive",
                }, indent=2, sort_keys=True) + "\n").encode("utf-8"),
            )
            return destination
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt + 1 < max(1, retries):
                time.sleep(1.5 * (2**attempt))
    raise RuntimeError(f"could not download official OMNI2 file {url}: {last_error}")


def parse_omni2_file(path: str | Path) -> pd.DataFrame:
    """Parse UTC, planetary 3-hour Ap and F10.7 from an OMNI2 flat file.

    OMNI2 words are 1-based in the official format: year=1, DOY=2, hour=3,
    Ap=50 and F10.7=51.  Raw fill values stay missing.
    """

    source = Path(path)
    frame = pd.read_csv(
        source,
        sep=r"\s+",
        header=None,
        usecols=[0, 1, 2, 49, 50],
        names=["year", "day_of_year", "hour", "ap_index_nt", "f107_sfu"],
        engine="c",
    )
    timestamp = (
        pd.to_datetime(
            frame["year"] * 1000 + frame["day_of_year"],
            format="%Y%j",
            utc=True,
            errors="coerce",
        )
        + pd.to_timedelta(frame["hour"], unit="h")
    )
    ap = pd.to_numeric(frame["ap_index_nt"], errors="coerce")
    f107 = pd.to_numeric(frame["f107_sfu"], errors="coerce")
    ap = ap.mask((ap < 0) | (ap >= AP_FILL))
    f107 = f107.mask((f107 <= 0) | (f107 >= F107_FILL))
    output = pd.DataFrame({
        "timestamp_utc": timestamp,
        "ap_index_nt": ap,
        "f107_sfu": f107,
        "source_file": str(source.resolve()),
    })
    return output.dropna(subset=["timestamp_utc"]).sort_values("timestamp_utc").reset_index(drop=True)


def build_msis_forcing_from_hourly(
    hourly: pd.DataFrame,
    *,
    f107a_mode: F107aMode = "centered_81_day_retrospective",
) -> pd.DataFrame:
    """Derive daily F10.7/F10.7a and the seven storm-time Ap inputs."""

    required = {"timestamp_utc", "ap_index_nt", "f107_sfu"}
    missing = required - set(hourly.columns)
    if missing:
        raise ValueError(f"hourly OMNI2 table is missing {sorted(missing)}")
    if f107a_mode not in {"centered_81_day_retrospective", "trailing_81_day"}:
        raise ValueError(f"unsupported F10.7a mode: {f107a_mode}")

    work = hourly.copy()
    work["timestamp_utc"] = pd.to_datetime(work["timestamp_utc"], utc=True, errors="coerce")
    work["ap_index_nt"] = pd.to_numeric(work["ap_index_nt"], errors="coerce")
    work["f107_sfu"] = pd.to_numeric(work["f107_sfu"], errors="coerce")
    work = work.dropna(subset=["timestamp_utc"]).sort_values("timestamp_utc")
    work["three_hour_utc"] = work["timestamp_utc"].dt.floor("3h")
    work["date_utc"] = work["timestamp_utc"].dt.floor("D")

    ap3 = work.groupby("three_hour_utc", sort=True)["ap_index_nt"].median().rename("ap_current")
    daily_ap = ap3.groupby(ap3.index.floor("D")).mean().rename("ap_daily")
    daily_f107 = work.groupby("date_utc", sort=True)["f107_sfu"].median().rename("f107_observed_sfu")
    daily = pd.concat([daily_f107, daily_ap], axis=1).sort_index()
    daily["f107_previous_day_sfu"] = daily["f107_observed_sfu"].shift(1)
    if f107a_mode == "centered_81_day_retrospective":
        daily["f107a_sfu"] = daily["f107_observed_sfu"].rolling(
            81, center=True, min_periods=81
        ).mean()
    else:
        # At any issuance time within day D, D's final daily flux is not yet
        # known.  The causal 81-day mean therefore ends at D-1, matching the
        # previous-day F10.7 availability boundary used by the baseline.
        daily["f107a_sfu"] = daily["f107_observed_sfu"].shift(1).rolling(
            81, center=False, min_periods=81
        ).mean()

    forcing = ap3.to_frame()
    forcing["ap_3h_before"] = forcing["ap_current"].shift(1)
    forcing["ap_6h_before"] = forcing["ap_current"].shift(2)
    forcing["ap_9h_before"] = forcing["ap_current"].shift(3)
    forcing["ap_12_33h_mean"] = forcing["ap_current"].shift(4).rolling(8, min_periods=8).mean()
    forcing["ap_36_57h_mean"] = forcing["ap_current"].shift(12).rolling(8, min_periods=8).mean()
    forcing["date_utc"] = forcing.index.floor("D")
    forcing = forcing.join(
        daily[["ap_daily", "f107_previous_day_sfu", "f107a_sfu"]],
        on="date_utc",
    )
    forcing = forcing.reset_index().rename(columns={"three_hour_utc": "forcing_time_utc"})
    forcing["f107a_mode"] = f107a_mode
    forcing["ancillary_availability_class"] = "retrospective_only"
    forcing["ancillary_source"] = "NASA SPDF OMNI2 hourly"
    return forcing.drop(columns=["date_utc"])


def forcing_for_timestamps(
    timestamps: Iterable[object],
    forcing: pd.DataFrame,
) -> pd.DataFrame:
    """Backward-join the active three-hour forcing bin to requested UTC times."""

    left = pd.DataFrame({
        "timestamp_utc": pd.to_datetime(
            list(timestamps), utc=True, errors="coerce"
        ).astype("datetime64[ns, UTC]")
    })
    left["_row"] = np.arange(len(left))
    valid = left.dropna(subset=["timestamp_utc"]).sort_values("timestamp_utc")
    right = forcing.copy()
    right["forcing_time_utc"] = pd.to_datetime(
        right["forcing_time_utc"], utc=True, errors="coerce"
    ).astype("datetime64[ns, UTC]")
    right = right.dropna(subset=["forcing_time_utc"]).sort_values("forcing_time_utc")
    merged = pd.merge_asof(
        valid,
        right,
        left_on="timestamp_utc",
        right_on="forcing_time_utc",
        direction="backward",
        tolerance=pd.Timedelta(hours=3),
        allow_exact_matches=True,
    ) if not valid.empty else valid.copy()
    if left["timestamp_utc"].isna().any():
        invalid = left[left["timestamp_utc"].isna()].copy()
        for column in right.columns:
            if column not in invalid:
                invalid[column] = pd.NA
        merged = pd.concat([merged, invalid], ignore_index=True, sort=False)
    return merged.sort_values("_row").drop(columns=["_row"]).reset_index(drop=True)


def load_omni2_forcing(
    start: object,
    stop: object,
    *,
    data_root: str | Path = "data",
    refresh: bool = False,
    f107a_mode: F107aMode = "centered_81_day_retrospective",
) -> tuple[pd.DataFrame, AncillarySnapshot]:
    """Load a reproducible forcing table spanning ``[start, stop)``.

    The centered retrospective mean retains sixty days on either side.  The
    causal trailing mean retains ninety days before the requested interval so
    its first value has the full 81-day history.  The returned table still
    includes sixty hours of pre-window Ap context for timestamp alignment.
    """

    start_ts = pd.to_datetime(start, utc=True, errors="raise")
    stop_ts = pd.to_datetime(stop, utc=True, errors="raise")
    if stop_ts <= start_ts:
        raise ValueError("stop must be after start")
    history_margin_days = 90 if f107a_mode == "trailing_81_day" else 60
    margin_start = start_ts - pd.Timedelta(days=history_margin_days)
    margin_stop = stop_ts + pd.Timedelta(days=60)
    paths = [
        download_omni2_year(year, data_root=data_root, refresh=refresh)
        for year in range(margin_start.year, margin_stop.year + 1)
    ]
    hourly = pd.concat([parse_omni2_file(path) for path in paths], ignore_index=True)
    hourly = hourly[
        (hourly["timestamp_utc"] >= margin_start.floor("h"))
        & (hourly["timestamp_utc"] < margin_stop.ceil("h"))
    ].copy()
    forcing = build_msis_forcing_from_hourly(hourly, f107a_mode=f107a_mode)
    forcing = forcing[
        (forcing["forcing_time_utc"] >= start_ts.floor("3h") - pd.Timedelta(hours=60))
        & (forcing["forcing_time_utc"] < stop_ts.ceil("3h"))
    ].reset_index(drop=True)

    checksums: dict[str, str] = {}
    urls: list[str] = []
    retrieved: dict[str, str | None] = {}
    for path in paths:
        checksums[path.name] = _sha256(path.read_bytes())
        urls.append(f"{OMNI2_BASE_URL}/{path.name}")
        sidecar = _sidecar_path(path)
        try:
            metadata = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            metadata = {}
        retrieved[path.name] = metadata.get("retrieved_at_utc")
    coverage_start = hourly["timestamp_utc"].min() if not hourly.empty else None
    coverage_stop = hourly["timestamp_utc"].max() if not hourly.empty else None
    snapshot = AncillarySnapshot(
        source_files=[str(path.resolve()) for path in paths],
        checksums_sha256=checksums,
        source_urls=urls,
        coverage_start_utc=_utc_iso(coverage_start) if coverage_start is not None else None,
        coverage_end_utc=_utc_iso(coverage_stop) if coverage_stop is not None else None,
        retrieved_at_utc=retrieved,
        f107a_mode=f107a_mode,
        availability_class="retrospective_only",
    )
    return forcing, snapshot
