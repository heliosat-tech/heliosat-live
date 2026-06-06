from __future__ import annotations

import pickle
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .metrics import regression_metrics
from .validators import FoldSplit


RIDGE_ALPHAS = [0.01, 0.1, 1.0, 10.0, 100.0]
LIGHTGBM_DEFAULTS = {
    "num_leaves": 31,
    "learning_rate": 0.05,
    "n_estimators": 500,
    "min_child_samples": 20,
    "reg_alpha": 0.1,
    "reg_lambda": 0.1,
    "random_state": 42,
}
L1_TO_EARTH_DISTANCE_KM = 1_500_000.0
MRU_ASOF_TOLERANCE = pd.Timedelta(minutes=5)


@dataclass
class TrainedModelResult:
    model_name: str
    metrics_global: dict[str, Any]
    metrics_per_fold: list[dict[str, Any]]
    predictions: pd.DataFrame
    hyperparams: dict[str, Any]
    feature_importance: list[dict[str, float]]
    model_artifact_path: str | None
    n_train_samples: int
    n_val_samples: int


def _artifact_path(root: Path, experiment_id: str, run_id: str, suffix: str) -> Path:
    path = root / experiment_id / f"{run_id}{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _prediction_frame(frame: pd.DataFrame, split: FoldSplit, y_pred: np.ndarray) -> pd.DataFrame:
    values = frame.loc[split.val_index, ["timestamp_utc", "y"]].copy()
    values["fold"] = split.fold
    values["split"] = "validation"
    values["y_pred"] = y_pred
    values["residual"] = values["y_pred"] - values["y"]
    return values.rename(columns={"y": "y_true"})


def _normalize_column_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _l1_columns(frame: pd.DataFrame) -> list[tuple[str, str]]:
    return [
        (column, _normalize_column_name(column).removeprefix("l1_"))
        for column in frame.columns
        if column.lower().startswith("l1__")
    ]


def _find_l1_speed_column(frame: pd.DataFrame) -> str | None:
    exact_names = {
        "v",
        "vp",
        "speed",
        "flow_speed",
        "bulk_speed",
        "proton_speed",
        "solar_wind_speed",
        "plasma_speed",
    }

    for column, tail in _l1_columns(frame):
        if tail in exact_names:
            return column

    for column, tail in _l1_columns(frame):
        if any(token in tail for token in ("speed", "bulk", "flow")) or tail.endswith("_vp"):
            return column

    return None


def _find_l1_component_column(frame: pd.DataFrame, candidates: tuple[str, ...]) -> str | None:
    for column, tail in _l1_columns(frame):
        for candidate in candidates:
            if tail == candidate or tail.startswith(f"{candidate}_") or tail.endswith(f"_{candidate}") or f"_{candidate}_" in tail:
                return column

    return None


def _find_l1_magnetic_signal(frame: pd.DataFrame) -> tuple[pd.Series, str]:
    target_column = str(frame.attrs.get("target_column", ""))

    if not any(token in target_column.lower() for token in ("mag", "magnetic", "h_magnitude")):
        raise ValueError("MRU propagation currently requires a magnetic target and L1 magnetic field measurements.")

    exact_magnitude_names = {
        "b",
        "bt",
        "abs_b",
        "b_mag",
        "b_magnitude",
        "b_total",
        "btotal",
        "magnetic_field_magnitude",
        "field_magnitude",
    }

    for column, tail in _l1_columns(frame):
        if tail in exact_magnitude_names:
            return frame[column].astype(float), column

    for column, tail in _l1_columns(frame):
        if any(token in tail for token in ("b_magnitude", "abs_b", "magnetic_field_magnitude")):
            return frame[column].astype(float), column

    bx = _find_l1_component_column(frame, ("bx", "b_x", "br", "gsm_x", "gse_x"))
    by = _find_l1_component_column(frame, ("by", "b_y", "gsm_y", "gse_y"))
    bz = _find_l1_component_column(frame, ("bz", "b_z", "bn", "gsm_z", "gse_z"))

    if bx and by and bz:
        signal = (frame[bx].astype(float) ** 2 + frame[by].astype(float) ** 2 + frame[bz].astype(float) ** 2) ** 0.5
        return signal, f"sqrt({bx}^2+{by}^2+{bz}^2)"

    raise ValueError("MRU propagation requires L1 magnetic magnitude or BX/BY/BZ components.")


