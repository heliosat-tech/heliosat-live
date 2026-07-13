"""Scientific plots for versioned LEO density study artifacts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from .metrics import EventWindow
from .models import ModelSuiteResult, load_model_artifact

BACKGROUND = "#07111f"
PANEL = "#0f1c2e"
TEXT = "#d9e6f2"
GRID = "#25364d"
CYAN = "#33c8d7"
AMBER = "#f5b942"
MAGENTA = "#db6dba"
GREEN = "#65d48a"


def _plt():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    return plt


def _style(ax: Any, title: str, xlabel: str = "", ylabel: str = "") -> None:
    ax.set_facecolor(PANEL)
    ax.set_title(title, color=TEXT, fontsize=10)
    ax.set_xlabel(xlabel, color=TEXT, fontsize=8)
    ax.set_ylabel(ylabel, color=TEXT, fontsize=8)
    ax.tick_params(colors=TEXT, labelsize=7)
    ax.grid(color=GRID, linewidth=0.5, alpha=0.7)
    for spine in ax.spines.values():
        spine.set_color(GRID)


def _save(fig: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor=BACKGROUND, bbox_inches="tight")
    _plt().close(fig)


def _prediction_path(root: Path, run_id: str, mode: str, model: str = "m3") -> Path:
    return root / run_id / mode / f"{model}-test-predictions.parquet"


def _metric_by_group(frame: pd.DataFrame, group: pd.Series) -> tuple[list[str], list[float]]:
    labels: list[str] = []
    values: list[float] = []
    error = np.abs(
        np.log10(frame["rho_predicted_kg_m3"].to_numpy(float))
        - np.log10(frame["rho_obs_kg_m3"].to_numpy(float))
    )
    work = pd.DataFrame({"group": group.astype(str).to_numpy(), "error": error})
    for label, subset in work.groupby("group", sort=True):
        labels.append(str(label))
        values.append(float(subset["error"].mean()))
    return labels, values


def _baseline_overview(observations: pd.DataFrame, plot_dir: Path) -> str:
    plt = _plt()
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2), facecolor=BACKGROUND)
    sampled = observations.sort_values("timestamp_utc").iloc[::20]
    axes[0].scatter(
        np.log10(sampled["rho_obs_kg_m3"]), np.log10(sampled["rho_baseline_kg_m3"]),
        s=4, alpha=0.25, color=CYAN,
    )
    bounds = [
        min(axes[0].get_xlim()[0], axes[0].get_ylim()[0]),
        max(axes[0].get_xlim()[1], axes[0].get_ylim()[1]),
    ]
    axes[0].plot(bounds, bounds, "--", color=AMBER, linewidth=1)
    _style(axes[0], "Observed versus NRLMSIS baseline", "log10 observed rho", "log10 baseline rho")
    ratios = observations["rho_obs_kg_m3"] / observations["rho_baseline_kg_m3"]
    axes[1].hist(np.log10(ratios), bins=80, color=CYAN, alpha=0.8)
    axes[1].axvline(0, color=AMBER, linestyle="--", linewidth=1)
    _style(axes[1], "Baseline log-ratio residual", "log10(observed / baseline)", "rows")
    path = plot_dir / "observed-versus-baseline.png"
    _save(fig, path)
    return f"plots/{path.name}"


def _mode_plots(frame: pd.DataFrame, mode: str, plot_dir: Path) -> list[str]:
    plt = _plt()
    artifacts: list[str] = []
    mode_label = "Reference aligned" if mode == "reference_aligned" else "HelioSat predicted arrival"

    selected_key = frame[["mission", "spacecraft_id"]].drop_duplicates().iloc[0]
    selected = frame[
        (frame["mission"] == selected_key["mission"])
        & (frame["spacecraft_id"] == selected_key["spacecraft_id"])
    ].set_index("timestamp_utc")
    series = selected[["rho_obs_kg_m3", "rho_baseline_kg_m3", "rho_predicted_kg_m3"]].resample("15min").median()
    fig, ax = plt.subplots(figsize=(11, 4), facecolor=BACKGROUND)
    ax.plot(series.index, series["rho_obs_kg_m3"], color=TEXT, linewidth=1, label="Observed ESA density")
    ax.plot(series.index, series["rho_baseline_kg_m3"], color=AMBER, linewidth=1, label="NRLMSIS baseline")
    ax.plot(series.index, series["rho_predicted_kg_m3"], color=CYAN, linewidth=1, label="M3 corrected")
    ax.set_yscale("log")
    ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=7)
    _style(ax, f"{mode_label}: held-out density time series", "UTC", "rho [kg/m3]")
    path = plot_dir / f"corrected-density-timeseries-{mode}.png"
    _save(fig, path)
    artifacts.append(f"plots/{path.name}")

    fig, axes = plt.subplots(1, 2, figsize=(10, 4.2), facecolor=BACKGROUND)
    observed_log = np.log10(frame["rho_obs_kg_m3"])
    predicted_log = np.log10(frame["rho_predicted_kg_m3"])
    axes[0].hexbin(observed_log, predicted_log, gridsize=55, mincnt=1, cmap="viridis")
    low = float(min(observed_log.min(), predicted_log.min()))
    high = float(max(observed_log.max(), predicted_log.max()))
    axes[0].plot([low, high], [low, high], "--", color=AMBER, linewidth=1)
    _style(axes[0], "Corrected predicted versus observed", "log10 observed rho", "log10 M3 rho")
    residual = predicted_log - observed_log
    axes[1].hist(residual, bins=80, color=CYAN, alpha=0.8)
    axes[1].axvline(0, color=AMBER, linestyle="--", linewidth=1)
    _style(axes[1], "Held-out corrected residual", "log10(predicted / observed)", "rows")
    path = plot_dir / f"scatter-residual-{mode}.png"
    _save(fig, path)
    artifacts.append(f"plots/{path.name}")

    absolute_error = np.abs(residual)
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.8), facecolor=BACKGROUND)
    contexts = [
        (pd.cut(frame["altitude_km"], bins=10), "Altitude", "km"),
        (pd.cut(frame["latitude_deg"], bins=np.linspace(-90, 90, 13)), "Latitude", "degrees"),
        (pd.cut(frame["local_solar_time_h"], bins=np.linspace(0, 24, 9)), "Local solar time", "hours"),
    ]
    for ax, (groups, label, units) in zip(axes, contexts, strict=True):
        grouped = pd.DataFrame({"group": groups, "error": absolute_error}).groupby("group", observed=True)
        points = grouped["error"].mean()
        ax.plot(np.arange(len(points)), points.to_numpy(), marker="o", color=CYAN, linewidth=1)
        ax.set_xticks(np.arange(len(points)), [str(value) for value in points.index], rotation=55, ha="right")
        _style(ax, f"Error by {label.lower()}", f"{label} [{units}]", "MAE log10 rho")
    path = plot_dir / f"error-by-orbital-context-{mode}.png"
    _save(fig, path)
    artifacts.append(f"plots/{path.name}")

    mission_labels, mission_values = _metric_by_group(
        frame, frame["mission"].astype(str) + " " + frame["spacecraft_id"].astype(str)
    )
    latitude = frame["latitude_deg"].abs()
    regime = pd.Series(np.select(
        [latitude >= 60, latitude >= 30], ["high latitude", "mid latitude"], default="equatorial"
    ), index=frame.index)
    regime_labels, regime_values = _metric_by_group(frame, regime)
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8), facecolor=BACKGROUND)
    axes[0].bar(mission_labels, mission_values, color=[CYAN, MAGENTA, GREEN, AMBER][:len(mission_labels)])
    axes[0].tick_params(axis="x", rotation=30)
    _style(axes[0], "Held-out error by mission", "mission / spacecraft", "MAE log10 rho")
    axes[1].bar(regime_labels, regime_values, color=[CYAN, MAGENTA, GREEN][:len(regime_labels)])
    axes[1].tick_params(axis="x", rotation=25)
    _style(axes[1], "Held-out error by latitude regime", "retrospective regime", "MAE log10 rho")
    path = plot_dir / f"error-by-mission-regime-{mode}.png"
    _save(fig, path)
    artifacts.append(f"plots/{path.name}")

    coupling = pd.to_numeric(frame.get("newell_coupling"), errors="coerce")
    valid = coupling.notna() & np.isfinite(coupling) & np.isfinite(residual)
    if valid.sum() > 20:
        bins = pd.qcut(coupling[valid], q=min(10, coupling[valid].nunique()), duplicates="drop")
        response = pd.DataFrame({"bin": bins, "target": frame.loc[valid, "target_log_density_residual"], "prediction": np.log(frame.loc[valid, "rho_predicted_kg_m3"] / frame.loc[valid, "rho_baseline_kg_m3"])}).groupby("bin", observed=True).median()
        fig, ax = plt.subplots(figsize=(7, 4), facecolor=BACKGROUND)
        x = np.arange(len(response))
        ax.plot(x, response["target"], marker="o", color=TEXT, label="Observed residual")
        ax.plot(x, response["prediction"], marker="o", color=CYAN, label="M3 residual")
        ax.set_xticks(x, [str(value) for value in response.index], rotation=55, ha="right")
        ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=7)
        _style(ax, "Binned coupling-response diagnostic", "Newell coupling quantile", "ln density residual")
        path = plot_dir / f"coupling-response-{mode}.png"
        _save(fig, path)
        artifacts.append(f"plots/{path.name}")
    return artifacts


def _event_plots(observations: pd.DataFrame, events: Sequence[EventWindow], plot_dir: Path) -> list[str]:
    plt = _plt()
    output: list[str] = []
    for event in events:
        start, stop = pd.to_datetime(event.start_utc, utc=True), pd.to_datetime(event.stop_utc, utc=True)
        data = observations[observations["timestamp_utc"].between(start, stop, inclusive="both")].copy()
        if data.empty:
            continue
        fig, ax = plt.subplots(figsize=(10, 4), facecolor=BACKGROUND)
        for index, ((mission, spacecraft), group) in enumerate(data.groupby(["mission", "spacecraft_id"])):
            series = group.set_index("timestamp_utc")[["rho_obs_kg_m3", "rho_baseline_kg_m3"]].resample("10min").median()
            color = [CYAN, MAGENTA, GREEN, TEXT][index % 4]
            ax.plot(series.index, series["rho_obs_kg_m3"], color=color, linewidth=1, label=f"{mission} {spacecraft} observed")
            ax.plot(series.index, series["rho_baseline_kg_m3"], color=color, linewidth=0.7, linestyle="--", alpha=0.65)
        ax.set_yscale("log")
        ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=6, ncol=2)
        _style(ax, f"Retrospective Kp>=5 event: {event.event_id}", "UTC", "rho [kg/m3]")
        path = plot_dir / f"event-{event.event_id}.png"
        _save(fig, path)
        output.append(f"plots/{path.name}")
    return output


def _lag_plot(frame: pd.DataFrame, mode: str, plot_dir: Path) -> str | None:
    plt = _plt()
    needed = {"timestamp_utc", "target_log_density_residual", "newell_coupling"}
    if not needed.issubset(frame.columns):
        return None
    aggregate = frame.groupby("timestamp_utc", as_index=True)[
        ["target_log_density_residual", "newell_coupling"]
    ].median().resample("5min").median()
    lags = np.arange(0, 12.01, 0.25)
    correlations: list[float] = []
    for lag in lags:
        shifted = aggregate["newell_coupling"].shift(int(round(lag * 12)))
        correlations.append(float(aggregate["target_log_density_residual"].corr(shifted)))
    fig, ax = plt.subplots(figsize=(7, 3.8), facecolor=BACKGROUND)
    ax.plot(lags, correlations, color=CYAN, linewidth=1.2)
    ax.axhline(0, color=GRID, linewidth=0.8)
    _style(ax, "Exploratory coupling-to-density lag correlation", "driver lead / response lag [h]", "Pearson r")
    path = plot_dir / f"coupling-lag-{mode}.png"
    _save(fig, path)
    return f"plots/{path.name}"


def _feature_importance(
    frame: pd.DataFrame,
    model_path: Path,
    mode: str,
    plot_dir: Path,
    random_seed: int,
) -> str | None:
    if not model_path.exists():
        return None
    from sklearn.inspection import permutation_importance

    payload = load_model_artifact(model_path)
    estimator = payload["estimator"]
    features = list(payload["feature_columns"])
    sample = frame.sample(n=min(600, len(frame)), random_state=random_seed)
    result = permutation_importance(
        estimator,
        sample[features],
        sample["target_log_density_residual"],
        scoring="neg_mean_absolute_error",
        n_repeats=1,
        random_state=random_seed,
        n_jobs=1,
    )
    records = sorted(
        [
            {"feature": feature, "mae_increase": float(mean)}
            for feature, mean in zip(features, result.importances_mean, strict=True)
        ],
        key=lambda row: row["mae_increase"], reverse=True,
    )
    metadata_path = plot_dir / f"feature-importance-{mode}.json"
    metadata_path.write_text(json.dumps({
        "method": "single-repeat permutation importance on 600 held-out rows",
        "random_seed": random_seed,
        "records": records,
    }, indent=2), encoding="utf-8")
    top = records[:15][::-1]
    plt = _plt()
    fig, ax = plt.subplots(figsize=(8, 5), facecolor=BACKGROUND)
    ax.barh([item["feature"] for item in top], [item["mae_increase"] for item in top], color=CYAN)
    _style(ax, "M3 held-out permutation importance", "increase in residual MAE", "feature")
    path = plot_dir / f"feature-importance-{mode}.png"
    _save(fig, path)
    return f"plots/{path.name}"


def _mode_comparison(
    predictions: Mapping[str, pd.DataFrame],
    plot_dir: Path,
) -> str | None:
    if len(predictions) < 2:
        return None
    plt = _plt()
    modes = ["reference_aligned", "heliosat_predicted_arrival"]
    labels, m0, m3 = [], [], []
    for mode in modes:
        frame = predictions.get(mode)
        if frame is None:
            continue
        labels.append("Reference" if mode == "reference_aligned" else "HelioSat end-to-end")
        observed = np.log10(frame["rho_obs_kg_m3"])
        m0.append(float(np.mean(np.abs(np.log10(frame["rho_baseline_kg_m3"]) - observed))))
        m3.append(float(np.mean(np.abs(np.log10(frame["rho_predicted_kg_m3"]) - observed))))
    x = np.arange(len(labels))
    fig, ax = plt.subplots(figsize=(7, 4), facecolor=BACKGROUND)
    ax.bar(x - 0.18, m0, width=0.36, color=AMBER, label="M0 baseline")
    ax.bar(x + 0.18, m3, width=0.36, color=CYAN, label="M3 L1 augmented")
    ax.set_xticks(x, labels)
    ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=7)
    _style(ax, "Reference alignment versus end-to-end", "experiment mode", "held-out MAE log10 rho")
    path = plot_dir / "reference-versus-end-to-end.png"
    _save(fig, path)
    return f"plots/{path.name}"


def generate_study_plots(
    *,
    run_directory: str | Path,
    observations: pd.DataFrame,
    feature_frames: Mapping[str, pd.DataFrame],
    suites: Mapping[str, ModelSuiteResult],
    events: Sequence[EventWindow],
    kp: pd.DataFrame,
    model_root: str | Path,
    random_seed: int = 42,
) -> list[str]:
    """Generate every plot from official observations or held-out predictions."""

    del kp  # Kp-derived events are already explicit in ``events``.
    run_dir = Path(run_directory)
    root = Path(model_root)
    plot_dir = run_dir / "plots"
    artifacts = [_baseline_overview(observations, plot_dir)]
    artifacts.extend(_event_plots(observations, events, plot_dir))
    predictions: dict[str, pd.DataFrame] = {}
    for mode, suite in suites.items():
        path = _prediction_path(root, suite.run_id, mode)
        if not path.exists():
            continue
        frame = pd.read_parquet(path)
        frame["timestamp_utc"] = pd.to_datetime(frame["timestamp_utc"], utc=True)
        predictions[mode] = frame
        artifacts.extend(_mode_plots(frame, mode, plot_dir))
        lag = _lag_plot(feature_frames[mode], mode, plot_dir)
        if lag:
            artifacts.append(lag)
        importance = _feature_importance(
            frame, root / suite.run_id / mode / "m3.joblib", mode, plot_dir, random_seed
        )
        if importance:
            artifacts.append(importance)
            artifacts.append(f"plots/feature-importance-{mode}.json")
    comparison = _mode_comparison(predictions, plot_dir)
    if comparison:
        artifacts.append(comparison)
    return sorted(set(artifacts))


def _multiyear_regime_plot(frame: pd.DataFrame, plot_dir: Path) -> str:
    """Plot held-out error by mission and the plan's saved storm regime."""

    mission_labels, mission_values = _metric_by_group(
        frame, frame["mission"].astype(str) + " " + frame["spacecraft_id"].astype(str)
    )
    regime_labels, regime_values = _metric_by_group(frame, frame["study_regime"])
    plt = _plt()
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8), facecolor=BACKGROUND)
    axes[0].bar(
        mission_labels, mission_values,
        color=[CYAN, MAGENTA, GREEN, AMBER][:len(mission_labels)],
    )
    axes[0].tick_params(axis="x", rotation=30)
    _style(axes[0], "Held-out error by mission", "mission / spacecraft", "MAE log10 rho")
    axes[1].bar(
        regime_labels, regime_values,
        color=[GREEN, AMBER, MAGENTA][:len(regime_labels)],
    )
    axes[1].tick_params(axis="x", rotation=25)
    _style(axes[1], "Held-out error by storm regime", "saved Kp regime", "MAE log10 rho")
    path = plot_dir / "error-by-mission-regime-heliosat_predicted_arrival.png"
    _save(fig, path)
    return f"plots/{path.name}"


