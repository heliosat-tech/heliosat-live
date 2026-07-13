"""Canonical ESA/VirES thermospheric-density schema and validation.

Raw HAPI responses are retained byte-for-byte by :mod:`leo_drag.ingestion`.
This module maps those responses into a mission-independent table.  Invalid
numeric fill values become missing values; they are never replaced by a
climatology or zero.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence

import numpy as np
import pandas as pd

DENSITY_SCHEMA_VERSION = "thermosphere-density-v1"
ESA_FILL_ABS_THRESHOLD = 1.0e30


@dataclass(frozen=True)
class DensityCollection:
    collection_id: str
    mission: Literal["swarm", "grace_fo"]
    mission_label: Literal["Swarm", "GRACE-FO"]
    spacecraft_id: str
    product_family: str
    native_cadence_seconds: int
    quality_flag_available: bool
    official_density_product: bool = True


COLLECTIONS: dict[str, DensityCollection] = {
    **{
        f"SW_OPER_DNS{spacecraft}POD_2_": DensityCollection(
            f"SW_OPER_DNS{spacecraft}POD_2_", "swarm", "Swarm", spacecraft,
            "SW_DNSxPOD_2_", 30, True,
        )
        for spacecraft in ("A", "B", "C")
    },
    **{
        f"SW_OPER_DNS{spacecraft}ACC_2_": DensityCollection(
            f"SW_OPER_DNS{spacecraft}ACC_2_", "swarm", "Swarm", spacecraft,
            "SW_DNSxACC_2_", 10, False,
        )
        for spacecraft in ("A", "B", "C")
    },
    "GF_OPER_DNS1ACC_2_": DensityCollection(
        "GF_OPER_DNS1ACC_2_", "grace_fo", "GRACE-FO", "1",
        "GF_DNSxACC_2_", 10, True,
    ),
}

# Kept only to drive an honest UI state. It must never be passed to the data
# endpoint because VirES currently has no official GRACE-FO 2 density dataset.
UNAVAILABLE_COLLECTIONS: dict[str, DensityCollection] = {
    "GF_OPER_DNS2ACC_2_": DensityCollection(
        "GF_OPER_DNS2ACC_2_", "grace_fo", "GRACE-FO", "2",
        "GF_DNSxACC_2_", 10, True, official_density_product=False,
    )
}

CANONICAL_DENSITY_COLUMNS = [
    "timestamp_utc",
    "mission",
    "spacecraft_id",
    "source_product",
    "source_version",
    "latitude_deg",
    "longitude_deg",
    "altitude_km",
    "local_solar_time_h",
    "rho_obs_kg_m3",
    "rho_uncertainty_kg_m3",
    "quality_flag",
    "orbit_direction",
    "source_file",
    "source_url",
    "source_checksum_sha256",
    "source_catalog_modified_at_utc",
    "ingested_at_utc",
    "evidence_class",
    "schema_version",
    "mission_specific_json",
]


def _finite_or_nan(value: Any) -> float:
    if value is None or isinstance(value, bool):
        return math.nan
    if isinstance(value, str) and value.strip().lower() in {
        "nan", "+nan", "-nan", "inf", "+inf", "-inf", "infinity",
        "+infinity", "-infinity", "null", "",
    }:
        return math.nan
    try:
        result = float(value)
    except (TypeError, ValueError):
        return math.nan
    return result if math.isfinite(result) else math.nan


def _iso_utc(value: Any) -> str | None:
    parsed = pd.to_datetime(value, utc=True, errors="coerce")
    if pd.isna(parsed):
        return None
    return parsed.isoformat().replace("+00:00", "Z")


def collection_for(collection_id: str) -> DensityCollection:
    if collection_id in UNAVAILABLE_COLLECTIONS:
        raise ValueError(
            f"{collection_id} has no official density coverage in the current VirES catalog"
        )
    try:
        return COLLECTIONS[collection_id]
    except KeyError as exc:
        raise ValueError(f"unsupported thermospheric density collection: {collection_id}") from exc


def hapi_parameter_names(info: Mapping[str, Any], response: Mapping[str, Any]) -> list[str]:
    parameters = response.get("parameters") or info.get("parameters") or []
    names: list[str] = []
    for item in parameters:
        if isinstance(item, Mapping) and isinstance(item.get("name"), str):
            names.append(str(item["name"]))
        elif isinstance(item, str):
            names.append(item)
    if not names:
        raise ValueError("HAPI metadata does not describe response parameters")
    return names


def normalize_hapi_response(
    *,
    collection_id: str,
    info: Mapping[str, Any],
    response: Mapping[str, Any],
    source_file: str | Path,
    source_url: str,
    checksum_sha256: str,
    ingested_at_utc: str | datetime | None = None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Normalize one official HAPI response without interpolating missing data."""

    collection = collection_for(collection_id)
    names = hapi_parameter_names(info, response)
    rows = response.get("data")
    if not isinstance(rows, list):
        raise ValueError("HAPI response.data must be a list")
    records: list[dict[str, Any]] = []
    malformed_rows = 0
    for row in rows:
        if not isinstance(row, Sequence) or isinstance(row, (str, bytes)) or len(row) != len(names):
            malformed_rows += 1
            continue
        records.append(dict(zip(names, row, strict=True)))
    native = pd.DataFrame.from_records(records)
    if native.empty:
        return empty_density_frame(), {
            "input_rows": len(rows), "output_rows": 0, "malformed_rows": malformed_rows,
            "invalid_timestamp_rows": 0, "fill_or_invalid_density_rows": 0,
        }
    required = {"Timestamp", "Latitude_GD", "Longitude_GD", "Height_GD", "density"}
    missing = required - set(native.columns)
    if missing:
        raise ValueError(f"HAPI response is missing required parameter(s): {sorted(missing)}")

    timestamp = pd.to_datetime(native["Timestamp"], utc=True, errors="coerce")
    density = native["density"].map(_finite_or_nan).astype(float)
    fill_mask = density.abs().ge(ESA_FILL_ABS_THRESHOLD) | density.le(0)
    density = density.mask(fill_mask)
    latitude = native["Latitude_GD"].map(_finite_or_nan)
    longitude = native["Longitude_GD"].map(_finite_or_nan)
    altitude_km = native["Height_GD"].map(_finite_or_nan) / 1_000.0
    local_solar_time = (
        native["local_solar_time"].map(_finite_or_nan)
        if "local_solar_time" in native else pd.Series(np.nan, index=native.index)
    )
    # VirES can carry ESA fill values independently in geodetic/context
    # fields while density remains populated. Preserve the row and mark only
    # the affected auxiliary value missing; never pass a 1e30 sentinel into
    # trajectory, baseline or seasonal features.
    latitude = latitude.where(latitude.between(-90.0, 90.0))
    longitude = longitude.where(longitude.between(-180.0, 360.0))
    altitude_km = altitude_km.where(altitude_km.between(0.0, 2_000.0))
    local_solar_time = local_solar_time.where(local_solar_time.between(0.0, 24.0))
    if "validity_flag" in native:
        quality = pd.to_numeric(native["validity_flag"], errors="coerce").round().astype("Int64")
    else:
        quality = pd.Series(pd.array([pd.NA] * len(native), dtype="Int64"), index=native.index)

    received = ingested_at_utc or datetime.now(timezone.utc)
    received_iso = _iso_utc(received)
    if received_iso is None:
        raise ValueError("ingested_at_utc must be a UTC-compatible timestamp")
    source_version = info.get("x_version") or info.get("version")
    source_version = str(source_version) if source_version not in (None, "") else None
    catalogue_modified = _iso_utc(info.get("modificationDate"))

    mission_specific: list[str] = []
    for _, row in native.iterrows():
        extra: dict[str, Any] = {}
        for key in ("density_orbitmean", "validity_flag_orbitmean"):
            if key in native.columns:
                value = row.get(key)
                numeric = _finite_or_nan(value)
                extra[key] = numeric if math.isfinite(numeric) and abs(numeric) < ESA_FILL_ABS_THRESHOLD else None
        extra["coordinate_reference"] = "GRS80 geodetic (VirES HAPI)"
        extra["quality_flag_source"] = "VirES validity_flag" if collection.quality_flag_available else "not supplied"
        mission_specific.append(json.dumps(extra, sort_keys=True, separators=(",", ":")))

    frame = pd.DataFrame({
        "timestamp_utc": timestamp,
        "mission": collection.mission_label,
        "spacecraft_id": collection.spacecraft_id,
        "source_product": collection_id,
        "source_version": source_version,
        "latitude_deg": latitude,
        "longitude_deg": longitude,
        "altitude_km": altitude_km,
        "local_solar_time_h": local_solar_time,
        "rho_obs_kg_m3": density,
        "rho_uncertainty_kg_m3": np.nan,
        "quality_flag": quality,
        "orbit_direction": pd.Series([None] * len(native), dtype="object"),
        "source_file": str(source_file),
        "source_url": source_url,
        "source_checksum_sha256": checksum_sha256,
        "source_catalog_modified_at_utc": catalogue_modified,
        "ingested_at_utc": pd.to_datetime(received_iso, utc=True),
        "evidence_class": "observed",
        "schema_version": DENSITY_SCHEMA_VERSION,
        "mission_specific_json": mission_specific,
    })
    frame = frame.loc[frame["timestamp_utc"].notna()].sort_values("timestamp_utc").reset_index(drop=True)
    delta_lat = frame["latitude_deg"].diff()
    frame.loc[delta_lat > 0, "orbit_direction"] = "ascending"
    frame.loc[delta_lat < 0, "orbit_direction"] = "descending"
    report = validate_density_frame(frame)
    report.update({
        "input_rows": len(rows),
        "output_rows": len(frame),
        "malformed_rows": malformed_rows,
        "invalid_timestamp_rows": int(timestamp.isna().sum()),
        "fill_or_invalid_density_rows": int(fill_mask.sum()),
    })
    return frame[CANONICAL_DENSITY_COLUMNS], report


