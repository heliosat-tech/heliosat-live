"""Scientific metrics for held-out LEO density predictions.

All metrics operate on positive densities and report how many exactly matched
rows were retained.  Storm timing metrics are never inferred from an unnamed
threshold: callers must supply explicit event windows (and an onset/recovery
threshold when those metrics are wanted).  Without those definitions the
result carries an honest ``unavailable`` status.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class EventWindow:
    event_id: str
    start_utc: str | pd.Timestamp
    stop_utc: str | pd.Timestamp
    threshold_kg_m3: float | None = None


@dataclass(frozen=True)
class PaddedEventWindow:
    """A storm core plus explicit pre-onset and post-recovery context."""

    event_id: str
    event_start_utc: str | pd.Timestamp
    event_stop_utc: str | pd.Timestamp
    padded_start_utc: str | pd.Timestamp
    padded_stop_utc: str | pd.Timestamp
    event_block_id: str | None = None


def _numeric(values: Sequence[float] | pd.Series) -> pd.Series:
    return pd.to_numeric(pd.Series(values).reset_index(drop=True), errors="coerce").astype(float)


def _finite(value: float | np.floating | None) -> float | None:
    if value is None:
        return None
    number = float(value)
    return number if np.isfinite(number) else None


def _correlation(x: np.ndarray, y: np.ndarray) -> float | None:
    if len(x) < 2 or np.std(x) == 0.0 or np.std(y) == 0.0:
        return None
    return _finite(np.corrcoef(x, y)[0, 1])


def _event_unavailable(reason: str) -> dict[str, object]:
    return {
        "status": "unavailable",
        "reason": reason,
        "event_count": 0,
        "peak_density_absolute_relative_error": None,
        "peak_timing_mae_min": None,
        "onset_timing_mae_min": None,
        "recovery_timing_mae_min": None,
        "events": [],
    }


def _iso_utc(value: pd.Timestamp) -> str:
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp.isoformat().replace("+00:00", "Z")


def _parse_padded_window(
    definition: PaddedEventWindow,
) -> tuple[pd.Timestamp, pd.Timestamp, pd.Timestamp, pd.Timestamp, str]:
    padded_start = pd.to_datetime(definition.padded_start_utc, utc=True, errors="coerce")
    event_start = pd.to_datetime(definition.event_start_utc, utc=True, errors="coerce")
    event_stop = pd.to_datetime(definition.event_stop_utc, utc=True, errors="coerce")
    padded_stop = pd.to_datetime(definition.padded_stop_utc, utc=True, errors="coerce")
    if any(pd.isna(value) for value in (padded_start, event_start, event_stop, padded_stop)):
        raise ValueError(f"event {definition.event_id!r} has an invalid timestamp")
    if not padded_start < event_start < event_stop < padded_stop:
        raise ValueError(
            f"event {definition.event_id!r} requires strict pre-event and post-event padding"
        )
    event_id = str(definition.event_id).strip()
    if not event_id:
        raise ValueError("event_id cannot be empty")
    block_id = str(definition.event_block_id or event_id).strip()
    if not block_id:
        raise ValueError(f"event {event_id!r} has an empty event_block_id")
    return padded_start, event_start, event_stop, padded_stop, block_id


def _enhancement_crossing(
    timestamps: pd.Series,
    enhancement: pd.Series,
    *,
    threshold: float,
    direction: str,
) -> tuple[pd.Timestamp | None, str | None]:
    values = pd.to_numeric(enhancement, errors="coerce")
    time = pd.to_datetime(timestamps, utc=True, errors="coerce")
    valid = time.notna() & np.isfinite(values)
    values = values.loc[valid].reset_index(drop=True)
    time = time.loc[valid].reset_index(drop=True)
    if values.empty:
        return None, "no valid enhancement samples are available"
    if direction == "onset":
        if values.iloc[0] >= threshold:
            return None, "series is already above threshold at the padded-window boundary"
        crossing = (values >= threshold) & (values.shift(1) < threshold)
        reason = "upward threshold crossing is absent from the padded window"
    elif direction == "recovery":
        if values.max() < threshold:
            return None, "enhancement never reaches the declared threshold"
        crossing = (values < threshold) & (values.shift(1) >= threshold)
        reason = "downward recovery crossing is absent from the padded window"
    else:
        raise ValueError(f"unsupported crossing direction: {direction}")
    if not crossing.any():
        return None, reason
    return pd.Timestamp(time.loc[crossing].iloc[0]), None


def _timing_comparison(
    observed_time: pd.Timestamp | None,
    predicted_time: pd.Timestamp | None,
    observed_reason: str | None,
    predicted_reason: str | None,
) -> dict[str, object]:
    if observed_time is None or predicted_time is None:
        reasons = []
        if observed_time is None:
            reasons.append(f"observed: {observed_reason or 'crossing unavailable'}")
        if predicted_time is None:
            reasons.append(f"predicted: {predicted_reason or 'crossing unavailable'}")
        return {
            "status": "unavailable",
            "reason": "; ".join(reasons),
            "observed_utc": _iso_utc(observed_time) if observed_time is not None else None,
            "predicted_utc": _iso_utc(predicted_time) if predicted_time is not None else None,
            "error_min": None,
            "absolute_error_min": None,
        }
    error_min = (predicted_time - observed_time).total_seconds() / 60.0
    return {
        "status": "available",
        "reason": None,
        "observed_utc": _iso_utc(observed_time),
        "predicted_utc": _iso_utc(predicted_time),
        "error_min": error_min,
        "absolute_error_min": abs(error_min),
    }


def _unavailable_spacecraft_event_record(
    *,
    event_id: str,
    event_block_id: str,
    spacecraft_key: str,
    spacecraft_identity: Mapping[str, str],
    reason: str,
    input_rows: int,
    valid_rows: int,
) -> dict[str, object]:
    return {
        "event_id": event_id,
        "event_block_id": event_block_id,
        "spacecraft_event_id": f"{event_id}::{spacecraft_key}",
        "spacecraft_key": spacecraft_key,
        "spacecraft": dict(spacecraft_identity),
        "status": "unavailable",
        "reason": reason,
        "input_rows": input_rows,
        "valid_rows": valid_rows,
        "onset": _timing_comparison(None, None, reason, reason),
        "peak_magnitude": {
            "status": "unavailable",
            "reason": reason,
            "observed_enhancement_ratio": None,
            "predicted_enhancement_ratio": None,
            "error": None,
            "absolute_error": None,
            "absolute_relative_error": None,
        },
        "peak_timing": _timing_comparison(None, None, reason, reason),
        "recovery": _timing_comparison(None, None, reason, reason),
    }


def _aggregate_event_component(
    records: Sequence[Mapping[str, object]],
    component: str,
    field: str,
) -> dict[str, object]:
    values: list[float] = []
    for record in records:
        payload = record.get(component)
        if not isinstance(payload, Mapping) or payload.get("status") != "available":
            continue
        value = payload.get(field)
        if value is not None and np.isfinite(float(value)):
            values.append(float(value))
    if not values:
        return {
            "status": "unavailable",
            "reason": "no spacecraft has both observed and predicted values for this metric",
            "spacecraft_count": 0,
            "median": None,
        }
    return {
        "status": "available",
        "reason": None,
        "spacecraft_count": len(values),
        "median": float(np.median(values)),
    }


def spacecraft_event_enhancement_metrics(
    frame: pd.DataFrame,
    event_windows: Sequence[PaddedEventWindow],
    *,
    enhancement_threshold: float = 1.2,
    timestamp_column: str = "timestamp_utc",
    observed_column: str = "rho_obs_kg_m3",
    predicted_column: str = "rho_predicted_kg_m3",
    baseline_column: str = "rho_baseline_kg_m3",
    spacecraft_columns: Sequence[str] = ("mission", "spacecraft_id"),
) -> dict[str, object]:
    """Evaluate padded storm timing on per-spacecraft density enhancements.

    Peaks are selected inside the event core.  Onset is sought from the padded
    start through each series' peak; recovery is sought from that peak through
    the padded stop.  Ratios are always formed against each row's own positive
    baseline, so absolute densities from different spacecraft are never
    pooled.  Aggregation first takes a median across spacecraft within an
    event, then a median across events so every event has equal weight.
    """

    if not np.isfinite(enhancement_threshold) or enhancement_threshold <= 1.0:
        raise ValueError("enhancement_threshold must be finite and greater than 1")
    if not event_windows:
        raise ValueError("at least one padded event window is required")
    if not spacecraft_columns:
        raise ValueError("at least one spacecraft identity column is required")
    required = {
        timestamp_column,
        observed_column,
        predicted_column,
        baseline_column,
        *spacecraft_columns,
    }
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"event timing frame missing column(s): {sorted(missing)}")
    parsed_windows: list[
        tuple[PaddedEventWindow, pd.Timestamp, pd.Timestamp, pd.Timestamp, pd.Timestamp, str]
    ] = []
    event_ids: set[str] = set()
    for definition in event_windows:
        padded_start, event_start, event_stop, padded_stop, block_id = _parse_padded_window(
            definition
        )
        event_id = str(definition.event_id).strip()
        if event_id in event_ids:
            raise ValueError(f"duplicate event_id: {event_id}")
        event_ids.add(event_id)
        parsed_windows.append(
            (definition, padded_start, event_start, event_stop, padded_stop, block_id)
        )

    work = frame.copy()
    work["_timestamp"] = pd.to_datetime(work[timestamp_column], utc=True, errors="coerce")
    for column in (observed_column, predicted_column, baseline_column):
        work[f"_numeric_{column}"] = pd.to_numeric(work[column], errors="coerce")
    identity_missing = work[list(spacecraft_columns)].isna().any(axis=1)
    if identity_missing.any():
        raise ValueError("spacecraft identity columns cannot contain missing values")
    work["_spacecraft_key"] = work[list(spacecraft_columns)].astype(str).agg(":".join, axis=1)
    spacecraft_identity: dict[str, dict[str, str]] = {}
    for key, group in work.groupby("_spacecraft_key", sort=True):
        spacecraft_identity[str(key)] = {
            column: str(group.iloc[0][column]) for column in spacecraft_columns
        }
    if not spacecraft_identity:
        raise ValueError("event timing requires at least one spacecraft")

    records: list[dict[str, object]] = []
    for definition, padded_start, event_start, event_stop, padded_stop, block_id in parsed_windows:
        event_id = str(definition.event_id).strip()
        padded_mask = work["_timestamp"].between(
            padded_start, padded_stop, inclusive="both"
        )
        for spacecraft_key, identity in spacecraft_identity.items():
            raw = work.loc[padded_mask & work["_spacecraft_key"].eq(spacecraft_key)].copy()
            valid = (
                raw["_timestamp"].notna()
                & np.isfinite(raw[f"_numeric_{observed_column}"])
                & np.isfinite(raw[f"_numeric_{predicted_column}"])
                & np.isfinite(raw[f"_numeric_{baseline_column}"])
                & (raw[f"_numeric_{observed_column}"] > 0.0)
                & (raw[f"_numeric_{predicted_column}"] > 0.0)
                & (raw[f"_numeric_{baseline_column}"] > 0.0)
            )
            sample = raw.loc[valid].sort_values("_timestamp", kind="mergesort").copy()
            if sample.empty:
                records.append(
                    _unavailable_spacecraft_event_record(
                        event_id=event_id,
                        event_block_id=block_id,
                        spacecraft_key=spacecraft_key,
                        spacecraft_identity=identity,
                        reason="no positive matched density/baseline rows in the padded window",
                        input_rows=len(raw),
                        valid_rows=0,
                    )
                )
                continue
            sample["_observed_enhancement"] = (
                sample[f"_numeric_{observed_column}"]
                / sample[f"_numeric_{baseline_column}"]
            )
            sample["_predicted_enhancement"] = (
                sample[f"_numeric_{predicted_column}"]
                / sample[f"_numeric_{baseline_column}"]
            )
            core = sample.loc[
                sample["_timestamp"].between(event_start, event_stop, inclusive="both")
            ]
            if core.empty:
                records.append(
                    _unavailable_spacecraft_event_record(
                        event_id=event_id,
                        event_block_id=block_id,
                        spacecraft_key=spacecraft_key,
                        spacecraft_identity=identity,
                        reason="no positive matched rows in the event core",
                        input_rows=len(raw),
                        valid_rows=len(sample),
                    )
                )
                continue

            observed_peak_index = core["_observed_enhancement"].idxmax()
            predicted_peak_index = core["_predicted_enhancement"].idxmax()
            observed_peak = float(core.loc[observed_peak_index, "_observed_enhancement"])
            predicted_peak = float(core.loc[predicted_peak_index, "_predicted_enhancement"])
            observed_peak_time = pd.Timestamp(core.loc[observed_peak_index, "_timestamp"])
            predicted_peak_time = pd.Timestamp(core.loc[predicted_peak_index, "_timestamp"])

            observed_before_peak = sample.loc[sample["_timestamp"] <= observed_peak_time]
            predicted_before_peak = sample.loc[sample["_timestamp"] <= predicted_peak_time]
            observed_onset, observed_onset_reason = _enhancement_crossing(
                observed_before_peak["_timestamp"],
                observed_before_peak["_observed_enhancement"],
                threshold=enhancement_threshold,
                direction="onset",
            )
            predicted_onset, predicted_onset_reason = _enhancement_crossing(
                predicted_before_peak["_timestamp"],
                predicted_before_peak["_predicted_enhancement"],
                threshold=enhancement_threshold,
                direction="onset",
            )
            observed_after_peak = sample.loc[sample["_timestamp"] >= observed_peak_time]
            predicted_after_peak = sample.loc[sample["_timestamp"] >= predicted_peak_time]
            observed_recovery, observed_recovery_reason = _enhancement_crossing(
                observed_after_peak["_timestamp"],
                observed_after_peak["_observed_enhancement"],
                threshold=enhancement_threshold,
                direction="recovery",
            )
            predicted_recovery, predicted_recovery_reason = _enhancement_crossing(
                predicted_after_peak["_timestamp"],
                predicted_after_peak["_predicted_enhancement"],
                threshold=enhancement_threshold,
                direction="recovery",
            )
            peak_error = predicted_peak - observed_peak
            record = {
                "event_id": event_id,
                "event_block_id": block_id,
                "spacecraft_event_id": f"{event_id}::{spacecraft_key}",
                "spacecraft_key": spacecraft_key,
                "spacecraft": identity,
                "status": "available",
                "reason": None,
                "input_rows": len(raw),
                "valid_rows": len(sample),
                "enhancement_threshold": enhancement_threshold,
                "onset": _timing_comparison(
                    observed_onset,
                    predicted_onset,
                    observed_onset_reason,
                    predicted_onset_reason,
                ),
                "peak_magnitude": {
                    "status": "available",
                    "reason": None,
                    "observed_enhancement_ratio": observed_peak,
                    "predicted_enhancement_ratio": predicted_peak,
                    "error": peak_error,
                    "absolute_error": abs(peak_error),
                    "absolute_relative_error": abs(predicted_peak / observed_peak - 1.0),
                },
                "peak_timing": _timing_comparison(
                    observed_peak_time, predicted_peak_time, None, None
                ),
                "recovery": _timing_comparison(
                    observed_recovery,
                    predicted_recovery,
                    observed_recovery_reason,
                    predicted_recovery_reason,
                ),
            }
            records.append(record)

    event_aggregates: list[dict[str, object]] = []
    component_fields = {
        "onset": "absolute_error_min",
        "peak_magnitude": "absolute_relative_error",
        "peak_timing": "absolute_error_min",
        "recovery": "absolute_error_min",
    }
    for definition, padded_start, event_start, event_stop, padded_stop, block_id in parsed_windows:
        event_id = str(definition.event_id).strip()
        event_records = [record for record in records if record["event_id"] == event_id]
        event_aggregates.append(
            {
                "event_id": event_id,
                "event_block_id": block_id,
                "event_start_utc": _iso_utc(event_start),
                "event_stop_utc": _iso_utc(event_stop),
                "padded_start_utc": _iso_utc(padded_start),
                "padded_stop_utc": _iso_utc(padded_stop),
                "spacecraft_records": len(event_records),
                "available_spacecraft_records": sum(
                    record.get("status") == "available" for record in event_records
                ),
                "metrics": {
                    component: _aggregate_event_component(event_records, component, field)
                    for component, field in component_fields.items()
                },
            }
        )

    aggregate: dict[str, object] = {}
    for component in component_fields:
        event_values = [
            event["metrics"][component]["median"]  # type: ignore[index]
            for event in event_aggregates
            if event["metrics"][component]["status"] == "available"  # type: ignore[index]
        ]
        aggregate[component] = (
            {
                "status": "available",
                "reason": None,
                "event_count": len(event_values),
                "median": float(np.median(event_values)),
            }
            if event_values
            else {
                "status": "unavailable",
                "reason": "no event has an available per-spacecraft median",
                "event_count": 0,
                "median": None,
            }
        )

    available_records = [record for record in records if record["status"] == "available"]
    return {
        "status": "available" if available_records else "unavailable",
        "reason": None if available_records else "no spacecraft-event has valid core rows",
        "method": "per-spacecraft enhancement ratio; spacecraft median within event; median across events",
        "enhancement_definition": "rho / positive rho_baseline",
        "enhancement_threshold": enhancement_threshold,
        "spacecraft_columns": list(spacecraft_columns),
        "event_count": len(parsed_windows),
        "spacecraft_count": len(spacecraft_identity),
        "spacecraft_event_count": len(records),
        "available_spacecraft_event_count": len(available_records),
        "per_spacecraft_event": records,
        "per_event": event_aggregates,
        "aggregate": aggregate,
        "bootstrap": {
            "compatible": True,
            "block_id_field": "event_block_id",
            "spacecraft_event_id_field": "spacecraft_event_id",
            "event_block_ids": list(dict.fromkeys(event["event_block_id"] for event in event_aggregates)),
            "instruction": "resample complete event_block_id groups, never minute rows",
        },
    }


def _first_threshold_crossing(
    timestamps: pd.Series,
    values: pd.Series,
    threshold: float,
) -> pd.Timestamp | None:
    above = values >= threshold
    crossings = above & ~above.shift(1, fill_value=False)
    if not crossings.any():
        return None
    return pd.Timestamp(timestamps.loc[crossings].iloc[0])


def _recovery_crossing(
    timestamps: pd.Series,
    values: pd.Series,
    threshold: float,
    peak_time: pd.Timestamp,
) -> pd.Timestamp | None:
    after_peak = timestamps >= peak_time
    below = values < threshold
    prior_above = (values.shift(1) >= threshold).fillna(False)
    crossings = after_peak & below & prior_above
    if not crossings.any():
        return None
    return pd.Timestamp(timestamps.loc[crossings].iloc[0])


def density_event_metrics(
    observed_density: Sequence[float] | pd.Series,
    predicted_density: Sequence[float] | pd.Series,
    timestamps: Sequence[object] | pd.Series | None,
    event_windows: Sequence[EventWindow] | None,
) -> dict[str, object]:
    """Evaluate explicitly defined events without inventing a storm rule."""

    if timestamps is None:
        return _event_unavailable("timestamps were not supplied")
    if not event_windows:
        return _event_unavailable("storm/event definitions were not supplied")

    observed = _numeric(observed_density)
    predicted = _numeric(predicted_density)
    time = pd.to_datetime(pd.Series(timestamps).reset_index(drop=True), utc=True, errors="coerce")
    if not (len(observed) == len(predicted) == len(time)):
        raise ValueError("observed, predicted and timestamp arrays must have equal length")
    valid = (
        time.notna()
        & np.isfinite(observed)
        & np.isfinite(predicted)
        & (observed > 0.0)
        & (predicted > 0.0)
    )
    work = pd.DataFrame(
        {
            "timestamp_utc": time.loc[valid],
            "observed": observed.loc[valid],
            "predicted": predicted.loc[valid],
        }
    ).sort_values("timestamp_utc")

    records: list[dict[str, object]] = []
    for definition in event_windows:
        start = pd.to_datetime(definition.start_utc, utc=True, errors="coerce")
        stop = pd.to_datetime(definition.stop_utc, utc=True, errors="coerce")
        if pd.isna(start) or pd.isna(stop) or start >= stop:
            records.append(
                {
                    "event_id": definition.event_id,
                    "status": "unavailable",
                    "reason": "invalid event window",
                }
            )
            continue
        event = work.loc[work["timestamp_utc"].between(start, stop, inclusive="both")]
        if event.empty:
            records.append(
                {
                    "event_id": definition.event_id,
                    "status": "unavailable",
                    "reason": "no matched density rows in event window",
                }
            )
            continue

        observed_peak_index = event["observed"].idxmax()
        predicted_peak_index = event["predicted"].idxmax()
        observed_peak = float(event.loc[observed_peak_index, "observed"])
        predicted_peak = float(event.loc[predicted_peak_index, "predicted"])
        observed_peak_time = pd.Timestamp(event.loc[observed_peak_index, "timestamp_utc"])
        predicted_peak_time = pd.Timestamp(event.loc[predicted_peak_index, "timestamp_utc"])
        record: dict[str, object] = {
            "event_id": definition.event_id,
            "status": "available",
            "rows": len(event),
            "observed_peak_kg_m3": observed_peak,
            "predicted_peak_kg_m3": predicted_peak,
            "peak_density_absolute_relative_error": abs(predicted_peak / observed_peak - 1.0),
            "observed_peak_utc": observed_peak_time.isoformat().replace("+00:00", "Z"),
            "predicted_peak_utc": predicted_peak_time.isoformat().replace("+00:00", "Z"),
            "peak_timing_error_min": (
                predicted_peak_time - observed_peak_time
            ).total_seconds()
            / 60.0,
            "threshold_kg_m3": definition.threshold_kg_m3,
            "onset_timing_error_min": None,
            "recovery_timing_error_min": None,
            "timing_status": "unavailable",
            "timing_reason": "event threshold was not supplied",
        }
        threshold = definition.threshold_kg_m3
        if threshold is not None and np.isfinite(threshold) and threshold > 0.0:
            observed_onset = _first_threshold_crossing(
                event["timestamp_utc"], event["observed"], float(threshold)
            )
            predicted_onset = _first_threshold_crossing(
                event["timestamp_utc"], event["predicted"], float(threshold)
            )
            observed_recovery = _recovery_crossing(
                event["timestamp_utc"], event["observed"], float(threshold), observed_peak_time
            )
            predicted_recovery = _recovery_crossing(
                event["timestamp_utc"], event["predicted"], float(threshold), predicted_peak_time
            )
            if observed_onset is not None and predicted_onset is not None:
                record["onset_timing_error_min"] = (
                    predicted_onset - observed_onset
                ).total_seconds() / 60.0
            if observed_recovery is not None and predicted_recovery is not None:
                record["recovery_timing_error_min"] = (
                    predicted_recovery - observed_recovery
                ).total_seconds() / 60.0
            if record["onset_timing_error_min"] is not None or record["recovery_timing_error_min"] is not None:
                record["timing_status"] = "available"
                record["timing_reason"] = None
            else:
                record["timing_reason"] = "threshold crossings were absent from observed or predicted series"
        records.append(record)

    available = [record for record in records if record.get("status") == "available"]
    if not available:
        result = _event_unavailable("no event window contained matched density rows")
        result["events"] = records
        return result

    def median_absolute(field: str) -> float | None:
        values = [
            abs(float(record[field]))
            for record in available
            if record.get(field) is not None and np.isfinite(float(record[field]))
        ]
        return _finite(np.median(values)) if values else None

    return {
        "status": "available",
        "reason": None,
        "event_count": len(available),
        "peak_density_absolute_relative_error": _finite(
            np.median([record["peak_density_absolute_relative_error"] for record in available])
        ),
        "peak_timing_mae_min": median_absolute("peak_timing_error_min"),
        "onset_timing_mae_min": median_absolute("onset_timing_error_min"),
        "recovery_timing_mae_min": median_absolute("recovery_timing_error_min"),
        "events": records,
    }


def density_metrics(
    observed_density: Sequence[float] | pd.Series,
    predicted_density: Sequence[float] | pd.Series,
    *,
    baseline_density: Sequence[float] | pd.Series | None = None,
    timestamps: Sequence[object] | pd.Series | None = None,
    event_windows: Sequence[EventWindow] | None = None,
) -> dict[str, object]:
    """Return core density metrics on positive, exactly matched samples.

    Skill is ``1 - model_error / M0_error`` for both log10 MAE and RMSE.  A
    value above zero is improvement over M0; a value below zero is worse.
    """

    observed = _numeric(observed_density)
    predicted = _numeric(predicted_density)
    if len(observed) != len(predicted):
        raise ValueError("observed and predicted density arrays must have equal length")
    baseline: pd.Series | None = None
    if baseline_density is not None:
        baseline = _numeric(baseline_density)
        if len(baseline) != len(observed):
            raise ValueError("baseline density array must match observed density length")
    valid = (
        np.isfinite(observed)
        & np.isfinite(predicted)
        & (observed > 0.0)
        & (predicted > 0.0)
    )
    if baseline is not None:
        valid &= np.isfinite(baseline) & (baseline > 0.0)
    observed_valid = observed.loc[valid].to_numpy(dtype=float)
    predicted_valid = predicted.loc[valid].to_numpy(dtype=float)
    baseline_valid = baseline.loc[valid].to_numpy(dtype=float) if baseline is not None else None

    if not len(observed_valid):
        return {
            "status": "unavailable",
            "reason": "no positive matched observed/predicted density rows",
            "sample_count": 0,
            "rejected_rows": int(len(observed)),
            "mae_log10_rho": None,
            "rmse_log10_rho": None,
            "median_absolute_relative_error": None,
            "density_ratio_error": None,
            "median_density_ratio": None,
            "median_absolute_log10_density_ratio_error": None,
            "bias_kg_m3": None,
            "bias_log10_rho": None,
            "mean_relative_bias": None,
            "correlation_density": None,
            "correlation_log10_rho": None,
            "skill_vs_m0": {"status": "unavailable", "reason": "no matched rows"},
            "events": _event_unavailable("no positive matched density rows"),
        }

    log_observed = np.log10(observed_valid)
    log_predicted = np.log10(predicted_valid)
    log_error = log_predicted - log_observed
    ratio = predicted_valid / observed_valid
    mae = float(np.mean(np.abs(log_error)))
    rmse = float(np.sqrt(np.mean(log_error**2)))

    skill: dict[str, object]
    if baseline_valid is None:
        skill = {"status": "unavailable", "reason": "M0 baseline density was not supplied"}
    else:
        baseline_error = np.log10(baseline_valid) - log_observed
        baseline_mae = float(np.mean(np.abs(baseline_error)))
        baseline_rmse = float(np.sqrt(np.mean(baseline_error**2)))
        skill = {
            "status": "available" if baseline_mae > 0.0 or baseline_rmse > 0.0 else "unavailable",
            "reason": None if baseline_mae > 0.0 or baseline_rmse > 0.0 else "M0 has zero error",
            "m0_mae_log10_rho": baseline_mae,
            "m0_rmse_log10_rho": baseline_rmse,
            "mae_skill": _finite(1.0 - mae / baseline_mae) if baseline_mae > 0.0 else None,
            "rmse_skill": _finite(1.0 - rmse / baseline_rmse) if baseline_rmse > 0.0 else None,
        }

    timestamps_valid: pd.Series | None = None
    if timestamps is not None:
        timestamp_series = pd.Series(timestamps).reset_index(drop=True)
        if len(timestamp_series) != len(observed):
            raise ValueError("timestamp array must match observed density length")
        timestamps_valid = timestamp_series.loc[valid]
    events = density_event_metrics(
        pd.Series(observed_valid),
        pd.Series(predicted_valid),
        timestamps_valid.reset_index(drop=True) if timestamps_valid is not None else None,
        event_windows,
    )
    return {
        "status": "available",
        "reason": None,
        "sample_count": int(len(observed_valid)),
        "rejected_rows": int(len(observed) - len(observed_valid)),
        "mae_log10_rho": mae,
        "rmse_log10_rho": rmse,
        "median_absolute_relative_error": float(np.median(np.abs(ratio - 1.0))),
        "density_ratio_error": float(np.median(np.abs(ratio - 1.0))),
        "median_density_ratio": float(np.median(ratio)),
        "median_absolute_log10_density_ratio_error": float(np.median(np.abs(log_error))),
        "bias_kg_m3": float(np.mean(predicted_valid - observed_valid)),
        "bias_log10_rho": float(np.mean(log_error)),
        "mean_relative_bias": float(np.mean(ratio - 1.0)),
        "correlation_density": _correlation(observed_valid, predicted_valid),
        "correlation_log10_rho": _correlation(log_observed, log_predicted),
        "skill_vs_m0": skill,
        "events": events,
    }


BOOTSTRAP_METRICS: Mapping[str, Callable[[Mapping[str, object]], float | None]] = {
    "mae_log10_rho": lambda result: result.get("mae_log10_rho"),  # type: ignore[return-value]
    "rmse_log10_rho": lambda result: result.get("rmse_log10_rho"),  # type: ignore[return-value]
    "median_absolute_relative_error": lambda result: result.get("median_absolute_relative_error"),  # type: ignore[return-value]
    "median_density_ratio": lambda result: result.get("median_density_ratio"),  # type: ignore[return-value]
    "bias_log10_rho": lambda result: result.get("bias_log10_rho"),  # type: ignore[return-value]
    "correlation_log10_rho": lambda result: result.get("correlation_log10_rho"),  # type: ignore[return-value]
    "mae_skill_vs_m0": lambda result: (result.get("skill_vs_m0") or {}).get("mae_skill"),  # type: ignore[union-attr,return-value]
    "rmse_skill_vs_m0": lambda result: (result.get("skill_vs_m0") or {}).get("rmse_skill"),  # type: ignore[union-attr,return-value]
}


def block_bootstrap_density_metrics(
    frame: pd.DataFrame,
    *,
    observed_column: str = "rho_obs_kg_m3",
    predicted_column: str = "rho_predicted_kg_m3",
    baseline_column: str | None = "rho_baseline_kg_m3",
    timestamp_column: str = "timestamp_utc",
    event_column: str | None = None,
    n_resamples: int = 1_000,
    confidence_level: float = 0.95,
    random_seed: int = 42,
) -> dict[str, object]:
    """Bootstrap whole event blocks, or whole UTC days when events are absent."""

    if n_resamples < 1:
        raise ValueError("n_resamples must be >= 1")
    if not 0.0 < confidence_level < 1.0:
        raise ValueError("confidence_level must be between zero and one")
    required = {observed_column, predicted_column, timestamp_column}
    if baseline_column is not None:
        required.add(baseline_column)
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"bootstrap frame missing column(s): {sorted(missing)}")

    work = frame.copy()
    timestamps = pd.to_datetime(work[timestamp_column], utc=True, errors="coerce")
    if event_column is not None:
        if event_column not in work.columns:
            raise ValueError(f"missing event block column: {event_column}")
        if work[event_column].isna().any():
            raise ValueError("event block identifiers cannot be missing")
        work["_bootstrap_block"] = work[event_column].astype(str)
        method = "event_block_bootstrap"
    else:
        if timestamps.isna().any():
            raise ValueError("timestamps must be valid for UTC-day block bootstrap")
        work["_bootstrap_block"] = timestamps.dt.strftime("%Y-%m-%d")
        method = "utc_day_block_bootstrap"

    block_ids = work["_bootstrap_block"].drop_duplicates().tolist()
    if len(block_ids) < 2:
        return {
            "status": "unavailable",
            "reason": "at least two day/event blocks are required",
            "method": method,
            "block_count": len(block_ids),
            "n_resamples": 0,
            "confidence_level": confidence_level,
            "intervals": {},
        }

    grouped = {block: work.loc[work["_bootstrap_block"] == block] for block in block_ids}

    def calculate(sample: pd.DataFrame) -> dict[str, object]:
        return density_metrics(
            sample[observed_column],
            sample[predicted_column],
            baseline_density=sample[baseline_column] if baseline_column is not None else None,
        )

    estimate = calculate(work)
    samples: dict[str, list[float]] = {name: [] for name in BOOTSTRAP_METRICS}
    random = np.random.default_rng(random_seed)
    for _ in range(n_resamples):
        selected = random.choice(block_ids, size=len(block_ids), replace=True)
        sample = pd.concat([grouped[block] for block in selected], ignore_index=True)
        result = calculate(sample)
        for name, accessor in BOOTSTRAP_METRICS.items():
            value = accessor(result)
            if value is not None and np.isfinite(float(value)):
                samples[name].append(float(value))

    alpha = (1.0 - confidence_level) / 2.0
    intervals: dict[str, dict[str, float | int | None]] = {}
    for name, accessor in BOOTSTRAP_METRICS.items():
        values = np.asarray(samples[name], dtype=float)
        intervals[name] = {
            "estimate": _finite(accessor(estimate)),
            "low": _finite(np.quantile(values, alpha)) if len(values) else None,
            "high": _finite(np.quantile(values, 1.0 - alpha)) if len(values) else None,
            "successful_resamples": int(len(values)),
        }
    return {
        "status": "available",
        "reason": None,
        "method": method,
        "block_count": len(block_ids),
        "n_resamples": n_resamples,
        "confidence_level": confidence_level,
        "random_seed": random_seed,
        "intervals": intervals,
    }
