"""Causal solar-wind driver timelines for LEO density studies.

Two experiment modes are intentionally represented by different constants and
different builders:

``reference_aligned``
    Retrospective OMNI bow-shock alignment.  This isolates thermospheric
    response skill but is not a deployable forecast input.

``heliosat_predicted_arrival``
    The MRU bow-shock arrival used by HelioSat, optionally corrected by the
    repository's existing arrival-residual artifact when that artifact and all
    required features are present.

The merge helper enforces two distinct causal clocks for every joined value:
the parcel must have arrived by the forecast target time, and its upstream
measurement must have been available at the forecast issuance time.  Keeping
those clocks separate is essential for using already-measured inbound parcels
in a future LEO forecast.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Literal, Mapping, Sequence

import numpy as np
import pandas as pd

REFERENCE_ALIGNED = "reference_aligned"
# Explicit study modes.  The legacy name remains accepted so existing pilot
# artifacts and callers keep working, but new comparisons should use the two
# unambiguous HelioSat modes below.
HELIOSAT_MRU_ARRIVAL = "heliosat_mru_arrival"
HELIOSAT_MRU_ML_ARRIVAL = "heliosat_mru_ml_arrival"
HELIOSAT_PREDICTED_ARRIVAL = "heliosat_predicted_arrival"
DriverMode = Literal[
    "reference_aligned",
    "heliosat_mru_arrival",
    "heliosat_mru_ml_arrival",
    "heliosat_predicted_arrival",
]

REFERENCE_LABEL = "Reference aligned response study"
HELIOSAT_LABEL = "HelioSat predicted-arrival retrospective replay"
HELIOSAT_MRU_LABEL = "HelioSat MRU-arrival retrospective replay"
HELIOSAT_MRU_ML_LABEL = "HelioSat MRU plus ML-arrival retrospective replay"

RE_KM = 6_371.2
NOMINAL_L1_X_KM = 1_500_000.0
BOW_SHOCK_NOSE_X_RE = 13.5
NOMINAL_BOW_SHOCK_DISTANCE_KM = NOMINAL_L1_X_KM - BOW_SHOCK_NOSE_X_RE * RE_KM

PDYN_COEFFICIENT = 1.67262192369e-6
EARTH_RADIUS_M = 6_371_200.0
MU0 = 4.0e-7 * math.pi

WINDOWS: tuple[tuple[str, str], ...] = (
    ("15m", "15min"),
    ("30m", "30min"),
    ("1h", "1h"),
    ("3h", "3h"),
    ("6h", "6h"),
    ("12h", "12h"),
)

DRIVER_VALUE_COLUMNS: tuple[str, ...] = (
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
)

ROLLING_VALUE_COLUMNS: tuple[str, ...] = (
    "vsw_km_s",
    "np_cm3",
    "bz_gsm_nt",
    "pdyn_npa",
    "em_mv_m",
    "newell_coupling",
)

_ALIASES: dict[str, tuple[str, ...]] = {
    "vsw_km_s": ("vsw_km_s", "speed_km_s", "speed"),
    "np_cm3": ("np_cm3", "density_p_cc", "density"),
    "bx_gsm_nt": ("bx_gsm_nt", "bx_nt", "bx"),
    "by_gsm_nt": ("by_gsm_nt", "by_nt", "by"),
    "bz_gsm_nt": ("bz_gsm_nt", "bz_nt", "bz"),
    "bmag_nt": ("bmag_nt", "bt_nt", "bt"),
}


@dataclass(frozen=True)
class TimelineBuildReport:
    mode: DriverMode
    study_label: str
    input_rows: int
    output_rows: int
    invalid_time_rows: int
    invalid_speed_rows: int
    ml_corrected_rows: int
    mru_fallback_rows: int
    start_utc: str | None
    end_utc: str | None
    missingness: dict[str, float]
    arrival_ml_status: str = "not_requested"
    arrival_ml_error: str | None = None
    strict_ml_rejected_rows: int = 0


def _utc_series(values: object) -> pd.Series:
    parsed = pd.to_datetime(values, utc=True, errors="coerce")
    # Pandas may preserve microsecond input resolution.  merge_asof requires
    # exactly matching dtypes, so normalize every causal key to UTC nanoseconds.
    return parsed.astype("datetime64[ns, UTC]")


def _numeric(frame: pd.DataFrame, aliases: Sequence[str]) -> pd.Series:
    for name in aliases:
        if name in frame.columns:
            return pd.to_numeric(frame[name], errors="coerce")
    return pd.Series(np.nan, index=frame.index, dtype=float)


def _optional_numeric(frame: pd.DataFrame, name: str, default: float = np.nan) -> pd.Series:
    """Return an index-aligned numeric series for an optional column."""

    if name not in frame.columns:
        return pd.Series(default, index=frame.index, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce")


def _normalise_driver_values(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    for canonical, aliases in _ALIASES.items():
        out[canonical] = _numeric(out, aliases)

    # Official OMNI flat files encode missing measurements as large positive
    # fill values.  Reject them before deriving any coupling proxy.
    out["vsw_km_s"] = out["vsw_km_s"].where(
        (out["vsw_km_s"] > 0) & (out["vsw_km_s"] < 90_000)
    )
    out["np_cm3"] = out["np_cm3"].where(
        (out["np_cm3"] >= 0) & (out["np_cm3"] < 999)
    )
    for column in ("bx_gsm_nt", "by_gsm_nt", "bz_gsm_nt", "bmag_nt"):
        out[column] = out[column].where(out[column].abs() < 9_999)

    # If magnitude is absent, derive it only when all three components exist.
    missing_bmag = out["bmag_nt"].isna()
    components = out[["bx_gsm_nt", "by_gsm_nt", "bz_gsm_nt"]]
    derived_bmag = np.sqrt((components**2).sum(axis=1, min_count=3))
    out.loc[missing_bmag, "bmag_nt"] = derived_bmag[missing_bmag]

    speed = out["vsw_km_s"].where(out["vsw_km_s"] > 0)
    density = out["np_cm3"].where(out["np_cm3"] >= 0)
    bz = out["bz_gsm_nt"]
    by = out["by_gsm_nt"]
    transverse = np.hypot(by, bz)
    clock_angle = np.arctan2(np.abs(by), bz)

    out["pdyn_npa"] = PDYN_COEFFICIENT * density * speed**2
    out["em_mv_m"] = speed * np.maximum(0.0, -bz) * 1e-3
    out["newell_coupling"] = (
        speed ** (4.0 / 3.0)
        * transverse ** (2.0 / 3.0)
        * np.sin(clock_angle / 2.0) ** (8.0 / 3.0)
    )
    # Akasofu epsilon in watts with l0=7 Re.  This is retained with its units
    # in the column name rather than exposed as an unlabeled proxy.
    out["epsilon_coupling_w"] = (
        speed * 1_000.0
        * (transverse * 1e-9) ** 2
        / MU0
        * (7.0 * EARTH_RADIUS_M) ** 2
        * np.sin(clock_angle / 2.0) ** 4
    )
    out["epsilon_coupling"] = out["epsilon_coupling_w"]
    return out


def _first_present_time(frame: pd.DataFrame, names: Sequence[str]) -> pd.Series:
    for name in names:
        if name in frame.columns:
            return _utc_series(frame[name])
    return pd.Series(pd.NaT, index=frame.index, dtype="datetime64[ns, UTC]")


def _source_measurement_time(frame: pd.DataFrame) -> pd.Series:
    explicit = _first_present_time(
        frame,
        ("source_measurement_time_l1_utc", "measurement_time_l1_utc", "source_time_utc"),
    )
    if explicit.notna().any():
        return explicit
    if "time" in frame.columns and "timeshift_s" in frame.columns:
        shift_seconds = pd.to_numeric(frame["timeshift_s"], errors="coerce")
        shift_seconds = shift_seconds.where((shift_seconds > 0) & (shift_seconds < 900_000))
        return _utc_series(frame["time"]) - pd.to_timedelta(shift_seconds, unit="s")
    return _first_present_time(frame, ("timestamp_utc", "time"))


def _availability_time(frame: pd.DataFrame, fallback: pd.Series) -> pd.Series:
    explicit = _first_present_time(
        frame,
        ("available_at_utc", "driver_available_at_utc", "source_available_at_utc", "issued_at_utc"),
    )
    return explicit.where(explicit.notna(), fallback)


def _reference_arrival_time(frame: pd.DataFrame) -> pd.Series:
    explicit = _first_present_time(
        frame,
        ("arrival_time_bow_shock_utc", "reference_arrival_time_utc", "time", "timestamp_utc"),
    )
    return explicit


def _load_current_arrival_uncertainty(metrics_path: Path | None) -> tuple[float | None, float | None]:
    if metrics_path is None or not metrics_path.exists():
        return None, None
    try:
        payload = json.loads(metrics_path.read_text(encoding="utf-8"))
        overall = payload.get("overall") or {}
        mru = float((overall.get("benchmark") or {}).get("maeMin"))
        ml = float((overall.get("ml") or {}).get("maeMin"))
        return (mru if math.isfinite(mru) else None, ml if math.isfinite(ml) else None)
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None, None


def _arrival_residual_predictions(
    frame: pd.DataFrame,
    source_time: pd.Series,
    mru_delay_min: pd.Series,
    model_path: Path | None,
) -> tuple[pd.Series, pd.Series, str | None]:
    """Run the existing arrival residual artifact in-process when possible."""

    residual = pd.Series(np.nan, index=frame.index, dtype=float)
    complete = pd.Series(False, index=frame.index, dtype=bool)
    if frame.empty:
        return residual, complete, None
    if model_path is None:
        return residual, complete, "arrival residual model path was not supplied"
    if not model_path.exists():
        return residual, complete, f"arrival residual model is missing: {model_path}"
    try:
        import joblib

        import sklearn

        from ml.arrival_residual.features import (
            FEATURE_NAMES,
            FEATURE_SCHEMA_VERSION,
            NOMINAL_BOW_SHOCK_X_RE,
            build_features,
        )
        from ml.arrival_residual.train import ARTIFACT_SCHEMA_VERSION

        payload = joblib.load(model_path)
        if not isinstance(payload, dict):
            raise ValueError("arrival artifact is not a versioned mapping")
        if payload.get("artifactSchemaVersion") != ARTIFACT_SCHEMA_VERSION:
            raise ValueError("unsupported arrival artifact schema")
        if payload.get("featureSchemaVersion") != FEATURE_SCHEMA_VERSION:
            raise ValueError("arrival feature schema does not match the runtime")
        if list(payload.get("featureNames") or []) != FEATURE_NAMES:
            raise ValueError("arrival artifact feature order does not match the runtime")
        if payload.get("sklearnVersion") != sklearn.__version__:
            raise ValueError(
                "arrival artifact sklearn version does not match the pinned runtime"
            )
        geometry = payload.get("benchmarkGeometry") or {}
        if (
            not isinstance(geometry, Mapping)
            or bool(geometry.get("referenceBsnXUsedAsFeature", True))
            or not math.isclose(
                float(geometry.get("bowShockNoseXRe", math.nan)),
                NOMINAL_BOW_SHOCK_X_RE,
            )
        ):
            raise ValueError("arrival artifact does not use the causal nominal geometry")
        estimator = payload.get("model")
        if estimator is None:
            raise ValueError("arrival artifact has no estimator")
        work = pd.DataFrame(index=frame.index)
        work["time"] = source_time
        for canonical, source in (
            ("speed_km_s", "vsw_km_s"),
            ("density_p_cc", "np_cm3"),
            ("bmag_nt", "bmag_nt"),
            ("bz_gsm_nt", "bz_gsm_nt"),
            ("by_gsm_nt", "by_gsm_nt"),
        ):
            work[canonical] = pd.to_numeric(frame[source], errors="coerce")
        for column in ("sc_x_re", "sc_y_re", "sc_z_re"):
            work[column] = _optional_numeric(frame, column)
        work["benchmark_bsn_x_re"] = NOMINAL_BOW_SHOCK_X_RE
        work["mru_delay_min"] = mru_delay_min
        work = work.loc[work["time"].notna()].sort_values("time")
        if work.empty:
            return residual, complete, None
        featured = build_features(work)
        matrix = featured[FEATURE_NAMES]
        valid = matrix.notna().all(axis=1) & np.isfinite(featured["mru_delay_min"])
        if valid.any():
            predicted = np.asarray(estimator.predict(matrix.loc[valid]), dtype=float)
            finite = np.isfinite(predicted)
            valid_indexes = matrix.index[valid]
            residual.loc[valid_indexes[finite]] = predicted[finite]
            complete.loc[valid_indexes[finite]] = True
    except Exception as exc:  # noqa: BLE001 - failure is surfaced to the report
        return (
            pd.Series(np.nan, index=frame.index, dtype=float),
            pd.Series(False, index=frame.index, dtype=bool),
            f"{type(exc).__name__}: {exc}",
        )
    return residual, complete, None


def _finalise_timeline(frame: pd.DataFrame, mode: DriverMode) -> tuple[pd.DataFrame, TimelineBuildReport]:
    input_rows = len(frame)
    out = frame.copy()
    out["arrival_time_bow_shock_utc"] = _utc_series(out["arrival_time_bow_shock_utc"])
    out["source_measurement_time_l1_utc"] = _utc_series(out["source_measurement_time_l1_utc"])
    out["available_at_utc"] = _utc_series(out["available_at_utc"])
    invalid_time = (
        out["arrival_time_bow_shock_utc"].isna()
        | out["source_measurement_time_l1_utc"].isna()
        | out["available_at_utc"].isna()
    )
    invalid_speed = ~np.isfinite(out["vsw_km_s"]) | (out["vsw_km_s"] <= 0)
    out = out.loc[~invalid_time & ~invalid_speed].copy()
    out = out.sort_values(["arrival_time_bow_shock_utc", "source_measurement_time_l1_utc"], kind="mergesort")
    out = out.drop_duplicates(
        subset=["arrival_time_bow_shock_utc", "source_measurement_time_l1_utc"], keep="last"
    ).reset_index(drop=True)
    assert_causal_timeline(out)
    study_label = {
        REFERENCE_ALIGNED: REFERENCE_LABEL,
        HELIOSAT_MRU_ARRIVAL: HELIOSAT_MRU_LABEL,
        HELIOSAT_MRU_ML_ARRIVAL: HELIOSAT_MRU_ML_LABEL,
        HELIOSAT_PREDICTED_ARRIVAL: HELIOSAT_LABEL,
    }[mode]
    out["experiment_mode"] = mode
    out["study_label"] = study_label
    out["feature_availability"] = (
        "retrospective_only" if mode == REFERENCE_ALIGNED else "available_at_issuance"
    )
    out["source_archive_evidence_class"] = "retrospective_replay"
    out["issuance_availability_assumption"] = (
        None
        if mode == REFERENCE_ALIGNED
        else "OMNI source measurement is treated as received at its measurement time; historical HelioSat reception timestamps are unavailable"
    )
    start = out["arrival_time_bow_shock_utc"].min() if not out.empty else None
    stop = out["arrival_time_bow_shock_utc"].max() if not out.empty else None
    missingness = {
        column: round(float(out[column].isna().mean()), 6)
        for column in DRIVER_VALUE_COLUMNS
        if column in out.columns
    }
    corrected = int(
        out["arrival_residual_ml_applied"].fillna(False).astype(bool).sum()
    ) if "arrival_residual_ml_applied" in out.columns else 0
    report = TimelineBuildReport(
        mode=mode,
        study_label=study_label,
        input_rows=input_rows,
        output_rows=len(out),
        invalid_time_rows=int(invalid_time.sum()),
        invalid_speed_rows=int((invalid_speed & ~invalid_time).sum()),
        ml_corrected_rows=corrected,
        mru_fallback_rows=(len(out) - corrected) if mode == HELIOSAT_PREDICTED_ARRIVAL else 0,
        start_utc=start.isoformat().replace("+00:00", "Z") if start is not None else None,
        end_utc=stop.isoformat().replace("+00:00", "Z") if stop is not None else None,
        missingness=missingness,
        arrival_ml_status=str(out.attrs.get("arrival_ml_status", "not_requested")),
        arrival_ml_error=(
            str(out.attrs["arrival_ml_error"])
            if out.attrs.get("arrival_ml_error") is not None else None
        ),
        strict_ml_rejected_rows=int(out.attrs.get("strict_ml_rejected_rows", 0)),
    )
    out.attrs["timeline_report"] = report
    return out, report


def build_reference_aligned_timeline(frame: pd.DataFrame) -> tuple[pd.DataFrame, TimelineBuildReport]:
    """Build the explicitly retrospective OMNI/reference-aligned timeline."""

    out = _normalise_driver_values(frame)
    source_time = _source_measurement_time(out)
    arrival_time = _reference_arrival_time(out)
    out["source_measurement_time_l1_utc"] = source_time
    out["arrival_time_bow_shock_utc"] = arrival_time
    # Reference alignment becomes physically usable at its bow-shock timestamp
    # for the response study, but is still labeled retrospective_only.
    out["available_at_utc"] = _availability_time(out, arrival_time)
    out["issued_at_utc"] = out["available_at_utc"]
    out["arrival_model"] = "omni_timeshift_reference"
    out["arrival_uncertainty_min"] = _optional_numeric(out, "arrival_uncertainty_min")
    out["arrival_residual_ml_applied"] = False
    out["distance_basis"] = "retrospective_reference_geometry"
    return _finalise_timeline(out, REFERENCE_ALIGNED)


def build_heliosat_predicted_timeline(
    frame: pd.DataFrame,
    *,
    arrival_model_path: str | Path | None = None,
    arrival_metrics_path: str | Path | None = None,
    nominal_distance_km: float = NOMINAL_BOW_SHOCK_DISTANCE_KM,
    residual_predictor: Callable[[pd.DataFrame], Sequence[float | None]] | None = None,
    strict_ml: bool = False,
    experiment_mode: DriverMode = HELIOSAT_PREDICTED_ARRIVAL,
) -> tuple[pd.DataFrame, TimelineBuildReport]:
    """Build MRU/ML arrivals from measurements that were available at L1.

    A missing or incomplete ML artifact falls back per row to MRU and records
    that fact.  It never substitutes a residual estimate.
    """

    out = _normalise_driver_values(frame)
    source_time = _source_measurement_time(out)
    availability = _availability_time(out, source_time)
    speed = out["vsw_km_s"]

    if experiment_mode not in {
        HELIOSAT_PREDICTED_ARRIVAL,
        HELIOSAT_MRU_ARRIVAL,
        HELIOSAT_MRU_ML_ARRIVAL,
    }:
        raise ValueError(f"invalid HelioSat arrival experiment mode: {experiment_mode!r}")
    if strict_ml and experiment_mode != HELIOSAT_MRU_ML_ARRIVAL:
        raise ValueError("strict_ml is reserved for the explicit MRU+ML study mode")

    sc_x_re = _optional_numeric(out, "sc_x_re")
    bsn_x_re = _optional_numeric(
        out, "bsn_x_re", BOW_SHOCK_NOSE_X_RE
    ).fillna(BOW_SHOCK_NOSE_X_RE)
    measured_distance = (sc_x_re - bsn_x_re) * RE_KM
    causal_nominal_geometry_distance = (sc_x_re - BOW_SHOCK_NOSE_X_RE) * RE_KM
    explicit_distance = _optional_numeric(out, "mru_distance_km")
    if experiment_mode == HELIOSAT_PREDICTED_ARRIVAL:
        # Legacy pilot replay retained only for reproducibility.
        distance = explicit_distance.where(
            explicit_distance > 0,
            measured_distance.where(measured_distance > 0, nominal_distance_km),
        )
        distance_basis = np.select(
            [explicit_distance > 0, measured_distance > 0],
            ["explicit_bow_shock_distance", "measured_sc_x_to_bow_shock"],
            default="nominal_l1_to_bow_shock",
        )
    else:
        # Headline MRU and MRU+ML use only causal/live-available geometry.
        distance = explicit_distance.where(
            explicit_distance > 0,
            causal_nominal_geometry_distance.where(
                causal_nominal_geometry_distance > 0, nominal_distance_km
            ),
        )
        distance_basis = np.select(
            [explicit_distance > 0, causal_nominal_geometry_distance > 0],
            [
                "explicit_causal_bow_shock_distance",
                "measured_sc_x_to_nominal_bow_shock",
            ],
            default="nominal_l1_to_bow_shock",
        )
    out["mru_distance_km"] = distance
    out["distance_basis"] = distance_basis
    mru_delay = distance / speed / 60.0

    residual = pd.Series(np.nan, index=out.index, dtype=float)
    ml_complete = pd.Series(False, index=out.index, dtype=bool)
    ml_error: str | None = None
    request_ml = experiment_mode != HELIOSAT_MRU_ARRIVAL
    if residual_predictor is not None and request_ml:
        try:
            supplied = pd.to_numeric(pd.Series(residual_predictor(out), index=out.index), errors="coerce")
            residual.loc[supplied.notna()] = supplied[supplied.notna()]
            ml_complete.loc[supplied.notna()] = True
        except Exception as exc:  # noqa: BLE001 - surfaced below
            ml_error = f"{type(exc).__name__}: {exc}"
    elif request_ml:
        residual, ml_complete, ml_error = _arrival_residual_predictions(
            out,
            source_time,
            mru_delay,
            Path(arrival_model_path) if arrival_model_path is not None else None,
        )

    candidate_delay = mru_delay + residual
    physically_valid_ml = (
        ml_complete
        & np.isfinite(residual)
        & np.isfinite(candidate_delay)
        & (candidate_delay > 0.0)
    )
    ml_complete = physically_valid_ml
    rejected_strict = (~ml_complete) if strict_ml else pd.Series(False, index=out.index)
    corrected_delay = mru_delay + residual.where(ml_complete, 0.0)
    if strict_ml:
        # Do not relabel an MRU fallback as MRU+ML.  Invalid/unavailable rows get
        # no arrival timestamp and are removed by the ordinary timeline checks.
        corrected_delay = corrected_delay.where(ml_complete)
    out["source_measurement_time_l1_utc"] = source_time
    out["available_at_utc"] = availability
    out["issued_at_utc"] = availability
    out["mru_delay_min"] = mru_delay
    out["arrival_residual_min"] = residual.where(ml_complete)
    out["arrival_residual_ml_applied"] = ml_complete
    out["arrival_time_bow_shock_utc"] = source_time + pd.to_timedelta(corrected_delay, unit="m")
    out["arrival_model"] = np.where(
        ml_complete,
        "mru_ballistic_plus_arrival_residual_ml",
        "mru_ballistic",
    )

    mru_uncertainty, ml_uncertainty = _load_current_arrival_uncertainty(
        Path(arrival_metrics_path) if arrival_metrics_path is not None else None
    )
    out["arrival_uncertainty_min"] = np.where(ml_complete, ml_uncertainty, mru_uncertainty)
    out.attrs["arrival_ml_status"] = (
        "not_requested" if not request_ml
        else "available" if bool(ml_complete.all())
        else "partial" if bool(ml_complete.any())
        else "unavailable"
    )
    out.attrs["arrival_ml_error"] = ml_error
    out.attrs["strict_ml_rejected_rows"] = int(rejected_strict.sum())
    return _finalise_timeline(out, experiment_mode)


def build_heliosat_mru_timeline(
    frame: pd.DataFrame,
    *,
    nominal_distance_km: float = NOMINAL_BOW_SHOCK_DISTANCE_KM,
) -> tuple[pd.DataFrame, TimelineBuildReport]:
    """Build the explicit MRU-only study timeline without loading ML."""

    return build_heliosat_predicted_timeline(
        frame,
        nominal_distance_km=nominal_distance_km,
        experiment_mode=HELIOSAT_MRU_ARRIVAL,
    )


def build_heliosat_mru_ml_timeline(
    frame: pd.DataFrame,
    *,
    arrival_model_path: str | Path | None = None,
    arrival_metrics_path: str | Path | None = None,
    nominal_distance_km: float = NOMINAL_BOW_SHOCK_DISTANCE_KM,
    residual_predictor: Callable[[pd.DataFrame], Sequence[float | None]] | None = None,
) -> tuple[pd.DataFrame, TimelineBuildReport]:
    """Build strict MRU+ML study arrivals; never substitute MRU-only rows."""

    return build_heliosat_predicted_timeline(
        frame,
        arrival_model_path=arrival_model_path,
        arrival_metrics_path=arrival_metrics_path,
        nominal_distance_km=nominal_distance_km,
        residual_predictor=residual_predictor,
        strict_ml=True,
        experiment_mode=HELIOSAT_MRU_ML_ARRIVAL,
    )


def driver_feature_name(column: str, statistic: str, window_label: str) -> str:
    return f"drv__{column}__{statistic}__{window_label}"


def add_causal_rolling_features(
    timeline: pd.DataFrame,
    *,
    windows: Iterable[tuple[str, str]] = WINDOWS,
    value_columns: Iterable[str] = ROLLING_VALUE_COLUMNS,
    max_integral_gap: str = "30min",
    expected_cadence: str = "5min",
) -> pd.DataFrame:
    """Add trailing statistics; every window contains current and past rows only."""

    if timeline.empty:
        return timeline.copy()
    assert_causal_timeline(timeline)
    out = timeline.sort_values("arrival_time_bow_shock_utc", kind="mergesort").reset_index(drop=True).copy()
    index = pd.DatetimeIndex(out["arrival_time_bow_shock_utc"])
    elapsed_hours = pd.Series((index.view("i8") - index.view("i8")[0]) / 3.6e12, index=index)
    dt_hours = pd.Series(index.to_series(index=index).diff().dt.total_seconds().to_numpy() / 3_600.0, index=index)
    max_gap_hours = pd.Timedelta(max_integral_gap).total_seconds() / 3_600.0
    expected_cadence_delta = pd.Timedelta(expected_cadence)
    if expected_cadence_delta <= pd.Timedelta(0):
        raise ValueError("expected_cadence must be positive")

    generated: list[str] = []
    feature_values: dict[str, np.ndarray] = {}
    for column in value_columns:
        if column not in out.columns:
            continue
        values = pd.Series(pd.to_numeric(out[column], errors="coerce").to_numpy(), index=index)
        interval_area = 0.5 * (values + values.shift(1)) * dt_hours
        interval_area = interval_area.where((dt_hours > 0) & (dt_hours <= max_gap_hours))
        for label, window in windows:
            rolling = values.rolling(window, closed="both", min_periods=1)
            count = rolling.count()
            mean = rolling.mean()
            minimum = rolling.min()
            maximum = rolling.max()
            std = rolling.std(ddof=0)

            # Least-squares slope per hour using only rolling sums.  Global
            # elapsed time is safe here because covariance is shift invariant.
            valid_elapsed = elapsed_hours.where(values.notna())
            roll_t = valid_elapsed.rolling(window, closed="both", min_periods=2)
            sum_t = roll_t.sum()
            sum_t2 = (valid_elapsed**2).rolling(window, closed="both", min_periods=2).sum()
            sum_y = rolling.sum()
            sum_ty = (valid_elapsed * values).rolling(window, closed="both", min_periods=2).sum()
            denominator = sum_t2 - (sum_t**2 / count)
            trend = (sum_ty - sum_t * sum_y / count) / denominator
            trend = trend.where((count >= 2) & (denominator.abs() > 1e-12))
            integral = interval_area.rolling(window, closed="both", min_periods=1).sum()
            expected_count = max(
                1.0,
                np.floor(pd.Timedelta(window) / expected_cadence_delta) + 1.0,
            )
            coverage = (count / expected_count).clip(upper=1.0)

            values_by_stat = {
                "mean": mean,
                "min": minimum,
                "max": maximum,
                "std": std,
                "trend_per_h": trend,
                "integral_h": integral,
                "count": count,
                "coverage_fraction": coverage,
            }
            for statistic, series in values_by_stat.items():
                name = driver_feature_name(column, statistic, label)
                feature_values[name] = series.to_numpy()
                generated.append(name)

    # The example threshold requested in the implementation plan: time since
    # the most recent downward crossing into Bz < -10 nT.
    if "bz_gsm_nt" in out.columns:
        bz = pd.to_numeric(out["bz_gsm_nt"], errors="coerce")
        below = bz < -10.0
        crossing = below & ~below.shift(1, fill_value=False)
        crossing_ns = pd.Series(np.where(crossing, index.view("i8"), np.nan)).ffill()
        elapsed = (index.view("i8") - crossing_ns.to_numpy()) / 6.0e10
        feature_values["time_since_bz_below_minus_10_min"] = np.where(
            crossing_ns.notna(), elapsed, np.nan
        )
        generated.append("time_since_bz_below_minus_10_min")

    if feature_values:
        out = pd.concat(
            [out, pd.DataFrame(feature_values, index=out.index)],
            axis=1,
        )

    out.attrs.update(timeline.attrs)
    out.attrs["causal_feature_columns"] = generated
    out.attrs["causal_windows"] = [label for label, _ in windows]
    out.attrs["integral_method"] = "trapezoid_right_endpoint; gaps over max_integral_gap excluded"
    out.attrs["coverage_definition"] = (
        f"valid count divided by full-window expected count at {expected_cadence_delta} cadence"
    )
    assert_no_future_rolling_rows(out)
    return out


def assert_causal_timeline(timeline: pd.DataFrame) -> None:
    required = {
        "arrival_time_bow_shock_utc",
        "source_measurement_time_l1_utc",
        "available_at_utc",
    }
    missing = required - set(timeline.columns)
    if missing:
        raise AssertionError(f"timeline missing causal column(s): {sorted(missing)}")
    arrival = _utc_series(timeline["arrival_time_bow_shock_utc"])
    source = _utc_series(timeline["source_measurement_time_l1_utc"])
    available = _utc_series(timeline["available_at_utc"])
    if (source > arrival).any():
        raise AssertionError("source measurement time occurs after bow-shock arrival")
    if (available < source).any():
        raise AssertionError("driver is marked available before its source measurement")
    if timeline.attrs.get("rolling_window_direction") == "forward":
        raise AssertionError("forward rolling windows are forbidden")


def assert_no_future_rolling_rows(timeline: pd.DataFrame) -> None:
    """Verify recorded causal bounds when supplied by a test or persisted set."""

    if "feature_window_end_utc" in timeline.columns:
        end = _utc_series(timeline["feature_window_end_utc"])
        arrival = _utc_series(timeline["arrival_time_bow_shock_utc"])
        if (end > arrival).any():
            raise AssertionError("a rolling feature window ends in the future")


def causal_backward_join(
    observations: pd.DataFrame,
    timeline: pd.DataFrame,
    *,
    observation_time_column: str = "timestamp_utc",
    issuance_time_column: str | None = None,
    tolerance: str | pd.Timedelta | None = "30min",
    suffix: str = "_driver",
) -> pd.DataFrame:
    """Join the latest physically arrived *and available* driver to each row."""

    if observation_time_column not in observations.columns:
        raise ValueError(f"missing observation timestamp column: {observation_time_column}")
    assert_causal_timeline(timeline)
    left = observations.copy()
    left["_observation_time"] = _utc_series(left[observation_time_column])
    if issuance_time_column is None:
        left["_issuance_time"] = left["_observation_time"]
    elif issuance_time_column not in left.columns:
        raise ValueError(f"missing issuance timestamp column: {issuance_time_column}")
    else:
        left["_issuance_time"] = _utc_series(left[issuance_time_column])
    left["_original_order"] = np.arange(len(left))
    invalid_left = left["_observation_time"].isna() | left["_issuance_time"].isna()

    right = timeline.copy()
    right["_driver_arrival_time"] = _utc_series(right["arrival_time_bow_shock_utc"])
    right["_driver_available_time"] = _utc_series(right["available_at_utc"])
    right = right.dropna(subset=["_driver_arrival_time", "_driver_available_time"]).sort_values(
        "_driver_arrival_time", kind="mergesort"
    )
    left_sorted = left.loc[~invalid_left].sort_values("_observation_time", kind="mergesort")

    overlap = set(left_sorted.columns) & set(right.columns)
    rename = {name: f"{name}{suffix}" for name in overlap}
    right = right.rename(columns=rename)
    arrival_name = rename.get("arrival_time_bow_shock_utc", "arrival_time_bow_shock_utc")
    available_name = rename.get("available_at_utc", "available_at_utc")
    if left_sorted.empty:
        merged = left_sorted.copy()
        for column in right.columns:
            if column not in merged.columns:
                merged[column] = pd.Series(dtype=right[column].dtype)
    else:
        merged = pd.merge_asof(
            left_sorted,
            right,
            left_on="_observation_time",
            right_on="_driver_arrival_time",
            direction="backward",
            tolerance=pd.Timedelta(tolerance) if tolerance is not None else None,
            allow_exact_matches=True,
        )
        # merge_asof enforces physical arrival.  Usually the selected driver
        # was measured at L1 earlier and is already available.  If publication
        # availability is later, walk backward to the newest row satisfying
        # the independent issuance-time constraint.
        unavailable = (
            merged[arrival_name].notna()
            & (_utc_series(merged[available_name]) > merged["_issuance_time"])
        )
        if unavailable.any():
            tolerance_delta = pd.Timedelta(tolerance) if tolerance is not None else None
            right_arrival = _utc_series(right["_driver_arrival_time"])
            right_available = _utc_series(right["_driver_available_time"])
            no_candidate_rows: list[object] = []
            for row_index in merged.index[unavailable]:
                observation_time = merged.at[row_index, "_observation_time"]
                issuance_time = merged.at[row_index, "_issuance_time"]
                eligible = (right_arrival <= observation_time) & (right_available <= issuance_time)
                if tolerance_delta is not None:
                    eligible &= right_arrival >= observation_time - tolerance_delta
                candidates = np.flatnonzero(eligible.to_numpy())
                if not len(candidates):
                    no_candidate_rows.append(row_index)
                    continue
                replacement = right.iloc[int(candidates[-1])]
                for column in right.columns:
                    merged.at[row_index, column] = replacement[column]
            if no_candidate_rows:
                clear = merged.index.isin(no_candidate_rows)
                for column in right.columns:
                    merged[column] = merged[column].mask(clear)
    if invalid_left.any():
        invalid_rows = left.loc[invalid_left].copy()
        for column in right.columns:
            if column not in invalid_rows.columns:
                invalid_rows[column] = pd.NA
        merged = pd.concat([merged, invalid_rows], ignore_index=False, sort=False)
    merged = merged.sort_values("_original_order").drop(columns=["_original_order"])
    matched = merged[arrival_name].notna()
    if matched.any():
        joined_arrival = _utc_series(merged.loc[matched, arrival_name])
        joined_available = _utc_series(merged.loc[matched, available_name])
        if (joined_arrival > merged.loc[matched, "_observation_time"]).any():
            raise AssertionError("future bow-shock driver joined to an observation")
        if (joined_available > merged.loc[matched, "_issuance_time"]).any():
            raise AssertionError("driver unavailable at issuance joined to an observation")
    merged["driver_join_age_min"] = (
        merged["_observation_time"] - _utc_series(merged[arrival_name])
    ).dt.total_seconds() / 60.0
    merged["driver_join_status"] = np.where(matched, "matched", "missing")
    merged = merged.drop(columns=["_driver_arrival_time", "_driver_available_time"], errors="ignore")
    merged.attrs.update(observations.attrs)
    merged.attrs["driver_join"] = {
        "direction": "backward",
        "requires_arrival_at_or_before_observation": True,
        "requires_availability_at_or_before_issuance": True,
        "tolerance": str(tolerance) if tolerance is not None else None,
        "matched_rows": int(matched.sum()),
        "missing_rows": int((~matched).sum()),
        "coverage_fraction": float(matched.mean()) if len(matched) else 0.0,
    }
    return merged


def driver_missingness(frame: pd.DataFrame, columns: Iterable[str] | None = None) -> dict[str, dict[str, float | int]]:
    selected = list(columns) if columns is not None else [
        column for column in frame.columns if column in DRIVER_VALUE_COLUMNS or column.startswith("drv__")
    ]
    return {
        column: {
            "missing_rows": int(frame[column].isna().sum()),
            "missing_fraction": float(frame[column].isna().mean()) if len(frame) else 1.0,
        }
        for column in selected
        if column in frame.columns
    }
