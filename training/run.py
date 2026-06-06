from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_ROOT = PROJECT_ROOT / "data" / "model-runs" / "artifacts"
MODEL_ORDER = ("mru_propagation", "persistence", "ridge", "lightgbm")


def _parse_models(value: str) -> list[str]:
    if value == "all":
        return list(MODEL_ORDER)

    models = [item.strip() for item in value.split(",") if item.strip()]
    invalid = sorted(set(models).difference(MODEL_ORDER))

    if invalid:
        raise argparse.ArgumentTypeError(f"Unsupported model(s): {', '.join(invalid)}")

    return models


def _load_experiment_from_file(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _load_run_ids(value: str | None) -> dict[str, str]:
    if not value:
        return {}

    return json.loads(value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run HelioSat baseline training for an active experiment.")
    parser.add_argument("--experiment-id", required=True)
    parser.add_argument("--models", default="all", type=_parse_models)
    parser.add_argument("--run-ids", default=None, help="JSON object mapping model_name to pre-created experiment_run id.")
    parser.add_argument("--experiment-json", default=None, help="Local experiment JSON for offline execution.")
    args = parser.parse_args(argv)

    from .persister import TrainingPersister

    persister = TrainingPersister()
    run_ids = _load_run_ids(args.run_ids)

    try:
        experiment = _load_experiment_from_file(args.experiment_json) if args.experiment_json else persister.fetch_experiment(args.experiment_id)
    except Exception as exc:
        print(f"Failed to load experiment: {exc}", file=sys.stderr)
        return 1

    config = experiment["config"]

    try:
        from .data_loader import load_training_dataset
        from .feature_builder import build_feature_matrix
        from .metrics import regression_metrics
        from .trainers import train_lightgbm, train_mru_propagation, train_persistence, train_ridge
        from .validators import build_event_holdout_mask, build_walk_forward_splits

        loaded = load_training_dataset(config)
        dataset = build_feature_matrix(loaded, config)
        event_mask = None

        if config["validation"].get("event_holdout"):
            event_mask = build_event_holdout_mask(
                dataset,
                threshold=int(config["validation"].get("event_holdout_dst_threshold") or -100),
            )

        n_folds = int(config["validation"].get("n_folds") or 1)
        splits = build_walk_forward_splits(dataset, n_folds=n_folds, excluded_mask=event_mask)
        feature_columns = list(dataset.attrs["feature_columns"])
        persistence_eval = train_persistence(
            dataset,
            splits,
            run_id="persistence-eval",
            experiment_id=experiment["id"],
            artifact_root=ARTIFACT_ROOT,
            persistence_rmse=None,
        )
        persistence_rmse = persistence_eval.metrics_global["rmse"]

        for model_name in args.models:
            run_id = run_ids.get(model_name)

            if not run_id:
                run_id = persister.create_run(experiment, model_name)

            try:
                persister.mark_running(run_id)

                if model_name == "mru_propagation":
                    result = train_mru_propagation(dataset, splits, run_id, experiment["id"], ARTIFACT_ROOT, persistence_rmse)
                elif model_name == "persistence":
                    result = persistence_eval
                    result.metrics_global = regression_metrics(result.predictions["y_true"], result.predictions["y_pred"], persistence_rmse)
                elif model_name == "ridge":
                    result = train_ridge(dataset, splits, feature_columns, run_id, experiment["id"], ARTIFACT_ROOT, persistence_rmse)
                elif model_name == "lightgbm":
                    result = train_lightgbm(dataset, splits, feature_columns, run_id, experiment["id"], ARTIFACT_ROOT, persistence_rmse)
                else:
                    raise ValueError(f"Unsupported model: {model_name}")

                persister.persist_completed(experiment, run_id, result)
            except Exception as exc:
                persister.mark_failed(run_id, "".join(traceback.format_exception(exc)))

    except Exception as exc:
        message = "".join(traceback.format_exception(exc))
        print(message, file=sys.stderr)

        for run_id in run_ids.values():
            try:
                persister.mark_failed(run_id, message)
            except Exception:
                pass

        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
