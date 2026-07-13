"""Experimental live LEO density/drag snapshot generation.

The generator is intentionally an explicit research command.  It combines a
real satellite.js/CelesTrak trajectory, already-measured live L1 parcels, a
versioned held-out M3 artifact, explicit official atmosphere forcing and a
generic drag scenario.  Missing inputs stop publication of the snapshot; no
climatology or synthetic trajectory is substituted.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import pandas as pd

from .ancillary import load_omni2_forcing
from .baseline import AtmosphereInput, PymsisBaseline
from .baseline_processing import research_license_enabled
from .drag import (
    calculate_drag_profile,
    compare_baseline_and_corrected_drag,
    get_spacecraft_scenario,
)
from .drivers import (
    HELIOSAT_PREDICTED_ARRIVAL,
    add_causal_rolling_features,
    assert_causal_timeline,
    build_heliosat_predicted_timeline,
)
from .features import build_feature_dataset
from .models import load_model_artifact, predict_density_from_artifact
from .validation import apply_density_interval_calibration

PROJECT_ROOT = Path(__file__).resolve().parents[1]
NOAA_F107_URL = "https://services.swpc.noaa.gov/json/f107_cm_flux.json"
NOAA_KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"
FORECAST_SCHEMA_VERSION = "1"
LIVE_ANCILLARY_SCHEMA_VERSION = "leo-live-atmosphere-forcing-v1"


def _iso(value: object) -> str:
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp.isoformat().replace("+00:00", "Z")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _finite_or_none(value: object) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if np.isfinite(numeric) else None


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


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    body = (json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()
    _atomic_bytes(path, body)


def _fetch_official_json(url: str, *, timeout_seconds: float = 30.0, retries: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(max(1, retries)):
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "heliosat-internal-leo-density-research/1.0",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = response.read()
            decoded = json.loads(payload)
            if not isinstance(decoded, list):
                raise ValueError("official live ancillary response is not a list")
            return payload
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError, ValueError) as exc:
            last_error = exc
            if attempt + 1 < max(1, retries):
                time.sleep(1.0 * (2**attempt))
    raise RuntimeError(f"official live ancillary request failed: {url}: {last_error}")


def _save_live_raw(data_root: Path, name: str, url: str, payload: bytes, retrieved_at: str) -> dict[str, Any]:
    checksum = _sha256(payload)
    stamp = pd.Timestamp(retrieved_at).strftime("%Y%m%dT%H%M%SZ")
    path = data_root / "raw" / "thermosphere" / "ancillary" / "live" / f"{name}-{stamp}-{checksum[:12]}.json"
    _atomic_bytes(path, payload)
    return {
        "source_url": url,
        "raw_file": str(path),
        "checksum_sha256": checksum,
        "retrieved_at_utc": retrieved_at,
    }


def _parse_noaa_ap(payload: bytes, issuance: pd.Timestamp) -> tuple[list[float], dict[str, Any]]:
    rows = json.loads(payload)
    frame = pd.DataFrame(rows)
    if frame.empty or "time_tag" not in frame or "a_running" not in frame:
        raise ValueError("NOAA planetary K product lacks time_tag/a_running")
    frame["timestamp_utc"] = pd.to_datetime(frame["time_tag"], utc=True, errors="coerce")
    frame["ap"] = pd.to_numeric(frame["a_running"], errors="coerce")
    frame = frame.dropna(subset=["timestamp_utc", "ap"])
    frame = frame[(frame["timestamp_utc"] <= issuance) & (frame["ap"] >= 0)].sort_values("timestamp_utc")
    if len(frame) < 20:
        raise ValueError("NOAA planetary a history is too short for the seven-element MSIS input")
    current = frame.iloc[-1]
    values = frame["ap"].to_numpy(float)
    ap_vector = [
        float(frame[frame["timestamp_utc"].dt.floor("D") == current["timestamp_utc"].floor("D")]["ap"].mean()),
        float(values[-1]),
        float(values[-2]),
        float(values[-3]),
        float(values[-4]),
        float(np.mean(values[-12:-4])),
        float(np.mean(values[-20:-12])),
    ]
    return ap_vector, {
        "latest_ap_time_utc": _iso(current["timestamp_utc"]),
        "latest_kp": float(current["Kp"]) if "Kp" in current and pd.notna(current["Kp"]) else None,
        "daily_ap_method": "mean of current UTC day's available NOAA three-hour a_running values",
        "storm_history_method": "NOAA a_running: current, -3h, -6h, -9h, means at 12-33h and 36-57h",
    }


def _parse_noaa_previous_day_f107(payload: bytes, issuance: pd.Timestamp) -> tuple[float, dict[str, Any]]:
    rows = json.loads(payload)
    frame = pd.DataFrame(rows)
    if frame.empty or "time_tag" not in frame or "flux" not in frame:
        raise ValueError("NOAA F10.7 product lacks time_tag/flux")
    frame["timestamp_utc"] = pd.to_datetime(frame["time_tag"], utc=True, errors="coerce")
    frame["f107"] = pd.to_numeric(frame["flux"], errors="coerce")
    target_day = issuance.floor("D") - pd.Timedelta(days=1)
    day = frame[
        (frame["timestamp_utc"].dt.floor("D") == target_day)
        & frame["f107"].between(1, 400)
    ].copy()
    if day.empty:
        raise ValueError("NOAA F10.7 product has no previous-day observation")
    noon = day[day.get("reporting_schedule", pd.Series(index=day.index, dtype=str)).astype(str).str.lower().eq("noon")]
    selected = (noon if not noon.empty else day).sort_values("timestamp_utc").iloc[-1]
    return float(selected["f107"]), {
        "f107_time_utc": _iso(selected["timestamp_utc"]),
        "reporting_schedule": selected.get("reporting_schedule"),
        "method": "previous UTC day NOAA F10.7; noon record preferred",
    }


def prepare_live_atmosphere_forcing(
    *,
    data_root: str | Path = "data",
    refresh_omni2: bool = True,
) -> dict[str, Any]:
    """Snapshot explicit official F10.7/F10.7a/Ap before collecting trajectory."""

    root = Path(data_root).resolve()
    f107_bytes = _fetch_official_json(NOAA_F107_URL)
    kp_bytes = _fetch_official_json(NOAA_KP_URL)
    retrieved = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    issuance = pd.Timestamp(retrieved)
    f107, f107_metadata = _parse_noaa_previous_day_f107(f107_bytes, issuance)
    ap, ap_metadata = _parse_noaa_ap(kp_bytes, issuance)
    omni_forcing, omni_snapshot = load_omni2_forcing(
        issuance - pd.Timedelta(days=7),
        issuance + pd.Timedelta(minutes=1),
        data_root=root,
        refresh=refresh_omni2,
        f107a_mode="trailing_81_day",
    )
    usable_f107a = omni_forcing[
        (pd.to_datetime(omni_forcing["forcing_time_utc"], utc=True) <= issuance)
        & pd.to_numeric(omni_forcing["f107a_sfu"], errors="coerce").notna()
    ]
    if usable_f107a.empty:
        raise ValueError("NASA OMNI2 snapshot has no causal trailing 81-day F10.7 mean")
    latest = usable_f107a.iloc[-1]
    f107a_time = pd.Timestamp(latest["forcing_time_utc"])
    age_days = (issuance - f107a_time).total_seconds() / 86_400.0
    if age_days > 7:
        raise ValueError(f"NASA OMNI2 trailing F10.7a is stale by {age_days:.1f} days")
    raw_sources = {
        "noaa_f107": _save_live_raw(root, "noaa-f107", NOAA_F107_URL, f107_bytes, retrieved),
        "noaa_planetary_k": _save_live_raw(root, "noaa-kp", NOAA_KP_URL, kp_bytes, retrieved),
    }
    return {
        "schema_version": LIVE_ANCILLARY_SCHEMA_VERSION,
        "retrieved_at_utc": retrieved,
        "f107_sfu": f107,
        "f107a_sfu": float(latest["f107a_sfu"]),
        "ap": ap,
        "f107_metadata": f107_metadata,
        "f107a_metadata": {
            "source": "NASA SPDF OMNI2 hourly",
            "forcing_time_utc": _iso(f107a_time),
            "age_days": age_days,
            "method": "causal trailing 81-day mean ending at D-1 for experimental forecast and multi-year training",
            "snapshot": omni_snapshot.to_dict(),
        },
        "ap_metadata": ap_metadata,
        "raw_sources": raw_sources,
        "availability_class": "available_at_issuance",
    }


def collect_live_context(
    *,
    group: str = "stations",
    norad_id: str | None = None,
    horizon_minutes: int = 180,
    cadence_minutes: int = 5,
    timeout_seconds: float = 60.0,
) -> dict[str, Any]:
    command = [
        "node", "--import", "./scripts/test-register.mjs",
        "scripts/collect-leo-live-context.mts",
        "--group", "weather" if group == "weather" else "stations",
        "--horizon-minutes", str(horizon_minutes),
        "--cadence-minutes", str(cadence_minutes),
        "--history-hours", "13",
    ]
    if norad_id:
        command.extend(["--norad-id", str(norad_id)])
    result = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"live context collector failed: {result.stderr.strip() or result.stdout.strip()}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"live context collector did not return JSON: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != "leo-live-context-v1":
        raise ValueError("live context collector returned an unsupported contract")
    return payload


def find_latest_m3_artifact(model_root: str | Path) -> Path:
    root = Path(model_root).resolve()
    candidates = [
        path for path in root.glob("*/heliosat_mru_ml_arrival/m3.joblib")
        if path.is_file()
    ]
    if not candidates:
        raise FileNotFoundError(
            "no strict versioned MRU+ML mission-agnostic M3 artifact is available"
        )
    eligible: list[Path] = []
    for path in candidates:
        sidecar = path.with_suffix(path.suffix + ".metadata.json")
        try:
            metadata = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        features = {str(value) for value in metadata.get("feature_columns") or []}
        if (
            metadata.get("deployable") is True
            and metadata.get("experiment_mode") == "heliosat_mru_ml_arrival"
            and not features.intersection({"mission", "spacecraft_id", "spacecraft_key"})
        ):
            eligible.append(path)
    if not eligible:
        raise FileNotFoundError(
            "strict MRU+ML M3 artifacts exist, but none proves deployable identity-free features"
        )
    return max(eligible, key=lambda path: path.stat().st_mtime)


def _trajectory_frame(context: Mapping[str, Any]) -> pd.DataFrame:
    trajectory = context.get("trajectory")
    points = trajectory.get("points") if isinstance(trajectory, Mapping) else None
    if not isinstance(points, list) or not points:
        raise ValueError("real future TLE trajectory is unavailable")
    selected = (context.get("selector") or {}).get("selected_norad_id")
    if not selected:
        raise ValueError("trajectory has no selected NORAD identifier")
    records: list[dict[str, Any]] = []
    for point in points:
        if not isinstance(point, Mapping):
            continue
        position = point.get("position_km")
        velocity = point.get("velocity_km_s")
        if not isinstance(position, Mapping) or not isinstance(velocity, Mapping):
            continue
        try:
            position_m = [float(position[axis]) * 1_000 for axis in ("x", "y", "z")]
            velocity_m_s = [float(velocity[axis]) * 1_000 for axis in ("x", "y", "z")]
        except (KeyError, TypeError, ValueError):
            continue
        records.append({
            "timestamp_utc": point.get("timestamp_utc"),
            "mission": "Selected TLE object",
            "spacecraft_id": str(selected),
            "source_product": "CelesTrak TLE / SGP4",
            "latitude_deg": point.get("latitude_deg"),
            "longitude_deg": point.get("longitude_deg"),
            "altitude_km": point.get("altitude_km"),
            "local_solar_time_h": point.get("local_solar_time_h"),
            "rho_obs_kg_m3": np.nan,
            "position_x_m": position_m[0],
            "position_y_m": position_m[1],
            "position_z_m": position_m[2],
            "velocity_x_m_s": velocity_m_s[0],
            "velocity_y_m_s": velocity_m_s[1],
            "velocity_z_m_s": velocity_m_s[2],
        })
    frame = pd.DataFrame(records)
    if frame.empty:
        raise ValueError("real future TLE trajectory contains no complete state vectors")
    frame["timestamp_utc"] = pd.to_datetime(frame["timestamp_utc"], utc=True, errors="coerce")
    frame = frame.dropna(subset=["timestamp_utc"]).sort_values("timestamp_utc").reset_index(drop=True)
    delta_lat = pd.to_numeric(frame["latitude_deg"], errors="coerce").diff()
    frame["orbit_direction"] = np.select(
        [delta_lat > 0, delta_lat < 0], ["ascending", "descending"], default="unknown"
    )
    return frame


def _resample_live_driver_source(source: pd.DataFrame) -> pd.DataFrame:
    """Match the five-minute OMNI cadence used by the fitted M3 artifact."""

    work = source.copy()
    work["source_measurement_time_l1_utc"] = pd.to_datetime(
        work.get("source_measurement_time_l1_utc"), utc=True, errors="coerce"
    )
    work["available_at_utc"] = pd.to_datetime(
        work.get("available_at_utc"), utc=True, errors="coerce"
    )
    work = work.dropna(
        subset=["source_measurement_time_l1_utc", "available_at_utc"]
    ).sort_values("source_measurement_time_l1_utc")
    if work.empty:
        raise ValueError("no timestamp-valid live L1 samples are available")
    work["_five_minute"] = work["source_measurement_time_l1_utc"].dt.floor("5min")
    numeric_columns = [
        column for column in (
            "mru_distance_km", "vsw_km_s", "np_cm3", "bx_gsm_nt",
            "by_gsm_nt", "bz_gsm_nt", "bmag_nt", "sc_x_re", "sc_y_re",
            "sc_z_re", "bsn_x_re",
        ) if column in work.columns
    ]
    records: list[dict[str, Any]] = []
    for _, group in work.groupby("_five_minute", sort=True):
        record: dict[str, Any] = {
            # A bin is not available before its final contributing sample.
            "source_measurement_time_l1_utc": group["source_measurement_time_l1_utc"].max(),
            "available_at_utc": group["available_at_utc"].max(),
            "source_label": group["source_label"].dropna().iloc[-1]
            if "source_label" in group and group["source_label"].notna().any()
            else None,
            "evidence_class": "experimental_forecast",
            "native_samples_in_five_minute_bin": int(len(group)),
        }
        for column in numeric_columns:
            numeric = pd.to_numeric(group[column], errors="coerce")
            record[column] = float(numeric.median()) if numeric.notna().any() else np.nan
        records.append(record)
    return pd.DataFrame(records)


def _build_live_driver_timeline(context: Mapping[str, Any], trajectory: pd.DataFrame) -> tuple[pd.DataFrame, pd.Timestamp]:
    drivers = context.get("l1_drivers")
    if not isinstance(drivers, list) or not drivers:
        raise ValueError("no real already-measured L1 parcel history is available")
    source = _resample_live_driver_source(pd.DataFrame(drivers))
    issuance = pd.Timestamp(context["generated_at_utc"])
    source_times = pd.to_datetime(source["source_measurement_time_l1_utc"], utc=True)
    history_hours = (source_times.max() - source_times.min()).total_seconds() / 3_600.0
    latest_age_minutes = (issuance - source_times.max()).total_seconds() / 60.0
    if history_hours < 12.0:
        raise ValueError(
            f"live L1 history covers only {history_hours:.2f} h; M3 requires a complete 12 h causal window"
        )
    if latest_age_minutes < -1 or latest_age_minutes > 15:
        raise ValueError(
            f"latest live L1 sample age is {latest_age_minutes:.1f} min; a fresh issuance-safe history is required"
        )
    cadence = source_times.sort_values().diff().dropna().dt.total_seconds().median()
    if pd.isna(cadence) or not 240 <= float(cadence) <= 360:
        raise ValueError("live L1 history does not satisfy the five-minute M3 cadence contract")
    confirmed, _ = build_heliosat_predicted_timeline(source)
    if confirmed.empty:
        raise ValueError("no L1 parcel can be propagated to the Earth bow shock")
    confirmed["forcing_mode"] = "confirmed_inbound"
    confirmed["evidence_class"] = "experimental_forecast"
    last_confirmed = confirmed["arrival_time_bow_shock_utc"].max()
    last = confirmed.iloc[-1].copy()
    extension_rows: list[pd.Series] = []
    for timestamp in trajectory["timestamp_utc"]:
        if timestamp <= last_confirmed:
            continue
        row = last.copy()
        row["arrival_time_bow_shock_utc"] = timestamp
        row["available_at_utc"] = issuance
        row["issued_at_utc"] = issuance
        row["arrival_model"] = "persistence_assumption_beyond_confirmed_inbound_queue"
        row["forcing_mode"] = "assumption_extension"
        extension_rows.append(row)
    timeline = pd.concat(
        [confirmed, pd.DataFrame(extension_rows)], ignore_index=True, sort=False
    ).sort_values("arrival_time_bow_shock_utc").drop_duplicates(
        "arrival_time_bow_shock_utc", keep="last"
    ).reset_index(drop=True)
    assert_causal_timeline(timeline)
    return add_causal_rolling_features(timeline), last_confirmed


def build_forecast_snapshot(
    context: Mapping[str, Any],
    ancillary: Mapping[str, Any],
    *,
    model_path: str | Path,
    acknowledge_research_license: bool = False,
    scenario_id: str = "nominal",
) -> dict[str, Any]:
    if not research_license_enabled(acknowledge_research_license):
        raise PermissionError(
            "NRLMSIS internal-research acknowledgement is required; this is not commercial authorization"
        )
    trajectory = _trajectory_frame(context)
    issuance = pd.Timestamp(context["generated_at_utc"])
    baseline = PymsisBaseline(allow_research_use=True)
    inputs = [
        AtmosphereInput(
            timestamp_utc=row.timestamp_utc,
            latitude_deg=row.latitude_deg,
            longitude_deg=row.longitude_deg,
            altitude_km=row.altitude_km,
            local_solar_time_h=row.local_solar_time_h,
            f107_sfu=float(ancillary["f107_sfu"]),
            f107a_sfu=float(ancillary["f107a_sfu"]),
            ap=list(ancillary["ap"]),
            ancillary_source="NOAA SWPC F10.7/Kp plus NASA SPDF OMNI2 trailing F10.7a",
            ancillary_version=LIVE_ANCILLARY_SCHEMA_VERSION,
            ancillary_available_at_utc=ancillary["retrieved_at_utc"],
        )
        for row in trajectory.itertuples(index=False)
    ]
    results = baseline.predict_many(inputs)
    trajectory["rho_baseline_kg_m3"] = [result.rho_baseline_kg_m3 for result in results]
    if not all(result.baseline_input_status == "ok" for result in results):
        statuses = sorted({result.baseline_input_status for result in results})
        raise RuntimeError(f"live atmosphere baseline is incomplete: {statuses}")
    trajectory["baseline_model_name"] = baseline.model_name
    trajectory["baseline_model_version"] = baseline.model_version
    trajectory["f107_sfu"] = float(ancillary["f107_sfu"])
    trajectory["f107a_sfu"] = float(ancillary["f107a_sfu"])
    trajectory["forecast_issuance_time_utc"] = issuance
    timeline, last_confirmed = _build_live_driver_timeline(context, trajectory)
    features, feature_metadata = build_feature_dataset(
        trajectory,
        timeline,
        experiment_mode=HELIOSAT_PREDICTED_ARRIVAL,
        issuance_time_column="forecast_issuance_time_utc",
        tolerance="15min",
    )
    payload = load_model_artifact(model_path)
    point_prediction = predict_density_from_artifact(payload, features)
    if not np.isfinite(point_prediction).all():
        raise RuntimeError("M3 returned missing/non-physical density for at least one trajectory point")
    calibration_payload = payload.get("uncertainty_calibration")
    calibration_metrics = payload.get("uncertainty_test_metrics")
    calibration_available = isinstance(calibration_payload, Mapping)
    if calibration_available:
        intervals = apply_density_interval_calibration(
            point_prediction, calibration_payload  # type: ignore[arg-type]
        )
        rho_p10 = intervals["rho_p10_kg_m3"].to_numpy(float)
        rho_p50 = intervals["rho_p50_kg_m3"].to_numpy(float)
        rho_p90 = intervals["rho_p90_kg_m3"].to_numpy(float)
    else:
        rho_p10 = np.full(len(point_prediction), np.nan)
        rho_p50 = point_prediction
        rho_p90 = np.full(len(point_prediction), np.nan)
    features["rho_predicted_kg_m3"] = rho_p50
    scenario = get_spacecraft_scenario(scenario_id)  # type: ignore[arg-type]
    positions = features[["position_x_m", "position_y_m", "position_z_m"]].to_numpy(float)
    velocities = features[["velocity_x_m_s", "velocity_y_m_s", "velocity_z_m_s"]].to_numpy(float)
    comparison = compare_baseline_and_corrected_drag(
        features["timestamp_utc"], positions, velocities,
        features["rho_baseline_kg_m3"].to_numpy(float), rho_p50,
        scenario.parameters,
    )
    p10_drag = (
        calculate_drag_profile(
            features["timestamp_utc"], positions, velocities, rho_p10,
            scenario.parameters,
        ) if calibration_available else None
    )
    p90_drag = (
        calculate_drag_profile(
            features["timestamp_utc"], positions, velocities, rho_p90,
            scenario.parameters,
        ) if calibration_available else None
    )
    forcing_mode = np.where(
        features["timestamp_utc"] <= last_confirmed,
        "confirmed_inbound", "assumption_extension",
    )
    timeline_output: list[dict[str, Any]] = []
    forcing_output: list[dict[str, Any]] = []
    for index, row in features.reset_index(drop=True).iterrows():
        timeline_output.append({
            "timestamp_utc": _iso(row["timestamp_utc"]),
            "forcing_mode": str(forcing_mode[index]),
            "density_evidence_class": "experimental_forecast",
            "impact_evidence_class": "scenario",
            "rho_baseline_kg_m3": float(row["rho_baseline_kg_m3"]),
            "rho_p10_kg_m3": float(rho_p10[index]) if calibration_available else None,
            "rho_p50_kg_m3": float(rho_p50[index]),
            "rho_p90_kg_m3": float(rho_p90[index]) if calibration_available else None,
            "drag_acceleration_baseline_m_s2": float(comparison.baseline.drag_acceleration_m_s2[index]),
            "drag_acceleration_p10_m_s2": (
                float(p10_drag.drag_acceleration_m_s2[index]) if p10_drag is not None else None
            ),
            "drag_acceleration_p50_m_s2": float(comparison.corrected.drag_acceleration_m_s2[index]),
            "drag_acceleration_p90_m_s2": (
                float(p90_drag.drag_acceleration_m_s2[index]) if p90_drag is not None else None
            ),
            "cumulative_delta_v_baseline_m_s": float(comparison.baseline.impact.cumulative_delta_v_loss_m_s[index]),
            "cumulative_delta_v_p50_m_s": float(comparison.corrected.impact.cumulative_delta_v_loss_m_s[index]),
            "along_track_baseline_m": float(comparison.baseline.impact.along_track_displacement_m[index]),
            "along_track_p50_m": float(comparison.corrected.impact.along_track_displacement_m[index]),
            "altitude_km": float(row["altitude_km"]),
            "latitude_deg": float(row["latitude_deg"]),
            "longitude_deg": float(row["longitude_deg"]),
            "local_solar_time_h": float(row["local_solar_time_h"]),
        })
        forcing_output.append({
            "arrival_time_bow_shock_utc": _iso(row["timestamp_utc"]),
            "forcing_mode": str(forcing_mode[index]),
            "evidence_class": "experimental_forecast",
            "speed_km_s": _finite_or_none(row.get("vsw_km_s")),
            "bz_gsm_nt": _finite_or_none(row.get("bz_gsm_nt")),
            "dynamic_pressure_npa": _finite_or_none(row.get("pdyn_npa")),
            "em_mv_m": _finite_or_none(row.get("em_mv_m")),
            "newell_coupling": _finite_or_none(row.get("newell_coupling")),
        })
    split = payload.get("split") if isinstance(payload.get("split"), Mapping) else {}
    training = split.get("train") if isinstance(split, Mapping) else {}
    domain = payload.get("validated_domain") if isinstance(payload.get("validated_domain"), Mapping) else {}
    first = timeline_output[0]
    final = timeline_output[-1]
    warnings = [
        "Research model, not operational.",
        *([] if calibration_available else [
            "p10/p90 are unavailable because forecast uncertainty has not been calibrated; only p50 is emitted."
        ]),
        "Beyond the confirmed inbound L1 queue, solar-wind drivers use explicit persistence.",
        "Live and multi-year F10.7a use the causal 81-day mean ending at the previous UTC day.",
        "F10.7, trailing F10.7a and Ap are held constant over this short forecast horizon from values available at issuance.",
        "Generic drag scenario; no mass, area or Cd was inferred from the selected TLE.",
    ]
    context_warnings = context.get("warnings")
    if isinstance(context_warnings, list):
        warnings.extend(str(item) for item in context_warnings if isinstance(item, str) and item)
    altitude_min = domain.get("altitude_min_km") if isinstance(domain, Mapping) else None
    altitude_max = domain.get("altitude_max_km") if isinstance(domain, Mapping) else None
    if altitude_min is not None and features["altitude_km"].min() < float(altitude_min):
        warnings.append("Trajectory is below the validated pilot altitude range; output is out of distribution.")
    if altitude_max is not None and features["altitude_km"].max() > float(altitude_max):
        warnings.append("Trajectory is above the validated pilot altitude range; output is out of distribution.")
    categorical_levels = domain.get("categorical_feature_levels") if isinstance(domain, Mapping) else {}
    category_violations: list[str] = []
    if isinstance(categorical_levels, Mapping):
        for column, allowed in categorical_levels.items():
            if column not in features or not isinstance(allowed, list):
                continue
            observed = set(features[column].dropna().astype(str).unique())
            unknown = sorted(observed - set(str(item) for item in allowed))
            if unknown:
                category_violations.append(f"{column}: {', '.join(unknown[:3])}")
    numeric_ranges = domain.get("numeric_feature_ranges") if isinstance(domain, Mapping) else {}
    numeric_violations: list[str] = []
    if isinstance(numeric_ranges, Mapping):
        for column, limits in numeric_ranges.items():
            if column not in features or not isinstance(limits, Mapping):
                continue
            values = pd.to_numeric(features[column], errors="coerce").dropna()
            lower = _finite_or_none(limits.get("min"))
            upper = _finite_or_none(limits.get("max"))
            if values.empty or lower is None or upper is None:
                continue
            if float(values.min()) < lower or float(values.max()) > upper:
                numeric_violations.append(str(column))
    if category_violations:
        warnings.append(
            "Live categorical features were not represented in training ("
            + "; ".join(category_violations)
            + "); output is out of distribution."
        )
    if numeric_violations:
        warnings.append(
            f"{len(numeric_violations)} live numeric feature(s) exceed the training range "
            f"({', '.join(numeric_violations[:8])}); output is out of distribution."
        )
    model_path_obj = Path(model_path).resolve()
    try:
        model_reference = model_path_obj.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        model_reference = str(model_path_obj)
    confirmed_forcing = [
        point for point in forcing_output if point["forcing_mode"] == "confirmed_inbound"
    ]
    assumed_forcing = [
        point for point in forcing_output if point["forcing_mode"] == "assumption_extension"
    ]
    health = context.get("data_health") if isinstance(context.get("data_health"), Mapping) else {}
    l1_freshness = health.get("l1_freshness") if isinstance(health, Mapping) else None
    forcing_status = "available" if l1_freshness == "fresh" else "partial"
    trajectory_contract = context.get("trajectory")
    if not isinstance(trajectory_contract, Mapping):
        raise ValueError("live context omitted its versioned trajectory contract")
    return {
        "schema_version": FORECAST_SCHEMA_VERSION,
        "forecast_mode": "experimental",
        "generated_at_utc": _iso(issuance),
        "selector": context["selector"],
        "model": {
            "status": "available",
            "version": payload.get("model_version"),
            "artifact": model_reference,
            "training_range": {
                "start_utc": training.get("start_utc"),
                "end_utc": training.get("stop_utc"),
            } if isinstance(training, Mapping) else None,
            "uncertainty": ({
                "status": "calibrated",
                "method": calibration_payload.get("method"),
                "model_version": payload.get("model_version"),
                "calibration_start_utc": calibration_payload.get("calibration_start_utc"),
                "calibration_end_utc": calibration_payload.get("calibration_stop_utc"),
                "sample_count": calibration_payload.get("calibration_rows"),
                "nominal_coverage": (
                    calibration_metrics.get("central_interval_nominal_coverage")
                    if isinstance(calibration_metrics, Mapping) else None
                ),
                "empirical_coverage": (
                    calibration_metrics.get("central_interval_empirical_coverage")
                    if isinstance(calibration_metrics, Mapping) else None
                ),
            } if calibration_available else {
                "status": "uncalibrated",
                "method": None,
                "model_version": payload.get("model_version"),
            }),
        },
        "baseline": {
            "status": "available",
            "model_name": baseline.model_name,
            "model_version": baseline.model_version,
            "licensing_status": "internal research acknowledgement; commercial use unresolved",
        },
        "validated_domain": {
            "altitude_min_km": altitude_min,
            "altitude_max_km": altitude_max,
            "missions": domain.get("missions", []) if isinstance(domain, Mapping) else [],
            "spacecraft": domain.get("spacecraft", []) if isinstance(domain, Mapping) else [],
            "mission_category_validated": not category_violations,
            "feature_range_violations": numeric_violations,
        },
        "spacecraft_parameters": {
            "id": scenario.id,
            "label": scenario.label,
            "evidence_class": "scenario",
            "direct_ballistic_coefficient_m2_kg": scenario.parameters.resolved_ballistic_coefficient_m2_kg,
            "mass_kg": None,
            "reference_area_m2": None,
            "drag_coefficient": None,
            "attitude_mode": "generic sensitivity scenario",
            "parameter_source": scenario.parameters.parameter_source,
            "is_real_satellite_property": False,
        },
        # Trajectory, forcing and density are one issuance-atomic context.  The
        # API must never combine this timeline with a later orbit/L1 request.
        "trajectory": trajectory_contract,
        "forcing": {
            "source_status": forcing_status,
            "l1_sample_time_utc": health.get("l1_latest_sample_utc") if isinstance(health, Mapping) else None,
            "arrival_model": "HelioSat MRU ballistic propagation to the Earth bow-shock nose",
            "confirmed_inbound": {
                "start_utc": confirmed_forcing[0]["arrival_time_bow_shock_utc"] if confirmed_forcing else None,
                "end_utc": confirmed_forcing[-1]["arrival_time_bow_shock_utc"] if confirmed_forcing else None,
            },
            "assumption_extension": {
                "start_utc": assumed_forcing[0]["arrival_time_bow_shock_utc"] if assumed_forcing else None,
                "end_utc": assumed_forcing[-1]["arrival_time_bow_shock_utc"] if assumed_forcing else None,
                "policy": "Persistence of the last propagated physical driver; no new L1 knowledge beyond the confirmed inbound queue.",
            },
            "timeline": forcing_output,
            "warnings": [
                *(str(item) for item in context_warnings if isinstance(item, str) and item)
            ] if isinstance(context_warnings, list) else [],
        },
        "timeline": timeline_output,
        "summary": {
            "rho_baseline_kg_m3": first["rho_baseline_kg_m3"],
            "rho_p50_kg_m3": first["rho_p50_kg_m3"],
            "rho_p10_kg_m3": first["rho_p10_kg_m3"],
            "rho_p90_kg_m3": first["rho_p90_kg_m3"],
            "density_enhancement": first["rho_p50_kg_m3"] / first["rho_baseline_kg_m3"],
            "drag_acceleration_p50_m_s2": first["drag_acceleration_p50_m_s2"],
            "cumulative_delta_v_m_s": final["cumulative_delta_v_p50_m_s"],
            "along_track_estimate_m": final["along_track_p50_m"],
            "expected_onset_utc": None,
            "expected_peak_utc": None,
            "expected_recovery_utc": None,
            "forecast_confidence": (
                "held-out calibrated p10/p50/p90; experimental research only"
                if calibration_available
                else "uncalibrated point forecast; p10/p90 unavailable"
            ),
        },
        "provenance": {
            "live_context": context.get("data_health"),
            "atmosphere_forcing": ancillary,
            "feature_dataset": feature_metadata.to_dict(),
            "confirmed_inbound_end_utc": _iso(last_confirmed),
        },
        "warnings": warnings,
    }


def generate_live_forecast_snapshot(
    *,
    data_root: str | Path = "data",
    model_root: str | Path = "data/model-runs/leo-density",
    group: str = "stations",
    norad_id: str | None = None,
    horizon_minutes: int = 180,
    cadence_minutes: int = 5,
    scenario_id: str = "nominal",
    acknowledge_research_license: bool = False,
    refresh_omni2: bool = True,
) -> dict[str, Any]:
    ancillary = prepare_live_atmosphere_forcing(
        data_root=data_root, refresh_omni2=refresh_omni2
    )
    context = collect_live_context(
        group=group, norad_id=norad_id, horizon_minutes=horizon_minutes,
        cadence_minutes=cadence_minutes,
    )
    model_path = find_latest_m3_artifact(model_root)
    snapshot = build_forecast_snapshot(
        context,
        ancillary,
        model_path=model_path,
        acknowledge_research_license=acknowledge_research_license,
        scenario_id=scenario_id,
    )
    root = Path(model_root).resolve()
    run_directory = model_path.parent.parent
    run_path = run_directory / "forecast-latest.v1.json"
    root_path = root / "forecast-latest.v1.json"
    _atomic_json(run_path, snapshot)
    _atomic_json(root_path, snapshot)
    return {
        "status": "completed",
        "snapshot": str(run_path),
        "root_alias": str(root_path),
        "selected_norad_id": snapshot["selector"]["selected_norad_id"],
        "generated_at_utc": snapshot["generated_at_utc"],
        "timeline_rows": len(snapshot["timeline"]),
        "warnings": snapshot["warnings"],
    }


__all__ = [
    "LIVE_ANCILLARY_SCHEMA_VERSION",
    "build_forecast_snapshot",
    "collect_live_context",
    "find_latest_m3_artifact",
    "generate_live_forecast_snapshot",
    "prepare_live_atmosphere_forcing",
]
