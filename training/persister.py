from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import pandas as pd

    from .trainers import TrainedModelResult


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUN_ROOT = PROJECT_ROOT / "data" / "model-runs"
PREDICTION_SUPABASE_LIMIT = 50_000


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    api_key: str
    access_token: str


def _load_supabase_config() -> SupabaseConfig | None:
    url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    api_key = (
        os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    )
    access_token = os.environ.get("SUPABASE_ACCESS_TOKEN") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not api_key or not access_token:
        return None

    return SupabaseConfig(url=url.rstrip("/"), api_key=api_key, access_token=access_token)


class TrainingPersister:
    def __init__(self, supabase: SupabaseConfig | None = None, local_root: Path = LOCAL_RUN_ROOT):
        self.supabase = supabase if supabase is not None else _load_supabase_config()
        self.local_root = local_root
        self.local_root.mkdir(parents=True, exist_ok=True)

    def _request(self, method: str, path: str, payload: Any | None = None) -> Any:
        if not self.supabase:
            raise RuntimeError("Supabase environment is not configured")

        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.supabase.url}/rest/v1/{path}",
            data=body,
            method=method,
            headers={
                "apikey": self.supabase.api_key,
                "Authorization": f"Bearer {self.supabase.access_token}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Supabase {method} {path} failed: {exc.code} {detail}") from exc

        if not raw:
            return None

        return json.loads(raw.decode("utf-8"))

    def fetch_experiment(self, experiment_id: str) -> dict[str, Any]:
        rows = self._request("GET", f"experiments?id=eq.{urllib.parse.quote(experiment_id)}&select=*")

        if not rows:
            raise RuntimeError(f"Experiment not found: {experiment_id}")

        return rows[0]

    def create_run(self, experiment: dict[str, Any], model_name: str) -> str:
        payload = [{
            "owner_id": experiment["owner_id"],
            "experiment_id": experiment["id"],
            "model_name": model_name,
            "status": "queued",
            "hyperparams": {},
        }]
        rows = self._request("POST", "experiment_runs", payload)

        return rows[0]["id"]

    def mark_running(self, run_id: str) -> None:
        self._request(
            "PATCH",
            f"experiment_runs?id=eq.{urllib.parse.quote(run_id)}",
            {
                "status": "running",
                "started_at": datetime.now(timezone.utc).isoformat(),
            },
        )

    def mark_failed(self, run_id: str, message: str) -> None:
        self._request(
            "PATCH",
            f"experiment_runs?id=eq.{urllib.parse.quote(run_id)}",
            {
                "status": "failed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "metrics_global": {"error": message},
                "log_uri": self._write_log(run_id, message),
            },
        )

    def persist_completed(
        self,
        experiment: dict[str, Any],
        run_id: str,
        result: TrainedModelResult,
    ) -> None:
        prediction_uri = self.persist_predictions(experiment, run_id, result.predictions)
        payload = {
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "metrics_global": result.metrics_global,
            "metrics_per_fold": result.metrics_per_fold,
            "metrics_events": {},
            "hyperparams": result.hyperparams,
            "model_artifact_path": result.model_artifact_path,
            "feature_importance": result.feature_importance,
            "n_train_samples": result.n_train_samples,
            "n_val_samples": result.n_val_samples,
            "prediction_uri": prediction_uri,
            "score": result.metrics_global.get("rmse"),
        }
        self._request("PATCH", f"experiment_runs?id=eq.{urllib.parse.quote(run_id)}", payload)

    def persist_predictions(self, experiment: dict[str, Any], run_id: str, predictions: pd.DataFrame) -> str:
        import pandas as pd

        output_path = self.local_root / "predictions" / experiment["id"] / f"{run_id}.parquet"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        predictions.to_parquet(output_path, index=False)

        if self.supabase and len(predictions) <= PREDICTION_SUPABASE_LIMIT:
            rows = []

            for _, row in predictions.iterrows():
                rows.append({
                    "owner_id": experiment["owner_id"],
                    "experiment_id": experiment["id"],
                    "run_id": run_id,
                    "timestamp_utc": pd.Timestamp(row["timestamp_utc"]).isoformat(),
                    "split": row["split"],
                    "fold": None if pd.isna(row["fold"]) else int(row["fold"]),
                    "y_true": float(row["y_true"]),
                    "y_pred": float(row["y_pred"]),
                    "residual": float(row["residual"]),
                })

            for offset in range(0, len(rows), 1000):
                self._request("POST", "predictions", rows[offset:offset + 1000])

        return str(output_path)

    def _write_log(self, run_id: str, message: str) -> str:
        log_path = self.local_root / "logs" / f"{run_id}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(message, encoding="utf-8")
        return str(log_path)
