"""Apply the trained arrival-residual model to live L1 samples (live inference).

Reads ONE JSON object from stdin:

    {
      "samples": [                      # ascending by time, the trailing history
        {"time": "2026-06-13T11:31:00Z",
         "speed_km_s": 629.8, "density_p_cc": 2.1, "bmag_nt": 7.4,
         "bz_gsm_nt": -2.9, "by_gsm_nt": -6.5,
         "sc_x_re": 225.05, "sc_y_re": -35.8, "sc_z_re": -25.32},
        ...
      ],
      "bsn_x_re": 13.5                   # nominal bow-shock nose (live has no product)
    }

The 20 features are built with the SAME code as training (`build_features`), and the
benchmark delay is the training-basis bow-shock ballistic delay
`(sc_x - bsn_x) * Re / V`. The model predicts the residual `OMNI - MRU` (minutes) for
every input sample. A sample is only `complete` (trustworthy) when all 20 features are
finite — i.e. instantaneous fields present AND the trailing rolling windows have enough
history (>=3 h). The caller must fall back to raw MRU for any non-complete sample.

Writes JSON to stdout:

    {"predictions": [{"time", "mruDelayMin", "residualMin", "correctedDelayMin",
                      "complete"}, ...]}

Pure inference: no network, no fabricated values. On any failure it emits an empty
predictions list with an "error", so the caller falls back rather than blocking.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from .dataset import RE_KM
from .features import FEATURE_NAMES, build_features

MODEL_PATH = Path(__file__).resolve().parents[2] / "data" / "ml-model" / "arrival-residual" / "model.joblib"

BASE_COLUMNS = [
    "speed_km_s", "density_p_cc", "bmag_nt", "bz_gsm_nt", "by_gsm_nt",
    "sc_x_re", "sc_y_re", "sc_z_re",
]


def _emit(payload: dict) -> int:
    sys.stdout.write(json.dumps(payload))
    return 0


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception as exc:  # noqa: BLE001
        return _emit({"predictions": [], "error": f"bad stdin: {exc}"})

    samples = payload.get("samples") or []
    if not samples:
        return _emit({"predictions": [], "error": "no samples"})

    try:
        import joblib

        model = joblib.load(MODEL_PATH)["model"]

        df = pd.DataFrame(samples)
        df["time"] = pd.to_datetime(df["time"], utc=True, errors="coerce")
        df = df.dropna(subset=["time"]).sort_values("time").reset_index(drop=True)
        for column in BASE_COLUMNS:
            df[column] = pd.to_numeric(df.get(column), errors="coerce")

        bsn_x_re = float(payload.get("bsn_x_re", 13.5))
        df["bsn_x_re"] = bsn_x_re
        # Training-basis ballistic delay (bow-shock nose), matching dataset.py.
        df["mru_delay_min"] = (df["sc_x_re"] - df["bsn_x_re"]) * RE_KM / df["speed_km_s"] / 60.0

        feat = build_features(df)
        features = feat[FEATURE_NAMES]
        complete = features.notna().all(axis=1).to_numpy()
        # HGB tolerates NaN, but we only TRUST rows whose every feature is finite.
        resid = model.predict(features)

        predictions = []
        for i in range(len(feat)):
            mru = float(feat["mru_delay_min"].iloc[i])
            is_complete = bool(complete[i] and np.isfinite(mru))
            r = float(resid[i])
            predictions.append({
                "time": feat["time"].iloc[i].isoformat().replace("+00:00", "Z"),
                "mruDelayMin": round(mru, 3) if np.isfinite(mru) else None,
                "residualMin": round(r, 3) if is_complete else None,
                "correctedDelayMin": round(mru + r, 3) if is_complete else None,
                "complete": is_complete,
            })
        return _emit({"predictions": predictions})
    except Exception as exc:  # noqa: BLE001 - never raise into the caller
        return _emit({"predictions": [], "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    sys.exit(main())
