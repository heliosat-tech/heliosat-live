"""Chronological M0--M4 density-residual experiments and artifacts.

The module deliberately has no random row-level split.  Every learned model is
an sklearn pipeline whose imputers, encoders and scalers are fitted only on the
training partition.  All active models are evaluated on one exact matched-row
set; unavailable M4 inputs are reported rather than synthesized.
"""

from __future__ import annotations

import json
import hashlib
import importlib.metadata
import math
import os
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Literal, Mapping, Sequence

import joblib
import numpy as np
import pandas as pd

from .features import (
    CATEGORICAL_CONTEXT_FEATURES,
    FEATURE_SCHEMA_VERSION,
    IDENTITY_LINEAGE_COLUMNS,
    TARGET_COLUMN,
    TARGET_DEFINITION,
    FeatureDatasetMetadata,
    assert_no_target_leakage,
    feature_columns_by_group,
    issuance_safe_geomagnetic_features,
)
from .metrics import EventWindow, block_bootstrap_density_metrics, density_metrics

MODEL_ARTIFACT_SCHEMA_VERSION = "leo-density-model-artifact-v1"
STUDY_SCHEMA_VERSION = "leo-density-study-v1"
DEFAULT_RANDOM_SEED = 42

ModelId = Literal["M0", "M1", "M2", "M3", "M4", "M5"]
ModelStatus = Literal["available", "unavailable", "error"]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso(value: object) -> str | None:
    if value is None or pd.isna(value):
        return None
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp.isoformat().replace("+00:00", "Z")


def _json_safe(value: object) -> object:
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


def _atomic_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(_json_safe(payload), indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _git_revision() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        revision = result.stdout.strip()
        return revision or None
    except (OSError, subprocess.SubprocessError):
        return None


def _git_code_state() -> dict[str, object]:
    revision = _git_revision()
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain=v1"], check=True, capture_output=True,
            timeout=10,
        ).stdout
        diff = subprocess.run(
            ["git", "diff", "--binary", "HEAD"], check=True, capture_output=True,
            timeout=20,
        ).stdout
        untracked_output = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard", "-z"],
            check=True, capture_output=True, timeout=10,
        ).stdout
        digest = hashlib.sha256()
        digest.update(diff)
        for raw_path in sorted(item for item in untracked_output.split(b"\0") if item):
            digest.update(raw_path)
            path = Path(os.fsdecode(raw_path))
            if path.is_file():
                digest.update(path.read_bytes())
        return {
            "git_revision": revision,
            "dirty": bool(status.strip()),
            "working_tree_sha256": digest.hexdigest(),
            "status_sha256": hashlib.sha256(status).hexdigest(),
        }
    except (OSError, subprocess.SubprocessError):
        return {
            "git_revision": revision,
            "dirty": None,
            "working_tree_sha256": None,
            "status_sha256": None,
        }


def _runtime_versions() -> dict[str, str]:
    versions = {"python": sys.version.split()[0]}
    for distribution in (
        "numpy", "pandas", "pyarrow", "scikit-learn", "joblib", "scipy", "pymsis"
    ):
        try:
            versions[distribution] = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            versions[distribution] = "unavailable"
    return versions


@dataclass(frozen=True)
class ModelSpecification:
    model_id: ModelId
    label: str
    algorithm: str
    feature_group: str
    numeric_features: tuple[str, ...] = ()
    categorical_features: tuple[str, ...] = ()
    status: ModelStatus = "available"
    unavailable_reason: str | None = None
    deployable: bool = True

    @property
    def feature_columns(self) -> tuple[str, ...]:
        return self.numeric_features + self.categorical_features


@dataclass(frozen=True)
class MatchedRowsReport:
    input_rows: int
    matched_rows: int
    rejected_rows: int
    active_models: tuple[ModelId, ...]
    required_features: tuple[str, ...]
    rejection_counts: dict[str, int]


@dataclass(frozen=True)
class ChronologicalSplit:
    train_index: tuple[object, ...]
    validation_index: tuple[object, ...]
    test_index: tuple[object, ...]
    train_start_utc: str
    train_stop_utc: str
    validation_start_utc: str
    validation_stop_utc: str
    test_start_utc: str
    test_stop_utc: str

    def to_dict(self) -> dict[str, object]:
        return {
            "method": "chronological",
            "train": {
                "start_utc": self.train_start_utc,
                "stop_utc": self.train_stop_utc,
                "rows": len(self.train_index),
            },
            "validation": {
                "start_utc": self.validation_start_utc,
                "stop_utc": self.validation_stop_utc,
                "rows": len(self.validation_index),
            },
            "test": {
                "start_utc": self.test_start_utc,
                "stop_utc": self.test_stop_utc,
                "rows": len(self.test_index),
            },
        }


@dataclass(frozen=True)
class WalkForwardSplit:
    validation_year: int
    train_index: tuple[object, ...]
    validation_index: tuple[object, ...]
    train_start_utc: str
    train_stop_utc: str
    validation_start_utc: str
    validation_stop_utc: str

    def to_dict(self) -> dict[str, object]:
        return {
            "validation_year": self.validation_year,
            "train_start_utc": self.train_start_utc,
            "train_stop_utc": self.train_stop_utc,
            "validation_start_utc": self.validation_start_utc,
            "validation_stop_utc": self.validation_stop_utc,
            "train_rows": len(self.train_index),
            "validation_rows": len(self.validation_index),
        }


@dataclass
class ModelRunResult:
    model_id: ModelId
    label: str
    status: ModelStatus
    feature_group: str
    algorithm: str
    feature_columns: list[str]
    matched_rows: int
    train_rows: int
    validation_rows: int
    test_rows: int
    validation_metrics: dict[str, object] | None
    test_metrics: dict[str, object] | None
    bootstrap: dict[str, object] | None
    artifact: str | None
    predictions_artifact: str | None
    warning: str | None = None
    deployable: bool = True

    def to_dict(self) -> dict[str, object]:
        return _json_safe(asdict(self))  # type: ignore[return-value]


