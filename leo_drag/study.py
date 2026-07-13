"""End-to-end reproducible pilot study for LEO density and drag.

This runner deliberately calls the reusable ingestion, baseline, causal-driver,
feature, model and drag modules.  It writes versioned artifacts; it never uses
test fixtures or presents the short pilot interval as operational validation.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import tempfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from ml.arrival_residual.dataset import _parse_year_file, download_year

from .drag import calculate_drag_profile, compare_baseline_and_corrected_drag, get_spacecraft_scenario
from .drivers import (
    HELIOSAT_PREDICTED_ARRIVAL,
    REFERENCE_ALIGNED,
    TimelineBuildReport,
    add_causal_rolling_features,
    build_heliosat_predicted_timeline,
    build_reference_aligned_timeline,
)
from .features import FeatureDatasetMetadata, build_feature_dataset, write_feature_dataset
from .manifest import load_manifest, upsert_manifest_entry, utc_now_iso
from .metrics import EventWindow, density_metrics
from .models import (
    ModelSuiteResult,
    build_model_specifications,
    chronological_split,
    make_model_pipeline,
    prepare_matched_rows,
    train_model_suite,
    write_study_summary,
)
from .schema import usable_density_mask
from .trajectory import derive_inertial_trajectory

PILOT_STUDY_VERSION = "heliosat-leo-pilot-v1"
DEFAULT_ARRIVAL_ARTIFACT = Path("data/ml-model/arrival-residual/model.joblib")
DEFAULT_ARRIVAL_METRICS = Path("data/console/ml_metrics.json")
DEFAULT_KP_ARCHIVE = Path("data/console/omni-archive.json")


def _json_safe(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, (pd.Timestamp, datetime)):
        parsed = pd.Timestamp(value)
        if parsed.tzinfo is None:
            parsed = parsed.tz_localize("UTC")
        else:
            parsed = parsed.tz_convert("UTC")
        return parsed.isoformat().replace("+00:00", "Z")
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = (json.dumps(_json_safe(payload), indent=2, sort_keys=True, allow_nan=False) + "\n").encode()
    with tempfile.NamedTemporaryFile(
        "wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(body)
        temporary = Path(handle.name)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def load_baseline_observations(data_root: str | Path = "data") -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load only baseline files named by the canonical manifest."""

    root = Path(data_root).resolve()
    manifest_path = root / "processed" / "thermosphere" / "manifest.v1.json"
    manifest = load_manifest(manifest_path)
    frames: list[pd.DataFrame] = []
    files: list[Path] = []
    for entry in manifest.get("entries", []):
        if not isinstance(entry, dict):
            continue
        for value in entry.get("baseline_files") or []:
            candidate = Path(str(value))
            path = candidate if candidate.is_absolute() else root / candidate
            if not path.exists():
                continue
            frame = pd.read_parquet(path)
            frame["manifest_entry_id"] = str(entry.get("id"))
            frames.append(frame)
            files.append(path)
    if not frames:
        raise FileNotFoundError(
            "no baseline-augmented thermosphere files are listed in the manifest; run the baseline phase first"
        )
    observations = pd.concat(frames, ignore_index=True)
    observations["timestamp_utc"] = pd.to_datetime(
        observations["timestamp_utc"], utc=True, errors="coerce"
    )
    observations = observations.dropna(subset=["timestamp_utc"])
    observations = observations.sort_values(
        ["timestamp_utc", "mission", "spacecraft_id", "source_product"], kind="mergesort"
    ).drop_duplicates(
        ["timestamp_utc", "mission", "spacecraft_id", "source_product"], keep="last"
    ).reset_index(drop=True)
    quality = usable_density_mask(observations, allow_quality_not_provided=False)
    baseline_ok = observations["baseline_input_status"].eq("ok") & pd.to_numeric(
        observations["rho_baseline_kg_m3"], errors="coerce"
    ).gt(0)
    selected = observations.loc[quality & baseline_ok].copy().reset_index(drop=True)
    if selected.empty:
        raise ValueError("no nominal-quality observation has a valid physical baseline")
    report = {
        "manifest_path": str(manifest_path),
        "manifest_checksum_sha256": _sha256_file(manifest_path),
        "source_files": [_relative(path, root) for path in files],
        "source_checksums_sha256": {
            _relative(path, root): _sha256_file(path) for path in files
        },
        "input_rows": len(observations),
        "selected_rows": len(selected),
        "quality_rejected_rows": int((~quality).sum()),
        "baseline_rejected_rows": int((~baseline_ok).sum()),
        "coverage_start_utc": selected["timestamp_utc"].min(),
        "coverage_end_utc": selected["timestamp_utc"].max(),
        "missions": sorted(selected["mission"].astype(str).unique()),
        "spacecraft": sorted(
            f"{mission} {spacecraft}"
            for mission, spacecraft in selected[["mission", "spacecraft_id"]]
            .drop_duplicates().itertuples(index=False, name=None)
        ),
        "baseline_models": sorted(selected["baseline_model_name"].dropna().astype(str).unique()),
        "baseline_versions": sorted(selected["baseline_model_version"].dropna().astype(str).unique()),
        "quality_policy": "valid positive density and validity_flag == 0; unflagged products require explicit opt-in",
        "evidence_class": "observed_retrospective_product_plus_retrospective_physical_baseline",
    }
    return selected, report


