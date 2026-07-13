"""Reproducible staged multi-year thermospheric-density study.

The runner consumes only baseline files whose manifest entries are tagged with
the immutable corpus plan.  It never downloads data and it never mutates the
ingestion manifest.  Three arrival modes are compared on one exact population,
one year-role split and one estimator contract.  Mission identity is retained
for LOSO/cross-mission diagnostics but is forbidden from deployable M3.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.metadata
import json
import math
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from .drivers import (
    HELIOSAT_MRU_ARRIVAL,
    HELIOSAT_MRU_ML_ARRIVAL,
    REFERENCE_ALIGNED,
    TimelineBuildReport,
    add_causal_rolling_features,
    build_heliosat_mru_ml_timeline,
    build_heliosat_mru_timeline,
    build_reference_aligned_timeline,
)
from .features import FeatureDatasetMetadata, TARGET_COLUMN, build_feature_dataset
from .manifest import load_manifest
from .metrics import (
    PaddedEventWindow,
    block_bootstrap_density_metrics,
    density_metrics,
    spacecraft_event_enhancement_metrics,
)
from .models import (
    MODEL_ARTIFACT_SCHEMA_VERSION,
    STUDY_SCHEMA_VERSION,
    ChronologicalSplit,
    ModelSpecification,
    build_model_specifications,
    make_model_pipeline,
    save_model_artifact,
)
from .multiyear import MULTIYEAR_PLAN_SCHEMA_VERSION
from .schema import usable_density_mask
from .study import load_driver_source
from .validation import (
    CommonRowsReport,
    add_spacecraft_key,
    align_common_matched_rows,
    assert_mission_agnostic_features,
    build_ablation_specifications,
    calibrate_and_evaluate_density_intervals,
    cross_mission_indices,
    leave_one_spacecraft_out_indices,
    paired_block_bootstrap_delta,
)

MULTIYEAR_STUDY_SCHEMA_VERSION = "leo-density-study-summary-v2"
MULTIYEAR_STUDY_VERSION = "heliosat-leo-multiyear-v1"
YEAR_ROLES: Mapping[str, tuple[int, ...]] = {
    "train": (2021, 2022),
    "validation": (2023,),
    "calibration": (2024,),
    "test": (2025,),
}
EXPECTED_SPACECRAFT: tuple[str, ...] = (
    "Swarm:A",
    "Swarm:B",
    "Swarm:C",
    "GRACE-FO:1",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso(value: object) -> str:
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp.isoformat().replace("+00:00", "Z")


def _json_safe(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, pd.Timestamp):
        return _iso(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(_json_safe(payload), indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fingerprint(payload: Mapping[str, Any]) -> str:
    body = json.dumps(_json_safe(payload), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _runtime_versions() -> dict[str, str]:
    versions = {"python": sys.version.split()[0]}
    for package in ("numpy", "pandas", "pyarrow", "scikit-learn", "joblib"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "unavailable"
    return versions


def _code_state() -> dict[str, object]:
    """Capture the repository revision and dirty-state fingerprints if available."""

    try:
        root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True, stderr=subprocess.DEVNULL
        ).strip()
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True, stderr=subprocess.DEVNULL
        ).strip()
        diff = subprocess.check_output(
            ["git", "diff", "--binary", "HEAD"], cwd=root, stderr=subprocess.DEVNULL
        )
        untracked = subprocess.check_output(
            ["git", "ls-files", "--others", "--exclude-standard"],
            cwd=root, text=True, stderr=subprocess.DEVNULL,
        ).splitlines()
        return {
            "git_commit": commit,
            "tracked_diff_sha256": hashlib.sha256(diff).hexdigest(),
            "untracked_files_sha256": hashlib.sha256(
                "\n".join(sorted(untracked)).encode("utf-8")
            ).hexdigest(),
            "dirty": bool(diff or untracked),
        }
    except (OSError, subprocess.SubprocessError):
        return {"git_commit": None, "dirty": None, "reason": "git state unavailable"}


@dataclass(frozen=True)
class YearRoleSplit:
    train_index: tuple[object, ...]
    validation_index: tuple[object, ...]
    calibration_index: tuple[object, ...]
    test_index: tuple[object, ...]
    year_counts: dict[int, int]

    def indices(self, role: str) -> tuple[object, ...]:
        if role not in YEAR_ROLES:
            raise KeyError(role)
        return getattr(self, f"{role}_index")

    def to_dict(self, frame: pd.DataFrame) -> dict[str, object]:
        timestamp = pd.to_datetime(frame["timestamp_utc"], utc=True)
        roles: dict[str, object] = {}
        for role in YEAR_ROLES:
            index = list(self.indices(role))
            roles[role] = {
                "calendar_years": list(YEAR_ROLES[role]),
                "start_utc": _iso(timestamp.loc[index].min()),
                "stop_utc": _iso(timestamp.loc[index].max()),
                "rows": len(index),
            }
        return {
            "method": "fixed_calendar_year_roles_no_random_rows",
            "roles": roles,
            "year_counts": {str(year): count for year, count in self.year_counts.items()},
        }


def build_year_role_split(frame: pd.DataFrame) -> YearRoleSplit:
    """Create the immutable 2021-22/2023/2024/2025 study roles."""

    if "timestamp_utc" not in frame:
        raise ValueError("year-role split requires timestamp_utc")
    timestamp = pd.to_datetime(frame["timestamp_utc"], utc=True, errors="coerce")
    if timestamp.isna().any():
        raise ValueError("year-role split timestamps contain invalid values")
    allowed = {year for years in YEAR_ROLES.values() for year in years}
    represented = {int(year) for year in timestamp.dt.year.unique()}
    unexpected = represented - allowed
    if unexpected:
        raise ValueError(f"study rows contain years outside the fixed contract: {sorted(unexpected)}")
    counts = {year: int(timestamp.dt.year.eq(year).sum()) for year in sorted(allowed)}
    missing = [year for year, count in counts.items() if count == 0]
    if missing:
        raise ValueError(f"fixed multi-year split is missing calendar year(s): {missing}")
    role_indices = {
        role: tuple(frame.index[timestamp.dt.year.isin(years)])
        for role, years in YEAR_ROLES.items()
    }
    split = YearRoleSplit(
        train_index=role_indices["train"],
        validation_index=role_indices["validation"],
        calibration_index=role_indices["calibration"],
        test_index=role_indices["test"],
        year_counts=counts,
    )
    previous_stop: pd.Timestamp | None = None
    for role in YEAR_ROLES:
        values = timestamp.loc[list(split.indices(role))]
        if previous_stop is not None and not previous_stop < values.min():
            raise AssertionError("fixed year roles are not strictly chronological")
        previous_stop = values.max()
    return split


def validate_corpus_plan(plan: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(plan)
    if payload.get("schema_version") != MULTIYEAR_PLAN_SCHEMA_VERSION:
        raise ValueError(f"unsupported corpus plan schema: {payload.get('schema_version')}")
    core = {
        key: value for key, value in payload.items()
        if key not in {"plan_id", "plan_sha256", "generated_at_utc"}
    }
    digest = _fingerprint(core)
    if digest != payload.get("plan_sha256"):
        raise ValueError("corpus plan checksum does not match its immutable content")
    if not payload.get("plan_id") or not payload.get("collections"):
        raise ValueError("corpus plan lacks plan_id or collections")
    return payload


def _data_path(data_root: Path, value: object) -> Path:
    candidate = Path(str(value))
    return candidate if candidate.is_absolute() else data_root / candidate


def _assign_plan_regimes(frame: pd.DataFrame, plan: Mapping[str, Any]) -> pd.DataFrame:
    output = frame.copy()
    timestamp = pd.to_datetime(output["timestamp_utc"], utc=True)
    output["study_regime"] = "unclassified"
    output["study_interval_id"] = pd.NA
    output["bootstrap_event_block"] = timestamp.dt.strftime("day:%Y-%m-%d")
    priority = {"quiet": 1, "moderate_storm": 2, "severe_storm": 3}
    assigned_priority = pd.Series(0, index=output.index, dtype=int)
    for interval in plan.get("intervals") or []:
        if not isinstance(interval, Mapping):
            continue
        kind = str(interval.get("kind"))
        if kind not in priority:
            continue
        start = pd.to_datetime(interval.get("start_utc"), utc=True, errors="coerce")
        stop = pd.to_datetime(interval.get("stop_utc"), utc=True, errors="coerce")
        if pd.isna(start) or pd.isna(stop):
            continue
        mask = timestamp.ge(start) & timestamp.lt(stop) & assigned_priority.lt(priority[kind])
        output.loc[mask, "study_regime"] = kind
        output.loc[mask, "study_interval_id"] = str(interval.get("interval_id"))
        assigned_priority.loc[mask] = priority[kind]
        if kind != "quiet":
            output.loc[mask, "bootstrap_event_block"] = f"event:{interval.get('interval_id')}"
    return output


def _padded_test_event_windows(plan: Mapping[str, Any]) -> list[PaddedEventWindow]:
    """Recover preregistered event cores from the plan's documented -2/+5 d padding."""

    windows: list[PaddedEventWindow] = []
    for interval in plan.get("intervals") or []:
        if not isinstance(interval, Mapping) or interval.get("kind") == "quiet":
            continue
        padded_start = pd.to_datetime(interval.get("start_utc"), utc=True, errors="coerce")
        padded_stop = pd.to_datetime(interval.get("stop_utc"), utc=True, errors="coerce")
        if pd.isna(padded_start) or pd.isna(padded_stop):
            continue
        event_start = padded_start + pd.Timedelta(days=2)
        # The planner makes stop exclusive one hour after the final Kp>=6
        # label, then adds five full post-event days.
        event_stop = padded_stop - pd.Timedelta(days=5)
        if event_start.year != 2025 or not event_start < event_stop:
            continue
        event_id = str(interval.get("interval_id"))
        windows.append(PaddedEventWindow(
            event_id=event_id,
            event_start_utc=event_start,
            event_stop_utc=event_stop,
            padded_start_utc=padded_start,
            padded_stop_utc=padded_stop,
            event_block_id=f"event:{event_id}",
        ))
    return windows