@dataclass
class ModelSuiteResult:
    run_id: str
    generated_at_utc: str
    experiment_mode: str
    dataset_version: str
    feature_schema_version: str
    split: ChronologicalSplit
    matched_rows: MatchedRowsReport
    models: list[ModelRunResult]
    artifact_root: str | None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "run_id": self.run_id,
            "generated_at_utc": self.generated_at_utc,
            "experiment_mode": self.experiment_mode,
            "dataset_version": self.dataset_version,
            "feature_schema_version": self.feature_schema_version,
            "split": self.split.to_dict(),
            "matched_rows": asdict(self.matched_rows),
            "models": [model.to_dict() for model in self.models],
            "artifact_root": self.artifact_root,
            "warnings": self.warnings,
        }


def _metadata_payload(
    frame: pd.DataFrame,
    metadata: FeatureDatasetMetadata | Mapping[str, object] | None,
) -> Mapping[str, object]:
    if isinstance(metadata, FeatureDatasetMetadata):
        return metadata.to_dict()
    if isinstance(metadata, Mapping):
        return metadata
    payload = frame.attrs.get("feature_dataset_metadata")
    return payload if isinstance(payload, Mapping) else {}


def build_model_specifications(
    frame: pd.DataFrame,
    metadata: FeatureDatasetMetadata | Mapping[str, object] | None = None,
    *,
    include_identity_diagnostic: bool = True,
) -> list[ModelSpecification]:
    """Build mission-agnostic M0--M4 plus optional non-deployable M5.

    Mission and spacecraft identifiers remain in the table for lineage and
    held-out validation, but only M5 may consume them.  M5 is intentionally an
    identity-only diagnostic: it measures how much apparent skill can be
    obtained from category biases without claiming physical generalisation.
    """

    groups = feature_columns_by_group(frame, metadata)
    context = [
        column
        for column in dict.fromkeys(groups["context"] + groups["baseline"])
        if column not in IDENTITY_LINEAGE_COLUMNS
    ]
    categorical = [column for column in context if column in CATEGORICAL_CONTEXT_FEATURES]
    numeric = [column for column in context if column not in categorical]
    drivers = list(dict.fromkeys(groups["solar_wind"]))

    payload = _metadata_payload(frame, metadata)
    geomagnetic_availability = payload.get("geomagnetic_availability") or frame.attrs.get(
        "geomagnetic_availability", {}
    )
    if not isinstance(geomagnetic_availability, Mapping):
        geomagnetic_availability = {}
    safe_geomagnetic = issuance_safe_geomagnetic_features(
        frame,
        geomagnetic_availability,  # type: ignore[arg-type]
    )

    specifications: list[ModelSpecification] = [
        ModelSpecification(
            "M0",
            "M0 empirical atmosphere baseline",
            "atmosphere baseline (no learned estimator)",
            "baseline",
        ),
        ModelSpecification(
            "M1",
            "M1 baseline plus linear residual correction",
            "sklearn Ridge",
            "baseline + orbital/solar context",
            tuple(numeric),
            tuple(categorical),
            status="available" if numeric or categorical else "unavailable",
            unavailable_reason=None if numeric or categorical else "no context features are available",
        ),
        ModelSpecification(
            "M2",
            "M2 baseline plus tree residual correction",
            "sklearn HistGradientBoostingRegressor (absolute_error)",
            "baseline + orbital/solar context",
            tuple(numeric),
            tuple(categorical),
            status="available" if numeric or categorical else "unavailable",
            unavailable_reason=None if numeric or categorical else "no context features are available",
        ),
        ModelSpecification(
            "M3",
            "M3 baseline plus causal L1 drivers",
            "sklearn HistGradientBoostingRegressor (absolute_error)",
            "baseline + context + causal L1 drivers",
            tuple(numeric + drivers),
            tuple(categorical),
            status="available" if drivers else "unavailable",
            unavailable_reason=None if drivers else "no causal L1 driver features are available",
        ),
        ModelSpecification(
            "M4",
            "M4 baseline plus L1 and issuance-safe geomagnetic history",
            "sklearn HistGradientBoostingRegressor (absolute_error)",
            "baseline + context + causal L1 + issuance-safe geomagnetic history",
            tuple(numeric + drivers + safe_geomagnetic),
            tuple(categorical),
            status="available" if drivers and safe_geomagnetic else "unavailable",
            unavailable_reason=(
                None
                if drivers and safe_geomagnetic
                else "no geomagnetic feature has an issuance-safe label and causal availability timestamp"
                if drivers
                else "no causal L1 driver features are available"
            ),
        ),
    ]
    if include_identity_diagnostic:
        identity = tuple(
            column for column in ("mission", "spacecraft_id")
            if column in frame.columns
        )
        specifications.append(
            ModelSpecification(
                "M5",
                "M5 full causal plus identity retrospective diagnostic",
                "sklearn HistGradientBoostingRegressor (absolute_error)",
                "non-deployable full causal model with mission/spacecraft identity",
                tuple(numeric + drivers),
                tuple(dict.fromkeys([*categorical, *identity])),
                status="available" if identity and drivers else "unavailable",
                unavailable_reason=(
                    None if identity and drivers
                    else "mission/spacecraft identity or causal L1 drivers are unavailable"
                ),
                deployable=False,
            )
        )
    for specification in specifications:
        assert_no_target_leakage(specification.feature_columns)
    return specifications