def empty_density_frame() -> pd.DataFrame:
    return pd.DataFrame({column: pd.Series(dtype="object") for column in CANONICAL_DENSITY_COLUMNS})


def validate_density_frame(frame: pd.DataFrame) -> dict[str, Any]:
    errors: list[str] = []
    missing = set(CANONICAL_DENSITY_COLUMNS) - set(frame.columns)
    if missing:
        errors.append(f"missing canonical columns: {sorted(missing)}")
        return {"ok": False, "errors": errors}
    timestamps = pd.to_datetime(frame["timestamp_utc"], utc=True, errors="coerce")
    if timestamps.isna().any():
        errors.append(f"{int(timestamps.isna().sum())} invalid UTC timestamps")
    for column, low, high in (
        ("latitude_deg", -90.0, 90.0),
        ("longitude_deg", -180.0, 360.0),
        ("altitude_km", 0.0, 2_000.0),
        ("local_solar_time_h", 0.0, 24.0),
    ):
        values = pd.to_numeric(frame[column], errors="coerce")
        invalid = values.notna() & ~values.between(low, high, inclusive="both")
        if invalid.any():
            errors.append(f"{column}: {int(invalid.sum())} values outside [{low}, {high}]")
    density = pd.to_numeric(frame["rho_obs_kg_m3"], errors="coerce")
    invalid_density = density.notna() & ((density <= 0) | ~np.isfinite(density) | (density.abs() >= ESA_FILL_ABS_THRESHOLD))
    if invalid_density.any():
        errors.append(f"rho_obs_kg_m3: {int(invalid_density.sum())} invalid/fill values")
    return {"ok": not errors, "errors": errors}


def usable_density_mask(
    frame: pd.DataFrame,
    *,
    allow_quality_not_provided: bool = False,
) -> pd.Series:
    """Select positive finite density rows under an explicit quality policy.

    A missing mission quality flag is never silently interpreted as nominal.
    Callers that scientifically accept an unflagged product must opt in and
    record that choice in their run metadata.
    """

    if "rho_obs_kg_m3" not in frame or "quality_flag" not in frame:
        raise ValueError("density and quality columns are required")
    density = pd.to_numeric(frame["rho_obs_kg_m3"], errors="coerce")
    quality = pd.to_numeric(frame["quality_flag"], errors="coerce")
    physical = density.notna() & np.isfinite(density) & density.gt(0) & density.abs().lt(
        ESA_FILL_ABS_THRESHOLD
    )
    accepted_quality = quality.eq(0).fillna(False)
    if allow_quality_not_provided:
        accepted_quality = accepted_quality | quality.isna()
    return physical & accepted_quality