def _multiyear_ablation_plot(summary: Mapping[str, Any], plot_dir: Path) -> str | None:
    results = summary.get("ablations", {}).get("results", {})
    rows = [
        (str(key), str(value.get("label", key)), value.get("metrics", {}).get("mae_log10_rho"))
        for key, value in results.items()
        if isinstance(value, Mapping) and isinstance(value.get("metrics"), Mapping)
    ]
    rows = [(key, label, float(mae)) for key, label, mae in rows if isinstance(mae, (int, float))]
    if not rows:
        return None
    plt = _plt()
    fig, ax = plt.subplots(figsize=(8.5, 4.5), facecolor=BACKGROUND)
    labels = [f"{key} · {label}" for key, label, _ in rows]
    values = [value for _, _, value in rows]
    ax.barh(np.arange(len(rows)), values, color=[AMBER, CYAN, CYAN, CYAN, CYAN, CYAN][:len(rows)])
    ax.set_yticks(np.arange(len(rows)), labels)
    ax.invert_yaxis()
    _style(
        ax, "Feature-group ablation on matched 2025 test rows",
        "MAE log10 rho (lower is better)", "predeclared feature group",
    )
    path = plot_dir / "feature-group-ablation-mru_ml.png"
    _save(fig, path)
    return f"plots/{path.name}"


