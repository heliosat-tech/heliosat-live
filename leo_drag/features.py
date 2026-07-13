"""Leakage-safe feature datasets for thermospheric density studies.

The feature table is deliberately independent from the generic HelioSat
training pipeline.  Density is both the scientific target and a potential
source of severe leakage, so the target, observation time, forecast issuance
time and every optional data-availability time remain explicit.

The learned target follows the implementation plan exactly::

    log(rho_observed) - log(rho_baseline)

All solar-wind joins are backward joins delegated to :mod:`leo_drag.drivers`.
Optional geomagnetic inputs are accepted only with an explicit operational
availability label; a feature can enter M4 only when its own availability
timestamp proves that it existed at forecast issuance.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Literal, Mapping, Sequence

import numpy as np
import pandas as pd

from .drivers import DriverMode, causal_backward_join, driver_missingness

FEATURE_SCHEMA_VERSION = "leo-density-features-v1"
TARGET_COLUMN = "target_log_density_residual"
TARGET_DEFINITION = "ln(rho_obs_kg_m3) - ln(rho_baseline_kg_m3)"

FeatureAvailability = Literal[
    "available_at_issuance",
    "delayed_nowcast",
    "retrospective_only",
]

ALLOWED_AVAILABILITY: frozenset[str] = frozenset(
    {"available_at_issuance", "delayed_nowcast", "retrospective_only"}
)

# Only these stable mission attributes are eligible as model features.  Source
# product/version/file identifiers are lineage, not predictors: they can encode
# a campaign or time period and would make cross-mission results misleading.
# Mission and spacecraft identity are lineage, grouping and validation keys.
# They are deliberately barred from every deployable model: otherwise a fitted
# category bias can masquerade as physical generalisation to a new spacecraft.
CATEGORICAL_CONTEXT_FEATURES: tuple[str, ...] = ("orbit_direction",)

IDENTITY_LINEAGE_COLUMNS: tuple[str, ...] = (
    "mission",
    "spacecraft_id",
    "spacecraft_key",
)

NUMERIC_CONTEXT_FEATURES: tuple[str, ...] = (
    "altitude_km",
    "latitude_deg",
    "longitude_sin",
    "longitude_cos",
    "local_solar_time_sin",
    "local_solar_time_cos",
    "day_of_year_sin",
    "day_of_year_cos",
    "f107_sfu",
    "f107a_sfu",
    "log_rho_baseline",
)

DRIVER_INSTANTANEOUS_FEATURES: tuple[str, ...] = (
    "vsw_km_s",
    "np_cm3",
    "bx_gsm_nt",
    "by_gsm_nt",
    "bz_gsm_nt",
    "bmag_nt",
    "pdyn_npa",
    "em_mv_m",
    "newell_coupling",
    "epsilon_coupling_w",
    "arrival_uncertainty_min",
    "time_since_bz_below_minus_10_min",
)

FORBIDDEN_EXACT_FEATURES: frozenset[str] = frozenset(
    {
        TARGET_COLUMN,
        "rho_obs_kg_m3",
        "rho_uncertainty_kg_m3",
        "log_rho_obs",
        "log10_rho_obs",
        "density_ratio_observed_to_baseline",
        "target",
        "y",
    }
)

FORBIDDEN_FEATURE_FRAGMENTS: tuple[str, ...] = (
    "future_",
    "lead_",
    "rho_observed",
    "observed_density",
)


def _iso_utc(value: pd.Timestamp | datetime) -> str:
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp.isoformat().replace("+00:00", "Z")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


@dataclass(frozen=True)
class FeatureDefinition:
    name: str
    group: Literal["context", "baseline", "solar_wind", "geomagnetic"]
    dtype: Literal["numeric", "categorical"]
    availability: FeatureAvailability


@dataclass(frozen=True)
class FeatureDatasetMetadata:
    feature_schema_version: str
    dataset_version: str
    experiment_mode: DriverMode
    generated_at_utc: str
    target_column: str
    target_definition: str
    row_count: int
    target_valid_rows: int
    driver_matched_rows: int
    driver_missing_rows: int
    start_utc: str | None
    end_utc: str | None
    source_manifest_checksum_sha256: str | None
    feature_definitions: tuple[FeatureDefinition, ...]
    geomagnetic_availability: dict[str, FeatureAvailability]
    missingness: dict[str, dict[str, float | int]]
    causal_join: dict[str, object]

    def to_dict(self) -> dict[str, object]:
        result = asdict(self)
        result["feature_definitions"] = [asdict(item) for item in self.feature_definitions]
        return result


def density_residual_target(
    observed_density: Sequence[float] | pd.Series,
    baseline_density: Sequence[float] | pd.Series,
) -> pd.Series:
    """Return the natural-log residual and null every non-physical row."""

    observed = pd.to_numeric(pd.Series(observed_density), errors="coerce")
    baseline = pd.to_numeric(pd.Series(baseline_density), errors="coerce")
    observed, baseline = observed.align(baseline)
    valid = (
        np.isfinite(observed)
        & np.isfinite(baseline)
        & (observed > 0.0)
        & (baseline > 0.0)
    )
    target = pd.Series(np.nan, index=observed.index, dtype=float, name=TARGET_COLUMN)
    target.loc[valid] = np.log(observed.loc[valid]) - np.log(baseline.loc[valid])
    return target


def _numeric_column(frame: pd.DataFrame, name: str) -> pd.Series:
    if name not in frame.columns:
        return pd.Series(np.nan, index=frame.index, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce")


def add_cyclic_context(frame: pd.DataFrame) -> pd.DataFrame:
    """Encode longitude, local solar time and day-of-year cyclically."""

    if "timestamp_utc" not in frame.columns:
        raise ValueError("feature observations require timestamp_utc")
    out = frame.copy()
    timestamp = pd.to_datetime(out["timestamp_utc"], utc=True, errors="coerce")
    if timestamp.isna().any():
        raise ValueError("timestamp_utc contains invalid or timezone-less values")
    out["timestamp_utc"] = timestamp

    longitude = _numeric_column(out, "longitude_deg")
    longitude_rad = np.deg2rad(longitude)
    out["longitude_sin"] = np.sin(longitude_rad)
    out["longitude_cos"] = np.cos(longitude_rad)

    local_time = _numeric_column(out, "local_solar_time_h")
    local_time_rad = 2.0 * np.pi * (local_time % 24.0) / 24.0
    out["local_solar_time_sin"] = np.sin(local_time_rad)
    out["local_solar_time_cos"] = np.cos(local_time_rad)

    day = timestamp.dt.dayofyear.astype(float)
    days_in_year = np.where(timestamp.dt.is_leap_year, 366.0, 365.0)
    day_rad = 2.0 * np.pi * (day - 1.0) / days_in_year
    out["day_of_year_sin"] = np.sin(day_rad)
    out["day_of_year_cos"] = np.cos(day_rad)
    return out


def _driver_feature_columns(frame: pd.DataFrame) -> list[str]:
    return sorted(
        column
        for column in frame.columns
        if column in DRIVER_INSTANTANEOUS_FEATURES or column.startswith("drv__")
    )


def assert_no_target_leakage(feature_columns: Iterable[str]) -> None:
    """Reject target-derived or future-looking columns before model fitting."""

    offending: list[str] = []
    for column in feature_columns:
        normalised = str(column).strip().lower()
        if normalised in FORBIDDEN_EXACT_FEATURES or any(
            fragment in normalised for fragment in FORBIDDEN_FEATURE_FRAGMENTS
        ):
            offending.append(str(column))
    if offending:
        raise AssertionError(f"target/future leakage feature(s): {sorted(set(offending))}")


def assert_geomagnetic_availability(
    frame: pd.DataFrame,
    feature_names: Iterable[str],
    availability: Mapping[str, FeatureAvailability],
    *,
    issuance_column: str = "forecast_issuance_time_utc",
) -> None:
    """Prove that every issuance-safe geomagnetic value existed at issuance.

    The per-feature availability column must be named
    ``<feature>_available_at_utc``.  Missing timestamps are rejected; assuming
    immediate publication would be scientifically unsafe.
    """

    if issuance_column not in frame.columns:
        raise AssertionError(f"missing forecast issuance column: {issuance_column}")
    issuance = pd.to_datetime(frame[issuance_column], utc=True, errors="coerce")
    if issuance.isna().any():
        raise AssertionError("forecast issuance time contains invalid values")

    for feature in feature_names:
        label = availability.get(feature)
        if label not in ALLOWED_AVAILABILITY:
            raise AssertionError(f"geomagnetic feature {feature!r} has no valid availability label")
        if label != "available_at_issuance":
            continue
        availability_column = f"{feature}_available_at_utc"
        if availability_column not in frame.columns:
            raise AssertionError(
                f"issuance-safe geomagnetic feature {feature!r} lacks {availability_column!r}"
            )
        available_at = pd.to_datetime(frame[availability_column], utc=True, errors="coerce")
        populated = pd.to_numeric(frame[feature], errors="coerce").notna()
        if available_at.loc[populated].isna().any():
            raise AssertionError(f"geomagnetic feature {feature!r} has values without availability time")
        if (available_at.loc[populated] > issuance.loc[populated]).any():
            raise AssertionError(f"future geomagnetic value entered feature {feature!r}")


def issuance_safe_geomagnetic_features(
    frame: pd.DataFrame,
    availability: Mapping[str, FeatureAvailability],
    *,
    issuance_column: str = "forecast_issuance_time_utc",
) -> list[str]:
    """Return M4-eligible features, or an empty list when proof is incomplete."""

    candidates = sorted(
        feature
        for feature, label in availability.items()
        if label == "available_at_issuance" and feature in frame.columns
    )
    if not candidates:
        return []
    try:
        assert_geomagnetic_availability(
            frame,
            candidates,
            availability,
            issuance_column=issuance_column,
        )
    except AssertionError:
        return []
    return candidates


def _feature_definitions(
    frame: pd.DataFrame,
    *,
    experiment_mode: DriverMode,
    geomagnetic_availability: Mapping[str, FeatureAvailability],
) -> tuple[FeatureDefinition, ...]:
    definitions: list[FeatureDefinition] = []
    baseline_availability: FeatureAvailability = "available_at_issuance"
    if "f107a_mode" in frame.columns:
        modes = set(frame["f107a_mode"].dropna().astype(str).unique())
        if modes - {"trailing_81_day"}:
            baseline_availability = "retrospective_only"
    if "baseline_ancillary_availability" in frame.columns:
        labels = set(
            frame["baseline_ancillary_availability"].dropna().astype(str).unique()
        )
        if labels and labels != {"available_at_issuance"}:
            baseline_availability = "retrospective_only"
    for column in NUMERIC_CONTEXT_FEATURES:
        if column not in frame.columns:
            continue
        group: Literal["context", "baseline"] = (
            "baseline" if column == "log_rho_baseline" else "context"
        )
        availability: FeatureAvailability = (
            baseline_availability
            if column in {"f107_sfu", "f107a_sfu", "log_rho_baseline"}
            else "available_at_issuance"
        )
        definitions.append(FeatureDefinition(column, group, "numeric", availability))
    for column in CATEGORICAL_CONTEXT_FEATURES:
        if column in frame.columns:
            definitions.append(FeatureDefinition(column, "context", "categorical", "available_at_issuance"))
    driver_availability: FeatureAvailability = (
        "retrospective_only" if experiment_mode == "reference_aligned" else "available_at_issuance"
    )
    for column in _driver_feature_columns(frame):
        definitions.append(FeatureDefinition(column, "solar_wind", "numeric", driver_availability))
    for column, availability in sorted(geomagnetic_availability.items()):
        if column in frame.columns:
            definitions.append(FeatureDefinition(column, "geomagnetic", "numeric", availability))
    assert_no_target_leakage(item.name for item in definitions)
    return tuple(definitions)


def _dataset_version(
    frame: pd.DataFrame,
    *,
    experiment_mode: DriverMode,
    source_manifest_checksum: str | None,
) -> str:
    digest = hashlib.sha256()
    digest.update(FEATURE_SCHEMA_VERSION.encode("utf-8"))
    digest.update(experiment_mode.encode("utf-8"))
    digest.update((source_manifest_checksum or "no-manifest-checksum").encode("utf-8"))
    digest.update("\0".join(sorted(frame.columns)).encode("utf-8"))
    if not frame.empty:
        timestamps = pd.to_datetime(frame["timestamp_utc"], utc=True)
        digest.update(str(len(frame)).encode("ascii"))
        digest.update(_iso_utc(timestamps.min()).encode("ascii"))
        digest.update(_iso_utc(timestamps.max()).encode("ascii"))
        for column in ("source_checksum_sha256", "source_file"):
            if column in frame.columns:
                values = sorted(str(value) for value in frame[column].dropna().unique())
                digest.update("\0".join(values).encode("utf-8"))
    return f"{FEATURE_SCHEMA_VERSION}-{digest.hexdigest()[:16]}"


def build_feature_dataset(
    observations: pd.DataFrame,
    driver_timeline: pd.DataFrame,
    *,
    experiment_mode: DriverMode,
    issuance_time_column: str | None = None,
    geomagnetic_availability: Mapping[str, FeatureAvailability] | None = None,
    tolerance: str | pd.Timedelta | None = "30min",
    dataset_version: str | None = None,
    source_manifest_checksum_sha256: str | None = None,
) -> tuple[pd.DataFrame, FeatureDatasetMetadata]:
    """Create one versioned, causal feature table for one experiment mode."""

    required = {"timestamp_utc", "rho_obs_kg_m3", "rho_baseline_kg_m3"}
    missing = required - set(observations.columns)
    if missing:
        raise ValueError(f"density observations missing column(s): {sorted(missing)}")
    if experiment_mode not in {
        "reference_aligned",
        "heliosat_mru_arrival",
        "heliosat_mru_ml_arrival",
        "heliosat_predicted_arrival",
    }:
        raise ValueError(f"unknown experiment mode: {experiment_mode!r}")
    if "experiment_mode" in driver_timeline.columns:
        timeline_modes = set(driver_timeline["experiment_mode"].dropna().astype(str).unique())
        if timeline_modes and timeline_modes != {experiment_mode}:
            raise ValueError(
                f"driver timeline mode(s) {sorted(timeline_modes)} cannot enter {experiment_mode!r} dataset"
            )

    availability = dict(geomagnetic_availability or {})
    invalid_labels = {
        feature: label for feature, label in availability.items() if label not in ALLOWED_AVAILABILITY
    }
    if invalid_labels:
        raise ValueError(f"invalid geomagnetic availability labels: {invalid_labels}")

    context = add_cyclic_context(observations)
    if issuance_time_column is None:
        context["forecast_issuance_time_utc"] = context["timestamp_utc"]
        join_issuance_column = "forecast_issuance_time_utc"
    else:
        if issuance_time_column not in context.columns:
            raise ValueError(f"missing issuance timestamp column: {issuance_time_column}")
        context["forecast_issuance_time_utc"] = pd.to_datetime(
            context[issuance_time_column], utc=True, errors="coerce"
        )
        if context["forecast_issuance_time_utc"].isna().any():
            raise ValueError("forecast issuance time contains invalid values")
        join_issuance_column = "forecast_issuance_time_utc"

    observed = pd.to_numeric(context["rho_obs_kg_m3"], errors="coerce")
    baseline = pd.to_numeric(context["rho_baseline_kg_m3"], errors="coerce")
    context["log_rho_obs"] = np.where(observed > 0.0, np.log(observed), np.nan)
    context["log10_rho_obs"] = np.where(observed > 0.0, np.log10(observed), np.nan)
    context["log_rho_baseline"] = np.where(baseline > 0.0, np.log(baseline), np.nan)
    context["log10_rho_baseline"] = np.where(baseline > 0.0, np.log10(baseline), np.nan)
    context[TARGET_COLUMN] = density_residual_target(observed, baseline).to_numpy()
    context["target_status"] = np.where(context[TARGET_COLUMN].notna(), "valid", "invalid_density")
    context["experiment_mode"] = experiment_mode

    if driver_timeline.empty:
        joined = context.copy()
        joined["driver_join_status"] = "missing"
        joined["driver_join_age_min"] = np.nan
        joined["driver_arrival_time_bow_shock_utc"] = pd.NaT
        joined["driver_available_at_utc"] = pd.NaT
        joined["driver_source_measurement_time_l1_utc"] = pd.NaT
        joined.attrs["driver_join"] = {
            "direction": "backward",
            "requires_arrival_at_or_before_observation": True,
            "requires_availability_at_or_before_issuance": True,
            "tolerance": str(tolerance) if tolerance is not None else None,
            "matched_rows": 0,
            "missing_rows": len(joined),
            "coverage_fraction": 0.0,
        }
    else:
        joined = causal_backward_join(
            context,
            driver_timeline,
            observation_time_column="timestamp_utc",
            issuance_time_column=join_issuance_column,
            tolerance=tolerance,
            suffix="_driver",
        )
    joined["forecast_issuance_time_utc"] = pd.to_datetime(
        joined["forecast_issuance_time_utc"], utc=True
    )

    # Give causal timestamps stable names even if the source frame happened to
    # contain an overlapping column and the driver helper therefore suffixed it.
    for canonical, candidates in {
        "driver_arrival_time_bow_shock_utc": (
            "arrival_time_bow_shock_utc",
            "arrival_time_bow_shock_utc_driver",
        ),
        "driver_available_at_utc": ("available_at_utc", "available_at_utc_driver"),
        "driver_source_measurement_time_l1_utc": (
            "source_measurement_time_l1_utc",
            "source_measurement_time_l1_utc_driver",
        ),
    }.items():
        if canonical in joined.columns:
            continue
        for candidate in candidates:
            if candidate in joined.columns:
                joined[canonical] = pd.to_datetime(joined[candidate], utc=True, errors="coerce")
                break

    matched = joined["driver_join_status"].eq("matched")
    if matched.any():
        if (
            joined.loc[matched, "driver_arrival_time_bow_shock_utc"]
            > joined.loc[matched, "timestamp_utc"]
        ).any():
            raise AssertionError("future bow-shock arrival joined to density target")
        if (
            joined.loc[matched, "driver_available_at_utc"]
            > joined.loc[matched, "forecast_issuance_time_utc"]
        ).any():
            raise AssertionError("driver not available at forecast issuance")

    definitions = _feature_definitions(
        joined,
        experiment_mode=experiment_mode,
        geomagnetic_availability=availability,
    )
    feature_names = [item.name for item in definitions]
    assert_no_target_leakage(feature_names)

    start = joined["timestamp_utc"].min() if not joined.empty else None
    stop = joined["timestamp_utc"].max() if not joined.empty else None
    version = dataset_version or _dataset_version(
        joined,
        experiment_mode=experiment_mode,
        source_manifest_checksum=source_manifest_checksum_sha256,
    )
    causal_join = dict(joined.attrs.get("driver_join") or {})
    metadata = FeatureDatasetMetadata(
        feature_schema_version=FEATURE_SCHEMA_VERSION,
        dataset_version=version,
        experiment_mode=experiment_mode,
        generated_at_utc=_utc_now(),
        target_column=TARGET_COLUMN,
        target_definition=TARGET_DEFINITION,
        row_count=len(joined),
        target_valid_rows=int(joined[TARGET_COLUMN].notna().sum()),
        driver_matched_rows=int(matched.sum()),
        driver_missing_rows=int((~matched).sum()),
        start_utc=_iso_utc(start) if start is not None else None,
        end_utc=_iso_utc(stop) if stop is not None else None,
        source_manifest_checksum_sha256=source_manifest_checksum_sha256,
        feature_definitions=definitions,
        geomagnetic_availability=availability,
        missingness=driver_missingness(joined, _driver_feature_columns(joined)),
        causal_join=causal_join,
    )
    joined.attrs["feature_dataset_metadata"] = metadata.to_dict()
    joined.attrs["model_feature_columns"] = feature_names
    joined.attrs["geomagnetic_availability"] = availability
    return joined, metadata


def write_feature_dataset(
    frame: pd.DataFrame,
    metadata: FeatureDatasetMetadata,
    parquet_path: str | Path,
) -> tuple[Path, Path]:
    """Persist Parquet plus a machine-readable sidecar without hidden state."""

    path = Path(parquet_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    frame.to_parquet(temporary, index=False)
    os.replace(temporary, path)
    metadata_path = path.with_suffix(path.suffix + ".metadata.json")
    payload = metadata.to_dict()
    payload["parquet_file"] = path.name
    payload["parquet_checksum_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    _atomic_json(metadata_path, payload)
    return path, metadata_path


def read_feature_dataset(parquet_path: str | Path) -> tuple[pd.DataFrame, dict[str, object]]:
    """Read a persisted feature set and verify its sidecar checksum."""

    path = Path(parquet_path)
    metadata_path = path.with_suffix(path.suffix + ".metadata.json")
    if not path.exists() or not metadata_path.exists():
        raise FileNotFoundError("feature Parquet and metadata sidecar are both required")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    expected = metadata.get("parquet_checksum_sha256")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if not isinstance(expected, str) or expected != actual:
        raise ValueError("feature dataset checksum does not match metadata")
    if metadata.get("feature_schema_version") != FEATURE_SCHEMA_VERSION:
        raise ValueError("unsupported feature schema version")
    frame = pd.read_parquet(path)
    frame.attrs["feature_dataset_metadata"] = metadata
    frame.attrs["geomagnetic_availability"] = metadata.get("geomagnetic_availability", {})
    definitions = metadata.get("feature_definitions") or []
    frame.attrs["model_feature_columns"] = [
        item["name"] for item in definitions if isinstance(item, dict) and isinstance(item.get("name"), str)
    ]
    return frame, metadata


def feature_columns_by_group(
    frame: pd.DataFrame,
    metadata: FeatureDatasetMetadata | Mapping[str, object] | None = None,
) -> dict[str, list[str]]:
    """Return context/baseline/solar-wind/geomagnetic feature groups."""

    if isinstance(metadata, FeatureDatasetMetadata):
        definitions: Sequence[FeatureDefinition | Mapping[str, object]] = metadata.feature_definitions
    else:
        payload = metadata or frame.attrs.get("feature_dataset_metadata") or {}
        definitions = payload.get("feature_definitions", []) if isinstance(payload, Mapping) else []
    groups: dict[str, list[str]] = {
        "context": [],
        "baseline": [],
        "solar_wind": [],
        "geomagnetic": [],
    }
    for definition in definitions:
        if isinstance(definition, FeatureDefinition):
            name, group = definition.name, definition.group
        elif isinstance(definition, Mapping):
            name, group = definition.get("name"), definition.get("group")
        else:
            continue
        if isinstance(name, str) and isinstance(group, str) and group in groups and name in frame.columns:
            groups[group].append(name)
    if not any(groups.values()):
        groups["context"] = [
            column
            for column in (*NUMERIC_CONTEXT_FEATURES, *CATEGORICAL_CONTEXT_FEATURES)
            if column in frame.columns
        ]
        groups["solar_wind"] = _driver_feature_columns(frame)
        availability = frame.attrs.get("geomagnetic_availability") or {}
        if isinstance(availability, Mapping):
            groups["geomagnetic"] = [name for name in availability if name in frame.columns]
    for values in groups.values():
        assert_no_target_leakage(values)
    return groups
