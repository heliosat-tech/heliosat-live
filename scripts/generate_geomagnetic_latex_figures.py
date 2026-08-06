#!/usr/bin/env python3
"""Generate the vector figures used by the public geomagnetic report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
STUDY_PATH = ROOT / "data" / "console" / "geomagnetic-storm-study.json"
OUTPUT = ROOT / "output" / "pdf" / "figures"
LANGUAGE = "es"

INK = "#172033"
MUTED = "#667085"
GRID = "#DDE3EC"
CYAN = "#00A6C8"
VIOLET = "#7C5CFC"
GREEN = "#12A676"
AMBER = "#F29D38"
ROSE = "#E2556F"
GREY = "#8993A4"


TEXT = {
    "es": {
        "noaa_1": "NOAA\n1 día", "noaa_2": "NOAA\n2 días", "events_g1": "Eventos G1+", "events_g3": "Eventos G3+",
        "precision": "Precisión", "event_pct": "Porcentaje de eventos",
        "comparison_title": "Comparación sobre los mismos 3.694 intervalos (2025-2026)",
        "nowcast_note": "GFZ nowcast no es un pronóstico: aparece como referencia sin antelación positiva.",
        "all_storms": "G1+ · todas las tormentas", "severe_storms": "G3+ · tormentas severas",
        "hits": "Aciertos\nTP", "false_alarms": "Falsas alarmas\nFP", "misses": "Tormentas perdidas\nFN",
        "episode_count": "Número de episodios", "alert_outcomes": "Qué ocurrió con las alertas de HelioSat en el test final",
        "csi": "CSI", "previous_heuristic": "Heurística anterior", "trained_model": "Modelo entrenado",
        "training_title": "El entrenamiento mejora la detección de G3+",
        "gfz_definitive": "GFZ definitivo", "heliosat_trained": "HelioSat entrenado", "g3_threshold": "umbral G3",
        "may_title": "Tormenta de mayo de 2024: un caso completamente fuera del entrenamiento", "date_format": "%d may",
        "historical_validation": "Validación histórica\n2001-2023", "final_test": "Test final\n2024-2026",
        "observed_episodes": "Episodios observados", "separate_results": "Resultados separados",
        "evidence_title": "95 eventos G3+ de evidencia temporal, sin mezclar niveles de independencia",
    },
    "en": {
        "noaa_1": "NOAA\n1 day", "noaa_2": "NOAA\n2 days", "events_g1": "G1+ events", "events_g3": "G3+ events",
        "precision": "Precision", "event_pct": "Percentage of events",
        "comparison_title": "Comparison over the same 3,694 intervals (2025-2026)",
        "nowcast_note": "GFZ nowcast is not a forecast: it is shown as a reference with no positive lead time.",
        "all_storms": "G1+ · all storms", "severe_storms": "G3+ · severe storms",
        "hits": "Hits\nTP", "false_alarms": "False alarms\nFP", "misses": "Missed storms\nFN",
        "episode_count": "Number of episodes", "alert_outcomes": "What happened to HelioSat alerts in the final test",
        "csi": "CSI", "previous_heuristic": "Previous heuristic", "trained_model": "Trained model",
        "training_title": "Training improves G3+ detection",
        "gfz_definitive": "GFZ definitive", "heliosat_trained": "HelioSat trained", "g3_threshold": "G3 threshold",
        "may_title": "May 2024 storm: a case entirely outside training", "date_format": "%d May",
        "historical_validation": "Historical validation\n2001-2023", "final_test": "Final test\n2024-2026",
        "observed_episodes": "Observed episodes", "separate_results": "Results kept separate",
        "evidence_title": "95 G3+ events of temporal evidence, without mixing independence levels",
    },
}


def t(key: str) -> str:
    return TEXT[LANGUAGE][key]


def setup() -> None:
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 9,
        "axes.titlesize": 11,
        "axes.labelsize": 9,
        "axes.edgecolor": GRID,
        "axes.labelcolor": MUTED,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "text.color": INK,
        "axes.titlecolor": INK,
        "axes.facecolor": "white",
        "figure.facecolor": "white",
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "grid.color": GRID,
        "grid.linewidth": 0.7,
        "grid.alpha": 0.8,
        "legend.frameon": False,
        "pdf.fonttype": 42,
    })


def label_bars(ax: plt.Axes, bars, suffix: str = "%") -> None:
    for bar in bars:
        value = bar.get_height()
        ax.text(bar.get_x() + bar.get_width() / 2, value + 1.5, f"{value:.1f}{suffix}", ha="center", va="bottom", fontsize=8, color=INK)


def product_comparison(study: dict) -> None:
    products = study["results"]["externalComparison"]["products"]
    names = [t("noaa_1"), t("noaa_2"), "HelioSat\n~47 min", "GFZ\nnowcast"]
    fig, axes = plt.subplots(1, 2, figsize=(10.4, 3.9), sharey=True)
    x = np.arange(len(products))
    width = 0.34
    for ax, level, title in zip(axes, ("g1Event", "g3Event"), (t("events_g1"), t("events_g3")), strict=True):
        precision = [p[level]["precisionPct"] or 0 for p in products]
        recall = [p[level]["recallPct"] or 0 for p in products]
        first = ax.bar(x - width / 2, precision, width, label=t("precision"), color=VIOLET)
        second = ax.bar(x + width / 2, recall, width, label="Recall", color=CYAN)
        label_bars(ax, first)
        label_bars(ax, second)
        ax.set_title(title, loc="left", fontweight="bold", pad=10)
        ax.set_xticks(x, names)
        ax.set_ylim(0, 110)
        ax.set_yticks(np.arange(0, 101, 20), [f"{v}%" for v in range(0, 101, 20)])
        ax.grid(axis="x", visible=False)
        ax.set_axisbelow(True)
    axes[0].set_ylabel(t("event_pct"))
    axes[1].legend(loc="upper left")
    fig.suptitle(t("comparison_title"), x=0.07, ha="left", fontsize=12, fontweight="bold")
    fig.text(0.07, 0.01, t("nowcast_note"), color=MUTED, fontsize=8)
    fig.tight_layout(rect=(0, 0.05, 1, 0.92))
    fig.savefig(OUTPUT / "product-comparison.pdf", bbox_inches="tight")
    plt.close(fig)


def event_outcomes(study: dict) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(10.4, 3.5))
    for ax, key, title in zip(axes, ("g1Event", "g3Event"), (t("all_storms"), t("severe_storms")), strict=True):
        metric = study["results"][key]
        values = [metric["tp"], metric["fp"], metric["fn"]]
        labels = [t("hits"), t("false_alarms"), t("misses")]
        bars = ax.bar(labels, values, color=[GREEN, AMBER, ROSE], width=0.62)
        for bar, value in zip(bars, values, strict=True):
            ax.text(bar.get_x() + bar.get_width() / 2, value + max(values) * 0.025, str(value), ha="center", va="bottom", fontsize=12, fontweight="bold")
        ax.set_title(title, loc="left", fontweight="bold")
        ax.set_ylabel(t("episode_count"))
        ax.grid(axis="x", visible=False)
        ax.set_axisbelow(True)
        ax.set_ylim(0, max(values) * 1.2)
    fig.suptitle(t("alert_outcomes"), x=0.07, ha="left", fontsize=12, fontweight="bold")
    fig.tight_layout(rect=(0, 0, 1, 0.91))
    fig.savefig(OUTPUT / "event-outcomes.pdf", bbox_inches="tight")
    plt.close(fig)


def baseline_improvement(study: dict) -> None:
    current = study["results"]["g3Event"]
    baseline = study["results"]["baseline"]["g3Event"]
    metrics = [t("precision"), "Recall", t("csi")]
    before = [baseline["precisionPct"], baseline["recallPct"], baseline["csiPct"]]
    after = [current["precisionPct"], current["recallPct"], current["csiPct"]]
    x = np.arange(3)
    width = 0.34
    fig, ax = plt.subplots(figsize=(7.4, 3.7))
    bars_a = ax.bar(x - width / 2, before, width, label=t("previous_heuristic"), color=GREY)
    bars_b = ax.bar(x + width / 2, after, width, label=t("trained_model"), color=CYAN)
    label_bars(ax, bars_a)
    label_bars(ax, bars_b)
    ax.set_title(t("training_title"), loc="left", fontweight="bold")
    ax.set_xticks(x, metrics)
    ax.set_ylim(0, 100)
    ax.set_yticks(np.arange(0, 101, 20), [f"{v}%" for v in range(0, 101, 20)])
    ax.set_ylabel(t("event_pct"))
    ax.grid(axis="x", visible=False)
    ax.legend(loc="upper left")
    fig.tight_layout()
    fig.savefig(OUTPUT / "baseline-improvement.pdf", bbox_inches="tight")
    plt.close(fig)


def strongest_episode(study: dict) -> None:
    points = pd.DataFrame(study["examples"]["strongestWindow"]["points"])
    points["time"] = pd.to_datetime(points["t"], unit="ms", utc=True)
    fig, ax = plt.subplots(figsize=(10.4, 3.9))
    ax.plot(points["time"], points["gfzKp"], color=GREEN, linewidth=2.6, label=t("gfz_definitive"))
    ax.plot(points["time"], points["heliosatKp"], color=CYAN, linewidth=2.3, label=t("heliosat_trained"))
    ax.plot(points["time"], points["heuristicKp"], color=GREY, linewidth=1.6, linestyle="--", label=t("previous_heuristic"))
    ax.axhline(7, color=ROSE, linewidth=1.2, linestyle=":")
    ax.text(points["time"].iloc[0], 7.16, t("g3_threshold"), color=ROSE, fontsize=8)
    ax.set_ylim(0, 9.4)
    ax.set_yticks(range(0, 10))
    ax.set_ylabel("Kp")
    ax.set_title(t("may_title"), loc="left", fontweight="bold")
    ax.xaxis.set_major_locator(mdates.DayLocator(interval=1))
    ax.xaxis.set_major_formatter(mdates.DateFormatter(t("date_format")))
    ax.grid(axis="x", visible=False)
    ax.legend(loc="upper left", ncol=3)
    fig.tight_layout()
    fig.savefig(OUTPUT / "may-2024-episode.pdf", bbox_inches="tight")
    plt.close(fig)


def evidence_split(study: dict) -> None:
    selected_id = study["training"]["g3Selection"]["params"]["id"]
    selected = next(c for c in study["training"]["g3Selection"]["candidates"] if c["id"] == selected_id)
    validation = selected["oofEvents"]
    final = study["results"]["g3Event"]
    labels = [t("historical_validation"), t("final_test")]
    counts = [validation["observedEvents"], final["observedEvents"]]
    precision = [validation["precisionPct"], final["precisionPct"]]
    recall = [validation["recallPct"], final["recallPct"]]
    fig, axes = plt.subplots(1, 2, figsize=(9.2, 3.4), gridspec_kw={"width_ratios": [0.8, 1.2]})
    count_bars = axes[0].bar(labels, counts, color=[VIOLET, ROSE], width=0.6)
    for bar, value in zip(count_bars, counts, strict=True):
        axes[0].text(bar.get_x() + bar.get_width() / 2, value + 2, str(value), ha="center", fontweight="bold")
    axes[0].set_title(t("events_g3"), loc="left", fontweight="bold")
    axes[0].set_ylabel(t("observed_episodes"))
    axes[0].grid(axis="x", visible=False)
    x = np.arange(2)
    width = 0.34
    first = axes[1].bar(x - width / 2, precision, width, color=VIOLET, label=t("precision"))
    second = axes[1].bar(x + width / 2, recall, width, color=CYAN, label="Recall")
    label_bars(axes[1], first)
    label_bars(axes[1], second)
    axes[1].set_xticks(x, labels)
    axes[1].set_ylim(0, 100)
    axes[1].set_yticks(np.arange(0, 101, 20), [f"{v}%" for v in range(0, 101, 20)])
    axes[1].set_title(t("separate_results"), loc="left", fontweight="bold")
    axes[1].grid(axis="x", visible=False)
    axes[1].legend(loc="lower center", ncol=2)
    fig.suptitle(t("evidence_title"), x=0.06, ha="left", fontsize=12, fontweight="bold")
    fig.tight_layout(rect=(0, 0, 1, 0.9))
    fig.savefig(OUTPUT / "evidence-split.pdf", bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    global LANGUAGE, OUTPUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=("es", "en"), default="es")
    args = parser.parse_args()
    LANGUAGE = args.language
    OUTPUT = ROOT / "output" / "pdf" / ("figures-en" if LANGUAGE == "en" else "figures")
    study = json.loads(STUDY_PATH.read_text(encoding="utf-8"))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    setup()
    product_comparison(study)
    event_outcomes(study)
    baseline_improvement(study)
    strongest_episode(study)
    evidence_split(study)
    for path in sorted(OUTPUT.glob("*.pdf")):
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