def _multiyear_lag_plots(summary: Mapping[str, Any], plot_dir: Path) -> list[str]:
    lag = summary.get("lag_response", {})
    fixed = lag.get("fixed_lag", {}).get("results", {}) if isinstance(lag, Mapping) else {}
    output: list[str] = []
    curves: list[tuple[str, list[float], list[float], float | None]] = []
    if isinstance(fixed, Mapping):
        for driver, result in fixed.items():
            if not isinstance(result, Mapping):
                continue
            candidates = result.get("candidate_validation", [])
            points = [
                (float(item["lag_hours"]), float(item["selection_value"]))
                for item in candidates
                if isinstance(item, Mapping)
                and isinstance(item.get("lag_hours"), (int, float))
                and isinstance(item.get("selection_value"), (int, float))
            ]
            if points:
                curves.append((str(driver), [x for x, _ in points], [y for _, y in points], result.get("selected_lag_hours")))
    if curves:
        plt = _plt()
        fig, ax = plt.subplots(figsize=(7.5, 4.2), facecolor=BACKGROUND)
        for index, (driver, hours, values, selected) in enumerate(curves):
            color = [CYAN, MAGENTA][index % 2]
            ax.plot(hours, values, marker="o", markersize=2.5, color=color, label=driver)
            if isinstance(selected, (int, float)):
                ax.axvline(float(selected), color=color, linestyle="--", linewidth=0.8, alpha=0.75)
        ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=7)
        _style(ax, "Validation-only fixed response-lag scan", "response lag [h]", "2023 RMSE log10 rho")
        path = plot_dir / "lag-response-fixed-mru_ml.png"
        _save(fig, path)
        output.append(f"plots/{path.name}")

    distributed = lag.get("distributed_lag", {}) if isinstance(lag, Mapping) else {}
    importance = distributed.get("lag_importance_breakdowns", {}).get("overall", {}) if isinstance(distributed, Mapping) else {}
    if isinstance(importance, Mapping) and isinstance(importance.get("lag_importance"), Mapping):
        importance = importance["lag_importance"]
    records = []
    if isinstance(importance, Mapping):
        for feature, values in importance.items():
            if isinstance(values, Mapping) and isinstance(values.get("delta_rmse_mean"), (int, float)):
                records.append((str(feature), float(values["delta_rmse_mean"])))
    records = sorted(records, key=lambda item: abs(item[1]), reverse=True)[:15][::-1]
    if records:
        plt = _plt()
        fig, ax = plt.subplots(figsize=(9, 5.2), facecolor=BACKGROUND)
        labels = [feature.replace("response__", "").replace("__", " · ") for feature, _ in records]
        values = [value for _, value in records]
        ax.barh(labels, values, color=[CYAN if value >= 0 else MAGENTA for value in values])
        ax.axvline(0, color=GRID, linewidth=0.8)
        _style(ax, "Distributed-lag permutation diagnostic", "change in residual RMSE", "lag-bin feature")
        path = plot_dir / "distributed-lag-mru_ml.png"
        _save(fig, path)
        output.append(f"plots/{path.name}")
    return output