def _mru_prediction_frame(frame: pd.DataFrame, split: FoldSplit) -> tuple[pd.DataFrame, dict[str, Any]]:
    speed_column = _find_l1_speed_column(frame)

    if speed_column is None:
        raise ValueError("MRU propagation requires an L1 solar wind speed column.")

    signal, signal_source = _find_l1_magnetic_signal(frame)
    timestamps = pd.to_datetime(frame["timestamp_utc"], utc=True)
    speed = frame[speed_column].astype(float).abs()
    valid_source = speed.gt(0) & np.isfinite(speed) & signal.notna()
    transit_minutes = L1_TO_EARTH_DISTANCE_KM / speed[valid_source] / 60.0
    propagation = pd.DataFrame({
        "arrival_utc": timestamps[valid_source] + pd.to_timedelta(transit_minutes, unit="min"),
        "y_pred": signal[valid_source].astype(float),
    }).sort_values("arrival_utc")

    if propagation.empty:
        raise ValueError("MRU propagation could not build any finite arrival-time predictions.")

    horizon_minutes = int(frame.attrs.get("horizon_minutes") or 0)
    values = frame.loc[split.val_index, ["timestamp_utc", "y"]].copy()
    values["timestamp_utc"] = pd.to_datetime(values["timestamp_utc"], utc=True) + pd.to_timedelta(horizon_minutes, unit="min")
    values["fold"] = split.fold
    values["split"] = "validation"
    lookup = values[["timestamp_utc"]].rename(columns={"timestamp_utc": "arrival_utc"}).copy()
    lookup["row_order"] = np.arange(len(lookup))
    merged = pd.merge_asof(
        lookup.sort_values("arrival_utc"),
        propagation,
        on="arrival_utc",
        direction="nearest",
        tolerance=MRU_ASOF_TOLERANCE,
    ).sort_values("row_order")

    values["y_pred"] = merged["y_pred"].to_numpy()
    values["residual"] = values["y_pred"] - values["y"]
    values = values.dropna(subset=["y", "y_pred"])

    metadata = {
        "speed_column": speed_column,
        "signal_source": signal_source,
        "distance_km": L1_TO_EARTH_DISTANCE_KM,
        "arrival_tolerance_minutes": MRU_ASOF_TOLERANCE.total_seconds() / 60.0,
    }

    return values.rename(columns={"y": "y_true"}), metadata


def train_mru_propagation(
    frame: pd.DataFrame,
    splits: list[FoldSplit],
    run_id: str,
    experiment_id: str,
    artifact_root: Path,
    persistence_rmse: float | None,
) -> TrainedModelResult:
    predictions = []
    metrics_per_fold = []
    metadata: dict[str, Any] = {}

    for split in splits:
        fold_predictions, metadata = _mru_prediction_frame(frame, split)
        predictions.append(fold_predictions)
        metrics_per_fold.append({
            "fold": split.fold,
            **regression_metrics(fold_predictions["y_true"], fold_predictions["y_pred"], persistence_rmse),
        })

    prediction_frame = pd.concat(predictions, ignore_index=True) if predictions else pd.DataFrame(
        columns=["timestamp_utc", "fold", "split", "y_true", "y_pred", "residual"],
    )
    metrics_global = regression_metrics(prediction_frame["y_true"], prediction_frame["y_pred"], persistence_rmse)

    return TrainedModelResult(
        model_name="mru_propagation",
        metrics_global=metrics_global,
        metrics_per_fold=metrics_per_fold,
        predictions=prediction_frame,
        hyperparams={
            "method": "constant-velocity L1-to-Earth propagation",
            **metadata,
        },
        feature_importance=[],
        model_artifact_path=None,
        n_train_samples=0,
        n_val_samples=len(prediction_frame),
    )


def train_persistence(
    frame: pd.DataFrame,
    splits: list[FoldSplit],
    run_id: str,
    experiment_id: str,
    artifact_root: Path,
    persistence_rmse: float | None = None,
) -> TrainedModelResult:
    predictions = []
    metrics_per_fold = []
    n_train = 0
    n_val = 0

    for split in splits:
        y_pred = frame.loc[split.val_index, "y_current"].to_numpy(dtype=float)
        fold_predictions = _prediction_frame(frame, split, y_pred)
        predictions.append(fold_predictions)
        metrics_per_fold.append({
            "fold": split.fold,
            **regression_metrics(fold_predictions["y_true"], fold_predictions["y_pred"], persistence_rmse),
        })
        n_train += len(split.train_index)
        n_val += len(split.val_index)

    prediction_frame = pd.concat(predictions, ignore_index=True)
    metrics_global = regression_metrics(prediction_frame["y_true"], prediction_frame["y_pred"], persistence_rmse)

    return TrainedModelResult(
        model_name="persistence",
        metrics_global=metrics_global,
        metrics_per_fold=metrics_per_fold,
        predictions=prediction_frame,
        hyperparams={},
        feature_importance=[],
        model_artifact_path=None,
        n_train_samples=n_train,
        n_val_samples=n_val,
    )