def load_driver_source(
    start_utc: object,
    stop_utc: object,
    *,
    cache_root: str | Path = "data/cache/omni_high_res",
) -> tuple[pd.DataFrame, dict[str, Any]]:
    start = pd.to_datetime(start_utc, utc=True, errors="raise") - pd.Timedelta(hours=13)
    stop = pd.to_datetime(stop_utc, utc=True, errors="raise") + pd.Timedelta(hours=13)
    cache = Path(cache_root).resolve()
    frames: list[pd.DataFrame] = []
    paths: list[Path] = []
    for year in range(start.year, stop.year + 1):
        candidate = cache / f"omni_5min{year}.asc"
        path = candidate if candidate.exists() else download_year(year)
        paths.append(path.resolve())
        frames.append(_parse_year_file(path))
    source = pd.concat(frames, ignore_index=True)
    source = source[(source["time"] >= start) & (source["time"] < stop)].copy()
    return source, {
        "source": "NASA SPDF high-resolution OMNI 5-minute yearly files",
        "source_base_url": "https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/",
        "source_files": [str(path) for path in paths],
        "checksums_sha256": {path.name: _sha256_file(path) for path in paths},
        "coverage_start_utc": source["time"].min(),
        "coverage_end_utc": source["time"].max(),
        "evidence_class": "retrospective_reference_archive",
    }


def inspect_arrival_artifact(path: str | Path) -> dict[str, Any]:
    artifact = Path(path)
    result: dict[str, Any] = {
        "path": str(artifact),
        "exists": artifact.exists(),
        "checksum_sha256": _sha256_file(artifact) if artifact.exists() else None,
        "status": "unavailable",
        "error": None,
    }
    if not artifact.exists():
        result["error"] = "arrival residual artifact is missing; MRU fallback is required"
        return result
    try:
        import joblib

        payload = joblib.load(artifact)
        result["status"] = "available"
        result["artifact_schema_version"] = (
            payload.get("artifactSchemaVersion") if isinstance(payload, dict) else None
        )
        result["model_version"] = payload.get("modelVersion") if isinstance(payload, dict) else None
        result["feature_schema_version"] = (
            payload.get("featureSchemaVersion") if isinstance(payload, dict) else None
        )
        result["feature_names"] = payload.get("featureNames") if isinstance(payload, dict) else None
        result["sklearn_version"] = payload.get("sklearnVersion") if isinstance(payload, dict) else None
        result["train_range"] = payload.get("trainRange") if isinstance(payload, dict) else None
        result["validation_range"] = (
            payload.get("validationRange") if isinstance(payload, dict) else None
        )
        result["benchmark_geometry"] = (
            payload.get("benchmarkGeometry") if isinstance(payload, dict) else None
        )
    except Exception as exc:  # noqa: BLE001 - compatibility is reported, not hidden
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def build_study_timelines(
    source: pd.DataFrame,
    *,
    arrival_model_path: str | Path,
    arrival_metrics_path: str | Path,
) -> tuple[dict[str, pd.DataFrame], dict[str, TimelineBuildReport]]:
    reference, reference_report = build_reference_aligned_timeline(source)
    predicted, predicted_report = build_heliosat_predicted_timeline(
        source,
        arrival_model_path=arrival_model_path,
        arrival_metrics_path=arrival_metrics_path,
    )
    return {
        REFERENCE_ALIGNED: add_causal_rolling_features(reference),
        HELIOSAT_PREDICTED_ARRIVAL: add_causal_rolling_features(predicted),
    }, {
        REFERENCE_ALIGNED: reference_report,
        HELIOSAT_PREDICTED_ARRIVAL: predicted_report,
    }