def _multiyear_uncertainty_plot(summary: Mapping[str, Any], plot_dir: Path) -> str | None:
    calibration = summary.get("uncertainty_calibration", {})
    metrics = calibration.get("metrics", {}) if isinstance(calibration, Mapping) else {}
    observed = [
        metrics.get("observed_at_or_below_p10_fraction"),
        metrics.get("observed_at_or_below_p50_fraction"),
        metrics.get("observed_at_or_below_p90_fraction"),
    ]
    if not all(isinstance(value, (int, float)) for value in observed):
        return None
    plt = _plt()
    fig, ax = plt.subplots(figsize=(6.5, 4), facecolor=BACKGROUND)
    x = np.arange(3)
    ax.bar(x - 0.18, [0.1, 0.5, 0.9], width=0.36, color=AMBER, label="nominal")
    ax.bar(x + 0.18, observed, width=0.36, color=CYAN, label="2025 empirical")
    ax.set_xticks(x, ["p10", "p50", "p90"])
    ax.set_ylim(0, 1)
    ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=7)
    _style(ax, "Held-out density interval calibration", "saved quantile", "fraction observed below bound")
    path = plot_dir / "uncertainty-calibration-mru_ml.png"
    _save(fig, path)
    return f"plots/{path.name}"


def _multiyear_event_plots(
    frame: pd.DataFrame, summary: Mapping[str, Any], plot_dir: Path, *, maximum: int = 3,
) -> list[str]:
    event_timing = summary.get("event_timing", {})
    raw_events = event_timing.get("per_event", []) if isinstance(event_timing, Mapping) else []
    events = [event for event in raw_events if isinstance(event, Mapping)]
    severe = [event for event in events if str(event.get("event_id", "")).startswith("severe-")]
    selected = (severe or events)[:maximum]
    output: list[str] = []
    for event in selected:
        event_id = str(event.get("event_id", ""))
        try:
            padded_start = pd.to_datetime(event["padded_start_utc"], utc=True)
            padded_stop = pd.to_datetime(event["padded_stop_utc"], utc=True)
            core_start = pd.to_datetime(event["event_start_utc"], utc=True)
            core_stop = pd.to_datetime(event["event_stop_utc"], utc=True)
        except (KeyError, TypeError, ValueError):
            continue
        data = frame[frame["timestamp_utc"].between(padded_start, padded_stop, inclusive="both")]
        if data.empty:
            continue
        ratios = data.assign(
            observed_enhancement=data["rho_obs_kg_m3"] / data["rho_baseline_kg_m3"],
            predicted_enhancement=data["rho_predicted_kg_m3"] / data["rho_baseline_kg_m3"],
        ).groupby("timestamp_utc")[["observed_enhancement", "predicted_enhancement"]].median()
        plt = _plt()
        fig, ax = plt.subplots(figsize=(10, 4), facecolor=BACKGROUND)
        ax.plot(ratios.index, ratios["observed_enhancement"], color=TEXT, linewidth=1, label="Observed / NRLMSIS")
        ax.plot(ratios.index, ratios["predicted_enhancement"], color=CYAN, linewidth=1, label="MRU+ML M3 / NRLMSIS")
        ax.axhline(1.2, color=AMBER, linestyle="--", linewidth=0.9, label="declared 1.2 threshold")
        ax.axvspan(core_start, core_stop, color=MAGENTA, alpha=0.14, label="Kp event core")
        ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=7, ncol=2)
        _style(ax, f"Retrospective held-out storm response · {event_id}", "UTC", "density enhancement ratio")
        path = plot_dir / f"event-{event_id}.png"
        _save(fig, path)
        output.append(f"plots/{path.name}")
    return output