def prepare_matched_rows(
    frame: pd.DataFrame,
    specifications: Sequence[ModelSpecification],
    *,
    require_complete_features: bool = True,
) -> tuple[pd.DataFrame, MatchedRowsReport]:
    """Select one exact row set shared by every available M0--M4 model."""

    required = {"timestamp_utc", "rho_obs_kg_m3", "rho_baseline_kg_m3", TARGET_COLUMN}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"model dataset missing column(s): {sorted(missing)}")
    active = [specification for specification in specifications if specification.status == "available"]
    feature_columns = list(
        dict.fromkeys(column for specification in active for column in specification.feature_columns)
    )
    categorical_feature_columns = {
        column for specification in active for column in specification.categorical_features
    }
    assert_no_target_leakage(feature_columns)

    timestamp = pd.to_datetime(frame["timestamp_utc"], utc=True, errors="coerce")
    observed = pd.to_numeric(frame["rho_obs_kg_m3"], errors="coerce")
    baseline = pd.to_numeric(frame["rho_baseline_kg_m3"], errors="coerce")
    target = pd.to_numeric(frame[TARGET_COLUMN], errors="coerce")
    conditions: dict[str, pd.Series] = {
        "invalid_timestamp": timestamp.isna(),
        "invalid_observed_density": ~np.isfinite(observed) | (observed <= 0.0),
        "invalid_baseline_density": ~np.isfinite(baseline) | (baseline <= 0.0),
        "invalid_residual_target": ~np.isfinite(target),
    }
    if any(specification.model_id in {"M3", "M4"} for specification in active):
        if "driver_join_status" in frame.columns:
            conditions["missing_causal_driver_join"] = ~frame["driver_join_status"].eq("matched")
    if require_complete_features:
        for column in feature_columns:
            if column not in frame.columns:
                conditions[f"missing_feature:{column}"] = pd.Series(True, index=frame.index)
            elif column in categorical_feature_columns:
                values = frame[column]
                conditions[f"missing_feature:{column}"] = values.isna() | values.astype(str).str.strip().eq("")
            else:
                values = pd.to_numeric(frame[column], errors="coerce")
                conditions[f"missing_feature:{column}"] = ~np.isfinite(values)

    rejected = pd.Series(False, index=frame.index)
    for condition in conditions.values():
        rejected |= condition.fillna(True)
    matched = frame.loc[~rejected].copy()
    matched["timestamp_utc"] = timestamp.loc[~rejected]
    matched = matched.sort_values("timestamp_utc", kind="mergesort")
    report = MatchedRowsReport(
        input_rows=len(frame),
        matched_rows=len(matched),
        rejected_rows=int(rejected.sum()),
        active_models=tuple(specification.model_id for specification in active),
        required_features=tuple(feature_columns),
        rejection_counts={name: int(condition.fillna(True).sum()) for name, condition in conditions.items()},
    )
    matched.attrs.update(frame.attrs)
    matched.attrs["matched_rows_report"] = asdict(report)
    return matched, report


def chronological_split(
    frame: pd.DataFrame,
    *,
    timestamp_column: str = "timestamp_utc",
    train_fraction: float = 0.6,
    validation_fraction: float = 0.2,
) -> ChronologicalSplit:
    """Split by ordered unique timestamps, never by randomized rows."""

    if frame.empty:
        raise ValueError("cannot split an empty dataset")
    if train_fraction <= 0.0 or validation_fraction <= 0.0 or train_fraction + validation_fraction >= 1.0:
        raise ValueError("train/validation fractions must be positive and leave a test interval")
    if timestamp_column not in frame.columns:
        raise ValueError(f"missing timestamp column: {timestamp_column}")
    timestamps = pd.to_datetime(frame[timestamp_column], utc=True, errors="coerce")
    if timestamps.isna().any():
        raise ValueError("chronological split timestamps contain invalid values")
    unique_times = pd.DatetimeIndex(timestamps.sort_values().unique())
    if len(unique_times) < 3:
        raise ValueError("chronological split requires at least three unique timestamps")

    train_cut = max(1, min(len(unique_times) - 2, int(math.floor(len(unique_times) * train_fraction))))
    validation_cut = max(
        train_cut + 1,
        min(
            len(unique_times) - 1,
            int(math.floor(len(unique_times) * (train_fraction + validation_fraction))),
        ),
    )
    validation_start = unique_times[train_cut]
    test_start = unique_times[validation_cut]
    train_mask = timestamps < validation_start
    validation_mask = (timestamps >= validation_start) & (timestamps < test_start)
    test_mask = timestamps >= test_start
    if not train_mask.any() or not validation_mask.any() or not test_mask.any():
        raise ValueError("chronological split produced an empty partition")

    split = ChronologicalSplit(
        train_index=tuple(frame.index[train_mask]),
        validation_index=tuple(frame.index[validation_mask]),
        test_index=tuple(frame.index[test_mask]),
        train_start_utc=_iso(timestamps.loc[train_mask].min()) or "",
        train_stop_utc=_iso(timestamps.loc[train_mask].max()) or "",
        validation_start_utc=_iso(timestamps.loc[validation_mask].min()) or "",
        validation_stop_utc=_iso(timestamps.loc[validation_mask].max()) or "",
        test_start_utc=_iso(timestamps.loc[test_mask].min()) or "",
        test_stop_utc=_iso(timestamps.loc[test_mask].max()) or "",
    )
    assert_chronological_split(frame, split, timestamp_column=timestamp_column)
    return split


def assert_chronological_split(
    frame: pd.DataFrame,
    split: ChronologicalSplit,
    *,
    timestamp_column: str = "timestamp_utc",
) -> None:
    partitions = [set(split.train_index), set(split.validation_index), set(split.test_index)]
    if partitions[0] & partitions[1] or partitions[0] & partitions[2] or partitions[1] & partitions[2]:
        raise AssertionError("chronological partitions overlap")
    timestamp = pd.to_datetime(frame[timestamp_column], utc=True, errors="coerce")
    train = timestamp.loc[list(split.train_index)]
    validation = timestamp.loc[list(split.validation_index)]
    test = timestamp.loc[list(split.test_index)]
    if train.empty or validation.empty or test.empty:
        raise AssertionError("chronological partition is empty")
    if not (train.max() < validation.min() and validation.max() < test.min()):
        raise AssertionError("held-out intervals are not strictly after training")


