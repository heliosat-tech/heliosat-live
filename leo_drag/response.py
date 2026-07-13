"""Leakage-safe bow-shock to thermosphere response experiments.

This module is intentionally independent from the study runner.  It builds
fixed and distributed lag features from an already versioned bow-shock
timeline, selects a fixed lag using the validation partition only, and
evaluates only the selected model on the held-out test partition.

Every lookup enforces two clocks:

* the parcel must have arrived at the bow shock before the requested lagged
  time; and
* the parcel must have been available no later than forecast issuance.

No mission or spacecraft identifier is introduced here.  Callers control the
base model specification and remain responsible for using a deployable,
mission-agnostic specification when reporting headline results.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, replace
from typing import Mapping, Sequence

import numpy as np
import pandas as pd

from .drivers import assert_causal_timeline, causal_backward_join
from .features import TARGET_COLUMN, assert_no_target_leakage
from .metrics import density_metrics
from .models import (
    DEFAULT_RANDOM_SEED,
    ChronologicalSplit,
    ModelSpecification,
    assert_chronological_split,
    make_model_pipeline,
)

RESPONSE_SCHEMA_VERSION = "leo-density-response-v1"
DEFAULT_FIXED_LAGS_HOURS: tuple[float, ...] = tuple(index / 2.0 for index in range(25))
DISTRIBUTED_LAG_BINS_HOURS: tuple[tuple[float, float], ...] = (
    (0.0, 0.5),
    (0.5, 1.0),
    (1.0, 2.0),
    (2.0, 3.0),
    (3.0, 6.0),
    (6.0, 9.0),
    (9.0, 12.0),
)


def _number_label(value: float) -> str:
    return f"{value:g}".replace("-", "m").replace(".", "p")


def fixed_lag_feature_name(driver_column: str, lag_hours: float) -> str:
    return f"response__{driver_column}__lag__{_number_label(lag_hours)}h"


def distributed_lag_feature_name(
    driver_column: str,
    statistic: str,
    lower_hours: float,
    upper_hours: float,
) -> str:
    return (
        f"response__{driver_column}__{statistic}__"
        f"{_number_label(lower_hours)}to{_number_label(upper_hours)}h"
    )


def _validate_lags(lags_hours: Sequence[float]) -> tuple[float, ...]:
    values = tuple(float(value) for value in lags_hours)
    if not values:
        raise ValueError("at least one fixed lag is required")
    if any(not math.isfinite(value) or value < 0.0 or value > 12.0 for value in values):
        raise ValueError("fixed lags must be finite and between 0 and 12 hours")
    if len(set(values)) != len(values):
        raise ValueError("fixed lags must be unique")
    return tuple(sorted(values))


def _validate_bins(
    bins_hours: Sequence[tuple[float, float]],
) -> tuple[tuple[float, float], ...]:
    bins = tuple((float(lower), float(upper)) for lower, upper in bins_hours)
    if not bins:
        raise ValueError("at least one distributed-lag bin is required")
    previous_upper: float | None = None
    for lower, upper in bins:
        if (
            not math.isfinite(lower)
            or not math.isfinite(upper)
            or lower < 0.0
            or upper > 12.0
            or lower >= upper
        ):
            raise ValueError("distributed-lag bins must be increasing within 0 to 12 hours")
        if previous_upper is not None and not math.isclose(lower, previous_upper):
            raise ValueError("distributed-lag bins must be contiguous and disjoint")
        previous_upper = upper
    return bins


def _utc_series(values: Sequence[object] | pd.Series) -> pd.Series:
    return pd.to_datetime(pd.Series(values).reset_index(drop=True), utc=True, errors="coerce")


def build_fixed_lag_features(
    observations: pd.DataFrame,
    timeline: pd.DataFrame,
    *,
    driver_columns: Sequence[str],
    lags_hours: Sequence[float] = DEFAULT_FIXED_LAGS_HOURS,
    timestamp_column: str = "timestamp_utc",
    issuance_column: str = "forecast_issuance_time_utc",
    tolerance: str | pd.Timedelta | None = "10min",
) -> pd.DataFrame:
    """Join point driver values at fixed response lags using causal as-of joins."""

    if timestamp_column not in observations.columns:
        raise ValueError(f"missing observation timestamp column: {timestamp_column}")
    if issuance_column not in observations.columns:
        raise ValueError(f"missing forecast issuance column: {issuance_column}")
    if not driver_columns:
        raise ValueError("at least one driver column is required")
    missing = set(driver_columns) - set(timeline.columns)
    if missing:
        raise ValueError(f"timeline missing driver column(s): {sorted(missing)}")
    assert_no_target_leakage(driver_columns)
    assert_causal_timeline(timeline)
    lags = _validate_lags(lags_hours)
    timeline_columns = list(
        dict.fromkeys(
            (
                "arrival_time_bow_shock_utc",
                "source_measurement_time_l1_utc",
                "available_at_utc",
                *driver_columns,
            )
        )
    )
    response_timeline = timeline[timeline_columns].copy()
    response_timeline.attrs.update(timeline.attrs)

    target_time = _utc_series(observations[timestamp_column])
    issuance_time = _utc_series(observations[issuance_column])
    feature_values: dict[str, np.ndarray] = {}
    generated: list[str] = []
    for lag in lags:
        query = pd.DataFrame(
            {
                "_response_query_time_utc": target_time - pd.to_timedelta(lag, unit="h"),
                "_response_issuance_time_utc": issuance_time,
            }
        )
        joined = causal_backward_join(
            query,
            response_timeline,
            observation_time_column="_response_query_time_utc",
            issuance_time_column="_response_issuance_time_utc",
            tolerance=tolerance,
        )
        lag_label = _number_label(lag)
        for driver in driver_columns:
            name = fixed_lag_feature_name(driver, lag)
            feature_values[name] = pd.to_numeric(joined[driver], errors="coerce").to_numpy()
            generated.append(name)
        feature_values[f"response__join_status__lag__{lag_label}h"] = joined[
            "driver_join_status"
        ].to_numpy()
        arrival = pd.to_datetime(
            joined["arrival_time_bow_shock_utc"], utc=True, errors="coerce"
        )
        feature_values[f"response__actual_lookback_h__lag__{lag_label}h"] = (
            target_time - arrival
        ).dt.total_seconds().to_numpy() / 3_600.0

    output = observations.drop(columns=list(feature_values), errors="ignore").copy()
    output = pd.concat(
        [output, pd.DataFrame(feature_values, index=output.index)], axis=1
    )
    output.attrs.update(observations.attrs)
    output.attrs["response_features"] = {
        "schema_version": RESPONSE_SCHEMA_VERSION,
        "kind": "fixed_lag",
        "lags_hours": list(lags),
        "driver_columns": list(driver_columns),
        "feature_columns": generated,
        "lookup": "backward_asof",
        "requires_arrival_before_lagged_query": True,
        "requires_availability_at_issuance": True,
        "tolerance": str(tolerance) if tolerance is not None else None,
    }
    return output


def _prefix_range(prefix: np.ndarray, start: np.ndarray, stop: np.ndarray) -> np.ndarray:
    return prefix[stop] - prefix[start]


def build_distributed_lag_features(
    observations: pd.DataFrame,
    timeline: pd.DataFrame,
    *,
    driver_columns: Sequence[str],
    bins_hours: Sequence[tuple[float, float]] = DISTRIBUTED_LAG_BINS_HOURS,
    timestamp_column: str = "timestamp_utc",
    issuance_column: str = "forecast_issuance_time_utc",
    expected_cadence: str | pd.Timedelta = "5min",
) -> pd.DataFrame:
    """Aggregate drivers in disjoint causal response bins.

    Bins use lookback age ``[lower, upper)``; the final bin includes its outer
    12-hour edge.  Mean, rectangular sample integral, count and coverage are
    emitted.  The fast path uses prefix sums when availability timestamps are
    monotonic with arrival; a general causal fallback handles other timelines.
    """

    if timestamp_column not in observations.columns:
        raise ValueError(f"missing observation timestamp column: {timestamp_column}")
    if issuance_column not in observations.columns:
        raise ValueError(f"missing forecast issuance column: {issuance_column}")
    if not driver_columns:
        raise ValueError("at least one driver column is required")
    missing = set(driver_columns) - set(timeline.columns)
    if missing:
        raise ValueError(f"timeline missing driver column(s): {sorted(missing)}")
    assert_no_target_leakage(driver_columns)
    assert_causal_timeline(timeline)
    bins = _validate_bins(bins_hours)
    cadence = pd.Timedelta(expected_cadence)
    if cadence <= pd.Timedelta(0):
        raise ValueError("expected cadence must be positive")

    target = _utc_series(observations[timestamp_column])
    issuance = _utc_series(observations[issuance_column])
    timeline_columns = list(
        dict.fromkeys(
            (
                "arrival_time_bow_shock_utc",
                "source_measurement_time_l1_utc",
                "available_at_utc",
                *driver_columns,
            )
        )
    )
    ordered = timeline[timeline_columns].copy()
    ordered["_arrival"] = pd.to_datetime(
        ordered["arrival_time_bow_shock_utc"], utc=True, errors="coerce"
    )
    ordered["_available"] = pd.to_datetime(
        ordered["available_at_utc"], utc=True, errors="coerce"
    )
    ordered = ordered.dropna(subset=["_arrival", "_available"]).sort_values(
        "_arrival", kind="mergesort"
    ).reset_index(drop=True)
    arrival_ns = ordered["_arrival"].to_numpy(dtype="datetime64[ns]").astype("int64")
    available_ns = ordered["_available"].to_numpy(dtype="datetime64[ns]").astype("int64")
    monotonic_availability = bool(
        len(available_ns) < 2 or np.all(available_ns[1:] >= available_ns[:-1])
    )
    available_by_arrival = bool(
        len(available_ns) == 0 or np.all(available_ns <= arrival_ns)
    )
    target_ns = target.to_numpy(dtype="datetime64[ns]").astype("int64")
    issuance_ns = issuance.to_numpy(dtype="datetime64[ns]").astype("int64")
    invalid_observation = target.isna().to_numpy() | issuance.isna().to_numpy()
    feature_values: dict[str, np.ndarray] = {}
    generated: list[str] = []
    observation_count = len(observations)
    maximum_upper = max(upper for _, upper in bins)

    for driver in driver_columns:
        values = pd.to_numeric(ordered[driver], errors="coerce").to_numpy(dtype=float)
        valid_values = np.isfinite(values)
        prefix_sum = np.concatenate(([0.0], np.cumsum(np.where(valid_values, values, 0.0))))
        prefix_count = np.concatenate(([0], np.cumsum(valid_values.astype(np.int64))))
        for lower, upper in bins:
            width = upper - lower
            includes_outer_edge = math.isclose(upper, maximum_upper)
            samples_across_width = pd.Timedelta(hours=width) / cadence
            expected_count = max(
                1,
                int(math.ceil(samples_across_width))
                + (
                    1
                    if includes_outer_edge
                    and math.isclose(samples_across_width, round(samples_across_width))
                    else 0
                ),
            )
            means = np.full(observation_count, np.nan, dtype=float)
            integrals = np.full(observation_count, np.nan, dtype=float)
            counts = np.zeros(observation_count, dtype=np.int64)

            if len(ordered) and (monotonic_availability or available_by_arrival):
                start_boundary = target_ns - int(pd.Timedelta(hours=upper).value)
                stop_boundary = target_ns - int(pd.Timedelta(hours=lower).value)
                start_side = "left" if includes_outer_edge else "right"
                start = np.searchsorted(arrival_ns, start_boundary, side=start_side)
                stop = np.searchsorted(arrival_ns, stop_boundary, side="right")
                if not available_by_arrival:
                    available_stop = np.searchsorted(available_ns, issuance_ns, side="right")
                    stop = np.minimum(stop, available_stop)
                start = np.minimum(start, stop)
                counts = _prefix_range(prefix_count, start, stop).astype(np.int64)
                sums = _prefix_range(prefix_sum, start, stop)
                populated = counts > 0
                means[populated] = sums[populated] / counts[populated]
                integrals[populated] = sums[populated] * cadence.total_seconds() / 3_600.0
            elif len(ordered):
                for row in range(observation_count):
                    if invalid_observation[row]:
                        continue
                    age_hours = (target_ns[row] - arrival_ns) / 3.6e12
                    upper_test = age_hours <= upper if includes_outer_edge else age_hours < upper
                    eligible = (
                        (age_hours >= lower)
                        & upper_test
                        & (available_ns <= issuance_ns[row])
                        & valid_values
                    )
                    selected = values[eligible]
                    if not len(selected):
                        continue
                    counts[row] = len(selected)
                    means[row] = float(np.mean(selected))
                    integrals[row] = float(np.sum(selected) * cadence.total_seconds() / 3_600.0)

            means[invalid_observation] = np.nan
            integrals[invalid_observation] = np.nan
            counts[invalid_observation] = 0
            coverage = np.minimum(1.0, counts.astype(float) / expected_count)
            populated = counts > 0
            integrals[populated] = means[populated] * width * coverage[populated]
            for statistic, values_out in (
                ("mean", means),
                ("integral_h", integrals),
                ("count", counts),
                ("coverage_fraction", coverage),
            ):
                name = distributed_lag_feature_name(driver, statistic, lower, upper)
                feature_values[name] = values_out
                generated.append(name)

    output = observations.drop(columns=list(feature_values), errors="ignore").copy()
    output = pd.concat(
        [output, pd.DataFrame(feature_values, index=output.index)], axis=1
    )
    output.attrs.update(observations.attrs)
    output.attrs["response_features"] = {
        "schema_version": RESPONSE_SCHEMA_VERSION,
        "kind": "distributed_lag",
        "bins_hours": [list(item) for item in bins],
        "bin_boundary": "[lower, upper); final outer edge included",
        "driver_columns": list(driver_columns),
        "feature_columns": generated,
        "expected_cadence": str(cadence),
        "integral_method": "bin mean times bin width times valid-sample coverage",
        "availability_algorithm": (
            "arrival_implies_available_prefix_sum"
            if available_by_arrival
            else "monotonic_prefix_sum"
            if monotonic_availability
            else "general_causal_filter"
        ),
        "requires_availability_at_issuance": True,
    }
    return output


@dataclass(frozen=True)
class FixedLagEvaluationConfig:
    candidate_lags_hours: tuple[float, ...] = DEFAULT_FIXED_LAGS_HOURS
    selection_metric: str = "rmse_log10_rho"
    random_seed: int = DEFAULT_RANDOM_SEED
    refit_on_train_validation: bool = True
    require_complete_candidate_rows: bool = True


@dataclass
class FixedLagExperimentResult:
    driver_column: str
    selected_lag_hours: float
    selected_feature: str
    selection_metric: str
    candidate_validation: list[dict[str, object]]
    test_metrics: dict[str, object]
    train_rows: int
    validation_rows: int
    test_rows: int
    common_rows: int
    fitted_specification: ModelSpecification
    estimator: object = field(repr=False)

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": RESPONSE_SCHEMA_VERSION,
            "selection_source": "validation_only",
            "test_policy": "only the validation-selected lag is evaluated on test",
            "driver_column": self.driver_column,
            "selected_lag_hours": self.selected_lag_hours,
            "selected_feature": self.selected_feature,
            "selection_metric": self.selection_metric,
            "candidate_validation": self.candidate_validation,
            "test_metrics": self.test_metrics,
            "train_rows": self.train_rows,
            "validation_rows": self.validation_rows,
            "test_rows": self.test_rows,
            "common_rows": self.common_rows,
            "fitted_specification": asdict(self.fitted_specification),
        }


def _density_score(estimator: object, specification: ModelSpecification, frame: pd.DataFrame) -> dict[str, object]:
    residual = np.asarray(
        estimator.predict(frame[list(specification.feature_columns)]), dtype=float  # type: ignore[attr-defined]
    )
    baseline = pd.to_numeric(frame["rho_baseline_kg_m3"], errors="coerce").to_numpy(dtype=float)
    prediction = baseline * np.exp(residual)
    return density_metrics(
        frame["rho_obs_kg_m3"],
        prediction,
        baseline_density=frame["rho_baseline_kg_m3"],
        timestamps=frame["timestamp_utc"],
    )


def evaluate_fixed_lag_models(
    frame: pd.DataFrame,
    *,
    driver_column: str,
    model_specification: ModelSpecification,
    split: ChronologicalSplit,
    config: FixedLagEvaluationConfig = FixedLagEvaluationConfig(),
) -> FixedLagExperimentResult:
    """Select a fixed lag on validation, then score only that lag on test."""

    if model_specification.model_id == "M0" or model_specification.status != "available":
        raise ValueError("fixed-lag evaluation requires an available learned model specification")
    assert_chronological_split(frame, split)
    lags = _validate_lags(config.candidate_lags_hours)
    lag_features = [fixed_lag_feature_name(driver_column, lag) for lag in lags]
    missing = set(lag_features) - set(frame.columns)
    if missing:
        raise ValueError(f"fixed-lag frame missing feature(s): {sorted(missing)}")
    required = list(
        dict.fromkeys(
            [
                "timestamp_utc",
                "rho_obs_kg_m3",
                "rho_baseline_kg_m3",
                TARGET_COLUMN,
                *model_specification.feature_columns,
                *lag_features,
            ]
        )
    )
    assert_no_target_leakage([*model_specification.feature_columns, *lag_features])
    missing_required = set(required) - set(frame.columns)
    if missing_required:
        raise ValueError(f"fixed-lag frame missing column(s): {sorted(missing_required)}")

    keep = pd.Series(True, index=frame.index)
    numeric_required = set(required) - {"timestamp_utc", *model_specification.categorical_features}
    timestamp = pd.to_datetime(frame["timestamp_utc"], utc=True, errors="coerce")
    keep &= timestamp.notna()
    keep &= np.isfinite(pd.to_numeric(frame[TARGET_COLUMN], errors="coerce"))
    if config.require_complete_candidate_rows:
        for column in numeric_required:
            keep &= np.isfinite(pd.to_numeric(frame[column], errors="coerce"))
        for column in model_specification.categorical_features:
            keep &= frame[column].notna() & frame[column].astype(str).str.strip().ne("")
    keep &= pd.to_numeric(frame["rho_obs_kg_m3"], errors="coerce") > 0.0
    keep &= pd.to_numeric(frame["rho_baseline_kg_m3"], errors="coerce") > 0.0

    def retained(indices: Sequence[object]) -> list[object]:
        return [index for index in indices if index in keep.index and bool(keep.loc[index])]

    train_index = retained(split.train_index)
    validation_index = retained(split.validation_index)
    test_index = retained(split.test_index)
    if not train_index or not validation_index or not test_index:
        raise ValueError("complete fixed-lag rows must remain in train, validation and test")

    candidates: list[dict[str, object]] = []
    fitted_by_lag: dict[float, tuple[object, ModelSpecification]] = {}
    for lag, feature in zip(lags, lag_features, strict=True):
        specification = replace(
            model_specification,
            numeric_features=tuple(
                dict.fromkeys((*model_specification.numeric_features, feature))
            ),
        )
        estimator = make_model_pipeline(specification, random_seed=config.random_seed)
        estimator.fit(
            frame.loc[train_index, list(specification.feature_columns)],
            pd.to_numeric(frame.loc[train_index, TARGET_COLUMN], errors="coerce"),
        )
        metrics = _density_score(estimator, specification, frame.loc[validation_index])
        value = metrics.get(config.selection_metric)
        score = float(value) if value is not None and np.isfinite(float(value)) else math.inf
        candidates.append(
            {
                "lag_hours": lag,
                "feature": feature,
                "selection_metric": config.selection_metric,
                "selection_value": score if math.isfinite(score) else None,
                "validation_metrics": metrics,
            }
        )
        fitted_by_lag[lag] = (estimator, specification)
    available = [item for item in candidates if item["selection_value"] is not None]
    if not available:
        raise ValueError("no candidate lag produced a finite validation metric")
    selected = min(
        available,
        key=lambda item: (float(item["selection_value"]), float(item["lag_hours"])),
    )
    selected_lag = float(selected["lag_hours"])
    estimator, specification = fitted_by_lag[selected_lag]
    if config.refit_on_train_validation:
        development_index = [*train_index, *validation_index]
        estimator = make_model_pipeline(specification, random_seed=config.random_seed)
        estimator.fit(
            frame.loc[development_index, list(specification.feature_columns)],
            pd.to_numeric(frame.loc[development_index, TARGET_COLUMN], errors="coerce"),
        )
    test_metrics = _density_score(estimator, specification, frame.loc[test_index])
    return FixedLagExperimentResult(
        driver_column=driver_column,
        selected_lag_hours=selected_lag,
        selected_feature=str(selected["feature"]),
        selection_metric=config.selection_metric,
        candidate_validation=candidates,
        test_metrics=test_metrics,
        train_rows=len(train_index),
        validation_rows=len(validation_index),
        test_rows=len(test_index),
        common_rows=len(train_index) + len(validation_index) + len(test_index),
        fitted_specification=specification,
        estimator=estimator,
    )


@dataclass(frozen=True)
class RegimeBreakdownConfig:
    minimum_rows: int = 30
    permutation_repeats: int = 5
    random_seed: int = DEFAULT_RANDOM_SEED
    altitude_edges_km: tuple[float, ...] = (-math.inf, 450.0, 500.0, 550.0, math.inf)
    storm_column: str = "geomagnetic_regime"
    storm_labels: tuple[str, ...] = ()


def _importance_for_group(
    estimator: object,
    frame: pd.DataFrame,
    *,
    feature_columns: Sequence[str],
    lag_feature_columns: Sequence[str],
    target_column: str,
    config: RegimeBreakdownConfig,
) -> dict[str, object]:
    target = pd.to_numeric(frame[target_column], errors="coerce").to_numpy(dtype=float)
    valid = np.isfinite(target)
    work = frame.loc[valid].copy()
    target = target[valid]
    if len(work) < config.minimum_rows:
        return {
            "status": "unavailable",
            "reason": f"fewer than {config.minimum_rows} matched rows",
            "rows": len(work),
            "lag_importance": {},
        }
    baseline = np.asarray(
        estimator.predict(work[list(feature_columns)]), dtype=float  # type: ignore[attr-defined]
    )
    baseline_rmse = float(np.sqrt(np.mean((baseline - target) ** 2)))
    random = np.random.default_rng(config.random_seed)
    importance: dict[str, dict[str, float | int | None]] = {}
    for feature in lag_feature_columns:
        deltas: list[float] = []
        for _ in range(config.permutation_repeats):
            shuffled = work.copy()
            shuffled[feature] = random.permutation(shuffled[feature].to_numpy())
            prediction = np.asarray(
                estimator.predict(shuffled[list(feature_columns)]), dtype=float  # type: ignore[attr-defined]
            )
            rmse = float(np.sqrt(np.mean((prediction - target) ** 2)))
            deltas.append(rmse - baseline_rmse)
        importance[feature] = {
            "delta_rmse_mean": float(np.mean(deltas)),
            "delta_rmse_std": float(np.std(deltas, ddof=0)),
            "repeats": len(deltas),
        }
    return {
        "status": "available",
        "reason": None,
        "rows": len(work),
        "baseline_residual_rmse_ln": baseline_rmse,
        "lag_importance": importance,
    }


def lag_importance_breakdowns(
    estimator: object,
    frame: pd.DataFrame,
    *,
    feature_columns: Sequence[str],
    lag_feature_columns: Sequence[str],
    target_column: str = TARGET_COLUMN,
    config: RegimeBreakdownConfig = RegimeBreakdownConfig(),
) -> dict[str, object]:
    """Permutation importance overall and by explicit physical regimes.

    Expected but absent binned regimes are returned as ``unavailable``.  A
    missing dimension is also unavailable; no zero or synthetic importance is
    substituted.
    """

    required = {target_column, *feature_columns, *lag_feature_columns}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"importance frame missing column(s): {sorted(missing)}")
    if not set(lag_feature_columns).issubset(feature_columns):
        raise ValueError("lag features must be included in estimator feature columns")
    if config.minimum_rows < 1 or config.permutation_repeats < 1:
        raise ValueError("minimum_rows and permutation_repeats must be positive")

    dimensions: dict[str, dict[str, object]] = {}

    def evaluate_labels(
        dimension: str,
        labels: pd.Series | None,
        expected: Sequence[str],
        missing_reason: str | None = None,
    ) -> None:
        if labels is None:
            dimensions[dimension] = {
                "status": "unavailable",
                "reason": missing_reason or "regime source column is unavailable",
                "regimes": {},
            }
            return
        regimes: dict[str, object] = {}
        for label in expected:
            group = frame.loc[labels.astype("object").eq(label)]
            regimes[label] = _importance_for_group(
                estimator,
                group,
                feature_columns=feature_columns,
                lag_feature_columns=lag_feature_columns,
                target_column=target_column,
                config=config,
            )
        dimensions[dimension] = {
            "status": (
                "available"
                if any(item.get("status") == "available" for item in regimes.values())  # type: ignore[union-attr]
                else "unavailable"
            ),
            "reason": None if regimes else "no regime labels are available",
            "regimes": regimes,
        }

    if "latitude_deg" in frame.columns:
        latitude = pd.to_numeric(frame["latitude_deg"], errors="coerce").abs()
        latitude_labels = pd.cut(
            latitude,
            bins=[-0.001, 30.0, 60.0, 90.001],
            labels=["equatorial", "mid-latitude", "high-latitude"],
            include_lowest=True,
            right=False,
        ).astype("object")
        evaluate_labels(
            "latitude",
            latitude_labels,
            ("equatorial", "mid-latitude", "high-latitude"),
        )
    else:
        evaluate_labels("latitude", None, (), "latitude_deg is unavailable")

    if "local_solar_time_h" in frame.columns:
        local_time = pd.to_numeric(frame["local_solar_time_h"], errors="coerce") % 24.0
        local_labels = pd.Series(
            np.select(
                [
                    (local_time >= 3.0) & (local_time < 9.0),
                    (local_time >= 9.0) & (local_time < 15.0),
                    (local_time >= 15.0) & (local_time < 21.0),
                ],
                ["dawn", "day", "dusk"],
                default="night",
            ),
            index=frame.index,
        ).where(local_time.notna())
        evaluate_labels("local_solar_time", local_labels, ("night", "dawn", "day", "dusk"))
    else:
        evaluate_labels("local_solar_time", None, (), "local_solar_time_h is unavailable")

    if "altitude_km" in frame.columns:
        altitude = pd.to_numeric(frame["altitude_km"], errors="coerce")
        edges = config.altitude_edges_km
        if len(edges) < 2 or any(right <= left for left, right in zip(edges, edges[1:])):
            raise ValueError("altitude edges must be strictly increasing")
        altitude_names = tuple(
            f"{_number_label(left)}to{_number_label(right)}km" for left, right in zip(edges, edges[1:])
        )
        altitude_labels = pd.cut(
            altitude, bins=list(edges), labels=list(altitude_names), include_lowest=True, right=False
        ).astype("object")
        evaluate_labels("altitude", altitude_labels, altitude_names)
    else:
        evaluate_labels("altitude", None, (), "altitude_km is unavailable")

    if config.storm_column in frame.columns:
        storm = frame[config.storm_column].astype("object")
        observed_labels = tuple(str(value) for value in storm.dropna().drop_duplicates())
        expected_storm = config.storm_labels or observed_labels
        evaluate_labels("storm", storm.astype(str).where(storm.notna()), expected_storm)
    else:
        evaluate_labels("storm", None, (), f"{config.storm_column} is unavailable")

    return {
        "schema_version": RESPONSE_SCHEMA_VERSION,
        "metric": "permutation increase in natural-log residual RMSE",
        "overall": _importance_for_group(
            estimator,
            frame,
            feature_columns=feature_columns,
            lag_feature_columns=lag_feature_columns,
            target_column=target_column,
            config=config,
        ),
        "dimensions": dimensions,
    }


__all__ = [
    "DEFAULT_FIXED_LAGS_HOURS",
    "DISTRIBUTED_LAG_BINS_HOURS",
    "FixedLagEvaluationConfig",
    "FixedLagExperimentResult",
    "RESPONSE_SCHEMA_VERSION",
    "RegimeBreakdownConfig",
    "build_distributed_lag_features",
    "build_fixed_lag_features",
    "distributed_lag_feature_name",
    "evaluate_fixed_lag_models",
    "fixed_lag_feature_name",
    "lag_importance_breakdowns",
]