def load_kp_archive(path: str | Path) -> pd.DataFrame:
    archive_path = Path(path)
    if not archive_path.exists():
        return pd.DataFrame(columns=["timestamp_utc", "kp", "dst"])
    payload = json.loads(archive_path.read_text(encoding="utf-8"))
    rows = payload.get("rows") or []
    records = [
        {"timestamp_utc": pd.to_datetime(row[0], unit="ms", utc=True), "kp": row[5], "dst": row[6]}
        for row in rows if isinstance(row, list) and len(row) >= 7
    ]
    frame = pd.DataFrame(records)
    if frame.empty:
        return pd.DataFrame(columns=["timestamp_utc", "kp", "dst"])
    frame["kp"] = pd.to_numeric(frame["kp"], errors="coerce")
    frame["dst"] = pd.to_numeric(frame["dst"], errors="coerce")
    frame["timestamp_utc"] = frame["timestamp_utc"].astype("datetime64[ns, UTC]")
    return frame.sort_values("timestamp_utc").reset_index(drop=True)


def detect_kp_events(
    kp: pd.DataFrame,
    start_utc: object,
    stop_utc: object,
    *,
    threshold: float = 5.0,
) -> list[EventWindow]:
    """Create retrospective event windows from the explicit NOAA G1 Kp threshold."""

    if kp.empty:
        return []
    start = pd.to_datetime(start_utc, utc=True)
    stop = pd.to_datetime(stop_utc, utc=True)
    selected = kp[
        (kp["timestamp_utc"] >= start)
        & (kp["timestamp_utc"] <= stop)
        & (kp["kp"] >= threshold)
    ].copy()
    if selected.empty:
        return []
    selected["event_group"] = selected["timestamp_utc"].diff().gt(pd.Timedelta(hours=3)).cumsum()
    events: list[EventWindow] = []
    for number, (_, group) in enumerate(selected.groupby("event_group"), start=1):
        event_start = group["timestamp_utc"].min()
        event_stop = group["timestamp_utc"].max() + pd.Timedelta(hours=1)
        events.append(EventWindow(
            event_id=f"kp-g1plus-{event_start.strftime('%Y%m%dT%H%M')}-{number}",
            start_utc=event_start,
            stop_utc=event_stop,
            threshold_kg_m3=None,
        ))
    return events


def _core_metrics(metrics: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: metrics.get(key)
        for key in (
            "status", "sample_count", "mae_log10_rho", "rmse_log10_rho",
            "median_absolute_relative_error", "median_density_ratio",
            "bias_log10_rho", "correlation_log10_rho", "skill_vs_m0", "events",
        )
    }


def grouped_density_metrics(frame: pd.DataFrame) -> dict[str, Any]:
    """Held-out M3 regime and mission breakdowns."""

    work = frame.copy()
    altitude = pd.to_numeric(work["altitude_km"], errors="coerce")
    latitude = pd.to_numeric(work["latitude_deg"], errors="coerce").abs()
    lst = pd.to_numeric(work["local_solar_time_h"], errors="coerce") % 24
    f107 = pd.to_numeric(work.get("f107_sfu"), errors="coerce")
    work["altitude_band"] = pd.cut(
        altitude, [-np.inf, 450, 500, 550, np.inf],
        labels=["<450 km", "450-500 km", "500-550 km", ">550 km"],
    )
    work["latitude_band"] = pd.cut(
        latitude, [-0.01, 30, 60, 90.01], labels=["equatorial", "mid-latitude", "high-latitude"]
    )
    work["local_solar_time_band"] = np.select(
        [(lst >= 6) & (lst < 10), (lst >= 10) & (lst < 18), (lst >= 18) & (lst < 22)],
        ["dawn", "day", "dusk"], default="night",
    )
    median_f107 = float(f107.median()) if f107.notna().any() else math.nan
    work["solar_activity_band"] = np.where(
        f107.isna(), "unavailable", np.where(f107 <= median_f107, "lower-half pilot F10.7", "upper-half pilot F10.7")
    )

    def evaluate(column: str) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for label, group in work.groupby(column, observed=True, dropna=False):
            metrics = density_metrics(
                group["rho_obs_kg_m3"], group["rho_predicted_kg_m3"],
                baseline_density=group["rho_baseline_kg_m3"],
            )
            result[str(label)] = _core_metrics(metrics)
        return result

    return {
        "mission": evaluate("mission"),
        "spacecraft": evaluate("spacecraft_id"),
        "altitude": evaluate("altitude_band"),
        "latitude": evaluate("latitude_band"),
        "local_solar_time": evaluate("local_solar_time_band"),
        "solar_activity": evaluate("solar_activity_band"),
    }


