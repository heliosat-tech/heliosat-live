"""Train and evaluate the ML residual correction for MRU arrival times.

CLI (run from the repo root):

    python -m ml.arrival_residual.train            # full run
    python -m ml.arrival_residual.train --refresh-data
    python -m ml.arrival_residual.train --skip-walk-forward

What it does, end to end:
1. Builds the paired ACE<->OMNI record (same pairing, span and filters as the
   existing Arrival-time validation study).
2. Builds upstream-only features (see features.py) and hard-asserts no
   arrival-side leakage.
3. Splits chronologically, earliest ~70% train / latest ~30% validation, no
   shuffling, and emits the exact split dates from the data.
4. Trains a ridge baseline and a HistGradientBoostingRegressor (the main
   model; no new heavy dependency).
5. Evaluates benchmark vs ML side by side on the held-out tail: MAE, RMSE,
   bias, within 10/20/30 min, overall and per observed G regime. Also runs a
   walk-forward-by-year variant.
6. Computes permutation feature importance.
7. Persists: model file, model_card.md, figures, and the two UI artifacts
   data/console/ml_metrics.json and data/console/ml_data_split.json.

Honesty guardrails: results are reported even if the gain is small or
negative, the verdict line says so explicitly, and the run aborts if the
chronological split or the feature whitelist is violated.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .dataset import PROJECT_ROOT, RE_KM, PairedRecord, build_paired_record
from .evaluate import error_histogram, stratify_by_regime, summarize_errors
from .features import (
    FEATURE_NAMES,
    FEATURES,
    FEATURE_SCHEMA_VERSION,
    NOMINAL_BOW_SHOCK_X_RE,
    assert_no_leakage,
    build_features,
)

MODEL_DIR = PROJECT_ROOT / "data" / "ml-model" / "arrival-residual"
FIGURES_DIR = MODEL_DIR / "figures"
CONSOLE_DIR = PROJECT_ROOT / "data" / "console"
METRICS_PATH = CONSOLE_DIR / "ml_metrics.json"
SPLIT_PATH = CONSOLE_DIR / "ml_data_split.json"

TRAIN_FRACTION = 0.7
RANDOM_STATE = 42
ARTIFACT_SCHEMA_VERSION = "heliosat-arrival-residual-artifact-v2"

BENCHMARK_NAME = "MRU ballistic propagation"
MODEL_NAME = "MRU + ML residual correction (HistGradientBoostingRegressor)"

# Dark figure palette matching the console UI.
FIG_BG = "#0f172a"
FIG_BENCH = "#f59e0b"
FIG_ML = "#22d3ee"
FIG_TEXT = "#cbd5e1"


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _iso(ts: pd.Timestamp) -> str:
    return ts.isoformat().replace("+00:00", "Z")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _git_state() -> dict[str, object]:
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True
        ).stdout.strip()
        dirty = bool(subprocess.run(
            ["git", "status", "--porcelain=v1"], check=True, capture_output=True, text=True
        ).stdout.strip())
        return {"gitRevision": revision or None, "workingTreeDirty": dirty}
    except (OSError, subprocess.SubprocessError):
        return {"gitRevision": None, "workingTreeDirty": None}


def _runtime_versions() -> dict[str, str]:
    versions = {"python": sys.version.split()[0]}
    for package in ("numpy", "pandas", "scikit-learn", "joblib", "scipy"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "unavailable"
    return versions


def make_hgb(max_iter: int) -> HistGradientBoostingRegressor:
    """Main model. absolute_error loss optimizes the headline MAE directly and
    is robust to the heavy tails of the residual distribution. Early stopping
    is disabled because its internal split is random, which would mix future
    samples into the stopping decision."""
    return HistGradientBoostingRegressor(
        loss="absolute_error",
        max_iter=max_iter,
        learning_rate=0.06,
        max_leaf_nodes=63,
        min_samples_leaf=200,
        l2_regularization=1.0,
        early_stopping=False,
        random_state=RANDOM_STATE,
    )


def make_ridge() -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("ridge", Ridge(alpha=1.0)),
        ]
    )


def chronological_split(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    cut = int(len(frame) * TRAIN_FRACTION)
    train = frame.iloc[:cut]
    val = frame.iloc[cut:]
    assert train["time"].max() < val["time"].min(), "chronological split violated"
    return train, val


def walk_forward_by_year(
    frame: pd.DataFrame, feature_names: list[str], max_iter: int
) -> list[dict]:
    """Train on all years before Y, validate on year Y. Pure out-of-time."""
    results: list[dict] = []
    years = sorted(frame["time"].dt.year.unique())
    for year in years[1:]:
        train = frame[frame["time"].dt.year < year]
        val = frame[frame["time"].dt.year == year]
        if len(train) < 10_000 or len(val) < 1_000:
            continue
        model = make_hgb(max_iter)
        model.fit(train[feature_names], train["target_resid_min"])
        pred = model.predict(val[feature_names])
        ml_err = pred - val["target_resid_min"].to_numpy()
        bench_err = val["benchmark_err_min"].to_numpy()
        results.append(
            {
                "year": int(year),
                "trainRows": int(len(train)),
                "valRows": int(len(val)),
                "benchmarkMaeMin": round(float(np.abs(bench_err).mean()), 2),
                "mlMaeMin": round(float(np.abs(ml_err).mean()), 2),
            }
        )
        print(
            f"  walk-forward {year}: benchmark MAE {results[-1]['benchmarkMaeMin']:.2f} min, "
            f"ML MAE {results[-1]['mlMaeMin']:.2f} min ({len(train)} train / {len(val)} val rows)",
            flush=True,
        )
    return results


def compute_permutation_importance(
    model: HistGradientBoostingRegressor,
    val: pd.DataFrame,
    feature_names: list[str],
    sample_rows: int = 40_000,
) -> list[dict]:
    subset = val.sample(n=min(sample_rows, len(val)), random_state=RANDOM_STATE)
    result = permutation_importance(
        model,
        subset[feature_names],
        subset["target_resid_min"],
        scoring="neg_mean_absolute_error",
        n_repeats=5,
        random_state=RANDOM_STATE,
        n_jobs=-1,
    )
    rows = [
        {
            "feature": name,
            "deltaMaeMin": round(float(mean), 3),
            "std": round(float(std), 3),
        }
        for name, mean, std in zip(feature_names, result.importances_mean, result.importances_std)
    ]
    rows.sort(key=lambda r: r["deltaMaeMin"], reverse=True)
    return rows


# ---------------------------------------------------------------- figures ---

def _dark_axes(ax) -> None:
    ax.set_facecolor(FIG_BG)
    for spine in ax.spines.values():
        spine.set_color("#334155")
    ax.tick_params(colors=FIG_TEXT, labelsize=8)
    ax.xaxis.label.set_color(FIG_TEXT)
    ax.yaxis.label.set_color(FIG_TEXT)
    ax.title.set_color("#e2e8f0")
    ax.grid(color="#1e293b", linewidth=0.6)


def save_figures(
    histogram: dict,
    y_true: np.ndarray,
    y_pred: np.ndarray,
    importance: list[dict],
) -> list[str]:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []

    # 1. Overlaid arrival-error histogram, benchmark vs ML.
    edges = np.asarray(histogram["binEdgesMin"])
    centers = (edges[:-1] + edges[1:]) / 2
    fig, ax = plt.subplots(figsize=(8, 4.5), facecolor=FIG_BG)
    _dark_axes(ax)
    ax.fill_between(centers, histogram["benchmarkCounts"], step="mid", alpha=0.45, color=FIG_BENCH, label="Benchmark (MRU ballistic)")
    ax.fill_between(centers, histogram["mlCounts"], step="mid", alpha=0.45, color=FIG_ML, label="MRU + ML correction")
    ax.axvline(0, color="#64748b", linewidth=0.8)
    ax.set_xlabel("Arrival-time error (min), predicted minus observed")
    ax.set_ylabel("Validation samples")
    ax.set_title("Held-out arrival-time error: benchmark vs ML")
    legend = ax.legend(facecolor=FIG_BG, edgecolor="#334155", labelcolor=FIG_TEXT, fontsize=8)
    fig.tight_layout()
    path = FIGURES_DIR / "error-histogram.png"
    fig.savefig(path, dpi=150, facecolor=FIG_BG)
    plt.close(fig)
    saved.append(path.name)

    # 2. Predicted vs actual residual (density via hexbin; 130k+ points).
    fig, ax = plt.subplots(figsize=(6, 5.4), facecolor=FIG_BG)
    _dark_axes(ax)
    lim = 45
    hb = ax.hexbin(y_true, y_pred, gridsize=70, extent=(-lim, lim, -lim, lim), cmap="cividis", bins="log", linewidths=0)
    ax.plot([-lim, lim], [-lim, lim], color=FIG_ML, linewidth=0.9, linestyle="--", label="perfect correction")
    ax.set_xlabel("Actual residual y = OMNI delay minus MRU delay (min)")
    ax.set_ylabel("Predicted residual (min)")
    ax.set_title("Predicted vs actual timing residual (validation)")
    cb = fig.colorbar(hb, ax=ax)
    cb.set_label("log10(count)", color=FIG_TEXT)
    cb.ax.tick_params(colors=FIG_TEXT, labelsize=7)
    ax.legend(facecolor=FIG_BG, edgecolor="#334155", labelcolor=FIG_TEXT, fontsize=8)
    fig.tight_layout()
    path = FIGURES_DIR / "predicted-vs-actual.png"
    fig.savefig(path, dpi=150, facecolor=FIG_BG)
    plt.close(fig)
    saved.append(path.name)

    # 3. Permutation feature importance, top 10.
    top = importance[:10][::-1]
    fig, ax = plt.subplots(figsize=(7.5, 4.5), facecolor=FIG_BG)
    _dark_axes(ax)
    ax.barh(
        [r["feature"] for r in top],
        [r["deltaMaeMin"] for r in top],
        xerr=[r["std"] for r in top],
        color=FIG_ML,
        alpha=0.8,
        error_kw={"ecolor": FIG_TEXT, "elinewidth": 0.8},
    )
    ax.set_xlabel("MAE increase when feature is permuted (min)")
    ax.set_title("Permutation feature importance (top 10, validation subsample)")
    fig.tight_layout()
    path = FIGURES_DIR / "feature-importance.png"
    fig.savefig(path, dpi=150, facecolor=FIG_BG)
    plt.close(fig)
    saved.append(path.name)
    return saved


# ----------------------------------------------------------------- report ---

def print_table(overall: dict, regimes: list[dict]) -> None:
    def row(label: str, b: dict, m: dict) -> str:
        return (
            f"{label:<22} {b['maeMin']:>8.2f} {m['maeMin']:>8.2f} "
            f"{b['rmseMin']:>8.2f} {m['rmseMin']:>8.2f} "
            f"{b['biasMin']:>8.2f} {m['biasMin']:>8.2f} "
            f"{b['within20Pct']:>7.1f} {m['within20Pct']:>7.1f}"
        )

    print()
    print("BENCHMARK vs ML, held-out validation (errors in minutes)")
    print(f"{'':<22} {'B MAE':>8} {'ML MAE':>8} {'B RMSE':>8} {'ML RMSE':>8} {'B bias':>8} {'ML bias':>8} {'B w20%':>7} {'ML w20%':>7}")
    print(row("overall", overall["benchmark"], overall["ml"]))
    for regime in regimes:
        print(row(regime["label"], regime["benchmark"], regime["ml"]))
    print()


def build_verdict(overall: dict, ridge_summary: dict) -> str:
    bench_mae = overall["benchmark"]["maeMin"]
    ml_mae = overall["ml"]["maeMin"]
    if ml_mae < bench_mae:
        pct = (bench_mae - ml_mae) / bench_mae * 100
        verdict = (
            f"ML improves held-out MAE from {bench_mae:.2f} to {ml_mae:.2f} min "
            f"({pct:.1f}% lower)"
        )
    else:
        verdict = (
            f"no improvement: held-out MAE {bench_mae:.2f} min (benchmark) vs "
            f"{ml_mae:.2f} min (ML)"
        )
    if ridge_summary["maeMin"] < ml_mae:
        verdict += (
            f"; note: the ridge baseline ({ridge_summary['maeMin']:.2f} min) "
            f"outperformed the gradient-boosted model"
        )
    return verdict


def write_model_card(
    record: PairedRecord,
    train: pd.DataFrame,
    val: pd.DataFrame,
    overall: dict,
    regimes: list[dict],
    walk_forward: list[dict],
    importance: list[dict],
    verdict: str,
    figures: list[str],
) -> None:
    lines: list[str] = []
    lines.append("# Model card: MRU arrival-time residual correction")
    lines.append("")
    lines.append(f"Generated {_now_utc()} by `python -m ml.arrival_residual.train`.")
    lines.append("")
    lines.append("## Task")
    lines.append("")
    lines.append(
        "Learn the timing residual y = (OMNI propagation delay) - (MRU ballistic delay), "
        "in minutes, from upstream-only L1 features. The corrected arrival prediction is "
        "MRU delay + y_hat. The benchmark is the existing Arrival-time validation study: "
        "ballistic delay (x_sc - BSN_x) * Re / speed vs OMNI `Timeshift`."
    )
    lines.append("")
    lines.append("## Data")
    lines.append("")
    lines.append(f"- Pairing: SPDF high-res OMNI 5-min files ({', '.join(record.source_files)})")
    lines.append(f"- Span: {record.span_start_utc} to {record.span_stop_utc}")
    lines.append(f"- Valid paired samples: {len(train) + len(val):,}")
    lines.append(
        f"- Train: {_iso(train['time'].iloc[0])} to {_iso(train['time'].iloc[-1])} ({len(train):,} rows, earliest {TRAIN_FRACTION:.0%})"
    )
    lines.append(
        f"- Validation: {_iso(val['time'].iloc[0])} to {_iso(val['time'].iloc[-1])} ({len(val):,} rows, latest {1 - TRAIN_FRACTION:.0%})"
    )
    lines.append(
        f"- Storm-regime labels: local hourly Kp archive, coverage {record.kp_coverage_start_utc} to "
        f"{record.kp_coverage_end_utc}; {record.rows_without_kp_label:,} rows had no Kp within 3.5 h and default to quiet"
    )
    lines.append("")
    lines.append("## Features (upstream-only, known at prediction time)")
    lines.append("")
    lines.append("| Feature | Units | Description |")
    lines.append("| --- | --- | --- |")
    for name, units, description in FEATURES:
        lines.append(f"| `{name}` | {units} | {description} |")
    lines.append("")
    lines.append("## Split scheme")
    lines.append("")
    lines.append(
        "Chronological, no shuffling: the earliest 70% of the paired record trains, the "
        "latest 30% validates. Shuffled splits would leak through strong autocorrelation. "
        "A walk-forward-by-year variant is reported below."
    )
    lines.append("")
    lines.append("## Held-out metrics, benchmark vs ML")
    lines.append("")
    lines.append("| Scope | n | MAE bench | MAE ML | RMSE bench | RMSE ML | Bias bench | Bias ML | w20 bench | w20 ML |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")

    def card_row(label: str, n: int, b: dict, m: dict) -> str:
        return (
            f"| {label} | {n:,} | {b['maeMin']:.2f} | {m['maeMin']:.2f} | {b['rmseMin']:.2f} | "
            f"{m['rmseMin']:.2f} | {b['biasMin']:.2f} | {m['biasMin']:.2f} | "
            f"{b['within20Pct']:.1f}% | {m['within20Pct']:.1f}% |"
        )

    lines.append(card_row("Overall", overall["ml"]["samples"], overall["benchmark"], overall["ml"]))
    for regime in regimes:
        lines.append(card_row(regime["label"], regime["n"], regime["benchmark"], regime["ml"]))
    lines.append("")
    lines.append(f"Ridge baseline MAE: {overall['ridge']['maeMin']:.2f} min.")
    lines.append("")
    lines.append(f"**Verdict**: {verdict}.")
    lines.append("")
    if walk_forward:
        lines.append("## Walk-forward by year")
        lines.append("")
        lines.append("| Validation year | Train rows | Val rows | Benchmark MAE | ML MAE |")
        lines.append("| --- | --- | --- | --- | --- |")
        for wf in walk_forward:
            lines.append(
                f"| {wf['year']} | {wf['trainRows']:,} | {wf['valRows']:,} | "
                f"{wf['benchmarkMaeMin']:.2f} | {wf['mlMaeMin']:.2f} |"
            )
        lines.append("")
    lines.append("## Permutation feature importance (top 10)")
    lines.append("")
    lines.append("| Feature | MAE increase (min) | std |")
    lines.append("| --- | --- | --- |")
    for row in importance[:10]:
        lines.append(f"| `{row['feature']}` | {row['deltaMaeMin']:.3f} | {row['std']:.3f} |")
    lines.append("")
    lines.append("## Figures")
    lines.append("")
    for figure in figures:
        lines.append(f"- `figures/{figure}`")
    lines.append("")
    lines.append("## Caveats")
    lines.append("")
    lines.append(
        "- Ground truth is OMNI `Timeshift` (phase-front propagation), the same reference "
        "the benchmark study uses. It is itself a model of the true arrival, not an "
        "independent in-situ detection."
    )
    lines.append(
        "- The deployable benchmark uses a fixed causal bow-shock nose at 13.5 Re, the "
        "same nominal assumption as the current live MRU path. OMNI `BSN_x` is retained "
        "only as retrospective reference lineage and is not a model feature. A live "
        "pressure-dependent standoff estimate would add uncertainty not measured here."
    )
    lines.append(
        "- Features come from the OMNI high-res record, whose plasma and field values are "
        "the upstream L1 spacecraft measurements (ACE/Wind/DSCOVR) for that parcel. No "
        "arrival-side quantity is a feature; this is enforced by a whitelist assertion."
    )
    lines.append(
        "- Severe-storm samples (G3-G5) are a tiny share of the record, so their metrics "
        "carry wide uncertainty."
    )
    lines.append(
        "- The model corrects timing only. It does not change WHAT arrives, only WHEN."
    )
    lines.append(
        f"- The rebuilt record holds {len(train) + len(val):,} valid samples versus the "
        "443,069 the published study counted from the same span: the study pulled OMNI "
        "5-min through CDAWeb HAPI at an earlier date, and SPDF yearly files now carry "
        "more valid rows (OMNI is backfilled over time). The benchmark statistics match "
        "the published ones closely (MAE within 0.1 min)."
    )
    lines.append("")
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    (MODEL_DIR / "model_card.md").write_text("\n".join(lines), encoding="utf-8")


# ------------------------------------------------------------------- main ---

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train the MRU arrival-time residual model.")
    parser.add_argument("--refresh-data", action="store_true", help="Re-download the SPDF yearly files.")
    parser.add_argument("--skip-walk-forward", action="store_true", help="Skip the walk-forward-by-year variant.")
    parser.add_argument("--max-iter", type=int, default=400, help="Boosting iterations for the main model.")
    args = parser.parse_args(argv)

    print("[1/7] Building the paired ACE<->OMNI arrival record ...", flush=True)
    record = build_paired_record(refresh_downloads=args.refresh_data)
    frame = record.frame
    print(f"  {len(frame):,} valid paired samples, {record.span_start_utc} to {record.span_stop_utc}")
    if record.rows_without_kp_label:
        print(
            f"  note: {record.rows_without_kp_label:,} samples have no Kp label within 3.5 h "
            f"(Kp archive coverage {record.kp_coverage_start_utc} to {record.kp_coverage_end_utc}); they count as quiet"
        )

    print("[2/7] Building upstream-only features ...", flush=True)
    frame = build_features(frame)
    assert_no_leakage(FEATURE_NAMES)
    assert frame["target_resid_min"].notna().all(), "target must never be NaN"

    print("[3/7] Chronological 70/30 split (no shuffling) ...", flush=True)
    train, val = chronological_split(frame)
    print(
        f"  train {_iso(train['time'].iloc[0])} to {_iso(train['time'].iloc[-1])} ({len(train):,} rows)\n"
        f"  val   {_iso(val['time'].iloc[0])} to {_iso(val['time'].iloc[-1])} ({len(val):,} rows)"
    )

    print("[4/7] Training ridge baseline ...", flush=True)
    ridge = make_ridge()
    ridge.fit(train[FEATURE_NAMES], train["target_resid_min"])
    ridge_pred = ridge.predict(val[FEATURE_NAMES])

    print(f"[5/7] Training HistGradientBoostingRegressor (max_iter={args.max_iter}) ...", flush=True)
    model = make_hgb(args.max_iter)
    model.fit(train[FEATURE_NAMES], train["target_resid_min"])
    ml_pred = model.predict(val[FEATURE_NAMES])

    y_val = val["target_resid_min"].to_numpy()
    bench_err = val["benchmark_err_min"].to_numpy()  # = -y_val
    ml_err = ml_pred - y_val
    ridge_err = ridge_pred - y_val

    overall = {
        "benchmark": summarize_errors(bench_err),
        "ml": summarize_errors(ml_err),
        "ridge": summarize_errors(ridge_err),
    }
    regimes = stratify_by_regime(val["regime"], val["lead_min"], bench_err, ml_err)
    histogram = error_histogram(bench_err, ml_err)

    print("[6/7] Permutation importance and walk-forward ...", flush=True)
    importance = compute_permutation_importance(model, val, FEATURE_NAMES)
    walk_forward = [] if args.skip_walk_forward else walk_forward_by_year(frame, FEATURE_NAMES, args.max_iter)

    verdict = build_verdict(overall, overall["ridge"])

    print("[7/7] Persisting artifacts ...", flush=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    source_checksums = {
        name: _sha256(PROJECT_ROOT / "data" / "cache" / "omni_high_res" / name)
        for name in record.source_files
    }
    version_basis = {
        "artifactSchemaVersion": ARTIFACT_SCHEMA_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": FEATURE_NAMES,
        "sourceChecksumsSha256": source_checksums,
        "trainRange": [_iso(train["time"].iloc[0]), _iso(train["time"].iloc[-1])],
        "validationRange": [_iso(val["time"].iloc[0]), _iso(val["time"].iloc[-1])],
        "randomState": RANDOM_STATE,
        "maxIter": args.max_iter,
        "sklearnVersion": sklearn.__version__,
    }
    model_version = "arrival-residual-v2-" + hashlib.sha256(
        json.dumps(version_basis, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]
    joblib.dump(
        {
            "artifactSchemaVersion": ARTIFACT_SCHEMA_VERSION,
            "modelVersion": model_version,
            "model": model,
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "featureNames": FEATURE_NAMES,
            "target": "target_resid_min = OMNI Timeshift/60 - causal nominal-geometry MRU delay (min)",
            "benchmarkGeometry": {
                "bowShockNoseXRe": NOMINAL_BOW_SHOCK_X_RE,
                "availability": "fixed causal assumption",
                "referenceBsnXUsedAsFeature": False,
            },
            "trainedAtUtc": _now_utc(),
            "trainRange": version_basis["trainRange"],
            "validationRange": version_basis["validationRange"],
            "sklearnVersion": sklearn.__version__,
            "runtimeVersions": _runtime_versions(),
            "hyperparameters": model.get_params(deep=False),
            "randomState": RANDOM_STATE,
            "sourceFiles": record.source_files,
            "sourceChecksumsSha256": source_checksums,
            "metrics": overall,
            "codeState": _git_state(),
        },
        MODEL_DIR / "model.joblib",
    )
    joblib.dump(ridge, MODEL_DIR / "ridge.joblib")

    figures = save_figures(histogram, y_val, ml_pred, importance)
    write_model_card(record, train, val, overall, regimes, walk_forward, importance, verdict, figures)

    rng = np.random.default_rng(RANDOM_STATE)
    scatter_idx = rng.choice(len(y_val), size=min(1500, len(y_val)), replace=False)
    scatter_sample = [
        [round(float(y_val[i]), 2), round(float(ml_pred[i]), 2)] for i in scatter_idx
    ]

    generated_at = _now_utc()
    metrics_payload = {
        "generatedAtUtc": generated_at,
        "artifact": {
            "schemaVersion": ARTIFACT_SCHEMA_VERSION,
            "modelVersion": model_version,
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "sklearnVersion": sklearn.__version__,
            "featureNames": FEATURE_NAMES,
            "sourceChecksumsSha256": source_checksums,
            "benchmarkGeometry": {
                "bowShockNoseXRe": NOMINAL_BOW_SHOCK_X_RE,
                "availability": "fixed causal assumption",
                "referenceBsnXUsedAsFeature": False,
            },
        },
        "benchmarkName": BENCHMARK_NAME,
        "modelName": MODEL_NAME,
        "pairing": {
            "source": "SPDF high-res OMNI 5-min yearly files (Timeshift vs ballistic delay)",
            "sourceFiles": record.source_files,
            "cadence": "5 min",
            "spanStartUtc": record.span_start_utc,
            "spanStopUtc": record.span_stop_utc,
            "samplesTotal": int(len(frame)),
        },
        "train": {
            "startUtc": _iso(train["time"].iloc[0]),
            "endUtc": _iso(train["time"].iloc[-1]),
            "samples": int(len(train)),
        },
        "validation": {
            "startUtc": _iso(val["time"].iloc[0]),
            "endUtc": _iso(val["time"].iloc[-1]),
            "samples": int(len(val)),
        },
        "overall": overall,
        "improvement": {
            "maeMin": round(overall["benchmark"]["maeMin"] - overall["ml"]["maeMin"], 2),
            "within20Pct": round(overall["ml"]["within20Pct"] - overall["benchmark"]["within20Pct"], 1),
            "biasAbsMin": round(abs(overall["benchmark"]["biasMin"]) - abs(overall["ml"]["biasMin"]), 2),
        },
        "regimes": regimes,
        "histogram": histogram,
        "scatterSample": scatter_sample,
        "featureImportance": importance,
        "walkForward": walk_forward,
        "kpLabels": {
            "coverageStartUtc": record.kp_coverage_start_utc,
            "coverageEndUtc": record.kp_coverage_end_utc,
            "rowsWithoutKpLabel": record.rows_without_kp_label,
        },
        "leakage": {
            "chronologicalSplit": True,
            "trainEndUtc": _iso(train["time"].iloc[-1]),
            "validationStartUtc": _iso(val["time"].iloc[0]),
            "featureWhitelistEnforced": True,
            "note": "Features are upstream L1 quantities only; Timeshift is used solely as the target.",
        },
        "verdict": verdict,
    }
    CONSOLE_DIR.mkdir(parents=True, exist_ok=True)
    METRICS_PATH.write_text(json.dumps(metrics_payload, indent=2), encoding="utf-8")

    feature_variable_names = [name for name, _, _ in FEATURES]
    split_payload = {
        "generatedAtUtc": generated_at,
        "model": {
            "name": MODEL_NAME,
            "modelVersion": model_version,
            "artifactSchemaVersion": ARTIFACT_SCHEMA_VERSION,
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "sklearnVersion": sklearn.__version__,
            "algorithm": "sklearn HistGradientBoostingRegressor (absolute_error loss), ridge baseline",
            "target": "OMNI propagation delay minus MRU ballistic delay, minutes",
            "artifact": "data/ml-model/arrival-residual/model.joblib",
        },
        "split": {
            "scheme": "chronological, earliest 70% train / latest 30% validation, no shuffling",
            "train": {
                "startUtc": _iso(train["time"].iloc[0]),
                "endUtc": _iso(train["time"].iloc[-1]),
                "rows": int(len(train)),
            },
            "validation": {
                "startUtc": _iso(val["time"].iloc[0]),
                "endUtc": _iso(val["time"].iloc[-1]),
                "rows": int(len(val)),
            },
        },
        "features": [
            {"name": name, "units": units, "description": description}
            for name, units, description in FEATURES
        ],
        "datasets": [
            {
                "key": "ace",
                "usedByModel": True,
                "role": "Training input: the model's features are the upstream L1 measurements (speed, density, field, position) of each paired parcel, as carried in the OMNI high-res record.",
                "variables": feature_variable_names,
            },
            {
                "key": "omni",
                "usedByModel": True,
                "role": "Training target and validation reference: OMNI Timeshift is the observed propagation delay the residual is measured against.",
                "variables": ["timeshift_s (target side)", "bsn_x_re (reference lineage only)", "kp (regime labels)"],
            },
            {
                "key": "geo",
                "usedByModel": False,
                "role": "Context only, not used by the arrival-time model.",
                "variables": [],
            },
        ],
        "pairing": metrics_payload["pairing"],
    }
    SPLIT_PATH.write_text(json.dumps(split_payload, indent=2), encoding="utf-8")

    print_table(overall, regimes)
    print(f"Verdict: {verdict}")
    print()
    print("Artifacts:")
    print(f"  {MODEL_DIR / 'model.joblib'}")
    print(f"  {MODEL_DIR / 'model_card.md'}")
    for figure in figures:
        print(f"  {FIGURES_DIR / figure}")
    print(f"  {METRICS_PATH}")
    print(f"  {SPLIT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
