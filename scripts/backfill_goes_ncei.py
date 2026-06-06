#!/usr/bin/env python3
"""Backfill NOAA NCEI GOES-R MAG, SEISS, and EXIS XRS NetCDF files into local Parquet."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


SOURCE_ID = "ncei-goes-r-mag-seiss"
STORE_SOURCE = "goes_nccei"
BASE_URL = "https://data.ngdc.noaa.gov/platforms/solar-space-observing-satellites/goes"
USER_AGENT = "heliosat-goes-ncei-backfill/1.0"
DEFAULT_SPACECRAFT = ("GOES-16", "GOES-17", "GOES-18", "GOES-19")
PRODUCT_PATHS = {
    "mag": "magn-l2-avg1m",
    "mpsh": "mpsh-l2-avg1m",
    "sgps": "sgps-l2-avg1m",
    "xrs": "xrsf-l2-avg1m",
}
PRODUCT_INSTRUMENTS = {
    "mag": "MAG",
    "mpsh": "SEISS MPSH",
    "sgps": "SEISS SGPS",
    "xrs": "EXIS XRS",
}
NORMALIZED_COLUMNS = [
    "timestamp_utc",
    "source",
    "spacecraft_id",
    "mission",
    "instrument",
    "variable",
    "value",
    "quality_flag",
    "unit",
    "cadence_s",
    "native_product",
    "native_variable",
]
REQUEST_RETRIES = 3
REQUEST_BASE_DELAY_SECONDS = 2.0
SECONDS_PER_DAY = 24 * 60 * 60
UTC = timezone.utc


@dataclass(frozen=True)
class NceiFile:
    spacecraft: str
    product: str
    product_path: str
    day: date
    url: str
    file_name: str


def compute_h_magnitude(hn: Any, hp: Any, he: Any) -> Any:
    return (hn * hn + hp * hp + he * he) ** 0.5


def map_ncei_quality_flag(value: Any) -> int:
    if value is None:
        return 4

    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 4

    if not math.isfinite(parsed):
        return 4

    rounded = int(parsed)
    if rounded == 0:
        return 0
    if rounded == 1:
        return 1
    if rounded == 4:
        return 4
    return 2


def parse_utc_datetime(value: str) -> datetime:
    normalized = value.strip()

    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
        return datetime.fromisoformat(normalized).replace(tzinfo=UTC)

    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"

    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)

    return parsed.astimezone(UTC)


def normalize_utc_iso(value: Any) -> str | None:
    if value is None:
        return None

    try:
        parsed = parse_utc_datetime(str(value))
    except (TypeError, ValueError):
        return None

    return parsed.isoformat().replace("+00:00", "Z")


def update_last_timestamp_ingested(checkpoint: dict[str, Any], candidate_value: Any) -> None:
    candidate_iso = normalize_utc_iso(candidate_value)
    if candidate_iso is None:
        return

    existing_iso = normalize_utc_iso(checkpoint.get("last_timestamp_ingested"))
    if existing_iso is not None and parse_utc_datetime(existing_iso) >= parse_utc_datetime(candidate_iso):
        return

    checkpoint["last_timestamp_ingested"] = candidate_iso


def refresh_last_timestamp_from_partitions(checkpoint: dict[str, Any]) -> None:
    candidates = [checkpoint.get("last_timestamp_ingested")]
    candidates.extend(
        partition.get("last_timestamp_utc")
        for partition in checkpoint.get("partitions", {}).values()
        if isinstance(partition, dict)
    )
    parsed = [
        parse_utc_datetime(timestamp)
        for timestamp in (normalize_utc_iso(candidate) for candidate in candidates)
        if timestamp is not None
    ]

    if parsed:
        checkpoint["last_timestamp_ingested"] = max(parsed).isoformat().replace("+00:00", "Z")


def default_range() -> tuple[datetime, datetime]:
    stop = datetime.now(UTC) - timedelta(days=7)
    stop = stop.replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        start = stop.replace(year=stop.year - 2)
    except ValueError:
        start = stop.replace(year=stop.year - 2, day=28)
    return start, stop


def month_keys_between(start: datetime, stop: datetime) -> Iterable[tuple[int, int]]:
    cursor = datetime(start.year, start.month, 1, tzinfo=UTC)
    stop_month = datetime(stop.year, stop.month, 1, tzinfo=UTC)

    while cursor <= stop_month:
        yield cursor.year, cursor.month
        if cursor.month == 12:
            cursor = datetime(cursor.year + 1, 1, 1, tzinfo=UTC)
        else:
            cursor = datetime(cursor.year, cursor.month + 1, 1, tzinfo=UTC)


def normalize_spacecraft(value: str) -> str:
    normalized = value.strip().upper()
    if re.fullmatch(r"G\d{2}", normalized):
        normalized = f"GOES-{normalized[1:]}"
    if re.fullmatch(r"\d{2}", normalized):
        normalized = f"GOES-{normalized}"
    return normalized


def parse_csv_or_all(value: str, allowed: Iterable[str], normalizer=lambda item: item) -> list[str]:
    allowed_values = tuple(allowed)
    if value.strip().lower() == "all":
        return list(allowed_values)

    parsed = [normalizer(item) for item in value.split(",") if item.strip()]
    invalid = sorted(set(parsed).difference(allowed_values))

    if invalid:
        raise argparse.ArgumentTypeError(f"Unsupported value(s): {', '.join(invalid)}")

    return parsed


def load_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default
    except json.JSONDecodeError:
        return default


def save_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=path.parent, encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temp_name = handle.name
    os.replace(temp_name, path)


def request_with_retry(url: str) -> bytes:
    last_error: Exception | None = None

    for attempt in range(REQUEST_RETRIES):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise FileNotFoundError(url) from exc
            last_error = exc
            if attempt < REQUEST_RETRIES - 1:
                time.sleep(REQUEST_BASE_DELAY_SECONDS * (2**attempt))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt < REQUEST_RETRIES - 1:
                time.sleep(REQUEST_BASE_DELAY_SECONDS * (2**attempt))

    raise RuntimeError(f"Request failed for {url}: {last_error}")


def parse_directory_listing(html: str, base_url: str) -> list[str]:
    hrefs = re.findall(r'href="([^"]+)"', html, flags=re.IGNORECASE)
    urls: list[str] = []

    for href in hrefs:
        decoded = urllib.parse.unquote(href)
        if not decoded.endswith(".nc"):
            continue
        urls.append(urllib.parse.urljoin(base_url, decoded))

    return sorted(set(urls))


def date_from_file_name(file_name: str) -> date | None:
    match = re.search(r"_d(\d{8})_", file_name)
    if not match:
        return None
    return datetime.strptime(match.group(1), "%Y%m%d").date()


def version_from_file_name(file_name: str) -> tuple[int, ...]:
    match = re.search(r"_v(\d+(?:-\d+)*)\.nc$", file_name)
    if not match:
        return (0,)
    return tuple(int(part) for part in match.group(1).split("-"))


def discover_month_files(
    spacecraft: str,
    product: str,
    year: int,
    month: int,
    cache: dict[str, Any],
    force_refresh: bool = False,
) -> list[NceiFile]:
    product_path = PRODUCT_PATHS[product]
    spacecraft_number = spacecraft.split("-")[-1]
    url = f"{BASE_URL}/goes{spacecraft_number}/l2/data/{product_path}/{year}/{month:02d}/"
    cache_key = f"{spacecraft}|{product}|{year}|{month:02d}"
    cached = cache.setdefault("months", {}).get(cache_key)

    if cached and not force_refresh:
        nc_urls = cached.get("files", [])
    else:
        try:
            html = request_with_retry(url).decode("utf-8", errors="replace")
        except FileNotFoundError:
            html = ""
        nc_urls = parse_directory_listing(html, url)
        cache["months"][cache_key] = {
            "listed_at_utc": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "url": url,
            "files": nc_urls,
        }

    files_by_day: dict[date, NceiFile] = {}
    for file_url in nc_urls:
        file_name = Path(urllib.parse.urlparse(file_url).path).name
        day = date_from_file_name(file_name)
        if day is None:
            continue
        item = NceiFile(
            spacecraft=spacecraft,
            product=product,
            product_path=product_path,
            day=day,
            url=file_url,
            file_name=file_name,
        )
        existing = files_by_day.get(day)
        if existing is None or version_from_file_name(item.file_name) > version_from_file_name(existing.file_name):
            files_by_day[day] = item

    return sorted(files_by_day.values(), key=lambda item: item.day)


def discover_files(
    spacecraft: Iterable[str],
    products: Iterable[str],
    start: datetime,
    stop: datetime,
    cache_path: Path,
    force_refresh: bool = False,
) -> list[NceiFile]:
    cache = load_json(cache_path, {"version": 1, "months": {}})
    discovered: list[NceiFile] = []

    for spacecraft_id in spacecraft:
        for product in products:
            for year, month in month_keys_between(start, stop):
                discovered.extend(
                    discover_month_files(spacecraft_id, product, year, month, cache, force_refresh=force_refresh)
                )

    save_json_atomic(cache_path, cache)
    start_day = start.date()
    stop_day = stop.date()

    return [
        item
        for item in discovered
        if start_day <= item.day < stop_day
    ]


def local_download_path(download_dir: Path, item: NceiFile) -> Path:
    return (
        download_dir
        / item.spacecraft.lower().replace("-", "")
        / item.product_path
        / f"{item.day.year}"
        / f"{item.day.month:02d}"
        / item.file_name
    )


def download_file(item: NceiFile, download_dir: Path) -> Path:
    destination = local_download_path(download_dir, item)
    if destination.exists() and destination.stat().st_size > 0:
        return destination

    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination.with_suffix(destination.suffix + ".tmp")

    last_error: Exception | None = None
    for attempt in range(REQUEST_RETRIES):
        try:
            request = urllib.request.Request(item.url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=180) as response, temp_path.open("wb") as handle:
                shutil.copyfileobj(response, handle)
            os.replace(temp_path, destination)
            return destination
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if temp_path.exists():
                temp_path.unlink()
            if attempt < REQUEST_RETRIES - 1:
                time.sleep(REQUEST_BASE_DELAY_SECONDS * (2**attempt))

    raise RuntimeError(f"Download failed for {item.url}: {last_error}")


def load_science_stack():
    try:
        import numpy as np
        import pandas as pd
        import pyarrow  # noqa: F401
        import xarray as xr
    except ImportError as exc:
        raise RuntimeError(
            "GOES NCEI backfill requires xarray, numpy, pandas, pyarrow, and a NetCDF engine. "
            "Install them with: python3 -m pip install -r requirements-pipeline.txt"
        ) from exc

    return np, pd, xr


def to_utc_iso_strings(time_values: Any, time_attrs: dict[str, Any], np: Any, pd: Any) -> list[str]:
    values = np.asarray(time_values)

    if np.issubdtype(values.dtype, np.datetime64):
        index = pd.to_datetime(values, utc=True)
    else:
        units = str(time_attrs.get("units", "")).lower()
        match = re.search(r"since\s+([0-9:\-\. ttz]+)", units)
        origin_text = match.group(1).strip() if match else "2000-01-01 12:00:00"
        origin = pd.Timestamp(origin_text.replace("z", ""), tz="UTC")
        unit = "s"
        if units.startswith("milliseconds"):
            unit = "ms"
        elif units.startswith("microseconds"):
            unit = "us"
        elif units.startswith("nanoseconds"):
            unit = "ns"
        index = origin + pd.to_timedelta(values.astype("float64"), unit=unit)

    return [timestamp.isoformat().replace("+00:00", "Z") for timestamp in index]


def find_time_data_array(ds: Any) -> Any | None:
    for name in ("time", "L2_SciData_TimeStamp", "timestamp"):
        if name in ds:
            return ds[name]
    return None


def time_dim_for(da: Any) -> str:
    if "time" in da.dims:
        return "time"
    if "t" in da.dims:
        return "t"
    return da.dims[0]


def collapse_to_time_series(da: Any, np: Any, reducer: str = "mean") -> Any:
    time_dim = time_dim_for(da)
    result = da
    for dim in tuple(result.dims):
        if dim == time_dim:
            continue
        if reducer == "max":
            result = result.max(dim=dim, skipna=True)
        else:
            result = result.mean(dim=dim, skipna=True)
    return np.asarray(result.values, dtype="float64")


def select_component(da: Any, coordinate_name: str, fallback_index: int) -> Any:
    coordinate_dim = next((dim for dim in da.dims if dim.lower() in {"coordinate", "coord", "component"}), None)
    if coordinate_dim is None:
        return da

    coord = da.coords.get(coordinate_dim)
    if coord is not None:
        coord_values = [str(value).strip().upper() for value in coord.values.tolist()]
        if coordinate_name in coord_values:
            return da.sel({coordinate_dim: coord.values[coord_values.index(coordinate_name)]})

    return da.isel({coordinate_dim: fallback_index})


def energy_target_for_units(target_kev: float, energy_da: Any) -> float:
    units = str(energy_da.attrs.get("units", "")).lower()
    if "mev" in units:
        return target_kev / 1000.0
    return target_kev


def select_nearest_energy_channel(flux_da: Any, energy_da: Any, target_kev: float, np: Any) -> Any:
    time_dim = time_dim_for(flux_da)
    candidate_dims = [dim for dim in energy_da.dims if dim in flux_da.dims and dim != time_dim]

    if not candidate_dims:
        candidate_dims = [
            dim for dim in flux_da.dims
            if dim != time_dim and flux_da.sizes[dim] in set(np.asarray(energy_da.values).shape)
        ]

    if not candidate_dims:
        return flux_da

    energy_dim = candidate_dims[0]
    energy_by_channel = energy_da

    for dim in tuple(energy_by_channel.dims):
        if dim != energy_dim:
            energy_by_channel = energy_by_channel.mean(dim=dim, skipna=True)

    energy_values = np.asarray(energy_by_channel.values, dtype="float64")
    target = energy_target_for_units(target_kev, energy_da)
    index = int(np.nanargmin(np.abs(energy_values - target)))
    return flux_da.isel({energy_dim: index})


def quality_array_from_values(values: Any, base_quality: Any, np: Any) -> Any:
    quality = np.asarray(base_quality, dtype="int16").copy()
    missing = ~np.isfinite(np.asarray(values, dtype="float64"))
    quality[missing] = np.maximum(quality[missing], 4)
    return quality


def quality_from_numeric_da(da: Any, count: int, np: Any) -> Any:
    raw = collapse_to_time_series(da, np, reducer="max") if len(da.dims) > 1 else np.asarray(da.values)
    mapped = np.asarray([map_ncei_quality_flag(value) for value in raw], dtype="int16")

    if mapped.size != count:
        return np.zeros(count, dtype="int16")

    return mapped


def find_first_dataset_var(ds: Any, names: Iterable[str]) -> Any | None:
    for name in names:
        if name in ds:
            return ds[name]
    return None


def particle_quality(ds: Any, prefix: str, count: int, np: Any) -> Any:
    quality = np.zeros(count, dtype="int16")
    valid_names = [
        f"{prefix}ValidL1bSamplesInAvg",
        f"{prefix}ValidSamplesInAvg",
        "IntValidL1bSamplesInAvg" if prefix == "Int" else "",
    ]
    valid_da = find_first_dataset_var(ds, valid_names)

    if valid_da is not None:
        valid = collapse_to_time_series(valid_da, np, reducer="max")
        if valid.size == count:
            quality[valid <= 0] = 4

    dqf_names = [name for name in ds.data_vars if name.startswith(prefix) and "DQF" in name]
    for name in dqf_names:
        values = collapse_to_time_series(ds[name], np, reducer="max")
        if values.size != count:
            continue
        # SEISS DQF variables are sums of upstream condition counters over the averaging
        # window, not the compact 0/1/2/4 quality enum used by some NCEI products.
        # Treat finite nonzero DQF counters as degraded unless the sample is missing.
        warning_mask = (values > 0) & (quality == 0)
        quality[warning_mask] = 1

    return quality


def build_variable_frame(
    pd: Any,
    timestamps: list[str],
    spacecraft: str,
    product: str,
    variable: str,
    values: Any,
    quality: Any,
    unit: str,
    native_variable: str,
) -> Any:
    return pd.DataFrame(
        {
            "timestamp_utc": timestamps,
            "source": STORE_SOURCE,
            "spacecraft_id": spacecraft,
            "mission": spacecraft,
            "instrument": PRODUCT_INSTRUMENTS[product],
            "variable": variable,
            "value": values,
            "quality_flag": quality,
            "unit": unit,
            "cadence_s": 60,
            "native_product": PRODUCT_PATHS[product],
            "native_variable": native_variable,
        },
        columns=NORMALIZED_COLUMNS,
    )


def normalize_mag(ds: Any, item: NceiFile, timestamps: list[str], np: Any, pd: Any) -> Any:
    vector_name = "b_epn" if "b_epn" in ds else "b_epnu"

    if vector_name not in ds:
        return pd.DataFrame(columns=NORMALIZED_COLUMNS)

    vector = ds[vector_name]
    he = collapse_to_time_series(select_component(vector, "E", 0), np)
    hp = collapse_to_time_series(select_component(vector, "P", 1), np)
    hn = collapse_to_time_series(select_component(vector, "N", 2), np)
    magnitude = compute_h_magnitude(hn, hp, he)
    count = len(timestamps)
    base_quality = (
        quality_from_numeric_da(ds["b_quality"], count, np)
        if "b_quality" in ds
        else np.zeros(count, dtype="int16")
    )
    frames = [
        build_variable_frame(
            pd,
            timestamps,
            item.spacecraft,
            item.product,
            "goes_mag_he",
            he,
            quality_array_from_values(he, base_quality, np),
            "nT",
            f"{vector_name}.E",
        ),
        build_variable_frame(
            pd,
            timestamps,
            item.spacecraft,
            item.product,
            "goes_mag_hp",
            hp,
            quality_array_from_values(hp, base_quality, np),
            "nT",
            f"{vector_name}.P",
        ),
        build_variable_frame(
            pd,
            timestamps,
            item.spacecraft,
            item.product,
            "goes_mag_hn",
            hn,
            quality_array_from_values(hn, base_quality, np),
            "nT",
            f"{vector_name}.N",
        ),
        build_variable_frame(
            pd,
            timestamps,
            item.spacecraft,
            item.product,
            "goes_mag_h_magnitude",
            magnitude,
            quality_array_from_values(magnitude, base_quality, np),
            "nT",
            f"sqrt({vector_name}.E^2+{vector_name}.P^2+{vector_name}.N^2)",
        ),
    ]
    return pd.concat(frames, ignore_index=True)


def normalize_mpsh(ds: Any, item: NceiFile, timestamps: list[str], np: Any, pd: Any) -> Any:
    frames = []
    count = len(timestamps)

    if "AvgIntElectronFlux" in ds:
        flux = ds["AvgIntElectronFlux"]
        if "IntElectronEffectiveEnergy" in ds:
            flux = select_nearest_energy_channel(flux, ds["IntElectronEffectiveEnergy"], 2000.0, np)
        values = collapse_to_time_series(flux, np)
        quality = quality_array_from_values(values, particle_quality(ds, "Int", count, np), np)
        frames.append(
            build_variable_frame(
                pd,
                timestamps,
                item.spacecraft,
                item.product,
                "goes_electrons_2mev",
                values,
                quality,
                "pfu",
                "AvgIntElectronFlux",
            )
        )

    if "AvgDiffElectronFlux" in ds:
        flux = ds["AvgDiffElectronFlux"]
        energy = find_first_dataset_var(ds, ["DiffElectronEffectiveEnergy", "DiffElectronLowerEnergy"])
        if energy is not None:
            flux = select_nearest_energy_channel(flux, energy, 800.0, np)
        values = collapse_to_time_series(flux, np)
        quality = quality_array_from_values(values, particle_quality(ds, "DiffElectron", count, np), np)
        frames.append(
            build_variable_frame(
                pd,
                timestamps,
                item.spacecraft,
                item.product,
                "goes_electrons_800kev",
                values,
                quality,
                "pfu",
                "AvgDiffElectronFlux@800keV",
            )
        )

    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=NORMALIZED_COLUMNS)


def normalize_sgps(ds: Any, item: NceiFile, timestamps: list[str], np: Any, pd: Any) -> Any:
    if "AvgIntProtonFlux" not in ds:
        return pd.DataFrame(columns=NORMALIZED_COLUMNS)

    frames = []
    count = len(timestamps)
    base_quality = particle_quality(ds, "Int", count, np)
    energy = find_first_dataset_var(ds, ["IntegralProtonEffectiveEnergy", "IntProtonEffectiveEnergy"])
    channels = [
        ("goes_protons_10mev", 10000.0, "AvgIntProtonFlux@10MeV"),
        ("goes_protons_50mev", 50000.0, "AvgIntProtonFlux@50MeV"),
        ("goes_protons_100mev", 100000.0, "AvgIntProtonFlux@100MeV"),
    ]

    for variable, target_kev, native_variable in channels:
        flux = ds["AvgIntProtonFlux"]
        if energy is not None:
            flux = select_nearest_energy_channel(flux, energy, target_kev, np)
        values = collapse_to_time_series(flux, np)
        quality = quality_array_from_values(values, base_quality, np)
        frames.append(
            build_variable_frame(
                pd,
                timestamps,
                item.spacecraft,
                item.product,
                variable,
                values,
                quality,
                "pfu",
                native_variable,
            )
        )

    return pd.concat(frames, ignore_index=True)


def xrs_quality(ds: Any, flux_name: str, count: int, np: Any) -> Any:
    quality = np.zeros(count, dtype="int16")
    num_name = f"{flux_name.removesuffix('_flux')}_num"
    flag_name = f"{flux_name.removesuffix('_flux')}_flag"

    if num_name in ds:
        averaged_count = collapse_to_time_series(ds[num_name], np, reducer="max")
        if averaged_count.size == count:
            quality[averaged_count <= 0] = 4

    if flag_name in ds:
        flags = collapse_to_time_series(ds[flag_name], np, reducer="max")
        if flags.size == count:
            quality[(flags > 0) & (quality == 0)] = 1

    return quality


def normalize_xrs(ds: Any, item: NceiFile, timestamps: list[str], np: Any, pd: Any) -> Any:
    frames = []
    count = len(timestamps)
    channels = [
        ("goes_xrs_short_flux", "xrsa_flux", "0.05-0.4 nm"),
        ("goes_xrs_long_flux", "xrsb_flux", "0.1-0.8 nm"),
    ]

    for variable, flux_name, band in channels:
        if flux_name not in ds:
            continue

        values = collapse_to_time_series(ds[flux_name], np)
        quality = quality_array_from_values(values, xrs_quality(ds, flux_name, count, np), np)
        frames.append(
            build_variable_frame(
                pd,
                timestamps,
                item.spacecraft,
                item.product,
                variable,
                values,
                quality,
                "W/m^2",
                f"{flux_name}@{band}",
            )
        )

    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=NORMALIZED_COLUMNS)


def normalize_file(path: Path, item: NceiFile, variables: set[str] | None = None) -> Any:
    np, pd, xr = load_science_stack()

    with xr.open_dataset(path, mask_and_scale=True, decode_times=False) as ds:
        time_da = find_time_data_array(ds)
        if time_da is None:
            return pd.DataFrame(columns=NORMALIZED_COLUMNS)

        timestamps = to_utc_iso_strings(time_da.values, time_da.attrs, np, pd)

        if item.product == "mag":
            frame = normalize_mag(ds, item, timestamps, np, pd)
        elif item.product == "mpsh":
            frame = normalize_mpsh(ds, item, timestamps, np, pd)
        elif item.product == "sgps":
            frame = normalize_sgps(ds, item, timestamps, np, pd)
        elif item.product == "xrs":
            frame = normalize_xrs(ds, item, timestamps, np, pd)
        else:
            frame = pd.DataFrame(columns=NORMALIZED_COLUMNS)

    if variables:
        frame = frame[frame["variable"].isin(variables)].copy()

    return frame


def partition_path(store_root: Path, spacecraft: str, year: int, month: int) -> Path:
    return (
        store_root
        / f"source={STORE_SOURCE}"
        / f"spacecraft={spacecraft}"
        / f"year={year}"
        / f"month={month:02d}"
        / "part-000.parquet"
    )


def persist_frame(frame: Any, store_root: Path, checkpoint: dict[str, Any]) -> int:
    if frame.empty:
        return 0

    pd = sys.modules.get("pandas")
    if pd is None:
        _, pd, _ = load_science_stack()

    frame = frame.copy()
    timestamp = pd.to_datetime(frame["timestamp_utc"], utc=True)
    frame["_year"] = timestamp.dt.year
    frame["_month"] = timestamp.dt.month
    rows_written = 0

    group_columns = ["spacecraft_id", "_year", "_month"]
    for (spacecraft, year, month), chunk in frame.groupby(group_columns):
        target = partition_path(store_root, str(spacecraft), int(year), int(month))
        target.parent.mkdir(parents=True, exist_ok=True)
        chunk = chunk[NORMALIZED_COLUMNS].copy()

        if target.exists():
            existing = pd.read_parquet(target)
            merged = pd.concat([existing, chunk], ignore_index=True)
        else:
            merged = chunk

        merged = (
            merged.sort_values(["spacecraft_id", "variable", "timestamp_utc"])
            .drop_duplicates(["spacecraft_id", "variable", "timestamp_utc"], keep="last")
            .reset_index(drop=True)
        )
        temp_path = target.with_suffix(".parquet.tmp")
        merged.to_parquet(temp_path, engine="pyarrow", compression="snappy", index=False)
        os.replace(temp_path, target)

        partition_key = str(target.parent.relative_to(store_root))
        checkpoint.setdefault("partitions", {})[partition_key] = {
            "row_count": int(len(merged)),
            "last_timestamp_utc": str(merged["timestamp_utc"].max()) if not merged.empty else None,
            "updated_at_utc": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        }
        rows_written += int(len(chunk))

    update_last_timestamp_ingested(checkpoint, frame["timestamp_utc"].max())
    return rows_written


def update_daily_coverage(frame: Any, item: NceiFile, checkpoint: dict[str, Any]) -> None:
    if frame.empty:
        return

    valid = frame[frame["quality_flag"] < 2]
    observed = int(valid["timestamp_utc"].drop_duplicates().shape[0])
    key = f"{item.day.isoformat()}|{item.spacecraft}|{item.product}"
    checkpoint.setdefault("daily_coverage", {})[key] = {
        "date_utc": item.day.isoformat(),
        "spacecraft_id": item.spacecraft,
        "product": item.product,
        "observed_samples": observed,
        "expected_samples": SECONDS_PER_DAY // 60,
    }


def mark_processed(
    checkpoint: dict[str, Any],
    item: NceiFile,
    rows_written: int,
    local_path: Path,
) -> None:
    checkpoint.setdefault("processed_files", {})[item.url] = {
        "processed_at_utc": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "spacecraft_id": item.spacecraft,
        "product": item.product,
        "date_utc": item.day.isoformat(),
        "rows_written": rows_written,
        "local_path": str(local_path),
    }
    checkpoint.setdefault("failed_files", {}).pop(item.url, None)
    checkpoint["updated_at_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")


def mark_raw_deleted(checkpoint: dict[str, Any], item: NceiFile, local_path: Path) -> None:
    processed = checkpoint.setdefault("processed_files", {}).setdefault(item.url, {})
    processed["local_path"] = str(local_path)
    processed["raw_deleted"] = True
    processed["raw_deleted_at_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    checkpoint["updated_at_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")


def delete_raw_file(
    local_path: Path,
    checkpoint: dict[str, Any],
    item: NceiFile,
    checkpoint_path: Path,
) -> bool:
    try:
        if local_path.exists():
            local_path.unlink()
        mark_raw_deleted(checkpoint, item, local_path)
        save_json_atomic(checkpoint_path, checkpoint)
        return True
    except OSError as exc:
        print(f"FAILED delete raw {local_path}: {exc}", file=sys.stderr, flush=True)
        return False


def mark_failed(checkpoint: dict[str, Any], item: NceiFile, error: Exception) -> None:
    checkpoint.setdefault("failed_files", {})[item.url] = {
        "failed_at_utc": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "spacecraft_id": item.spacecraft,
        "product": item.product,
        "date_utc": item.day.isoformat(),
        "error": str(error),
    }
    checkpoint["updated_at_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")


def initialize_checkpoint() -> dict[str, Any]:
    return {
        "version": 1,
        "source_id": SOURCE_ID,
        "store_source": STORE_SOURCE,
        "processed_files": {},
        "failed_files": {},
        "partitions": {},
        "daily_coverage": {},
    }


def process_file(
    item: NceiFile,
    local_path: Path,
    store_root: Path,
    checkpoint: dict[str, Any],
    checkpoint_path: Path,
    variables: set[str] | None,
    force: bool = False,
) -> tuple[int, bool]:
    if item.url in checkpoint.get("processed_files", {}) and not force:
        return 0, True

    frame = normalize_file(local_path, item, variables=variables)
    rows_written = persist_frame(frame, store_root, checkpoint)
    update_daily_coverage(frame, item, checkpoint)
    mark_processed(checkpoint, item, rows_written, local_path)
    save_json_atomic(checkpoint_path, checkpoint)
    return rows_written, False


def build_parser() -> argparse.ArgumentParser:
    start, stop = default_range()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default=start.date().isoformat(), help="UTC start, inclusive. Default: now-1w-2y.")
    parser.add_argument("--stop", default=stop.date().isoformat(), help="UTC stop, exclusive. Default: now-1w.")
    parser.add_argument(
        "--spacecraft",
        default="all",
        help="Comma-separated GOES spacecraft, e.g. GOES-18 or GOES-16,GOES-18. Default: all.",
    )
    parser.add_argument(
        "--product",
        default="all",
        help="Comma-separated products: mag,mpsh,sgps,xrs. Default: all.",
    )
    parser.add_argument(
        "--variables",
        default="",
        help="Comma-separated canonical variables to retain after normalization.",
    )
    parser.add_argument("--workers", type=int, default=6, help="Parallel download workers.")
    parser.add_argument("--store-root", default="data/parquet", help="Local Parquet root.")
    parser.add_argument("--cache-path", default="data/cache/goes_ncei_archive_files.json", help="Discovery cache JSON.")
    parser.add_argument("--checkpoint", default="data/checkpoints/goes_ncei_archive.json", help="Checkpoint JSON.")
    parser.add_argument("--download-dir", default=".cache/goes_ncei/downloads", help="NetCDF download cache.")
    parser.add_argument("--refresh-discovery", action="store_true", help="Ignore cached NCEI directory listings.")
    parser.add_argument(
        "--delete-raw-after-process",
        action="store_true",
        help="Delete each local NetCDF file after it is processed or confirmed already checkpointed.",
    )
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Use checkpoint last_timestamp_ingested as --start for the daily production pull.",
    )
    parser.add_argument("--force", action="store_true", help="Reprocess already checkpointed files and merge idempotently.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    store_root = Path(args.store_root)
    cache_path = Path(args.cache_path)
    checkpoint_path = Path(args.checkpoint)
    download_dir = Path(args.download_dir)
    checkpoint = load_json(checkpoint_path, initialize_checkpoint())
    checkpoint.setdefault("source_id", SOURCE_ID)
    checkpoint.setdefault("store_source", STORE_SOURCE)
    start = parse_utc_datetime(args.start)
    stop = parse_utc_datetime(args.stop)

    if args.incremental and checkpoint.get("last_timestamp_ingested"):
        start = parse_utc_datetime(str(checkpoint["last_timestamp_ingested"]))

    if stop <= start:
        raise SystemExit("--stop must be after --start")

    spacecraft = parse_csv_or_all(args.spacecraft, DEFAULT_SPACECRAFT, normalize_spacecraft)
    products = parse_csv_or_all(args.product, PRODUCT_PATHS.keys(), lambda value: value.strip().lower())
    variables = {item.strip() for item in args.variables.split(",") if item.strip()} or None

    files = discover_files(
        spacecraft,
        products,
        start,
        stop,
        cache_path,
        force_refresh=args.refresh_discovery,
    )
    files = sorted(files, key=lambda item: (item.day, item.spacecraft, item.product, item.file_name))
    pending = [
        item
        for item in files
        if args.force or item.url not in checkpoint.get("processed_files", {})
    ]
    pull_started = datetime.now(UTC)
    failed = 0
    rows_written = 0
    skipped = len(files) - len(pending)
    processed_count = 0

    print(f"Discovered {len(files)} files, {len(pending)} pending.", flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as executor:
        futures = {executor.submit(download_file, item, download_dir): item for item in pending}
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                local_path = future.result()
            except Exception as exc:  # noqa: BLE001
                failed += 1
                mark_failed(checkpoint, item, exc)
                save_json_atomic(checkpoint_path, checkpoint)
                print(f"FAILED download {item.url}: {exc}", file=sys.stderr, flush=True)
                completed = processed_count + failed
                if completed % 100 == 0 or completed == len(pending):
                    print(
                        f"Progress completed={completed}/{len(pending)} processed={processed_count} "
                        f"failed={failed} rows_written={rows_written}",
                        flush=True,
                    )
                continue

            try:
                next_rows, was_skipped = process_file(
                    item,
                    local_path,
                    store_root,
                    checkpoint,
                    checkpoint_path,
                    variables,
                    force=args.force,
                )
                rows_written += next_rows
                skipped += int(was_skipped)
                processed_count += int(not was_skipped)
                deleted = (
                    delete_raw_file(local_path, checkpoint, item, checkpoint_path)
                    if args.delete_raw_after_process
                    else False
                )
                delete_label = " raw_deleted" if deleted else ""
                print(f"OK {item.spacecraft} {item.product} {item.day} rows={next_rows}{delete_label}", flush=True)
            except Exception as exc:  # noqa: BLE001
                failed += 1
                mark_failed(checkpoint, item, exc)
                save_json_atomic(checkpoint_path, checkpoint)
                print(f"FAILED process {item.url}: {exc}", file=sys.stderr, flush=True)

            completed = processed_count + failed
            if completed % 100 == 0 or completed == len(pending):
                print(
                    f"Progress completed={completed}/{len(pending)} processed={processed_count} "
                    f"failed={failed} rows_written={rows_written}",
                    flush=True,
                )

    elapsed_minutes = max((datetime.now(UTC) - pull_started).total_seconds() / 60.0, 1 / 60)
    checkpoint["last_pull"] = {
        "started_at_utc": pull_started.isoformat().replace("+00:00", "Z"),
        "finished_at_utc": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "rows_written": rows_written,
        "rows_per_minute": rows_written / elapsed_minutes,
        "files_discovered": len(files),
        "files_processed": processed_count,
        "files_failed": failed,
        "files_skipped": skipped,
        "last_error": None if failed == 0 else f"{failed} GOES NCEI file(s) failed in this pull",
    }
    refresh_last_timestamp_from_partitions(checkpoint)
    checkpoint["updated_at_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    save_json_atomic(checkpoint_path, checkpoint)

    print(
        f"Done rows_written={rows_written} files_failed={failed} files_skipped={skipped} "
        f"checkpoint={checkpoint_path}",
        flush=True,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