def year_walk_forward_splits(
    frame: pd.DataFrame,
    *,
    timestamp_column: str = "timestamp_utc",
    minimum_train_rows: int = 1,
) -> list[WalkForwardSplit]:
    """Train on all prior years and validate on the next complete year."""

    if frame.empty:
        raise ValueError("cannot build walk-forward splits from an empty dataset")
    timestamp = pd.to_datetime(frame[timestamp_column], utc=True, errors="coerce")
    if timestamp.isna().any():
        raise ValueError("walk-forward timestamps contain invalid values")
    years = sorted(int(year) for year in timestamp.dt.year.unique())
    splits: list[WalkForwardSplit] = []
    for year in years[1:]:
        train_mask = timestamp.dt.year < year
        validation_mask = timestamp.dt.year == year
        if int(train_mask.sum()) < minimum_train_rows or not validation_mask.any():
            continue
        splits.append(
            WalkForwardSplit(
                validation_year=year,
                train_index=tuple(frame.index[train_mask]),
                validation_index=tuple(frame.index[validation_mask]),
                train_start_utc=_iso(timestamp.loc[train_mask].min()) or "",
                train_stop_utc=_iso(timestamp.loc[train_mask].max()) or "",
                validation_start_utc=_iso(timestamp.loc[validation_mask].min()) or "",
                validation_stop_utc=_iso(timestamp.loc[validation_mask].max()) or "",
            )
        )
    if not splits:
        raise ValueError("year walk-forward requires at least two represented years")
    return splits


def event_holdout_indices(
    frame: pd.DataFrame,
    holdout_event_ids: Iterable[str],
    *,
    event_column: str = "event_id",
) -> tuple[tuple[object, ...], tuple[object, ...]]:
    """Return development/test indices with entire named events held out."""

    if event_column not in frame.columns:
        raise ValueError(f"missing event identifier column: {event_column}")
    held_out = {str(value) for value in holdout_event_ids}
    if not held_out:
        raise ValueError("at least one event must be held out")
    test_mask = frame[event_column].astype(str).isin(held_out)
    if not test_mask.any() or test_mask.all():
        raise ValueError("event holdout must leave non-empty development and test rows")
    return tuple(frame.index[~test_mask]), tuple(frame.index[test_mask])


def mission_holdout_indices(
    frame: pd.DataFrame,
    holdout_mission: str,
    *,
    mission_column: str = "mission",
) -> tuple[tuple[object, ...], tuple[object, ...]]:
    """Return a cross-mission transfer split without mixing the held-out mission."""

    if mission_column not in frame.columns:
        raise ValueError(f"missing mission column: {mission_column}")
    test_mask = frame[mission_column].astype(str).eq(str(holdout_mission))
    if not test_mask.any() or test_mask.all():
        raise ValueError("mission holdout must leave non-empty development and test rows")
    return tuple(frame.index[~test_mask]), tuple(frame.index[test_mask])