def generate_multiyear_study_plots(
    *,
    run_directory: str | Path,
    predictions: Mapping[str, pd.DataFrame],
    summary: Mapping[str, Any],
) -> list[str]:
    """Generate saved figures only from matched held-out official observations.

    The primary corrected-density figures use the MRU+ML point prediction.  The
    reference and MRU timelines remain separate in the end-to-end comparison.
    """

    required = {"reference_aligned", "heliosat_mru_ml_arrival"}
    if not required.issubset(predictions):
        return []
    prepared: dict[str, pd.DataFrame] = {}
    for mode, value in predictions.items():
        frame = value.copy()
        frame["timestamp_utc"] = pd.to_datetime(frame["timestamp_utc"], utc=True)
        frame["rho_predicted_kg_m3"] = pd.to_numeric(
            frame["rho_point_prediction_kg_m3"], errors="coerce"
        )
        density_columns = [
            "rho_obs_kg_m3", "rho_baseline_kg_m3", "rho_predicted_kg_m3",
        ]
        frame[density_columns] = frame[density_columns].apply(
            pd.to_numeric, errors="coerce"
        )
        density_values = frame[density_columns].to_numpy(dtype=float)
        valid = np.isfinite(density_values).all(axis=1)
        valid &= (density_values > 0).all(axis=1)
        prepared[mode] = frame.loc[valid].copy()
    primary = prepared["heliosat_mru_ml_arrival"]
    if primary.empty or prepared["reference_aligned"].empty:
        return []
    plot_dir = Path(run_directory) / "plots"
    artifacts = [_baseline_overview(primary, plot_dir)]
    artifacts.extend(_mode_plots(primary, "heliosat_predicted_arrival", plot_dir))
    artifacts.append(_multiyear_regime_plot(primary, plot_dir))
    comparison = _mode_comparison({
        "reference_aligned": prepared["reference_aligned"],
        "heliosat_predicted_arrival": primary,
    }, plot_dir)
    if comparison:
        artifacts.append(comparison)
    ablation = _multiyear_ablation_plot(summary, plot_dir)
    if ablation:
        artifacts.append(ablation)
    artifacts.extend(_multiyear_lag_plots(summary, plot_dir))
    calibration = _multiyear_uncertainty_plot(summary, plot_dir)
    if calibration:
        artifacts.append(calibration)
    artifacts.extend(_multiyear_event_plots(primary, summary, plot_dir))
    return sorted(set(artifacts))


__all__ = ["generate_multiyear_study_plots", "generate_study_plots"]