def load_plan_baseline_observations(
    *,
    data_root: str | Path,
    plan: Mapping[str, Any],
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load exact five-minute rows only from plan-tagged causal baselines."""

    validated = validate_corpus_plan(plan)
    root = Path(data_root).resolve()
    manifest_path = root / "processed" / "thermosphere" / "manifest.v1.json"
    manifest = load_manifest(manifest_path)
    plan_id, plan_sha = validated["plan_id"], validated["plan_sha256"]
    collections = {str(value) for value in validated["collections"]}
    entries = [
        entry for entry in manifest.get("entries", [])
        if isinstance(entry, Mapping)
        and entry.get("corpus_plan_id") == plan_id
        and entry.get("corpus_plan_sha256") == plan_sha
        and str(entry.get("source_product")) in collections
    ]
    if not entries:
        raise FileNotFoundError("no causal baseline manifest entry is tagged with this corpus plan")
    frames: list[pd.DataFrame] = []
    files: list[Path] = []
    entry_ids: list[str] = []
    rejected_entries: list[dict[str, str]] = []
    for entry in entries:
        if entry.get("baseline_f107a_mode") != "trailing_81_day" or not bool(
            entry.get("baseline_forecast_causal_f107a")
        ):
            rejected_entries.append({
                "id": str(entry.get("id")),
                "reason": "baseline is not tagged trailing_81_day forecast-causal",
            })
            continue
        baseline_files = entry.get("baseline_files") or []
        for value in baseline_files:
            path = _data_path(root, value)
            if not path.is_file():
                raise FileNotFoundError(f"manifest baseline file is missing: {path}")
            frame = pd.read_parquet(path)
            frame["manifest_entry_id"] = str(entry.get("id"))
            frames.append(frame)
            files.append(path)
            entry_ids.append(str(entry.get("id")))
    if not frames:
        reason = rejected_entries or [{"reason": "tagged entries contain no baseline files"}]
        raise FileNotFoundError(f"no plan-tagged causal baseline is usable: {reason}")
    observations = pd.concat(frames, ignore_index=True)
    timestamp = pd.to_datetime(observations["timestamp_utc"], utc=True, errors="coerce")
    exact_five_minute = (
        timestamp.notna() & timestamp.dt.minute.mod(5).eq(0)
        & timestamp.dt.second.eq(0) & timestamp.dt.microsecond.eq(0)
    )
    quality = usable_density_mask(observations, allow_quality_not_provided=False)
    baseline_ok = observations["baseline_input_status"].eq("ok") & pd.to_numeric(
        observations["rho_baseline_kg_m3"], errors="coerce"
    ).gt(0.0)
    selected = observations.loc[exact_five_minute & quality & baseline_ok].copy()
    selected["timestamp_utc"] = timestamp.loc[selected.index]
    selected = selected.sort_values(
        ["timestamp_utc", "mission", "spacecraft_id", "source_product"], kind="mergesort"
    ).drop_duplicates(
        ["timestamp_utc", "mission", "spacecraft_id", "source_product"], keep="last"
    ).reset_index(drop=True)
    if selected.empty:
        raise ValueError("plan-tagged baselines contain no nominal exact five-minute rows")
    selected = add_spacecraft_key(_assign_plan_regimes(selected, validated))
    report = {
        "manifest_path": str(manifest_path),
        "manifest_checksum_sha256": _sha256_file(manifest_path),
        "plan_id": plan_id,
        "plan_sha256": plan_sha,
        "tagged_entry_ids": sorted(set(entry_ids)),
        "rejected_tagged_entries": rejected_entries,
        "baseline_files": [str(path) for path in files],
        "baseline_file_checksums_sha256": {str(path): _sha256_file(path) for path in files},
        "source_files": [str(path) for path in files],
        "source_checksums_sha256": {str(path): _sha256_file(path) for path in files},
        "input_rows": len(observations),
        "selected_exact_five_minute_rows": len(selected),
        "selected_rows": len(selected),
        "coverage_start_utc": _iso(selected["timestamp_utc"].min()),
        "coverage_stop_utc": _iso(selected["timestamp_utc"].max()),
        "spacecraft": sorted(selected["spacecraft_key"].unique()),
        "missions": sorted(selected["mission"].astype(str).unique()),
        "baseline_models": (
            sorted(selected["baseline_model_name"].dropna().astype(str).unique())
            if "baseline_model_name" in selected else []
        ),
        "baseline_versions": (
            sorted(selected["baseline_model_version"].dropna().astype(str).unique())
            if "baseline_model_version" in selected else []
        ),
        "evidence_class": "observed_retrospective_product_plus_causal_definition_reanalysis_baseline",
        "analysis_cadence": "exact native/processed rows at UTC minute divisible by five; no interpolation",
        "baseline_f107a_mode": "trailing_81_day",
    }
    return selected, report


def build_three_arrival_feature_frames(
    observations: pd.DataFrame,
    *,
    arrival_model_path: str | Path,
    arrival_metrics_path: str | Path | None = None,
    driver_cache_root: str | Path = "data/cache/omni_high_res",
    source_manifest_checksum_sha256: str | None = None,
) -> tuple[
    dict[str, pd.DataFrame],
    dict[str, FeatureDatasetMetadata],
    dict[str, TimelineBuildReport],
    dict[str, Any],
]:
    """Build reference, MRU and strict MRU+ML feature frames in memory."""

    source, source_report = load_driver_source(
        observations["timestamp_utc"].min(), observations["timestamp_utc"].max(),
        cache_root=driver_cache_root,
    )
    reference, reference_report = build_reference_aligned_timeline(source)
    mru, mru_report = build_heliosat_mru_timeline(source)
    mru_ml, mru_ml_report = build_heliosat_mru_ml_timeline(
        source,
        arrival_model_path=arrival_model_path,
        arrival_metrics_path=arrival_metrics_path,
    )
    timelines = {
        REFERENCE_ALIGNED: add_causal_rolling_features(reference),
        HELIOSAT_MRU_ARRIVAL: add_causal_rolling_features(mru),
        HELIOSAT_MRU_ML_ARRIVAL: add_causal_rolling_features(mru_ml),
    }
    reports = {
        REFERENCE_ALIGNED: reference_report,
        HELIOSAT_MRU_ARRIVAL: mru_report,
        HELIOSAT_MRU_ML_ARRIVAL: mru_ml_report,
    }
    if mru_ml.empty:
        raise RuntimeError(
            "strict MRU+ML arrival mode is unavailable; "
            f"{mru_ml_report.arrival_ml_error or 'no row received an ML correction'}"
        )
    frames: dict[str, pd.DataFrame] = {}
    metadata: dict[str, FeatureDatasetMetadata] = {}
    for mode, timeline in timelines.items():
        frame, meta = build_feature_dataset(
            observations,
            timeline,
            experiment_mode=mode,  # type: ignore[arg-type]
            tolerance="15min",
            source_manifest_checksum_sha256=source_manifest_checksum_sha256,
        )
        frames[mode], metadata[mode] = frame, meta
    # Response features are only required on the primary strict MRU+ML mode.
    # Building them once keeps the other two comparison matrices compact.
    try:
        response = importlib.import_module("leo_drag.response")
        response_drivers = [
            column for column in ("newell_coupling", "em_mv_m")
            if column in timelines[HELIOSAT_MRU_ML_ARRIVAL].columns
        ]
        if response_drivers:
            primary = response.build_fixed_lag_features(
                frames[HELIOSAT_MRU_ML_ARRIVAL],
                timelines[HELIOSAT_MRU_ML_ARRIVAL],
                driver_columns=response_drivers,
            )
            primary = response.build_distributed_lag_features(
                primary,
                timelines[HELIOSAT_MRU_ML_ARRIVAL],
                driver_columns=response_drivers,
            )
            primary.attrs["response_build_status"] = {
                "status": "available", "driver_columns": response_drivers,
                "schema_version": getattr(response, "RESPONSE_SCHEMA_VERSION", None),
            }
            frames[HELIOSAT_MRU_ML_ARRIVAL] = primary
        else:
            frames[HELIOSAT_MRU_ML_ARRIVAL].attrs["response_build_status"] = {
                "status": "unavailable", "reason": "Newell and Em are absent from strict timeline"
            }
    except (ModuleNotFoundError, ValueError, AssertionError) as exc:
        frames[HELIOSAT_MRU_ML_ARRIVAL].attrs["response_build_status"] = {
            "status": "unavailable", "reason": f"{type(exc).__name__}: {exc}"
        }
    return frames, metadata, reports, source_report


def _partition_prediction(
    frame: pd.DataFrame,
    index: Sequence[object],
    estimator: Any | None,
    specification: ModelSpecification,
) -> pd.DataFrame:
    output = frame.loc[list(index)].copy()
    if estimator is None:
        prediction = pd.to_numeric(output["rho_baseline_kg_m3"], errors="coerce").to_numpy(float)
    else:
        residual = np.asarray(estimator.predict(output[list(specification.feature_columns)]), dtype=float)
        prediction = output["rho_baseline_kg_m3"].to_numpy(float) * np.exp(residual)
    output["rho_p50_kg_m3"] = prediction
    return output


def _density_metrics(frame: pd.DataFrame) -> dict[str, object]:
    return density_metrics(
        frame["rho_obs_kg_m3"], frame["rho_p50_kg_m3"],
        baseline_density=frame["rho_baseline_kg_m3"],
    )


def _compact_prediction_columns(frame: pd.DataFrame) -> list[str]:
    desired = [
        "comparison_row_id", "timestamp_utc", "mission", "spacecraft_id",
        "spacecraft_key", "source_product", "study_regime", "study_interval_id",
        "bootstrap_event_block", "altitude_km", "latitude_deg", "local_solar_time_h",
        "rho_obs_kg_m3", "rho_baseline_kg_m3", "rho_p10_kg_m3",
        "rho_point_prediction_kg_m3", "rho_p50_kg_m3", "rho_p90_kg_m3",
    ]
    return [column for column in desired if column in frame.columns]


def _breakdown_metrics(frame: pd.DataFrame) -> dict[str, object]:
    work = frame.copy()
    work["altitude_band"] = pd.cut(
        pd.to_numeric(work.get("altitude_km"), errors="coerce"),
        [-np.inf, 450, 500, 550, np.inf],
        labels=["<450 km", "450-500 km", "500-550 km", ">550 km"],
    )
    work["latitude_band"] = pd.cut(
        pd.to_numeric(work.get("latitude_deg"), errors="coerce").abs(),
        [-0.01, 30, 60, 90.01], labels=["equatorial", "mid-latitude", "high-latitude"],
    )
    local_time = pd.to_numeric(work.get("local_solar_time_h"), errors="coerce") % 24
    work["local_solar_time_band"] = np.select(
        [(local_time >= 6) & (local_time < 10), (local_time >= 10) & (local_time < 18),
         (local_time >= 18) & (local_time < 22)],
        ["dawn", "day", "dusk"], default="night",
    )

    def grouped(column: str) -> dict[str, object]:
        if column not in work:
            return {}
        result: dict[str, object] = {}
        for label, group in work.groupby(column, observed=True, dropna=False):
            result[str(label)] = _density_metrics(group)
        return result

    return {
        "mission": grouped("mission"),
        "spacecraft": grouped("spacecraft_key"),
        "altitude": grouped("altitude_band"),
        "latitude": grouped("latitude_band"),
        "local_solar_time": grouped("local_solar_time_band"),
        "storm_intensity": grouped("study_regime"),
    }


def _fit_m3_modes(
    frames: Mapping[str, pd.DataFrame],
    split: YearRoleSplit,
    *,
    output_directory: Path,
    run_id: str,
    comparison_contract_sha256: str,
    random_seed: int,
    bootstrap_resamples: int,
) -> tuple[dict[str, Any], dict[str, pd.DataFrame], list[str]]:
    mode_results: dict[str, Any] = {}
    test_predictions: dict[str, pd.DataFrame] = {}
    artifacts: list[str] = []
    expected_features: tuple[str, ...] | None = None
    expected_hyperparameters: Mapping[str, Any] | None = None
    runtime = _runtime_versions()
    for mode, frame in frames.items():
        specifications = build_model_specifications(frame)
        m3 = next(item for item in specifications if item.model_id == "M3")
        if m3.status != "available":
            mode_results[mode] = {"status": "unavailable", "reason": m3.unavailable_reason}
            continue
        assert_mission_agnostic_features(m3.feature_columns)
        estimator = make_model_pipeline(m3, random_seed=random_seed)
        hyperparameters = estimator.named_steps["estimator"].get_params(deep=False)
        if expected_features is None:
            expected_features = m3.feature_columns
            expected_hyperparameters = hyperparameters
        elif m3.feature_columns != expected_features or hyperparameters != expected_hyperparameters:
            raise AssertionError("arrival modes do not share an identical M3 estimator contract")
        estimator.fit(
            frame.loc[list(split.train_index), list(m3.feature_columns)],
            frame.loc[list(split.train_index), TARGET_COLUMN],
        )
        validation = _partition_prediction(frame, split.validation_index, estimator, m3)
        calibration = _partition_prediction(frame, split.calibration_index, estimator, m3)
        test = _partition_prediction(frame, split.test_index, estimator, m3)
        # Retain the uncalibrated point prediction for arrival-mode comparisons.
        # Each mode's calibrated p50 can legitimately receive a different bias
        # correction, which would otherwise confound the timing audit.
        test["rho_point_prediction_kg_m3"] = test["rho_p50_kg_m3"]
        interval, calibrated_test, interval_metrics = calibrate_and_evaluate_density_intervals(
            calibration,
            test,
            median_prediction_column="rho_p50_kg_m3",
        )
        mode_directory = output_directory / mode
        mode_directory.mkdir(parents=True, exist_ok=True)
        predictions_path = mode_directory / "m3-test-predictions.parquet"
        calibrated_test[_compact_prediction_columns(calibrated_test)].to_parquet(
            predictions_path, index=False
        )
        bootstrap = block_bootstrap_density_metrics(
            calibrated_test.rename(columns={"rho_p50_kg_m3": "rho_predicted_kg_m3"}),
            n_resamples=bootstrap_resamples,
            random_seed=random_seed,
        ) if bootstrap_resamples > 0 else None
        artifact_path = mode_directory / "m3.joblib"
        model_payload: dict[str, object] = {
            "artifact_schema_version": MODEL_ARTIFACT_SCHEMA_VERSION,
            "study_schema_version": STUDY_SCHEMA_VERSION,
            "model_id": "M3",
            "model_label": m3.label,
            "model_version": f"m3-{run_id}-{mode}",
            "algorithm": m3.algorithm,
            # Only the two HelioSat timelines are technically loadable by the
            # experimental forecast path.  Reference alignment is a
            # retrospective diagnostic and can never be deployed.
            "deployable": mode != REFERENCE_ALIGNED,
            "scientifically_operational": False,
            "experiment_mode": mode,
            "dataset_version": str(
                (frame.attrs.get("feature_dataset_metadata") or {}).get("dataset_version", "in-memory")
            ),
            "feature_schema_version": str(
                (frame.attrs.get("feature_dataset_metadata") or {}).get("feature_schema_version", "unknown")
            ),
            "feature_columns": list(m3.feature_columns),
            "numeric_features": list(m3.numeric_features),
            "categorical_features": list(m3.categorical_features),
            "target_column": TARGET_COLUMN,
            "target_definition": "ln(rho_observed) - ln(rho_baseline)",
            "split": split.to_dict(frame),
            "comparison_contract_sha256": comparison_contract_sha256,
            "validation_metrics": _density_metrics(validation),
            "test_metrics": _density_metrics(calibrated_test),
            "bootstrap": bootstrap,
            "uncertainty_calibration": interval.to_dict(),
            "uncertainty_test_metrics": interval_metrics,
            "hyperparameters": hyperparameters,
            "random_seed": random_seed,
            "runtime_versions": runtime,
            "code_state": _code_state(),
            "generated_at_utc": _now(),
            "estimator": estimator,
        }
        save_model_artifact(artifact_path, model_payload)
        artifacts.extend([
            str(predictions_path.relative_to(output_directory)),
            str(artifact_path.relative_to(output_directory)),
            str(artifact_path.with_suffix(".joblib.metadata.json").relative_to(output_directory)),
        ])
        mode_results[mode] = {
            "status": "available",
            "label": {
                REFERENCE_ALIGNED: "OMNI reference-aligned arrival",
                HELIOSAT_MRU_ARRIVAL: "HelioSat MRU arrival",
                HELIOSAT_MRU_ML_ARRIVAL: "HelioSat MRU plus ML arrival",
            }.get(mode, mode),
            "deployable": False,
            "technical_artifact_deployable": mode != REFERENCE_ALIGNED,
            "scientifically_operational": False,
            "models": [{
                "id": "M3",
                "label": m3.label,
                "status": "available",
                "feature_group": m3.feature_group,
                "role": (
                    "retrospective_diagnostic"
                    if mode == REFERENCE_ALIGNED else "deployable_candidate"
                ),
                "uses_mission_identity": False,
                "causality": (
                    "retrospective_only"
                    if mode == REFERENCE_ALIGNED else "unverified"
                ),
                "metrics": _density_metrics(calibrated_test),
            }],
            "metrics": _density_metrics(calibrated_test),
            "comparison_contract_sha256": comparison_contract_sha256,
            "feature_columns": list(m3.feature_columns),
            "hyperparameters": hyperparameters,
            "roles": {
                "validation": _density_metrics(validation),
                "calibration_point": _density_metrics(calibration),
                "test_calibrated_p50": _density_metrics(calibrated_test),
            },
            "uncertainty": {
                "calibration": interval.to_dict(),
                "test": interval_metrics,
            },
            "bootstrap": bootstrap,
            "breakdowns": _breakdown_metrics(calibrated_test),
            "artifacts": [
                str(predictions_path.relative_to(output_directory)),
                str(artifact_path.relative_to(output_directory)),
            ],
            "model_file_sha256": _sha256_file(artifact_path),
        }
        test_predictions[mode] = calibrated_test
    return mode_results, test_predictions, artifacts


def _fit_specification(
    frame: pd.DataFrame,
    training_index: Sequence[object],
    test_index: Sequence[object],
    specification: ModelSpecification,
    *,
    random_seed: int,
) -> tuple[pd.DataFrame, dict[str, object]]:
    if specification.model_id == "M0":
        predicted = _partition_prediction(frame, test_index, None, specification)
        return predicted, _density_metrics(predicted)
    estimator = make_model_pipeline(specification, random_seed=random_seed)
    training = frame.loc[list(training_index)]
    estimator.fit(training[list(specification.feature_columns)], training[TARGET_COLUMN])
    predicted = _partition_prediction(frame, test_index, estimator, specification)
    return predicted, _density_metrics(predicted)


def _run_ablations(
    frame: pd.DataFrame,
    split: YearRoleSplit,
    *,
    random_seed: int,
    comparison_contract_sha256: str,
) -> dict[str, object]:
    output: dict[str, object] = {}
    for ablation in build_ablation_specifications(frame):
        if ablation.status != "available":
            output[ablation.ablation_id] = {
                **ablation.to_dict(), "metrics": None,
                "comparison_contract_sha256": comparison_contract_sha256,
            }
            continue
        if ablation.ablation_id == "A0":
            specification = ModelSpecification(
                "M0", ablation.label, "atmosphere baseline", "baseline"
            )
        else:
            specification = ModelSpecification(
                "M3", ablation.label,
                "sklearn HistGradientBoostingRegressor (absolute_error)",
                "+".join(ablation.feature_groups),
                ablation.numeric_features, ablation.categorical_features,
            )
        _, metrics = _fit_specification(
            frame, split.train_index, split.test_index, specification,
            random_seed=random_seed,
        )
        output[ablation.ablation_id] = {
            **ablation.to_dict(), "metrics": metrics,
            "comparison_contract_sha256": comparison_contract_sha256,
        }
    return output


def _m3_specification(frame: pd.DataFrame) -> ModelSpecification:
    specification = next(
        item for item in build_model_specifications(frame) if item.model_id == "M3"
    )
    if specification.status != "available":
        raise ValueError(specification.unavailable_reason or "M3 is unavailable")
    assert_mission_agnostic_features(specification.feature_columns)
    return specification


def _year_walk_forward(
    frame: pd.DataFrame,
    *,
    random_seed: int,
) -> dict[str, object]:
    timestamp = pd.to_datetime(frame["timestamp_utc"], utc=True)
    specification = _m3_specification(frame)
    folds: list[dict[str, object]] = []
    for year in (2022, 2023, 2024, 2025):
        training_index = tuple(frame.index[timestamp.dt.year < year])
        test_index = tuple(frame.index[timestamp.dt.year == year])
        if not training_index or not test_index:
            folds.append({"year": year, "status": "unavailable", "reason": "missing rows"})
            continue
        _, metrics = _fit_specification(
            frame, training_index, test_index, specification, random_seed=random_seed
        )
        folds.append({
            "year": year, "status": "available", "train_rows": len(training_index),
            "test_rows": len(test_index), "metrics": metrics,
        })
    return {
        "status": "available" if any(item["status"] == "available" for item in folds) else "unavailable",
        "method": "expanding prior-calendar-years; identity-free M3 refit per fold",
        "folds": folds,
    }


def _loso(
    frame: pd.DataFrame,
    split: YearRoleSplit,
    *,
    random_seed: int,
) -> dict[str, object]:
    work = frame if "spacecraft_key" in frame else add_spacecraft_key(frame)
    specification = _m3_specification(work)
    # Preserve 2024 exclusively for uncertainty calibration.  Generalisation
    # diagnostics may use the predeclared 2023 validation year after the model
    # family is frozen, but never consume calibration or 2025 test targets.
    development_roles = set(split.train_index) | set(split.validation_index)
    test_role = set(split.test_index)
    results: dict[str, object] = {}
    for spacecraft in EXPECTED_SPACECRAFT:
        try:
            development, held_out = leave_one_spacecraft_out_indices(work, spacecraft)
            training_index = tuple(index for index in development if index in development_roles)
            test_index = tuple(index for index in held_out if index in test_role)
            if not training_index or not test_index:
                raise ValueError("fixed year roles leave no train or test rows")
            prediction, metrics = _fit_specification(
                work, training_index, test_index, specification, random_seed=random_seed
            )
            bootstrap = block_bootstrap_density_metrics(
                prediction.rename(columns={"rho_p50_kg_m3": "rho_predicted_kg_m3"}),
                n_resamples=100, random_seed=random_seed,
            )
            results[spacecraft] = {
                "status": "available", "train_rows": len(training_index),
                "test_rows": len(test_index), "metrics": metrics, "bootstrap": bootstrap,
            }
        except ValueError as exc:
            results[spacecraft] = {"status": "unavailable", "reason": str(exc)}
    return {
        "status": "available" if any(value.get("status") == "available" for value in results.values()) else "unavailable",
        "method": "train other spacecraft in 2021-2023; reserve 2024; test entirely held spacecraft in 2025",
        "results": results,
    }


def _cross_mission(
    frame: pd.DataFrame,
    split: YearRoleSplit,
    *,
    random_seed: int,
) -> dict[str, object]:
    specification = _m3_specification(frame)
    train_mission, test_mission = cross_mission_indices(
        frame, train_missions=["Swarm"], test_missions=["GRACE-FO"]
    )
    development_roles = set(split.train_index) | set(split.validation_index)
    test_role = set(split.test_index)
    training_index = tuple(index for index in train_mission if index in development_roles)
    test_index = tuple(index for index in test_mission if index in test_role)
    if not training_index or not test_index:
        return {"status": "unavailable", "reason": "fixed roles leave no Swarm train or GRACE-FO test rows"}
    prediction, metrics = _fit_specification(
        frame, training_index, test_index, specification, random_seed=random_seed
    )
    return {
        "status": "available",
        "method": "Swarm 2021-2023 training; 2024 reserved; entirely held-out GRACE-FO 2025 test",
        "train_rows": len(training_index), "test_rows": len(test_index),
        "metrics": metrics,
        "bootstrap": block_bootstrap_density_metrics(
            prediction.rename(columns={"rho_p50_kg_m3": "rho_predicted_kg_m3"}),
            n_resamples=100, random_seed=random_seed,
        ),
    }


def _paired_arrival_comparisons(
    predictions: Mapping[str, pd.DataFrame],
    *,
    bootstrap_resamples: int,
    random_seed: int,
) -> dict[str, object]:
    required = (REFERENCE_ALIGNED, HELIOSAT_MRU_ARRIVAL, HELIOSAT_MRU_ML_ARRIVAL)
    if any(mode not in predictions for mode in required):
        return {"status": "unavailable", "reason": "all three paired mode predictions are required"}
    base = predictions[REFERENCE_ALIGNED].copy()
    if "bootstrap_event_block" not in base:
        timestamp = pd.to_datetime(base["timestamp_utc"], utc=True)
        base["bootstrap_event_block"] = timestamp.dt.strftime("day:%Y-%m-%d")
    for mode in (HELIOSAT_MRU_ARRIVAL, HELIOSAT_MRU_ML_ARRIVAL):
        values = predictions[mode].set_index("comparison_row_id")["rho_point_prediction_kg_m3"]
        base[f"prediction__{mode}"] = base["comparison_row_id"].map(values)
    base[f"prediction__{REFERENCE_ALIGNED}"] = base["rho_point_prediction_kg_m3"]
    pairs = (
        (REFERENCE_ALIGNED, HELIOSAT_MRU_ARRIVAL),
        (REFERENCE_ALIGNED, HELIOSAT_MRU_ML_ARRIVAL),
        (HELIOSAT_MRU_ARRIVAL, HELIOSAT_MRU_ML_ARRIVAL),
    )
    output: dict[str, object] = {}
    for first, second in pairs:
        key = f"{second}_minus_{first}"
        day = paired_block_bootstrap_delta(
            base,
            prediction_a_column=f"prediction__{first}",
            prediction_b_column=f"prediction__{second}",
            n_resamples=bootstrap_resamples,
            random_seed=random_seed,
        )
        event = paired_block_bootstrap_delta(
            base,
            prediction_a_column=f"prediction__{first}",
            prediction_b_column=f"prediction__{second}",
            block_column="bootstrap_event_block",
            n_resamples=bootstrap_resamples,
            random_seed=random_seed,
        )
        output[key] = {"utc_day_blocks": day, "event_or_day_blocks": event}
    return {
        "status": "available",
        "metric_prediction_variant": "uncalibrated_point_prediction",
        "headline_density_metrics_variant": "p50_calibrated_on_held_out_2024",
        "interpretation_warning": (
            "arrival deltas and headline density metrics use different saved prediction variants"
        ),
        "delta_sign": "negative means the second mode has lower error",
        "comparisons": output,
    }


def _identity_diagnostics(
    frame: pd.DataFrame,
    split: YearRoleSplit,
    *,
    random_seed: int,
) -> dict[str, object]:
    """Quantify identity shortcuts without allowing either model to deploy."""

    specifications = build_model_specifications(frame)
    m3 = next(item for item in specifications if item.model_id == "M3")
    identity_columns = tuple(
        column for column in ("mission", "spacecraft_id") if column in frame
    )
    identity_only = ModelSpecification(
        "M5",
        "M5 identity-only retrospective diagnostic",
        "sklearn HistGradientBoostingRegressor (absolute_error)",
        "non-deployable identity-only diagnostic",
        (),
        identity_columns,
        status="available" if len(identity_columns) == 2 else "unavailable",
        unavailable_reason=(
            None if len(identity_columns) == 2
            else "mission/spacecraft identity unavailable"
        ),
        deployable=False,
    )
    output: dict[str, object] = {}
    if identity_only.status == "available":
        _, metrics = _fit_specification(
            frame, split.train_index, split.test_index, identity_only,
            random_seed=random_seed,
        )
        output["identity_only"] = {
            "status": "available", "deployable": False,
            "feature_columns": list(identity_only.feature_columns), "metrics": metrics,
        }
    else:
        output["identity_only"] = {
            "status": "unavailable", "deployable": False,
            "reason": identity_only.unavailable_reason,
        }
    full_identity = ModelSpecification(
        "M5",
        "M5 full causal plus identity retrospective diagnostic",
        "sklearn HistGradientBoostingRegressor (absolute_error)",
        "non-deployable full causal plus mission/spacecraft identity",
        m3.numeric_features,
        tuple(dict.fromkeys((*m3.categorical_features, "mission", "spacecraft_id"))),
        deployable=False,
    )
    _, metrics = _fit_specification(
        frame, split.train_index, split.test_index, full_identity,
        random_seed=random_seed,
    )
    output["full_causal_plus_identity"] = {
        "status": "available", "deployable": False,
        "feature_columns": list(full_identity.feature_columns), "metrics": metrics,
        "claim_boundary": "diagnostic only; identity dependence cannot demonstrate transfer",
    }
    return {
        "status": "available", "models": output,
        "deployable_model": "M3 excludes all identity columns",
    }


def _response_split(frame: pd.DataFrame, split: YearRoleSplit) -> ChronologicalSplit:
    timestamp = pd.to_datetime(frame["timestamp_utc"], utc=True)
    train, validation, test = (
        list(split.train_index), list(split.validation_index), list(split.test_index)
    )
    return ChronologicalSplit(
        train_index=tuple(train), validation_index=tuple(validation), test_index=tuple(test),
        train_start_utc=_iso(timestamp.loc[train].min()),
        train_stop_utc=_iso(timestamp.loc[train].max()),
        validation_start_utc=_iso(timestamp.loc[validation].min()),
        validation_stop_utc=_iso(timestamp.loc[validation].max()),
        test_start_utc=_iso(timestamp.loc[test].min()),
        test_stop_utc=_iso(timestamp.loc[test].max()),
    )


def _run_lag_response(
    frame: pd.DataFrame,
    split: YearRoleSplit,
    *,
    random_seed: int,
) -> dict[str, object]:
    """Run predeclared response studies; never select a lag on 2025 test."""

    try:
        response = importlib.import_module("leo_drag.response")
    except ModuleNotFoundError:
        return {
            "status": "unavailable",
            "reason": "leo_drag.response is not installed; lag experiments were not fabricated",
        }
    fixed_drivers = [
        driver for driver in ("newell_coupling", "em_mv_m")
        if any(column.startswith(f"response__{driver}__lag__") for column in frame.columns)
    ]
    distributed_features = [
        column for column in frame.columns
        if column.startswith("response__")
        and ("__mean__" in column or "__integral_h__" in column)
    ]
    if not fixed_drivers or not distributed_features:
        build_status = frame.attrs.get("response_build_status")
        return {
            "status": "unavailable",
            "reason": "fixed/distributed response features are absent from the primary frame",
            "build_status": build_status if isinstance(build_status, Mapping) else None,
            "schema_version": getattr(response, "RESPONSE_SCHEMA_VERSION", None),
        }
    ablation_context = next(
        item for item in build_ablation_specifications(frame) if item.ablation_id == "A1"
    )
    base = ModelSpecification(
        "M3", "Mission-agnostic context plus selected response lag",
        "sklearn HistGradientBoostingRegressor (absolute_error)",
        "context plus one response lag",
        ablation_context.numeric_features, ablation_context.categorical_features,
    )
    response_split = _response_split(frame, split)
    fixed: dict[str, object] = {}
    fixed_errors: dict[str, str] = {}
    for driver in fixed_drivers:
        try:
            result = response.evaluate_fixed_lag_models(
                frame,
                driver_column=driver,
                model_specification=base,
                split=response_split,
                config=response.FixedLagEvaluationConfig(
                    random_seed=random_seed,
                    refit_on_train_validation=True,
                    require_complete_candidate_rows=True,
                ),
            )
            fixed[driver] = result.to_dict()
        except (ValueError, AssertionError) as exc:
            fixed_errors[driver] = f"{type(exc).__name__}: {exc}"

    distributed_spec = ModelSpecification(
        "M3", "Predeclared distributed response bins",
        "sklearn HistGradientBoostingRegressor (absolute_error)",
        "context plus predeclared disjoint 0-12 hour response bins",
        tuple(dict.fromkeys((*base.numeric_features, *distributed_features))),
        base.categorical_features,
    )
    development = (*split.train_index, *split.validation_index)
    estimator = make_model_pipeline(distributed_spec, random_seed=random_seed)
    estimator.fit(
        frame.loc[list(development), list(distributed_spec.feature_columns)],
        frame.loc[list(development), TARGET_COLUMN],
    )
    test = _partition_prediction(
        frame, split.test_index, estimator, distributed_spec
    )
    importance = response.lag_importance_breakdowns(
        estimator,
        frame.loc[list(split.test_index)],
        feature_columns=list(distributed_spec.feature_columns),
        lag_feature_columns=distributed_features,
        config=response.RegimeBreakdownConfig(
            minimum_rows=30,
            permutation_repeats=3,
            random_seed=random_seed,
            storm_column="study_regime",
            storm_labels=("quiet", "moderate_storm", "severe_storm"),
        ),
    )
    return {
        "status": "available",
        "schema_version": getattr(response, "RESPONSE_SCHEMA_VERSION", None),
        "selection_policy": "fixed lag selected on 2023 validation only; 2025 test opened once",
        "calibration_year_excluded": 2024,
        "fixed_lag": {"results": fixed, "errors": fixed_errors},
        "distributed_lag": {
            "architecture": "predeclared disjoint bins; no test-driven bin selection",
            "feature_columns": distributed_features,
            "train_validation_rows": len(development),
            "test_rows": len(split.test_index),
            "test_metrics": _density_metrics(test),
            "lag_importance_breakdowns": importance,
        },
    }


def run_multiyear_study_from_feature_frames(
    feature_frames: Mapping[str, pd.DataFrame],
    *,
    output_root: str | Path,
    run_id: str,
    plan: Mapping[str, Any],
    data_lineage: Mapping[str, Any] | None = None,
    timeline_reports: Mapping[str, TimelineBuildReport | Mapping[str, Any]] | None = None,
    driver_lineage: Mapping[str, Any] | None = None,
    arrival_model_lineage: Mapping[str, Any] | None = None,
    random_seed: int = 42,
    bootstrap_resamples: int = 200,
    overwrite_run: bool = False,
) -> dict[str, Any]:
    """Fit and persist the study from already-built real or test feature frames."""

    validated_plan = validate_corpus_plan(plan)
    required_modes = {REFERENCE_ALIGNED, HELIOSAT_MRU_ARRIVAL, HELIOSAT_MRU_ML_ARRIVAL}
    missing_modes = required_modes - set(feature_frames)
    if missing_modes:
        raise ValueError(f"multi-year study lacks arrival mode(s): {sorted(missing_modes)}")
    root = Path(output_root).resolve()
    run_directory = root / run_id
    if run_directory.exists() and any(run_directory.iterdir()) and not overwrite_run:
        raise FileExistsError(
            f"run directory already contains artifacts: {run_directory}; choose a new --run-id"
        )
    run_directory.mkdir(parents=True, exist_ok=True)
    aligned, common_report = align_common_matched_rows(
        {mode: feature_frames[mode] for mode in sorted(required_modes)}
    )
    for mode, frame in aligned.items():
        if "spacecraft_key" not in frame:
            aligned[mode] = add_spacecraft_key(frame)
    canonical = aligned[REFERENCE_ALIGNED]
    split = build_year_role_split(canonical)
    specifications = {
        mode: _m3_specification(frame) for mode, frame in aligned.items()
    }
    feature_lists = {spec.feature_columns for spec in specifications.values()}
    if len(feature_lists) != 1:
        raise AssertionError("M3 feature columns differ between arrival modes")
    feature_columns = next(iter(feature_lists))
    prototype = make_model_pipeline(next(iter(specifications.values())), random_seed=random_seed)
    hyperparameters = prototype.named_steps["estimator"].get_params(deep=False)
    role_row_hashes = {
        role: _fingerprint({
            "row_ids": canonical.loc[list(split.indices(role)), "comparison_row_id"].tolist()
        }) for role in YEAR_ROLES
    }
    contract = {
        "row_schema_version": common_report.schema_version,
        "feature_columns": list(feature_columns),
        "hyperparameters": hyperparameters,
        "random_seed": random_seed,
        "year_roles": {role: list(years) for role, years in YEAR_ROLES.items()},
        "role_row_sha256": role_row_hashes,
    }
    contract_sha = _fingerprint(contract)
    modes, predictions, artifacts = _fit_m3_modes(
        aligned, split, output_directory=run_directory, run_id=run_id,
        comparison_contract_sha256=contract_sha, random_seed=random_seed,
        bootstrap_resamples=bootstrap_resamples,
    )
    primary_mode = HELIOSAT_MRU_ML_ARRIVAL
    primary = aligned[primary_mode]
    validations = {
        "year_walk_forward": _year_walk_forward(primary, random_seed=random_seed),
        "leave_one_spacecraft_out": _loso(primary, split, random_seed=random_seed),
        "cross_mission_swarm_to_grace_fo": _cross_mission(
            primary, split, random_seed=random_seed
        ),
    }
    lag_response = _run_lag_response(primary, split, random_seed=random_seed)
    identity_diagnostics = _identity_diagnostics(
        primary, split, random_seed=random_seed
    )
    uncertainty_calibration = {
        mode: result.get("uncertainty")
        for mode, result in modes.items()
        if isinstance(result, Mapping) and result.get("status") == "available"
    }
    arrival_modes = {
        "omni_reference_aligned": modes.get(REFERENCE_ALIGNED, {}),
        "mru": modes.get(HELIOSAT_MRU_ARRIVAL, {}),
        "mru_ml": modes.get(HELIOSAT_MRU_ML_ARRIVAL, {}),
    }
    loso_results = (
        validations.get("leave_one_spacecraft_out", {}).get("results", {})
        if isinstance(validations.get("leave_one_spacecraft_out"), Mapping) else {}
    )
    transfer_experiments: list[dict[str, Any]] = []
    if isinstance(loso_results, Mapping):
        for spacecraft, raw_result in loso_results.items():
            result = raw_result if isinstance(raw_result, Mapping) else {}
            mission, _, spacecraft_id = str(spacecraft).partition(":")
            transfer_experiments.append({
                "id": f"loso-{mission.lower().replace(' ', '-')}-{spacecraft_id.lower()}",
                "kind": "leave_one_spacecraft_out",
                "label": f"Hold out {spacecraft}",
                "arrival_mode": "mru_ml",
                "status": result.get("status", "unavailable"),
                "role": "deployable_candidate",
                "held_out_mission": mission or None,
                "held_out_spacecraft_id": spacecraft_id or None,
                "test_rows": result.get("test_rows"),
                "metrics": result.get("metrics"),
                "reason": result.get("reason"),
            })
    cross = validations.get("cross_mission_swarm_to_grace_fo")
    if isinstance(cross, Mapping):
        transfer_experiments.append({
            "id": "cross-mission-swarm-to-grace-fo",
            "kind": "cross_mission",
            "label": "Swarm to GRACE-FO transfer",
            "arrival_mode": "mru_ml",
            "status": cross.get("status", "unavailable"),
            "role": "deployable_candidate",
            "held_out_mission": "GRACE-FO",
            "train_missions": ["Swarm"],
            "test_rows": cross.get("test_rows"),
            "metrics": cross.get("metrics"),
            "reason": cross.get("reason"),
        })
    lag_experiments: list[dict[str, Any]] = []
    if isinstance(lag_response, Mapping):
        fixed = lag_response.get("fixed_lag")
        if isinstance(fixed, Mapping):
            results = fixed.get("results")
            if isinstance(results, Mapping):
                for driver, raw_result in results.items():
                    result = raw_result if isinstance(raw_result, Mapping) else {}
                    lag_experiments.append({
                        "id": f"fixed-lag-{str(driver).lower()}",
                        "label": f"Fixed lag: {driver}",
                        "arrival_mode": "mru_ml",
                        "kind": "fixed_lag",
                        "status": "available",
                        "lag_min_hours": 0.0,
                        "lag_max_hours": 12.0,
                        "lag_step_minutes": 30.0,
                        "best_lag_hours": result.get("selected_lag_hours"),
                        "reason": None,
                    })
            for index, error in enumerate(fixed.get("errors", []) if isinstance(fixed.get("errors"), list) else []):
                lag_experiments.append({
                    "id": f"fixed-lag-unavailable-{index + 1}",
                    "label": "Fixed lag unavailable",
                    "arrival_mode": "mru_ml",
                    "kind": "fixed_lag",
                    "status": "unavailable",
                    "reason": str(error),
                })
        distributed = lag_response.get("distributed_lag")
        if isinstance(distributed, Mapping):
            lag_experiments.append({
                "id": "distributed-lag-full-causal",
                "label": "Distributed response bins 0–12 h",
                "arrival_mode": "mru_ml",
                "kind": "distributed_lag",
                "status": "available" if distributed.get("test_metrics") else "unavailable",
                "lag_min_hours": 0.0,
                "lag_max_hours": 12.0,
                "reason": None if distributed.get("test_metrics") else "distributed model metrics unavailable",
            })
            for dimension in ("latitude", "local_solar_time", "altitude", "storm_intensity"):
                lag_experiments.append({
                    "id": f"distributed-lag-{dimension}",
                    "label": f"Distributed lag importance by {dimension}",
                    "arrival_mode": "mru_ml",
                    "kind": "stratified_lag",
                    "status": "available" if distributed.get("lag_importance_breakdowns") else "unavailable",
                    "lag_min_hours": 0.0,
                    "lag_max_hours": 12.0,
                    "stratification": dimension,
                    "reason": None if distributed.get("lag_importance_breakdowns") else "importance unavailable",
                })
    primary_uncertainty = uncertainty_calibration.get(primary_mode)
    if isinstance(primary_uncertainty, Mapping):
        ui_uncertainty: dict[str, Any] = {
            "status": "calibrated",
            "calibration": primary_uncertainty.get("calibration"),
            "metrics": primary_uncertainty.get("test"),
        }
    else:
        ui_uncertainty = {"status": "unavailable", "reason": "primary calibration unavailable"}
    matched_row_fingerprint = _fingerprint({
        "comparison_row_ids": canonical["comparison_row_id"].astype(str).tolist()
    })
    split_fingerprint = _fingerprint(split.to_dict(canonical))
    hyperparameter_fingerprint = _fingerprint(dict(hyperparameters))
    padded_events = _padded_test_event_windows(validated_plan)
    primary_prediction = predictions.get(primary_mode)
    if padded_events and primary_prediction is not None:
        event_timing = spacecraft_event_enhancement_metrics(
            primary_prediction,
            padded_events,
            enhancement_threshold=1.2,
            predicted_column="rho_p50_kg_m3",
        )
    else:
        event_timing = {
            "status": "unavailable",
            "reason": "no padded 2025 storm event and primary prediction overlap",
            "enhancement_threshold": 1.2,
        }
    summary: dict[str, Any] = {
        "schema_version": MULTIYEAR_STUDY_SCHEMA_VERSION,
        "study_version": MULTIYEAR_STUDY_VERSION,
        "run_id": run_id,
        "generated_at_utc": _now(),
        "status": "available",
        "evidence_class": "retrospective_staged_multi_year_official_density_study",
        "operational_status": "research_only_not_operational",
        "research_stage": "multi_year_study",
        "missions": sorted(primary["mission"].astype(str).unique()),
        "plan": {
            "plan_id": validated_plan["plan_id"],
            "plan_sha256": validated_plan["plan_sha256"],
            "strategy": validated_plan.get("strategy"),
            "coverage_summary": validated_plan.get("coverage_summary"),
        },
        "coverage": {
            "start_utc": _iso(canonical["timestamp_utc"].min()),
            "stop_utc": _iso(canonical["timestamp_utc"].max()),
            "effective_utc_days": int(
                pd.to_datetime(canonical["timestamp_utc"], utc=True).dt.floor("D").nunique()
            ),
            "effective_observation_days": int(
                pd.to_datetime(canonical["timestamp_utc"], utc=True).dt.floor("D").nunique()
            ),
            "calendar_years": sorted(
                int(value) for value in pd.to_datetime(canonical["timestamp_utc"], utc=True).dt.year.unique()
            ),
            "rows_common": len(canonical),
            "spacecraft": sorted(primary["spacecraft_key"].astype(str).unique()),
            "spacecraft_count": int(primary["spacecraft_key"].nunique()),
            "spacecraft_ids": sorted(primary["spacecraft_key"].astype(str).unique()),
            "mission_count": int(primary["mission"].nunique()),
            "quiet_interval_count": (
                validated_plan.get("coverage_summary", {}).get("quiet_intervals")
                if isinstance(validated_plan.get("coverage_summary"), Mapping) else None
            ),
            "storm_events": ({
                "moderate": validated_plan.get("coverage_summary", {}).get("moderate_storms"),
                "severe": validated_plan.get("coverage_summary", {}).get("severe_storms"),
            } if isinstance(validated_plan.get("coverage_summary"), Mapping) else {}),
            "regime_counts": primary["study_regime"].value_counts(dropna=False).to_dict()
            if "study_regime" in primary else {},
        },
        "data_lineage": dict(data_lineage or {}),
        "driver_lineage": dict(driver_lineage or {}),
        "arrival_model_lineage": dict(arrival_model_lineage or {}),
        "timeline_reports": {
            mode: asdict(report) if isinstance(report, TimelineBuildReport) else dict(report)
            for mode, report in (timeline_reports or {}).items()
        },
        "common_rows": common_report.to_dict(),
        "split": split.to_dict(canonical),
        "comparison_contract": {**contract, "sha256": contract_sha},
        "modes": modes,
        "arrival_modes": arrival_modes,
        "ablations": {
            "mode": primary_mode,
            "same_rows_and_split_sha256": contract_sha,
            "results": _run_ablations(
                primary, split, random_seed=random_seed,
                comparison_contract_sha256=contract_sha,
            ),
        },
        "validation": validations,
        "generalization": {"experiments": transfer_experiments},
        "transfer_experiments": transfer_experiments,
        "identity_diagnostics": identity_diagnostics,
        "arrival_mode_comparison": _paired_arrival_comparisons(
            predictions, bootstrap_resamples=bootstrap_resamples,
            random_seed=random_seed,
        ),
        "lag_response": lag_response,
        "lag_experiments": lag_experiments,
        "uncertainty_calibration": ui_uncertainty,
        "event_timing": event_timing,
        "comparability": {
            "comparison_contract_sha256": contract_sha,
            "common_rows": common_report.to_dict(),
            "role_row_sha256": role_row_hashes,
            "identical_feature_columns": True,
            "identical_hyperparameters": True,
        },
        "arrival_comparability": {
            "status": "identical",
            "matched_row_fingerprint": matched_row_fingerprint,
            "split_fingerprint": split_fingerprint,
            "hyperparameter_fingerprint": hyperparameter_fingerprint,
            "random_seed": random_seed,
            "reasons": [],
        },
        "drag": {
            "status": "not_recomputed",
            "level": 1,
            "reason": "density validation is the current priority; no higher-order orbit claim was added",
        },
        "artifacts": sorted(artifacts),
        "runtime_versions": _runtime_versions(),
        "code_state": _code_state(),
        "limitations": [
            "The corpus is a staged event/season sample, not continuous climatological coverage.",
            "Reference alignment is retrospective and must not be interpreted as an operational input.",
            "Strict MRU+ML results require a compatible rebuilt arrival artifact for every retained row.",
            "The fixed arrival-residual artifact is trained through 2026; density year folds do not refit arrival timing by year, so MRU+ML remains a retrospective replay rather than a strict year-forward operational test.",
            "NRLMSIS and ESA commercial/redistribution licensing remain unresolved.",
        ],
        "public_deployment_recommendation": "blocked_pending_all_validation_and_licensing_gates",
    }
    from .plots import generate_multiyear_study_plots

    plot_artifacts = generate_multiyear_study_plots(
        run_directory=run_directory,
        predictions=predictions,
        summary=summary,
    )
    artifacts.extend(plot_artifacts)
    summary["artifacts"] = sorted(set(artifacts))
    summary_path = run_directory / "study-summary.v2.json"
    _atomic_json(summary_path, summary)
    _atomic_json(root / "study-summary.v2.json", summary)
    return {
        "status": "completed",
        "run_id": run_id,
        "study_summary": str(summary_path),
        "comparison_contract_sha256": contract_sha,
        "common_rows": len(canonical),
        "artifacts": sorted(set(artifacts)),
    }


def run_multiyear_study(
    *,
    data_root: str | Path,
    model_root: str | Path,
    plan: Mapping[str, Any],
    run_id: str,
    arrival_model_path: str | Path,
    arrival_metrics_path: str | Path | None = None,
    random_seed: int = 42,
    bootstrap_resamples: int = 200,
    overwrite_run: bool = False,
) -> dict[str, Any]:
    observations, data_report = load_plan_baseline_observations(
        data_root=data_root, plan=plan
    )
    frames, _, reports, driver_report = build_three_arrival_feature_frames(
        observations,
        arrival_model_path=arrival_model_path,
        arrival_metrics_path=arrival_metrics_path,
        driver_cache_root=Path(data_root) / "cache" / "omni_high_res",
        source_manifest_checksum_sha256=data_report["manifest_checksum_sha256"],
    )
    arrival_path = Path(arrival_model_path).resolve()
    arrival_lineage: dict[str, Any] = {
        "artifact_path": str(arrival_path),
        "artifact_checksum_sha256": _sha256_file(arrival_path),
    }
    try:
        import joblib

        arrival_payload = joblib.load(arrival_path)
        if isinstance(arrival_payload, Mapping):
            arrival_lineage.update({
                "artifact_schema_version": arrival_payload.get("artifactSchemaVersion"),
                "model_version": arrival_payload.get("modelVersion"),
                "feature_schema_version": arrival_payload.get("featureSchemaVersion"),
                "trained_at_utc": arrival_payload.get("trainedAtUtc"),
                "train_range": arrival_payload.get("trainRange"),
                "validation_range": arrival_payload.get("validationRange"),
                "sklearn_version": arrival_payload.get("sklearnVersion"),
                "benchmark_geometry": arrival_payload.get("benchmarkGeometry"),
                "source_checksums_sha256": arrival_payload.get("sourceChecksumsSha256"),
            })
    except Exception as error:  # pragma: no cover - strict loader already validated it
        arrival_lineage["metadata_read_error"] = f"{type(error).__name__}: {error}"
    if arrival_metrics_path is not None:
        metrics_path = Path(arrival_metrics_path).resolve()
        arrival_lineage["metrics_path"] = str(metrics_path)
        if metrics_path.exists():
            arrival_lineage["metrics_checksum_sha256"] = _sha256_file(metrics_path)

    return run_multiyear_study_from_feature_frames(
        frames,
        output_root=model_root,
        run_id=run_id,
        plan=plan,
        data_lineage=data_report,
        timeline_reports=reports,
        driver_lineage=driver_report,
        arrival_model_lineage=arrival_lineage,
        random_seed=random_seed,
        bootstrap_resamples=bootstrap_resamples,
        overwrite_run=overwrite_run,
    )


__all__ = [
    "EXPECTED_SPACECRAFT",
    "MULTIYEAR_STUDY_SCHEMA_VERSION",
    "MULTIYEAR_STUDY_VERSION",
    "YEAR_ROLES",
    "YearRoleSplit",
    "build_three_arrival_feature_frames",
    "build_year_role_split",
    "load_plan_baseline_observations",
    "run_multiyear_study",
    "run_multiyear_study_from_feature_frames",
    "validate_corpus_plan",
]