def make_model_pipeline(
    specification: ModelSpecification,
    *,
    random_seed: int = DEFAULT_RANDOM_SEED,
):
    """Create a leakage-safe sklearn pipeline for M1--M4."""

    if specification.model_id == "M0":
        raise ValueError("M0 has no learned estimator")
    if specification.status != "available":
        raise ValueError(f"cannot create unavailable {specification.model_id}: {specification.unavailable_reason}")
    from sklearn.compose import ColumnTransformer
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, StandardScaler

    numeric_features = list(specification.numeric_features)
    categorical_features = list(specification.categorical_features)
    if specification.model_id == "M1":
        numeric_transformer = Pipeline(
            [
                ("imputer", SimpleImputer(strategy="median", keep_empty_features=True)),
                ("scaler", StandardScaler()),
            ]
        )
        categorical_transformer = Pipeline(
            [
                ("imputer", SimpleImputer(strategy="constant", fill_value="missing")),
                ("encoder", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
            ]
        )
        estimator = Ridge(alpha=1.0)
    else:
        numeric_transformer = Pipeline(
            [("imputer", SimpleImputer(strategy="median", keep_empty_features=True))]
        )
        categorical_transformer = Pipeline(
            [
                ("imputer", SimpleImputer(strategy="constant", fill_value="missing")),
                (
                    "encoder",
                    OrdinalEncoder(
                        handle_unknown="use_encoded_value",
                        unknown_value=-1,
                        encoded_missing_value=-2,
                    ),
                ),
            ]
        )
        estimator = HistGradientBoostingRegressor(
            loss="absolute_error",
            learning_rate=0.05,
            max_iter=200,
            max_leaf_nodes=15,
            min_samples_leaf=10,
            l2_regularization=0.1,
            # A randomized internal validation tail would make supposedly
            # identical arrival-mode experiments depend on different sampled
            # rows.  Hyperparameters are selected outside the held-out test.
            early_stopping=False,
            random_state=random_seed,
        )

    transformers = []
    if numeric_features:
        transformers.append(("numeric", numeric_transformer, numeric_features))
    if categorical_features:
        transformers.append(("categorical", categorical_transformer, categorical_features))
    if not transformers:
        raise ValueError(f"{specification.model_id} has no features")
    preprocessor = ColumnTransformer(transformers, remainder="drop", sparse_threshold=0.0)
    return Pipeline([("preprocessor", preprocessor), ("estimator", estimator)])


def predict_density_from_artifact(payload: Mapping[str, object], frame: pd.DataFrame) -> np.ndarray:
    """Apply a versioned residual artifact and restore density in kg m-3."""

    if payload.get("artifact_schema_version") != MODEL_ARTIFACT_SCHEMA_VERSION:
        raise ValueError("unsupported density model artifact schema")
    estimator = payload.get("estimator")
    features = payload.get("feature_columns")
    if estimator is None or not isinstance(features, (list, tuple)):
        raise ValueError("density model artifact is incomplete")
    if "rho_baseline_kg_m3" not in frame.columns:
        raise ValueError("prediction frame lacks rho_baseline_kg_m3")
    missing = set(str(column) for column in features) - set(frame.columns)
    if missing:
        raise ValueError(f"prediction frame missing feature(s): {sorted(missing)}")
    assert_no_target_leakage(str(column) for column in features)
    baseline = pd.to_numeric(frame["rho_baseline_kg_m3"], errors="coerce").to_numpy(dtype=float)
    residual = np.asarray(estimator.predict(frame[list(features)]), dtype=float)
    with np.errstate(over="ignore", invalid="ignore"):
        prediction = baseline * np.exp(residual)
    prediction[~np.isfinite(prediction) | (prediction <= 0.0)] = np.nan
    return prediction


def save_model_artifact(
    path: str | Path,
    payload: Mapping[str, object],
) -> tuple[Path, Path]:
    """Atomically serialize one model plus a JSON metadata sidecar."""

    if payload.get("artifact_schema_version") != MODEL_ARTIFACT_SCHEMA_VERSION:
        raise ValueError("model payload must declare the current artifact schema")
    if payload.get("estimator") is None:
        raise ValueError("model payload has no estimator")
    artifact_path = Path(path)
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = artifact_path.with_name(f".{artifact_path.name}.{os.getpid()}.tmp")
    joblib.dump(dict(payload), temporary)
    os.replace(temporary, artifact_path)
    metadata_path = artifact_path.with_suffix(artifact_path.suffix + ".metadata.json")
    metadata = {
        key: value
        for key, value in payload.items()
        if key != "estimator"
    }
    metadata["artifact_file"] = artifact_path.name
    _atomic_json(metadata_path, metadata)
    return artifact_path, metadata_path


def load_model_artifact(path: str | Path) -> dict[str, object]:
    payload = joblib.load(Path(path))
    if not isinstance(payload, dict):
        raise ValueError("density model artifact must be a mapping")
    if payload.get("artifact_schema_version") != MODEL_ARTIFACT_SCHEMA_VERSION:
        raise ValueError("unsupported density model artifact schema")
    if payload.get("estimator") is None:
        raise ValueError("density model artifact has no estimator")
    features = payload.get("feature_columns")
    if not isinstance(features, list) or not all(isinstance(column, str) for column in features):
        raise ValueError("density model artifact has an invalid feature list")
    assert_no_target_leakage(features)
    return payload


def _evaluate_partition(
    frame: pd.DataFrame,
    index: Sequence[object],
    predicted: np.ndarray,
    event_windows: Sequence[EventWindow] | None,
) -> tuple[pd.DataFrame, dict[str, object]]:
    partition = frame.loc[list(index)].copy()
    partition["rho_predicted_kg_m3"] = predicted
    metrics = density_metrics(
        partition["rho_obs_kg_m3"],
        partition["rho_predicted_kg_m3"],
        baseline_density=partition["rho_baseline_kg_m3"],
        timestamps=partition["timestamp_utc"],
        event_windows=event_windows,
    )
    return partition, metrics


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _validated_domain(
    frame: pd.DataFrame,
    index: Sequence[object],
    numeric_features: Sequence[str],
    categorical_features: Sequence[str],
) -> dict[str, object]:
    training = frame.loc[list(index)]
    altitude = pd.to_numeric(training.get("altitude_km"), errors="coerce")
    numeric_ranges: dict[str, dict[str, float]] = {}
    for column in numeric_features:
        values = pd.to_numeric(training.get(column), errors="coerce")
        if hasattr(values, "notna") and values.notna().any():
            numeric_ranges[column] = {
                "min": float(values.min()),
                "max": float(values.max()),
            }
    categorical_levels = {
        column: sorted(str(value) for value in training.get(column, pd.Series(dtype=str)).dropna().unique())
        for column in categorical_features
    }
    return {
        "altitude_min_km": float(altitude.min()) if hasattr(altitude, "notna") and altitude.notna().any() else None,
        "altitude_max_km": float(altitude.max()) if hasattr(altitude, "notna") and altitude.notna().any() else None,
        "missions": sorted(str(value) for value in training.get("mission", pd.Series(dtype=str)).dropna().unique()),
        "spacecraft": sorted(
            str(value) for value in training.get("spacecraft_id", pd.Series(dtype=str)).dropna().unique()
        ),
        "numeric_feature_ranges": numeric_ranges,
        "categorical_feature_levels": categorical_levels,
    }


def train_model_suite(
    frame: pd.DataFrame,
    *,
    experiment_mode: str,
    dataset_version: str | None = None,
    metadata: FeatureDatasetMetadata | Mapping[str, object] | None = None,
    split: ChronologicalSplit | None = None,
    artifact_root: str | Path | None = None,
    run_id: str | None = None,
    require_complete_features: bool = True,
    random_seed: int = DEFAULT_RANDOM_SEED,
    bootstrap_resamples: int = 0,
    event_windows: Sequence[EventWindow] | None = None,
) -> ModelSuiteResult:
    """Train and score M0--M4 on one exact chronological row set."""

    payload = _metadata_payload(frame, metadata)
    version = dataset_version or payload.get("dataset_version")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("a versioned feature dataset is required for model training")
    feature_schema = payload.get("feature_schema_version", FEATURE_SCHEMA_VERSION)
    if feature_schema != FEATURE_SCHEMA_VERSION:
        raise ValueError(f"unsupported feature schema: {feature_schema!r}")
    specifications = build_model_specifications(frame, metadata)
    matched, matched_report = prepare_matched_rows(
        frame,
        specifications,
        require_complete_features=require_complete_features,
    )
    if matched.empty:
        raise ValueError("no exact matched rows remain for M0--M4")
    temporal_split = split or chronological_split(matched)
    assert_chronological_split(matched, temporal_split)
    generated = _utc_now()
    resolved_run_id = run_id or (
        f"{pd.Timestamp(generated).strftime('%Y%m%dT%H%M%SZ')}-{experiment_mode}-{version[-8:]}"
    )
    root = Path(artifact_root) if artifact_root is not None else None
    mode_directory = root / resolved_run_id / experiment_mode if root is not None else None
    if mode_directory is not None:
        mode_directory.mkdir(parents=True, exist_ok=True)

    results: list[ModelRunResult] = []
    code_state = _git_code_state()
    runtime_versions = _runtime_versions()
    for specification in specifications:
        if specification.status != "available":
            results.append(
                ModelRunResult(
                    model_id=specification.model_id,
                    label=specification.label,
                    status="unavailable",
                    feature_group=specification.feature_group,
                    algorithm=specification.algorithm,
                    feature_columns=list(specification.feature_columns),
                    matched_rows=len(matched),
                    train_rows=len(temporal_split.train_index),
                    validation_rows=len(temporal_split.validation_index),
                    test_rows=len(temporal_split.test_index),
                    validation_metrics=None,
                    test_metrics=None,
                    bootstrap=None,
                    artifact=None,
                    predictions_artifact=None,
                    warning=specification.unavailable_reason,
                    deployable=specification.deployable,
                )
            )
            continue

        if specification.model_id == "M0":
            validation_prediction = pd.to_numeric(
                matched.loc[list(temporal_split.validation_index), "rho_baseline_kg_m3"], errors="coerce"
            ).to_numpy(dtype=float)
            test_prediction = pd.to_numeric(
                matched.loc[list(temporal_split.test_index), "rho_baseline_kg_m3"], errors="coerce"
            ).to_numpy(dtype=float)
            estimator = None
        else:
            estimator = make_model_pipeline(specification, random_seed=random_seed)
            training = matched.loc[list(temporal_split.train_index)]
            estimator.fit(training[list(specification.feature_columns)], training[TARGET_COLUMN])
            validation_residual = np.asarray(
                estimator.predict(matched.loc[list(temporal_split.validation_index), list(specification.feature_columns)]),
                dtype=float,
            )
            test_residual = np.asarray(
                estimator.predict(matched.loc[list(temporal_split.test_index), list(specification.feature_columns)]),
                dtype=float,
            )
            with np.errstate(over="ignore", invalid="ignore"):
                validation_prediction = (
                    matched.loc[list(temporal_split.validation_index), "rho_baseline_kg_m3"].to_numpy(dtype=float)
                    * np.exp(validation_residual)
                )
                test_prediction = (
                    matched.loc[list(temporal_split.test_index), "rho_baseline_kg_m3"].to_numpy(dtype=float)
                    * np.exp(test_residual)
                )

        validation_frame, validation_metrics = _evaluate_partition(
            matched,
            temporal_split.validation_index,
            validation_prediction,
            event_windows,
        )
        test_frame, test_metrics = _evaluate_partition(
            matched,
            temporal_split.test_index,
            test_prediction,
            event_windows,
        )
        bootstrap = None
        if bootstrap_resamples > 0:
            bootstrap = block_bootstrap_density_metrics(
                test_frame,
                n_resamples=bootstrap_resamples,
                random_seed=random_seed,
            )

        artifact_reference: str | None = None
        predictions_reference: str | None = None
        if mode_directory is not None:
            predictions_path = mode_directory / f"{specification.model_id.lower()}-test-predictions.parquet"
            test_frame.to_parquet(predictions_path, index=False)
            predictions_reference = _relative(predictions_path, root)
            if estimator is not None:
                artifact_path = mode_directory / f"{specification.model_id.lower()}.joblib"
                artifact_payload: dict[str, object] = {
                    "artifact_schema_version": MODEL_ARTIFACT_SCHEMA_VERSION,
                    "study_schema_version": STUDY_SCHEMA_VERSION,
                    "model_id": specification.model_id,
                    "model_label": specification.label,
                    "model_version": f"{specification.model_id.lower()}-{resolved_run_id}",
                    "algorithm": specification.algorithm,
                    "deployable": specification.deployable,
                    "experiment_mode": experiment_mode,
                    "dataset_version": version,
                    "feature_schema_version": feature_schema,
                    "feature_columns": list(specification.feature_columns),
                    "numeric_features": list(specification.numeric_features),
                    "categorical_features": list(specification.categorical_features),
                    "target_column": TARGET_COLUMN,
                    "target_definition": TARGET_DEFINITION,
                    "split": temporal_split.to_dict(),
                    "matched_rows": asdict(matched_report),
                    "validation_metrics": validation_metrics,
                    "test_metrics": test_metrics,
                    "bootstrap": bootstrap,
                    "hyperparameters": estimator.named_steps["estimator"].get_params(deep=False),
                    "random_seed": random_seed,
                    "code_revision": code_state.get("git_revision"),
                    "code_state": code_state,
                    "runtime_versions": runtime_versions,
                    "generated_at_utc": generated,
                    "data_quality_report": {
                        "input_rows": matched_report.input_rows,
                        "matched_rows": matched_report.matched_rows,
                        "rejected_rows": matched_report.rejected_rows,
                        "rejection_counts": matched_report.rejection_counts,
                    },
                    "validated_domain": _validated_domain(
                        matched,
                        temporal_split.train_index,
                        specification.numeric_features,
                        specification.categorical_features,
                    ),
                    "baseline_model": {
                        "names": sorted(
                            str(value)
                            for value in matched.get("baseline_model_name", pd.Series(dtype=str)).dropna().unique()
                        ),
                        "versions": sorted(
                            str(value)
                            for value in matched.get("baseline_model_version", pd.Series(dtype=str)).dropna().unique()
                        ),
                    },
                    "estimator": estimator,
                }
                saved, _ = save_model_artifact(artifact_path, artifact_payload)
                artifact_reference = _relative(saved, root)

        results.append(
            ModelRunResult(
                model_id=specification.model_id,
                label=specification.label,
                status="available",
                feature_group=specification.feature_group,
                algorithm=specification.algorithm,
                feature_columns=list(specification.feature_columns),
                matched_rows=len(matched),
                train_rows=len(temporal_split.train_index),
                validation_rows=len(temporal_split.validation_index),
                test_rows=len(temporal_split.test_index),
                validation_metrics=validation_metrics,
                test_metrics=test_metrics,
                bootstrap=bootstrap,
                artifact=artifact_reference,
                predictions_artifact=predictions_reference,
                deployable=specification.deployable,
            )
        )

    suite = ModelSuiteResult(
        run_id=resolved_run_id,
        generated_at_utc=generated,
        experiment_mode=experiment_mode,
        dataset_version=version,
        feature_schema_version=str(feature_schema),
        split=temporal_split,
        matched_rows=matched_report,
        models=results,
        artifact_root=str(root) if root is not None else None,
        warnings=[
            result.warning
            for result in results
            if result.warning is not None
        ],
    )
    if mode_directory is not None:
        _atomic_json(mode_directory / "artifact-manifest.v1.json", suite.to_dict())
    return suite


def evaluate_year_walk_forward(
    frame: pd.DataFrame,
    *,
    dataset_version: str | None = None,
    metadata: FeatureDatasetMetadata | Mapping[str, object] | None = None,
    require_complete_features: bool = True,
    minimum_train_rows: int = 1,
    random_seed: int = DEFAULT_RANDOM_SEED,
    event_windows: Sequence[EventWindow] | None = None,
) -> dict[str, object]:
    """Refit every available M0--M4 model for each held-out calendar year."""

    payload = _metadata_payload(frame, metadata)
    version = dataset_version or payload.get("dataset_version")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("a versioned feature dataset is required for walk-forward validation")
    specifications = build_model_specifications(frame, metadata)
    matched, matched_report = prepare_matched_rows(
        frame,
        specifications,
        require_complete_features=require_complete_features,
    )
    folds = year_walk_forward_splits(matched, minimum_train_rows=minimum_train_rows)
    models: dict[str, dict[str, object]] = {}
    for specification in specifications:
        if specification.status != "available":
            models[specification.model_id] = {
                "status": "unavailable",
                "reason": specification.unavailable_reason,
                "folds": [],
                "aggregate_metrics": None,
            }
            continue
        fold_results: list[dict[str, object]] = []
        prediction_frames: list[pd.DataFrame] = []
        for fold in folds:
            training = matched.loc[list(fold.train_index)]
            validation = matched.loc[list(fold.validation_index)]
            if specification.model_id == "M0":
                prediction = pd.to_numeric(
                    validation["rho_baseline_kg_m3"], errors="coerce"
                ).to_numpy(dtype=float)
            else:
                estimator = make_model_pipeline(specification, random_seed=random_seed)
                estimator.fit(
                    training[list(specification.feature_columns)],
                    training[TARGET_COLUMN],
                )
                residual = np.asarray(
                    estimator.predict(validation[list(specification.feature_columns)]),
                    dtype=float,
                )
                with np.errstate(over="ignore", invalid="ignore"):
                    prediction = validation["rho_baseline_kg_m3"].to_numpy(dtype=float) * np.exp(residual)
            predicted_frame, metrics = _evaluate_partition(
                matched,
                fold.validation_index,
                prediction,
                event_windows,
            )
            prediction_frames.append(predicted_frame)
            fold_results.append({**fold.to_dict(), "metrics": metrics})
        aggregate = pd.concat(prediction_frames, ignore_index=True)
        aggregate_metrics = density_metrics(
            aggregate["rho_obs_kg_m3"],
            aggregate["rho_predicted_kg_m3"],
            baseline_density=aggregate["rho_baseline_kg_m3"],
            timestamps=aggregate["timestamp_utc"],
            event_windows=event_windows,
        )
        models[specification.model_id] = {
            "status": "available",
            "reason": None,
            "feature_columns": list(specification.feature_columns),
            "folds": fold_results,
            "aggregate_metrics": aggregate_metrics,
        }
    return {
        "schema_version": STUDY_SCHEMA_VERSION,
        "dataset_version": version,
        "feature_schema_version": payload.get("feature_schema_version", FEATURE_SCHEMA_VERSION),
        "method": "expanding calendar-year walk-forward",
        "generated_at_utc": _utc_now(),
        "matched_rows": asdict(matched_report),
        "folds": [fold.to_dict() for fold in folds],
        "models": models,
    }


_METRIC_CONTRACT: tuple[tuple[str, str, str | None], ...] = (
    ("mae_log10_rho", "MAE log10 density", "dex"),
    ("rmse_log10_rho", "RMSE log10 density", "dex"),
    ("median_absolute_relative_error", "Median absolute relative error", "fraction"),
    ("median_density_ratio", "Median predicted/observed density ratio", "ratio"),
    ("bias_log10_rho", "Bias log10 density", "dex"),
    ("correlation_log10_rho", "Correlation log10 density", None),
)


def _contract_metrics(model: ModelRunResult) -> list[dict[str, object]]:
    metrics = model.test_metrics or {}
    records: list[dict[str, object]] = []
    intervals = (model.bootstrap or {}).get("intervals", {}) if model.bootstrap else {}
    for key, label, unit in _METRIC_CONTRACT:
        value = metrics.get(key)
        if value is None or not np.isfinite(float(value)):
            continue
        interval = intervals.get(key) if isinstance(intervals, Mapping) else None
        confidence_interval = None
        if isinstance(interval, Mapping) and interval.get("low") is not None and interval.get("high") is not None:
            confidence_interval = {
                "low": float(interval["low"]),
                "high": float(interval["high"]),
                "level_pct": float((model.bootstrap or {}).get("confidence_level", 0.95)) * 100.0,
            }
        records.append(
            {
                "key": key,
                "label": label,
                "value": float(value),
                "unit": unit,
                "model_id": model.model_id,
                "sample_count": metrics.get("sample_count"),
                "confidence_interval": confidence_interval,
            }
        )
    skill = metrics.get("skill_vs_m0")
    if isinstance(skill, Mapping) and skill.get("rmse_skill") is not None:
        value = float(skill["rmse_skill"])
        records.append(
            {
                "key": "rmse_skill_vs_m0",
                "label": "RMSE skill versus M0",
                "value": value,
                "unit": "fraction",
                "model_id": model.model_id,
                "sample_count": metrics.get("sample_count"),
                "confidence_interval": None,
            }
        )
    event_metrics = metrics.get("events")
    if isinstance(event_metrics, Mapping) and event_metrics.get("status") == "available":
        for key, label, unit in (
            ("peak_density_absolute_relative_error", "Peak density relative error", "fraction"),
            ("peak_timing_mae_min", "Peak timing MAE", "min"),
            ("onset_timing_mae_min", "Onset timing MAE", "min"),
            ("recovery_timing_mae_min", "Recovery timing MAE", "min"),
        ):
            value = event_metrics.get(key)
            if value is not None:
                records.append(
                    {
                        "key": key,
                        "label": label,
                        "value": float(value),
                        "unit": unit,
                        "model_id": model.model_id,
                        "sample_count": event_metrics.get("event_count"),
                        "confidence_interval": None,
                    }
                )
    return records


def suite_to_validation_mode(suite: ModelSuiteResult) -> dict[str, object]:
    """Map one suite onto the Internal Console validation contract."""

    label = (
        "Reference aligned response study"
        if suite.experiment_mode == "reference_aligned"
        else "HelioSat predicted arrival study"
    )
    models = []
    artifacts: list[str] = []
    for result in suite.models:
        model_artifacts = [item for item in (result.artifact, result.predictions_artifact) if item]
        artifacts.extend(model_artifacts)
        models.append(
            {
                "id": result.model_id,
                "label": result.label,
                "status": result.status,
                "deployable": result.deployable,
                "feature_group": result.feature_group,
                "metrics": _contract_metrics(result),
            }
        )
    headline = next((model for model in suite.models if model.model_id == "M3" and model.status == "available"), None)
    return {
        "mode": suite.experiment_mode,
        "label": label,
        "evidence_class": "retrospective",
        "status": "available" if any(model.status == "available" for model in suite.models) else "unavailable",
        "split": suite.split.to_dict(),
        "models": models,
        "metrics": _contract_metrics(headline) if headline is not None else [],
        "breakdowns": None,
        "artifacts": sorted(set(artifacts)),
        "warnings": suite.warnings,
    }


def write_study_summary(
    artifact_root: str | Path,
    run_id: str,
    suites: Mapping[str, ModelSuiteResult],
    *,
    missions: Sequence[str],
    limitations: Sequence[str],
    warnings: Sequence[str] = (),
) -> Path:
    """Write the canonical ``<run>/study-summary.v1.json`` UI artifact."""

    root = Path(artifact_root)
    run_directory = root / run_id
    run_directory.mkdir(parents=True, exist_ok=True)
    modes: dict[str, object] = {}
    for mode in ("reference_aligned", "heliosat_predicted_arrival"):
        suite = suites.get(mode)
        if suite is None:
            modes[mode] = {
                "mode": mode,
                "label": (
                    "Reference aligned response study"
                    if mode == "reference_aligned"
                    else "HelioSat predicted arrival study"
                ),
                "evidence_class": "retrospective",
                "status": "unavailable",
                "split": None,
                "models": [],
                "metrics": [],
                "breakdowns": None,
                "artifacts": [],
                "warnings": ["mode has not been run"],
            }
        else:
            if suite.run_id != run_id:
                raise ValueError("all mode suites must share the study run_id")
            modes[mode] = suite_to_validation_mode(suite)
    available_suites = list(suites.values())
    dataset_versions = sorted({suite.dataset_version for suite in available_suites})
    feature_versions = sorted({suite.feature_schema_version for suite in available_suites})
    artifacts = sorted(
        {
            artifact
            for mode in modes.values()
            if isinstance(mode, Mapping)
            for artifact in mode.get("artifacts", [])
        }
    )
    if len(available_suites) == 2:
        study_status = "available"
    elif available_suites:
        study_status = "partial"
    else:
        study_status = "unavailable"
    payload: dict[str, object] = {
        "run_id": run_id,
        "study_version": STUDY_SCHEMA_VERSION,
        "generated_at_utc": _utc_now(),
        "dataset_version": dataset_versions[0] if len(dataset_versions) == 1 else ";".join(dataset_versions) or None,
        "feature_schema_version": feature_versions[0] if len(feature_versions) == 1 else None,
        "status": study_status,
        "missions": sorted(set(str(mission) for mission in missions)),
        "split": available_suites[0].split.to_dict() if available_suites else None,
        "modes": modes,
        "artifacts": artifacts,
        "limitations": list(limitations),
        "warnings": list(warnings),
    }
    output = run_directory / "study-summary.v1.json"
    _atomic_json(output, payload)
    return output