def train_ridge(
    frame: pd.DataFrame,
    splits: list[FoldSplit],
    feature_columns: list[str],
    run_id: str,
    experiment_id: str,
    artifact_root: Path,
    persistence_rmse: float | None,
) -> TrainedModelResult:
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    predictions = []
    metrics_per_fold = []
    n_train = 0
    n_val = 0
    best_models: list[tuple[float, Pipeline]] = []

    for split in splits:
        x_train = frame.loc[split.train_index, feature_columns]
        y_train = frame.loc[split.train_index, "y"]
        x_val = frame.loc[split.val_index, feature_columns]
        y_val = frame.loc[split.val_index, "y"]
        fold_candidates = []

        for alpha in RIDGE_ALPHAS:
            model = Pipeline([
                ("scaler", StandardScaler()),
                ("ridge", Ridge(alpha=alpha)),
            ])
            model.fit(x_train, y_train)
            candidate_pred = model.predict(x_val)
            metrics = regression_metrics(y_val, candidate_pred, persistence_rmse)
            fold_candidates.append((float(metrics["rmse"] or float("inf")), alpha, model, candidate_pred, metrics))

        _, alpha, best_model, y_pred, metrics = min(fold_candidates, key=lambda item: item[0])
        fold_predictions = _prediction_frame(frame, split, y_pred)
        predictions.append(fold_predictions)
        metrics_per_fold.append({"fold": split.fold, "alpha": alpha, **metrics})
        best_models.append((alpha, best_model))
        n_train += len(split.train_index)
        n_val += len(split.val_index)

    prediction_frame = pd.concat(predictions, ignore_index=True)
    metrics_global = regression_metrics(prediction_frame["y_true"], prediction_frame["y_pred"], persistence_rmse)
    artifact = _artifact_path(artifact_root, experiment_id, run_id, ".pkl")

    with artifact.open("wb") as handle:
        pickle.dump({"fold_models": best_models, "feature_columns": feature_columns}, handle)

    return TrainedModelResult(
        model_name="ridge",
        metrics_global=metrics_global,
        metrics_per_fold=metrics_per_fold,
        predictions=prediction_frame,
        hyperparams={"alpha_grid": RIDGE_ALPHAS},
        feature_importance=[],
        model_artifact_path=str(artifact),
        n_train_samples=n_train,
        n_val_samples=n_val,
    )


def train_lightgbm(
    frame: pd.DataFrame,
    splits: list[FoldSplit],
    feature_columns: list[str],
    run_id: str,
    experiment_id: str,
    artifact_root: Path,
    persistence_rmse: float | None,
) -> TrainedModelResult:
    import lightgbm as lgb

    predictions = []
    metrics_per_fold = []
    importances = np.zeros(len(feature_columns), dtype=float)
    models = []
    n_train = 0
    n_val = 0

    for split in splits:
        x_train = frame.loc[split.train_index, feature_columns]
        y_train = frame.loc[split.train_index, "y"]
        x_val = frame.loc[split.val_index, feature_columns]
        y_val = frame.loc[split.val_index, "y"]
        model = lgb.LGBMRegressor(**LIGHTGBM_DEFAULTS)
        model.fit(
            x_train,
            y_train,
            eval_set=[(x_val, y_val)],
            eval_metric="rmse",
            callbacks=[lgb.early_stopping(50, verbose=False)],
        )
        y_pred = model.predict(x_val)
        fold_predictions = _prediction_frame(frame, split, y_pred)
        predictions.append(fold_predictions)
        metrics_per_fold.append({
            "fold": split.fold,
            "best_iteration": int(getattr(model, "best_iteration_", 0) or LIGHTGBM_DEFAULTS["n_estimators"]),
            **regression_metrics(fold_predictions["y_true"], fold_predictions["y_pred"], persistence_rmse),
        })
        importances += model.feature_importances_
        models.append(model)
        n_train += len(split.train_index)
        n_val += len(split.val_index)

    prediction_frame = pd.concat(predictions, ignore_index=True)
    metrics_global = regression_metrics(prediction_frame["y_true"], prediction_frame["y_pred"], persistence_rmse)
    artifact = _artifact_path(artifact_root, experiment_id, run_id, ".lgb.pkl")
    top_importance = sorted(
        (
            {"feature": feature, "importance": float(importance)}
            for feature, importance in zip(feature_columns, importances / max(1, len(splits)), strict=True)
        ),
        key=lambda item: item["importance"],
        reverse=True,
    )[:20]

    with artifact.open("wb") as handle:
        pickle.dump({"fold_models": models, "feature_columns": feature_columns}, handle)

    return TrainedModelResult(
        model_name="lightgbm",
        metrics_global=metrics_global,
        metrics_per_fold=metrics_per_fold,
        predictions=prediction_frame,
        hyperparams=LIGHTGBM_DEFAULTS,
        feature_importance=top_importance,
        model_artifact_path=str(artifact),
        n_train_samples=n_train,
        n_val_samples=n_val,
    )
