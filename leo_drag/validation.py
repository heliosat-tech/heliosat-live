"""Paired multi-year validation and uncertainty primitives.

This module contains no downloader and no study-run side effects.  It provides
the invariants needed by the larger runner: stable observation identities,
one common row population for arrival-mode comparisons, group holdouts,
paired block-bootstrap deltas, split calibration intervals and declarative
feature ablations.  Synthetic frames may exercise these functions in tests,
but the functions make no claim about the evidence class of their inputs.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from .features import (
    CATEGORICAL_CONTEXT_FEATURES,
    FeatureDatasetMetadata,
    IDENTITY_LINEAGE_COLUMNS,
    assert_no_target_leakage,
    feature_columns_by_group,
    issuance_safe_geomagnetic_features,
)
from .metrics import density_metrics

COMMON_ROW_SCHEMA_VERSION = "leo-common-comparison-rows-v1"
INTERVAL_CALIBRATION_SCHEMA_VERSION = "leo-density-interval-calibration-v1"
DEFAULT_ROW_KEY_COLUMNS: tuple[str, ...] = (
    "timestamp_utc",
    "mission",
    "spacecraft_id",
    "source_product",
)


@dataclass(frozen=True)
class CommonRowsReport:
    schema_version: str
    modes: tuple[str, ...]
    common_rows: int
    input_rows: dict[str, int]
    eligible_rows: dict[str, int]
    excluded_not_common: dict[str, int]
    row_key_columns: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class AblationSpecification:
    ablation_id: str
    label: str
    feature_groups: tuple[str, ...]
    numeric_features: tuple[str, ...]
    categorical_features: tuple[str, ...]
    deployable: bool = True
    status: str = "available"
    unavailable_reason: str | None = None

    @property
    def feature_columns(self) -> tuple[str, ...]:
        return self.numeric_features + self.categorical_features

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["feature_columns"] = list(self.feature_columns)
        return payload


@dataclass(frozen=True)
class DensityIntervalCalibration:
    schema_version: str
    method: str
    lower_probability: float
    upper_probability: float
    lower_log_residual_quantile: float
    median_log_residual_quantile: float
    upper_log_residual_quantile: float
    calibration_rows: int
    calibration_start_utc: str
    calibration_stop_utc: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _utc_series(values: object) -> pd.Series:
    return pd.to_datetime(values, utc=True, errors="coerce").astype("datetime64[ns, UTC]")


def _iso(value: object) -> str:
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp.isoformat().replace("+00:00", "Z")


def _normalised_key_value(column: str, value: object) -> object:
    if column == "timestamp_utc":
        parsed = pd.to_datetime(value, utc=True, errors="coerce")
        if pd.isna(parsed):
            raise ValueError("stable comparison row id requires a valid UTC timestamp")
        return _iso(parsed)
    if value is None or pd.isna(value):
        return None
    return str(value)


def add_stable_row_ids(
    frame: pd.DataFrame,
    *,
    key_columns: Sequence[str] | None = None,
    output_column: str = "comparison_row_id",
) -> pd.DataFrame:
    """Attach a content-derived observation id and reject ambiguous duplicates."""

    selected = tuple(
        key_columns
        if key_columns is not None
        else (column for column in DEFAULT_ROW_KEY_COLUMNS if column in frame.columns)
    )
    if "timestamp_utc" not in selected:
        raise ValueError("stable comparison row ids require timestamp_utc")
    missing = set(selected) - set(frame.columns)
    if missing:
        raise ValueError(f"row-id key column(s) are missing: {sorted(missing)}")
    output = frame.copy()
    identities: list[str] = []
    for values in output.loc[:, list(selected)].itertuples(index=False, name=None):
        record = {
            column: _normalised_key_value(column, value)
            for column, value in zip(selected, values, strict=True)
        }
        canonical = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        identities.append(hashlib.sha256(canonical.encode("utf-8")).hexdigest())
    output[output_column] = identities
    duplicated = output[output_column].duplicated(keep=False)
    if duplicated.any():
        raise ValueError(
            "stable comparison row keys are not unique; add a physical source key "
            f"({int(duplicated.sum())} ambiguous rows)"
        )
    return output


def _eligible_comparison_rows(
    frame: pd.DataFrame,
    *,
    required_columns: Sequence[str],
    require_driver_match: bool,
) -> pd.Series:
    required = {
        "timestamp_utc",
        "rho_obs_kg_m3",
        "rho_baseline_kg_m3",
        "target_log_density_residual",
        *required_columns,
    }
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"comparison frame missing column(s): {sorted(missing)}")
    timestamp = _utc_series(frame["timestamp_utc"])
    observed = pd.to_numeric(frame["rho_obs_kg_m3"], errors="coerce")
    baseline = pd.to_numeric(frame["rho_baseline_kg_m3"], errors="coerce")
    target = pd.to_numeric(frame["target_log_density_residual"], errors="coerce")
    valid = (
        timestamp.notna()
        & np.isfinite(observed)
        & (observed > 0.0)
        & np.isfinite(baseline)
        & (baseline > 0.0)
        & np.isfinite(target)
    )
    for column in required_columns:
        if column in CATEGORICAL_CONTEXT_FEATURES:
            valid &= frame[column].notna() & frame[column].astype(str).str.strip().ne("")
        else:
            valid &= np.isfinite(pd.to_numeric(frame[column], errors="coerce"))
    if require_driver_match and "driver_join_status" in frame.columns:
        valid &= frame["driver_join_status"].eq("matched")
    return valid.fillna(False)


def align_common_matched_rows(
    frames: Mapping[str, pd.DataFrame],
    *,
    key_columns: Sequence[str] | None = None,
    required_columns: Sequence[str] = (),
    require_driver_match: bool = True,
) -> tuple[dict[str, pd.DataFrame], CommonRowsReport]:
    """Return arrival-mode frames on one exact, identically ordered row set."""

    if len(frames) < 2:
        raise ValueError("common comparison requires at least two modes")
    prepared: dict[str, pd.DataFrame] = {}
    eligible_ids: dict[str, set[str]] = {}
    eligible_counts: dict[str, int] = {}
    resolved_keys: tuple[str, ...] | None = None
    for mode, source in frames.items():
        with_ids = add_stable_row_ids(source, key_columns=key_columns)
        current_keys = tuple(
            key_columns
            if key_columns is not None
            else (column for column in DEFAULT_ROW_KEY_COLUMNS if column in source.columns)
        )
        if resolved_keys is None:
            resolved_keys = current_keys
        elif current_keys != resolved_keys:
            raise ValueError("all comparison modes must expose the same row-id key columns")
        valid = _eligible_comparison_rows(
            with_ids,
            required_columns=required_columns,
            require_driver_match=require_driver_match,
        )
        selected = with_ids.loc[valid].copy()
        prepared[str(mode)] = selected
        eligible_ids[str(mode)] = set(selected["comparison_row_id"].astype(str))
        eligible_counts[str(mode)] = len(selected)
    common = set.intersection(*eligible_ids.values())
    if not common:
        raise ValueError("arrival modes have no common scientifically valid rows")

    aligned: dict[str, pd.DataFrame] = {}
    expected_ids: list[str] | None = None
    for mode, frame in prepared.items():
        selected = frame.loc[frame["comparison_row_id"].isin(common)].copy()
        selected["timestamp_utc"] = _utc_series(selected["timestamp_utc"])
        selected = selected.sort_values(
            ["timestamp_utc", "comparison_row_id"], kind="mergesort"
        ).reset_index(drop=True)
        ids = selected["comparison_row_id"].astype(str).tolist()
        if expected_ids is None:
            expected_ids = ids
        elif ids != expected_ids:
            raise AssertionError("common arrival-mode row ordering differs")
        aligned[mode] = selected

    first = next(iter(aligned.values()))
    for mode, frame in list(aligned.items())[1:]:
        for column in ("timestamp_utc", "mission", "spacecraft_id", "source_product"):
            if column in first.columns and column in frame.columns:
                if not first[column].astype(str).equals(frame[column].astype(str)):
                    raise AssertionError(f"{mode} changes observation identity column {column!r}")
        for column in ("rho_obs_kg_m3", "rho_baseline_kg_m3"):
            left = pd.to_numeric(first[column], errors="coerce").to_numpy(float)
            right = pd.to_numeric(frame[column], errors="coerce").to_numpy(float)
            if not np.allclose(left, right, rtol=1e-12, atol=0.0, equal_nan=True):
                raise AssertionError(f"{mode} changes common observation column {column!r}")

    report = CommonRowsReport(
        schema_version=COMMON_ROW_SCHEMA_VERSION,
        modes=tuple(str(mode) for mode in frames),
        common_rows=len(common),
        input_rows={str(mode): len(frame) for mode, frame in frames.items()},
        eligible_rows=eligible_counts,
        excluded_not_common={
            mode: eligible_counts[mode] - len(common) for mode in eligible_counts
        },
        row_key_columns=resolved_keys or (),
    )
    return aligned, report


def add_spacecraft_key(
    frame: pd.DataFrame,
    *,
    mission_column: str = "mission",
    spacecraft_column: str = "spacecraft_id",
    output_column: str = "spacecraft_key",
) -> pd.DataFrame:
    missing = {mission_column, spacecraft_column} - set(frame.columns)
    if missing:
        raise ValueError(f"spacecraft key requires column(s): {sorted(missing)}")
    output = frame.copy()
    mission = output[mission_column].astype("string").str.strip()
    spacecraft = output[spacecraft_column].astype("string").str.strip()
    if mission.isna().any() or spacecraft.isna().any() or mission.eq("").any() or spacecraft.eq("").any():
        raise ValueError("mission and spacecraft identifiers must be populated")
    output[output_column] = mission + ":" + spacecraft
    return output


def leave_one_spacecraft_out_indices(
    frame: pd.DataFrame,
    holdout_spacecraft: str,
    *,
    spacecraft_key_column: str = "spacecraft_key",
) -> tuple[tuple[object, ...], tuple[object, ...]]:
    work = frame if spacecraft_key_column in frame.columns else add_spacecraft_key(frame)
    test_mask = work[spacecraft_key_column].astype(str).eq(str(holdout_spacecraft))
    if not test_mask.any() or test_mask.all():
        raise ValueError("spacecraft holdout must leave non-empty development and test rows")
    return tuple(work.index[~test_mask]), tuple(work.index[test_mask])


def cross_mission_indices(
    frame: pd.DataFrame,
    *,
    train_missions: Sequence[str],
    test_missions: Sequence[str],
    mission_column: str = "mission",
) -> tuple[tuple[object, ...], tuple[object, ...]]:
    if mission_column not in frame.columns:
        raise ValueError(f"missing mission column: {mission_column}")
    train_labels = {str(value) for value in train_missions}
    test_labels = {str(value) for value in test_missions}
    if not train_labels or not test_labels or train_labels & test_labels:
        raise ValueError("cross-mission train/test labels must be non-empty and disjoint")
    values = frame[mission_column].astype(str)
    train_mask = values.isin(train_labels)
    test_mask = values.isin(test_labels)
    if not train_mask.any() or not test_mask.any():
        raise ValueError("cross-mission split produced an empty train or test partition")
    return tuple(frame.index[train_mask]), tuple(frame.index[test_mask])


def assert_mission_agnostic_features(feature_columns: Sequence[str]) -> None:
    forbidden = {"mission", "spacecraft_id", "spacecraft_key"} & set(feature_columns)
    if forbidden:
        raise AssertionError(f"deployable feature set contains identity: {sorted(forbidden)}")
    assert_no_target_leakage(feature_columns)


def _metric_value(result: Mapping[str, object], metric: str) -> float | None:
    if metric == "rmse_skill_vs_m0":
        skill = result.get("skill_vs_m0")
        value = skill.get("rmse_skill") if isinstance(skill, Mapping) else None
    elif metric == "mae_skill_vs_m0":
        skill = result.get("skill_vs_m0")
        value = skill.get("mae_skill") if isinstance(skill, Mapping) else None
    else:
        value = result.get(metric)
    if value is None or not np.isfinite(float(value)):
        return None
    return float(value)


def paired_block_bootstrap_delta(
    frame: pd.DataFrame,
    *,
    prediction_a_column: str,
    prediction_b_column: str,
    metric: str = "rmse_log10_rho",
    observed_column: str = "rho_obs_kg_m3",
    baseline_column: str = "rho_baseline_kg_m3",
    timestamp_column: str = "timestamp_utc",
    block_column: str | None = None,
    n_resamples: int = 1_000,
    confidence_level: float = 0.95,
    random_seed: int = 42,
) -> dict[str, object]:
    """CI for metric(B)-metric(A), resampling the same whole blocks for both."""

    if n_resamples < 1:
        raise ValueError("n_resamples must be >= 1")
    if not 0.0 < confidence_level < 1.0:
        raise ValueError("confidence_level must be between zero and one")
    required = {
        observed_column, baseline_column, prediction_a_column,
        prediction_b_column, timestamp_column,
    }
    if block_column is not None:
        required.add(block_column)
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"paired bootstrap frame missing column(s): {sorted(missing)}")
    work = frame.copy()
    if block_column is None:
        timestamp = _utc_series(work[timestamp_column])
        if timestamp.isna().any():
            raise ValueError("paired bootstrap timestamps must be valid")
        work["_paired_block"] = timestamp.dt.strftime("%Y-%m-%d")
        method = "paired_utc_day_block_bootstrap"
    else:
        if work[block_column].isna().any():
            raise ValueError("paired bootstrap block identifiers cannot be missing")
        work["_paired_block"] = work[block_column].astype(str)
        method = "paired_named_block_bootstrap"
    block_ids = work["_paired_block"].drop_duplicates().tolist()
    if len(block_ids) < 2:
        return {
            "status": "unavailable",
            "reason": "at least two paired blocks are required",
            "method": method,
            "metric": metric,
            "block_count": len(block_ids),
            "n_resamples": 0,
        }

    def score(sample: pd.DataFrame, prediction_column: str) -> float | None:
        result = density_metrics(
            sample[observed_column],
            sample[prediction_column],
            baseline_density=sample[baseline_column],
        )
        return _metric_value(result, metric)

    estimate_a = score(work, prediction_a_column)
    estimate_b = score(work, prediction_b_column)
    if estimate_a is None or estimate_b is None:
        raise ValueError(f"metric {metric!r} is unavailable on the paired population")
    grouped = {block: work.loc[work["_paired_block"] == block] for block in block_ids}
    random = np.random.default_rng(random_seed)
    deltas: list[float] = []
    for _ in range(n_resamples):
        selected = random.choice(block_ids, size=len(block_ids), replace=True)
        sample = pd.concat([grouped[block] for block in selected], ignore_index=True)
        value_a, value_b = score(sample, prediction_a_column), score(sample, prediction_b_column)
        if value_a is not None and value_b is not None:
            deltas.append(value_b - value_a)
    values = np.asarray(deltas, dtype=float)
    alpha = (1.0 - confidence_level) / 2.0
    return {
        "status": "available" if len(values) else "unavailable",
        "reason": None if len(values) else "no successful paired resample",
        "method": method,
        "metric": metric,
        "delta_definition": f"{prediction_b_column} minus {prediction_a_column}",
        "estimate_a": estimate_a,
        "estimate_b": estimate_b,
        "delta_estimate": estimate_b - estimate_a,
        "confidence_interval": {
            "low": float(np.quantile(values, alpha)) if len(values) else None,
            "high": float(np.quantile(values, 1.0 - alpha)) if len(values) else None,
            "confidence_level": confidence_level,
        },
        "block_count": len(block_ids),
        "n_resamples": n_resamples,
        "successful_resamples": len(values),
        "random_seed": random_seed,
    }


def calibrate_density_intervals(
    calibration_frame: pd.DataFrame,
    *,
    observed_column: str = "rho_obs_kg_m3",
    median_prediction_column: str = "rho_p50_kg_m3",
    timestamp_column: str = "timestamp_utc",
    lower_probability: float = 0.10,
    upper_probability: float = 0.90,
) -> DensityIntervalCalibration:
    """Calibrate asymmetric signed log-residual quantiles on a held-out period."""

    if not 0.0 < lower_probability < upper_probability < 1.0:
        raise ValueError("calibration probabilities must satisfy 0 < lower < upper < 1")
    required = {observed_column, median_prediction_column, timestamp_column}
    missing = required - set(calibration_frame.columns)
    if missing:
        raise ValueError(f"calibration frame missing column(s): {sorted(missing)}")
    observed = pd.to_numeric(calibration_frame[observed_column], errors="coerce")
    predicted = pd.to_numeric(calibration_frame[median_prediction_column], errors="coerce")
    timestamp = _utc_series(calibration_frame[timestamp_column])
    valid = (
        timestamp.notna() & np.isfinite(observed) & (observed > 0.0)
        & np.isfinite(predicted) & (predicted > 0.0)
    )
    if int(valid.sum()) < 2:
        raise ValueError("at least two valid held-out calibration rows are required")
    residual = np.log(observed.loc[valid].to_numpy(float) / predicted.loc[valid].to_numpy(float))
    lower, median, upper = np.quantile(
        residual, [lower_probability, 0.50, upper_probability]
    )
    return DensityIntervalCalibration(
        schema_version=INTERVAL_CALIBRATION_SCHEMA_VERSION,
        method="held_out_signed_log_residual_quantiles",
        lower_probability=lower_probability,
        upper_probability=upper_probability,
        lower_log_residual_quantile=float(lower),
        median_log_residual_quantile=float(median),
        upper_log_residual_quantile=float(upper),
        calibration_rows=int(valid.sum()),
        calibration_start_utc=_iso(timestamp.loc[valid].min()),
        calibration_stop_utc=_iso(timestamp.loc[valid].max()),
    )


def _coerce_calibration(
    calibration: DensityIntervalCalibration | Mapping[str, Any],
) -> DensityIntervalCalibration:
    if isinstance(calibration, DensityIntervalCalibration):
        result = calibration
    else:
        result = DensityIntervalCalibration(**dict(calibration))
    if result.schema_version != INTERVAL_CALIBRATION_SCHEMA_VERSION:
        raise ValueError("unsupported density interval calibration schema")
    return result


def apply_density_interval_calibration(
    median_prediction: Sequence[float] | pd.Series,
    calibration: DensityIntervalCalibration | Mapping[str, Any],
) -> pd.DataFrame:
    calibrated = _coerce_calibration(calibration)
    point = pd.to_numeric(pd.Series(median_prediction).reset_index(drop=True), errors="coerce")
    p10 = point * np.exp(calibrated.lower_log_residual_quantile)
    p50 = point * np.exp(calibrated.median_log_residual_quantile)
    p90 = point * np.exp(calibrated.upper_log_residual_quantile)
    invalid = ~np.isfinite(point) | (point <= 0.0)
    output = pd.DataFrame({
        "rho_p10_kg_m3": p10.mask(invalid),
        "rho_p50_kg_m3": p50.mask(invalid),
        "rho_p90_kg_m3": p90.mask(invalid),
    })
    finite = output.notna().all(axis=1)
    if finite.any() and not (
        (output.loc[finite, "rho_p10_kg_m3"] <= output.loc[finite, "rho_p50_kg_m3"]).all()
        and (output.loc[finite, "rho_p50_kg_m3"] <= output.loc[finite, "rho_p90_kg_m3"]).all()
    ):
        raise AssertionError("calibrated density quantiles are not ordered")
    return output


def evaluate_density_interval_calibration(
    test_frame: pd.DataFrame,
    calibration: DensityIntervalCalibration | Mapping[str, Any],
    *,
    observed_column: str = "rho_obs_kg_m3",
    median_prediction_column: str = "rho_p50_kg_m3",
) -> tuple[pd.DataFrame, dict[str, object]]:
    if observed_column not in test_frame or median_prediction_column not in test_frame:
        raise ValueError("test frame lacks observed density or p50 prediction")
    output = test_frame.copy().reset_index(drop=True)
    intervals = apply_density_interval_calibration(output[median_prediction_column], calibration)
    for column in intervals:
        output[column] = intervals[column]
    observed = pd.to_numeric(output[observed_column], errors="coerce")
    valid = (
        np.isfinite(observed) & (observed > 0.0)
        & output[["rho_p10_kg_m3", "rho_p50_kg_m3", "rho_p90_kg_m3"]].notna().all(axis=1)
    )
    if not valid.any():
        raise ValueError("test period has no valid calibrated interval rows")
    obs = observed.loc[valid]
    p10 = output.loc[valid, "rho_p10_kg_m3"]
    p50 = output.loc[valid, "rho_p50_kg_m3"]
    p90 = output.loc[valid, "rho_p90_kg_m3"]
    calibrated = _coerce_calibration(calibration)
    metrics = {
        "status": "available",
        "method": calibrated.method,
        "sample_count": int(valid.sum()),
        "nominal_lower_probability": calibrated.lower_probability,
        "nominal_upper_probability": calibrated.upper_probability,
        "observed_at_or_below_p10_fraction": float((obs <= p10).mean()),
        "observed_below_p50_fraction": float((obs < p50).mean()),
        "observed_at_or_below_p50_fraction": float((obs <= p50).mean()),
        "observed_above_p50_fraction": float((obs > p50).mean()),
        "observed_at_or_below_p90_fraction": float((obs <= p90).mean()),
        "central_interval_nominal_coverage": (
            calibrated.upper_probability - calibrated.lower_probability
        ),
        "central_interval_empirical_coverage": float(((obs >= p10) & (obs <= p90)).mean()),
        "median_interval_width_kg_m3": float(np.median(p90 - p10)),
        "median_relative_interval_width": float(np.median((p90 - p10) / p50)),
    }
    return output, metrics


def calibrate_and_evaluate_density_intervals(
    calibration_frame: pd.DataFrame,
    test_frame: pd.DataFrame,
    *,
    observed_column: str = "rho_obs_kg_m3",
    median_prediction_column: str = "rho_p50_kg_m3",
    timestamp_column: str = "timestamp_utc",
    row_id_column: str = "comparison_row_id",
    lower_probability: float = 0.10,
    upper_probability: float = 0.90,
) -> tuple[DensityIntervalCalibration, pd.DataFrame, dict[str, object]]:
    """Fit only on calibration rows and score only on a later disjoint test."""

    calibration_time = _utc_series(calibration_frame[timestamp_column])
    test_time = _utc_series(test_frame[timestamp_column])
    if calibration_time.isna().any() or test_time.isna().any():
        raise ValueError("calibration/test timestamps must be valid")
    if not calibration_time.max() < test_time.min():
        raise ValueError("calibration period must end strictly before the test period")
    if row_id_column in calibration_frame and row_id_column in test_frame:
        overlap = set(calibration_frame[row_id_column].astype(str)) & set(
            test_frame[row_id_column].astype(str)
        )
        if overlap:
            raise ValueError("calibration and test row ids overlap")
    calibration = calibrate_density_intervals(
        calibration_frame,
        observed_column=observed_column,
        median_prediction_column=median_prediction_column,
        timestamp_column=timestamp_column,
        lower_probability=lower_probability,
        upper_probability=upper_probability,
    )
    predictions, metrics = evaluate_density_interval_calibration(
        test_frame,
        calibration,
        observed_column=observed_column,
        median_prediction_column=median_prediction_column,
    )
    metrics["calibration_period"] = {
        "start_utc": calibration.calibration_start_utc,
        "stop_utc": calibration.calibration_stop_utc,
        "rows": calibration.calibration_rows,
    }
    metrics["test_period"] = {
        "start_utc": _iso(test_time.min()),
        "stop_utc": _iso(test_time.max()),
        "rows": len(test_frame),
    }
    return calibration, predictions, metrics


def build_ablation_specifications(
    frame: pd.DataFrame,
    metadata: FeatureDatasetMetadata | Mapping[str, object] | None = None,
) -> list[AblationSpecification]:
    """Declare matched-row ablations without fitting or selecting on test data."""

    groups = feature_columns_by_group(frame, metadata)
    context = [
        column
        for column in dict.fromkeys([*groups["context"], *groups["baseline"]])
        if column not in IDENTITY_LINEAGE_COLUMNS
    ]
    categorical_context = [
        column for column in context if column in CATEGORICAL_CONTEXT_FEATURES
    ]
    numeric_context = [column for column in context if column not in categorical_context]
    drivers = list(dict.fromkeys(groups["solar_wind"]))
    raw_names = {"vsw_km_s", "np_cm3", "bx_gsm_nt", "by_gsm_nt", "bz_gsm_nt", "bmag_nt"}
    coupling_names = {"pdyn_npa", "em_mv_m", "newell_coupling", "epsilon_coupling_w"}
    instantaneous = [column for column in drivers if column in raw_names]
    integrated = [
        column for column in drivers
        if column in coupling_names
        or (
            column.startswith("drv__")
            and "__integral_h__" in column
            and any(f"drv__{name}__" in column for name in coupling_names)
        )
    ]
    rolling = [
        column for column in drivers
        if column.startswith("drv__") and column not in integrated
    ]
    payload: Mapping[str, object]
    if isinstance(metadata, FeatureDatasetMetadata):
        payload = metadata.to_dict()
    elif isinstance(metadata, Mapping):
        payload = metadata
    else:
        candidate = frame.attrs.get("feature_dataset_metadata")
        payload = candidate if isinstance(candidate, Mapping) else {}
    availability = payload.get("geomagnetic_availability") or frame.attrs.get(
        "geomagnetic_availability", {}
    )
    safe_geomagnetic = issuance_safe_geomagnetic_features(
        frame,
        availability if isinstance(availability, Mapping) else {},  # type: ignore[arg-type]
    )

    def learned(
        ablation_id: str,
        label: str,
        feature_groups: tuple[str, ...],
        extra: Sequence[str],
        *,
        require_extra: bool = True,
    ) -> AblationSpecification:
        numeric = tuple(dict.fromkeys([*numeric_context, *extra]))
        features = (*numeric, *categorical_context)
        assert_mission_agnostic_features(features)
        available = bool(extra) or not require_extra
        return AblationSpecification(
            ablation_id,
            label,
            feature_groups,
            numeric,
            tuple(categorical_context),
            status="available" if available else "unavailable",
            unavailable_reason=None if available else "required feature group is unavailable",
        )

    full = list(dict.fromkeys([*instantaneous, *rolling, *integrated]))
    specifications = [
        AblationSpecification(
            "A0", "Atmosphere baseline only", ("baseline",), (), (),
        ),
        learned("A1", "Orbital and seasonal context", ("context",), (), require_extra=False),
        learned("A2", "Context plus instantaneous L1", ("context", "l1_instantaneous"), instantaneous),
        learned("A3", "Context plus rolling L1", ("context", "l1_rolling"), rolling),
        learned("A4", "Context plus integrated coupling", ("context", "integrated_coupling"), integrated),
        learned(
            "A5", "Full causal M3", (
                "context", "l1_instantaneous", "l1_rolling", "integrated_coupling"
            ), full,
        ),
        learned(
            "A6", "Full causal plus issuance-safe geomagnetic", (
                "context", "l1_instantaneous", "l1_rolling",
                "integrated_coupling", "geomagnetic",
            ), [*full, *safe_geomagnetic], require_extra=bool(full),
        ),
    ]
    if not full or not safe_geomagnetic:
        reason = (
            "full causal L1 feature group is unavailable"
            if not full
            else "no geomagnetic feature has proven issuance-safe availability"
        )
        specifications[-1] = AblationSpecification(
            **{
                **asdict(specifications[-1]),
                "status": "unavailable",
                "unavailable_reason": reason,
            }
        )
    return specifications


__all__ = [
    "AblationSpecification",
    "COMMON_ROW_SCHEMA_VERSION",
    "CommonRowsReport",
    "DensityIntervalCalibration",
    "INTERVAL_CALIBRATION_SCHEMA_VERSION",
    "add_spacecraft_key",
    "add_stable_row_ids",
    "align_common_matched_rows",
    "apply_density_interval_calibration",
    "assert_mission_agnostic_features",
    "build_ablation_specifications",
    "calibrate_and_evaluate_density_intervals",
    "calibrate_density_intervals",
    "cross_mission_indices",
    "evaluate_density_interval_calibration",
    "leave_one_spacecraft_out_indices",
    "paired_block_bootstrap_delta",
]