def add_retrospective_geomagnetic_regime(frame: pd.DataFrame, kp: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy().sort_values("timestamp_utc")
    output["timestamp_utc"] = pd.to_datetime(
        output["timestamp_utc"], utc=True, errors="coerce"
    ).astype("datetime64[ns, UTC]")
    if kp.empty:
        output["kp_retrospective"] = np.nan
        output["geomagnetic_regime"] = "unavailable"
        return output
    lookup = kp[["timestamp_utc", "kp", "dst"]].copy()
    lookup["timestamp_utc"] = pd.to_datetime(
        lookup["timestamp_utc"], utc=True, errors="coerce"
    ).astype("datetime64[ns, UTC]")
    joined = pd.merge_asof(
        output,
        lookup.sort_values("timestamp_utc"),
        on="timestamp_utc",
        direction="backward",
        tolerance=pd.Timedelta(hours=3, minutes=30),
    )
    joined = joined.rename(columns={"kp": "kp_retrospective", "dst": "dst_retrospective_nt"})
    joined["geomagnetic_regime"] = np.select(
        [joined["kp_retrospective"] >= 7, joined["kp_retrospective"] >= 5],
        ["G3+ retrospective", "G1-G2 retrospective"],
        default="quiet/unclassified retrospective",
    )
    return joined


def event_holdout_diagnostic(
    frame: pd.DataFrame,
    metadata: FeatureDatasetMetadata,
    events: Sequence[EventWindow],
    output_directory: Path,
) -> dict[str, Any]:
    if not events:
        return {"status": "unavailable", "reason": "no Kp>=5 event occurs in the pilot interval"}
    specifications = build_model_specifications(frame, metadata)
    m3 = next(specification for specification in specifications if specification.model_id == "M3")
    matched, _ = prepare_matched_rows(frame, specifications, require_complete_features=False)
    holdout = events[-1]
    start = pd.to_datetime(holdout.start_utc, utc=True)
    stop = pd.to_datetime(holdout.stop_utc, utc=True)
    test_mask = matched["timestamp_utc"].between(start, stop, inclusive="left")
    training = matched.loc[~test_mask]
    test = matched.loc[test_mask].copy()
    if len(training) < 100 or len(test) < 20:
        return {"status": "unavailable", "reason": "event holdout has insufficient matched rows"}
    estimator = make_model_pipeline(m3)
    estimator.fit(training[list(m3.feature_columns)], training["target_log_density_residual"])
    residual = estimator.predict(test[list(m3.feature_columns)])
    test["rho_predicted_kg_m3"] = test["rho_baseline_kg_m3"].to_numpy(float) * np.exp(residual)
    metrics = density_metrics(
        test["rho_obs_kg_m3"], test["rho_predicted_kg_m3"],
        baseline_density=test["rho_baseline_kg_m3"],
    )
    per_spacecraft: dict[str, Any] = {}
    for (mission, spacecraft), group in test.groupby(["mission", "spacecraft_id"]):
        event_metrics = density_metrics(
            group["rho_obs_kg_m3"], group["rho_predicted_kg_m3"],
            baseline_density=group["rho_baseline_kg_m3"], timestamps=group["timestamp_utc"],
            event_windows=[holdout],
        )["events"]
        per_spacecraft[f"{mission} {spacecraft}"] = event_metrics
    available_events = [
        value for value in per_spacecraft.values()
        if isinstance(value, Mapping) and value.get("status") == "available"
    ]
    aggregate_event = {
        "status": "available" if available_events else "unavailable",
        "method": "median of separately evaluated mission/spacecraft event peaks",
        "spacecraft_count": len(available_events),
        "peak_density_absolute_relative_error": (
            float(np.median([value["peak_density_absolute_relative_error"] for value in available_events]))
            if available_events else None
        ),
        "peak_timing_mae_min": (
            float(np.median([value["peak_timing_mae_min"] for value in available_events]))
            if available_events else None
        ),
        "onset_timing_mae_min": None,
        "recovery_timing_mae_min": None,
        "reason": "No density threshold was defined; onset/recovery metrics remain unavailable.",
    }
    path = output_directory / "m3-event-holdout-predictions.parquet"
    test.to_parquet(path, index=False)
    return {
        "status": "available",
        "event_definition": "retrospective Kp >= 5 (NOAA G1 threshold); not a model input",
        "event": asdict(holdout),
        "train_rows": len(training),
        "test_rows": len(test),
        "metrics": _core_metrics(metrics),
        "event_metrics": aggregate_event,
        "event_metrics_by_spacecraft": per_spacecraft,
        "predictions_artifact": path.name,
        "warning": "Additional whole-event holdout diagnostic; not the chronological headline split.",
    }


def cross_mission_diagnostics(
    frame: pd.DataFrame,
    metadata: FeatureDatasetMetadata,
    output_directory: Path,
) -> dict[str, Any]:
    specifications = build_model_specifications(frame, metadata)
    m3 = next(specification for specification in specifications if specification.model_id == "M3")
    matched, _ = prepare_matched_rows(frame, specifications, require_complete_features=False)
    results: dict[str, Any] = {}
    for mission in sorted(matched["mission"].astype(str).unique()):
        test_mask = matched["mission"].astype(str).eq(mission)
        training, test = matched.loc[~test_mask], matched.loc[test_mask].copy()
        if len(training) < 100 or len(test) < 20:
            continue
        estimator = make_model_pipeline(m3)
        estimator.fit(training[list(m3.feature_columns)], training["target_log_density_residual"])
        residual = estimator.predict(test[list(m3.feature_columns)])
        test["rho_predicted_kg_m3"] = test["rho_baseline_kg_m3"].to_numpy(float) * np.exp(residual)
        metrics = density_metrics(
            test["rho_obs_kg_m3"], test["rho_predicted_kg_m3"],
            baseline_density=test["rho_baseline_kg_m3"],
        )
        path = output_directory / f"m3-cross-mission-{mission.lower().replace(' ', '-')}.parquet"
        test.to_parquet(path, index=False)
        results[mission] = {
            "status": "available", "train_missions": sorted(training["mission"].astype(str).unique()),
            "train_rows": len(training), "test_rows": len(test),
            "metrics": _core_metrics(metrics), "predictions_artifact": path.name,
        }
    return {
        "status": "available" if results else "unavailable",
        "method": "entire mission held out; diagnostic transfer study, not headline",
        "results": results,
    }


def drag_diagnostics(frame: pd.DataFrame) -> dict[str, Any]:
    """Translate held-out density errors into one explicit generic scenario."""

    scenario = get_spacecraft_scenario("nominal")
    outputs: dict[str, Any] = {}
    for (mission, spacecraft), group in frame.groupby(["mission", "spacecraft_id"], sort=True):
        group = group.sort_values("timestamp_utc").reset_index(drop=True)
        try:
            trajectory = derive_inertial_trajectory(
                group["timestamp_utc"], group["latitude_deg"], group["longitude_deg"], group["altitude_km"]
            )
            mask = trajectory.valid_velocity
            if mask.sum() < 2:
                raise ValueError("fewer than two valid finite-difference velocity points")
            timestamps = np.asarray(trajectory.timestamps_utc, dtype=object)[mask]
            position = trajectory.position_inertial_m[mask]
            velocity = trajectory.velocity_inertial_m_s[mask]
            maximum_speed = float(np.linalg.norm(velocity, axis=1).max())
            if maximum_speed > 15_000:
                raise ValueError(
                    f"implausible finite-difference orbital speed {maximum_speed / 1_000:.2f} km/s"
                )
            observed_density = group["rho_obs_kg_m3"].to_numpy(float)[mask]
            baseline_density = group["rho_baseline_kg_m3"].to_numpy(float)[mask]
            corrected_density = group["rho_predicted_kg_m3"].to_numpy(float)[mask]
            observed = calculate_drag_profile(
                timestamps, position, velocity, observed_density, scenario.parameters
            )
            comparison = compare_baseline_and_corrected_drag(
                timestamps, position, velocity, baseline_density, corrected_density,
                scenario.parameters,
            )
            observed_acceleration = observed.drag_acceleration_m_s2
            predicted_acceleration = comparison.corrected.drag_acceleration_m_s2
            outputs[f"{mission} {spacecraft}"] = {
                "status": "available",
                "rows": int(mask.sum()),
                "scenario": scenario.to_metadata(),
                "trajectory_method": trajectory.method,
                "trajectory_warning": trajectory.warning,
                "maximum_inertial_speed_km_s": maximum_speed / 1_000.0,
                "drag_acceleration_mae_m_s2": float(np.mean(np.abs(predicted_acceleration - observed_acceleration))),
                "drag_acceleration_median_absolute_relative_error": float(
                    np.median(np.abs(predicted_acceleration / observed_acceleration - 1.0))
                ),
                "final_cumulative_delta_v_m_s": {
                    "observed_density_scenario": float(observed.impact.cumulative_delta_v_loss_m_s[-1]),
                    "baseline_density_scenario": float(comparison.baseline.impact.cumulative_delta_v_loss_m_s[-1]),
                    "corrected_density_scenario": float(comparison.corrected.impact.cumulative_delta_v_loss_m_s[-1]),
                },
                "final_along_track_displacement_m": {
                    "observed_density_scenario": float(observed.impact.along_track_displacement_m[-1]),
                    "baseline_density_scenario": float(comparison.baseline.impact.along_track_displacement_m[-1]),
                    "corrected_density_scenario": float(comparison.corrected.impact.along_track_displacement_m[-1]),
                },
                "assumptions": list(comparison.corrected.assumptions),
                "evidence_class": "retrospective_density_with_generic_spacecraft_scenario",
            }
        except Exception as exc:  # noqa: BLE001 - per-mission status remains visible
            outputs[f"{mission} {spacecraft}"] = {
                "status": "unavailable", "error": f"{type(exc).__name__}: {exc}"
            }
    return {
        "status": "available" if any(value.get("status") == "available" for value in outputs.values()) else "unavailable",
        "ballistic_coefficient_convention": "B = C_D A / m [m^2/kg]",
        "scenario_warning": scenario.warning,
        "spacecraft": outputs,
        "claim_boundary": "First-order scenario impact, not precise orbit determination or a measured satellite property.",
    }


def _load_prediction(root: Path, run_id: str, mode: str, model_id: str = "m3") -> pd.DataFrame:
    path = root / run_id / mode / f"{model_id}-test-predictions.parquet"
    if not path.exists():
        raise FileNotFoundError(path)
    frame = pd.read_parquet(path)
    frame["timestamp_utc"] = pd.to_datetime(frame["timestamp_utc"], utc=True)
    return frame


def _update_manifest_roles(
    data_root: Path,
    suites: Mapping[str, ModelSuiteResult],
    feature_paths: Mapping[str, Path],
) -> None:
    manifest_path = data_root / "processed" / "thermosphere" / "manifest.v1.json"
    manifest = load_manifest(manifest_path)
    split = next(iter(suites.values())).split
    role_ranges = {
        "train": {"start_utc": split.train_start_utc, "end_utc": split.train_stop_utc},
        "validation": {"start_utc": split.validation_start_utc, "end_utc": split.validation_stop_utc},
        "test": {"start_utc": split.test_start_utc, "end_utc": split.test_stop_utc},
    }
    for entry in manifest.get("entries", []):
        if not isinstance(entry, dict):
            continue
        updated = dict(entry)
        updated.update({
            "driver_join_status": "processed",
            "driver_join_modes": {
                mode: {
                    "matched_rows": suite.matched_rows.matched_rows,
                    "input_rows": suite.matched_rows.input_rows,
                }
                for mode, suite in suites.items()
            },
            "feature_dataset_files": {
                mode: _relative(path, data_root) for mode, path in feature_paths.items()
            },
            "training_role": "mixed",
            "role_coverage": role_ranges,
            "study_run_id": next(iter(suites.values())).run_id,
            "study_last_run_utc": utc_now_iso(),
        })
        upsert_manifest_entry(manifest_path, updated)


def _write_model_card(path: Path, summary: Mapping[str, Any]) -> None:
    modes = summary.get("modes") or {}
    lines = [
        "# Model card: HelioSat LEO thermospheric density pilot",
        "",
        f"Run: `{summary.get('run_id')}`",
        "",
        "## Intended use",
        "",
        "Authenticated internal research only. The model predicts a log-density residual over NRLMSIS 2.1 and translates density to a generic drag-sensitivity scenario.",
        "",
        "## Evidence boundary",
        "",
        "The density products are retrospective ESA observations. Model results are retrospective pilot results. Drag outputs are scenarios, not measured satellite properties. No public or operational claim is authorized.",
        "",
        "## Experiment modes",
        "",
    ]
    for key, mode in modes.items():
        lines.append(f"- `{key}`: {mode.get('label')} ({mode.get('status')})")
    lines.extend(["", "## Limitations", ""])
    lines.extend(f"- {item}" for item in summary.get("limitations") or [])
    lines.extend(["", "## Reproduction", "", "```bash", "python scripts/run_leo_density_study.py --data-root data --run-id " + str(summary.get("run_id")), "```", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def run_pilot_study(
    *,
    data_root: str | Path = "data",
    model_root: str | Path = "data/model-runs/leo-density",
    run_id: str = "pilot-20220203-20220208-v1",
    bootstrap_resamples: int = 200,
    random_seed: int = 42,
    arrival_model_path: str | Path = DEFAULT_ARRIVAL_ARTIFACT,
    arrival_metrics_path: str | Path = DEFAULT_ARRIVAL_METRICS,
    kp_archive_path: str | Path = DEFAULT_KP_ARCHIVE,
    overwrite_run: bool = False,
) -> dict[str, Any]:
    """Execute phases 5--7 and write the canonical validation artifact."""

    data_root_path = Path(data_root).resolve()
    model_root_path = Path(model_root).resolve()
    run_directory = model_root_path / run_id
    if run_directory.exists() and any(run_directory.iterdir()) and not overwrite_run:
        raise FileExistsError(
            f"run directory already contains artifacts: {run_directory}; choose a new --run-id "
            "or explicitly acknowledge replacement with --overwrite-run"
        )
    run_directory.mkdir(parents=True, exist_ok=True)
    observations, data_report = load_baseline_observations(data_root_path)
    source, driver_source_report = load_driver_source(
        observations["timestamp_utc"].min(), observations["timestamp_utc"].max()
    )
    arrival_artifact = inspect_arrival_artifact(arrival_model_path)
    timelines, timeline_reports = build_study_timelines(
        source,
        arrival_model_path=arrival_model_path,
        arrival_metrics_path=arrival_metrics_path,
    )
    kp = load_kp_archive(kp_archive_path)
    events = detect_kp_events(
        kp, observations["timestamp_utc"].min(), observations["timestamp_utc"].max()
    )

    feature_frames: dict[str, pd.DataFrame] = {}
    metadata: dict[str, FeatureDatasetMetadata] = {}
    feature_paths: dict[str, Path] = {}
    suites: dict[str, ModelSuiteResult] = {}
    diagnostics: dict[str, Any] = {}
    for mode in (REFERENCE_ALIGNED, HELIOSAT_PREDICTED_ARRIVAL):
        frame, meta = build_feature_dataset(
            observations,
            timelines[mode],
            experiment_mode=mode,
            tolerance="15min",
            source_manifest_checksum_sha256=data_report["manifest_checksum_sha256"],
        )
        feature_path = (
            data_root_path / "processed" / "thermosphere-features" / mode
            / f"{meta.dataset_version}.parquet"
        )
        write_feature_dataset(frame, meta, feature_path)
        specifications = build_model_specifications(frame, meta)
        matched, _ = prepare_matched_rows(frame, specifications, require_complete_features=False)
        split = chronological_split(matched, train_fraction=0.5, validation_fraction=0.1)
        suite = train_model_suite(
            frame,
            experiment_mode=mode,
            metadata=meta,
            split=split,
            artifact_root=model_root_path,
            run_id=run_id,
            require_complete_features=False,
            random_seed=random_seed,
            bootstrap_resamples=bootstrap_resamples,
            # Multi-spacecraft rows must never form one artificial density
            # peak.  Event metrics are computed by event_holdout_diagnostic()
            # separately per mission/spacecraft and only then aggregated.
            event_windows=None,
        )
        feature_frames[mode], metadata[mode], feature_paths[mode], suites[mode] = (
            frame, meta, feature_path, suite
        )
        prediction = add_retrospective_geomagnetic_regime(
            _load_prediction(model_root_path, run_id, mode), kp
        )
        breakdowns = grouped_density_metrics(prediction)
        breakdowns["geomagnetic_regime"] = {}
        for label, group in prediction.groupby("geomagnetic_regime", dropna=False):
            breakdowns["geomagnetic_regime"][str(label)] = _core_metrics(density_metrics(
                group["rho_obs_kg_m3"], group["rho_predicted_kg_m3"],
                baseline_density=group["rho_baseline_kg_m3"],
            ))
        mode_directory = run_directory / mode
        diagnostics[mode] = {
            "timeline_report": asdict(timeline_reports[mode]),
            "feature_dataset": {
                "feature_schema_version": meta.feature_schema_version,
                "dataset_version": meta.dataset_version,
                "row_count": meta.row_count,
                "target_valid_rows": meta.target_valid_rows,
                "driver_matched_rows": meta.driver_matched_rows,
                "driver_missing_rows": meta.driver_missing_rows,
                "start_utc": meta.start_utc,
                "end_utc": meta.end_utc,
                "feature_count": len(meta.feature_definitions),
                "source_manifest_checksum_sha256": meta.source_manifest_checksum_sha256,
                "causal_join": meta.causal_join,
            },
            "breakdowns": breakdowns,
            "event_holdout": event_holdout_diagnostic(frame, meta, events, mode_directory),
            "cross_mission_transfer": cross_mission_diagnostics(frame, meta, mode_directory),
            "year_walk_forward": {
                "status": "unavailable",
                "reason": "the official local pilot contains only 2022; the reusable year-walk-forward implementation requires at least two years",
            },
            "drag": drag_diagnostics(prediction),
        }

    limitations = [
        "Pilot coverage is only 2022-02-03 through 2022-02-07; metrics do not establish seasonal, annual or rare-storm generalization.",
        "The held-out chronological test contains only a few UTC-day blocks; bootstrap intervals remain pilot uncertainty estimates.",
        "NRLMSIS 2.1 is internal research software with unresolved commercial licensing for HelioSat.",
        "The centered 81-day F10.7 baseline input is retrospective and is not an issuance-safe live forcing.",
        "M4 is unavailable because no ground geomagnetic history in this dataset has a proven per-value publication time at issuance.",
        "The current arrival-residual artifact is incompatible with the installed scikit-learn runtime, so the end-to-end pilot uses the explicit MRU fallback.",
        "Drag uses a generic B=0.01 m^2/kg scenario and finite-difference density-product positions; it is not precise orbit determination.",
        "Neutral winds, attitude changes and operator ephemerides are not modeled.",
    ]
    warnings = [
        "Research pilot, not operational and not for the public dashboard.",
        "Reference-aligned and HelioSat-predicted-arrival metrics must not be combined into one headline.",
    ]
    if arrival_artifact["status"] != "available":
        warnings.append(f"Arrival ML unavailable; MRU fallback recorded: {arrival_artifact['error']}")
    summary_path = write_study_summary(
        model_root_path,
        run_id,
        suites,
        missions=sorted(observations["mission"].astype(str).unique()),
        limitations=limitations,
        warnings=warnings,
    )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    kp_path = Path(kp_archive_path).resolve()
    kp_lineage = {
        "source_file": str(kp_path),
        "checksum_sha256": _sha256_file(kp_path) if kp_path.exists() else None,
        "role": "retrospective event/regime labels only; never an M3 issuance feature",
    }
    model_metadata_path = (
        run_directory / HELIOSAT_PREDICTED_ARRIVAL / "m3.joblib.metadata.json"
    )
    try:
        model_metadata = json.loads(model_metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        model_metadata = {}
    summary.update({
        "pilot_study_version": PILOT_STUDY_VERSION,
        "study_scope": "short official-data pilot; no operational skill claim",
        "data_lineage": data_report,
        "driver_lineage": driver_source_report,
        "arrival_artifact": arrival_artifact,
        "event_definitions": [asdict(event) for event in events],
        "event_label_lineage": kp_lineage,
        "code_state": model_metadata.get("code_state"),
        "runtime_versions": model_metadata.get("runtime_versions"),
        "scientific_status": "pilot_completed",
    })
    for mode, diagnostic in diagnostics.items():
        summary["modes"][mode]["breakdowns"] = diagnostic
        summary["modes"][mode]["warnings"] = list(dict.fromkeys(
            [*summary["modes"][mode].get("warnings", []), *(
                ["End-to-end arrival timeline used MRU fallback; no arrival-residual ML rows were applied."]
                if mode == HELIOSAT_PREDICTED_ARRIVAL and timeline_reports[mode].ml_corrected_rows == 0
                else []
            )]
        ))
    _atomic_json(summary_path, summary)
    _atomic_json(run_directory / "data-quality-report.v1.json", {
        "generated_at_utc": utc_now_iso(), "data": data_report,
        "drivers": driver_source_report, "arrival_artifact": arrival_artifact,
        "timeline_reports": {mode: asdict(report) for mode, report in timeline_reports.items()},
    })
    _update_manifest_roles(data_root_path, suites, feature_paths)

    from .plots import generate_study_plots

    plot_artifacts = generate_study_plots(
        run_directory=run_directory,
        observations=observations,
        feature_frames=feature_frames,
        suites=suites,
        events=events,
        kp=kp,
        model_root=model_root_path,
        random_seed=random_seed,
    )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["artifacts"] = sorted(set([
        *summary.get("artifacts", []),
        "data-quality-report.v1.json",
        "model-card.md",
        *plot_artifacts,
    ]))
    for mode in summary["modes"].values():
        mode["artifacts"] = sorted(set([*mode.get("artifacts", []), *plot_artifacts]))
    _atomic_json(summary_path, summary)
    _write_model_card(run_directory / "model-card.md", summary)
    # Root alias is convenient for local/container deployments while the
    # immutable per-run copy remains the source of scientific lineage.
    _atomic_json(model_root_path / "study-summary.v1.json", summary)
    return {
        "status": "completed",
        "run_id": run_id,
        "study_summary": str(summary_path),
        "feature_datasets": {mode: str(path) for mode, path in feature_paths.items()},
        "plots": plot_artifacts,
        "modes": {mode: suite.to_dict() for mode, suite in suites.items()},
        "limitations": limitations,
        "warnings": warnings,
    }


__all__ = [
    "PILOT_STUDY_VERSION",
    "add_retrospective_geomagnetic_regime",
    "cross_mission_diagnostics",
    "detect_kp_events",
    "drag_diagnostics",
    "event_holdout_diagnostic",
    "grouped_density_metrics",
    "inspect_arrival_artifact",
    "load_baseline_observations",
    "load_driver_source",
    "load_kp_archive",
    "run_pilot_study",
]
