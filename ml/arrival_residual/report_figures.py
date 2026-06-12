"""Print-friendly report figures for the LaTeX university report.

CLI (run from the repo root):

    python -m ml.arrival_residual.report_figures

Writes vector PDFs (plus a 300-dpi PNG fallback each) and captions.md into
docs/report/figures/. Styling targets a white-background serif document:
navy #1B2A4A for the benchmark / observed series, colorblind-safe orange
#D55E00 for the ML / forecast series, labeled axes with units, a legend, and
NO baked-in titles (captions live in LaTeX).

Every number is read from the EXISTING console artifacts so the figures match
the console exactly:
  - data/console/ml_metrics.json     (benchmark-vs-ML evaluation)
  - data/console/ml_data_split.json  (split ranges, feature provenance)
  - data/console/arrival.json        (May 2024 worked-example series + G bands,
                                      themselves derived from the local Kp archive)
Nothing is recomputed in a way that could diverge from the displayed numbers;
the only derivations are the same ones the console performs client-side
(Em = V * max(0, -Bz) * 1e-3 and the rules-based forecast-G overlay, which
mirrors stormScaleService.ts anchor for anchor).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Patch

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONSOLE_DIR = PROJECT_ROOT / "data" / "console"
OUT_DIR = PROJECT_ROOT / "docs" / "report" / "figures"

NAVY = "#1B2A4A"  # benchmark / observed
ORANGE = "#D55E00"  # ML / forecast (colorblind-safe)
GRAY = "#8a8a8a"

WIDTH_IN = 6.5

# Mirrors stormScaleService.ts: Em (mV/m) -> Kp anchors and the speed -> Kp floor,
# used only to reproduce the console's forecast-G overlay for the worked example.
EM_KP_ANCHORS = [(0.0, 1.0), (0.5, 3.0), (1.5, 4.0), (2.5, 5.0), (4.0, 6.0), (6.0, 7.0), (9.0, 8.0), (13.0, 9.0)]
SPEED_KP_ANCHORS = [(350.0, 0.0), (450.0, 2.0), (550.0, 3.0), (650.0, 4.0), (800.0, 5.0)]

plt.rcParams.update({
    "font.family": "serif",
    "font.size": 9,
    "axes.labelsize": 9.5,
    "axes.edgecolor": "#444444",
    "axes.linewidth": 0.8,
    "axes.grid": True,
    "axes.axisbelow": True,
    "grid.color": "#dddddd",
    "grid.linewidth": 0.6,
    "legend.frameon": False,
    "legend.fontsize": 8.5,
    "savefig.bbox": "tight",
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    # TrueType (42) instead of Type 3 so LaTeX/PDF text stays selectable and clean.
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})


def _load(name: str) -> dict:
    with (CONSOLE_DIR / name).open() as handle:
        return json.load(handle)


def _save(fig: plt.Figure, stem: str) -> list[str]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pdf = OUT_DIR / f"{stem}.pdf"
    png = OUT_DIR / f"{stem}.png"
    fig.savefig(pdf)
    fig.savefig(png, dpi=300)
    plt.close(fig)
    return [pdf.name, png.name]


def _interp(anchors: list[tuple[float, float]], x: float) -> float:
    if x <= anchors[0][0]:
        return anchors[0][1]
    if x >= anchors[-1][0]:
        return anchors[-1][1]
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        if x0 <= x <= x1:
            return y0 + (x - x0) / (x1 - x0) * (y1 - y0)
    return anchors[-1][1]


def _g_from_kp(kp: float) -> int:
    return 5 if kp >= 9 else 4 if kp >= 8 else 3 if kp >= 7 else 2 if kp >= 6 else 1 if kp >= 5 else 0


def _ms_to_dt(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


# ---------------------------------------------------------------- figure 1 ---

def fig_error_hist(metrics: dict) -> list[str]:
    hist = metrics["histogram"]
    edges = np.asarray(hist["binEdgesMin"], dtype=float)
    centers = (edges[:-1] + edges[1:]) / 2
    width = float(edges[1] - edges[0])
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.2))
    ax.bar(centers, hist["benchmarkCounts"], width=width, color=NAVY, alpha=0.55,
           edgecolor="none", label="benchmark (MRU ballistic)")
    ax.bar(centers, hist["mlCounts"], width=width, color=ORANGE, alpha=0.55,
           edgecolor="none", label="MRU + ML correction")
    ax.axvline(0, color="#444444", lw=0.8)
    ax.set_xlim(edges[0], edges[-1])
    ax.set_xlabel("arrival-time error (min), predicted $-$ observed")
    ax.set_ylabel("held-out samples")
    ax.legend(loc="upper left")
    ax.grid(axis="x", visible=False)
    return _save(fig, "arrival_error_hist_benchmark_vs_ml")


# ---------------------------------------------------------------- figure 2 ---

def fig_mae_by_regime(metrics: dict) -> list[str]:
    regimes = {r["key"]: r for r in metrics["regimes"]}
    order = ["quiet", "storm", "severe"]
    rows = [regimes[k] for k in order if k in regimes]
    # Tick label carries the regime AND its sample share, so nothing can collide.
    labels = [f"{r['label'].replace(', ', chr(10))}\n{r['sharePct']}% of samples\nn = {r['n']:,}" for r in rows]
    bench = [r["benchmark"]["maeMin"] for r in rows]
    ml = [r["ml"]["maeMin"] for r in rows]
    x = np.arange(len(rows))
    bar_w = 0.36
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.2))
    bars_b = ax.bar(x - bar_w / 2, bench, bar_w, color=NAVY, alpha=0.9, label="benchmark (MRU ballistic)")
    bars_m = ax.bar(x + bar_w / 2, ml, bar_w, color=ORANGE, alpha=0.9, label="MRU + ML correction")
    for bar, value in list(zip(bars_b, bench)) + list(zip(bars_m, ml)):
        ax.text(bar.get_x() + bar.get_width() / 2, value + 0.12, f"{value:.1f}",
                ha="center", va="bottom", fontsize=8)
    ax.set_xticks(x, labels)
    ax.tick_params(axis="x", pad=2)
    ax.set_ylabel("mean absolute error (min)")
    ax.set_ylim(0, max(bench + ml) * 1.22)
    ax.legend(loc="upper right")
    ax.grid(axis="x", visible=False)
    return _save(fig, "mae_by_regime_benchmark_vs_ml")


# ---------------------------------------------------------------- figure 3 ---

def fig_walkforward(metrics: dict) -> list[str]:
    rows = metrics["walkForward"]
    years = [str(r["year"]) for r in rows]
    bench = [r["benchmarkMaeMin"] for r in rows]
    ml = [r["mlMaeMin"] for r in rows]
    x = np.arange(len(rows))
    bar_w = 0.36
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.0))
    bars_b = ax.bar(x - bar_w / 2, bench, bar_w, color=NAVY, alpha=0.9, label="benchmark (MRU ballistic)")
    bars_m = ax.bar(x + bar_w / 2, ml, bar_w, color=ORANGE, alpha=0.9, label="MRU + ML correction")
    for bar, value in list(zip(bars_b, bench)) + list(zip(bars_m, ml)):
        ax.text(bar.get_x() + bar.get_width() / 2, value + 0.1, f"{value:.1f}",
                ha="center", va="bottom", fontsize=8)
    ax.set_xticks(x, years)
    ax.set_xlabel("validation year (trained on all earlier years)")
    ax.set_ylabel("mean absolute error (min)")
    ax.set_ylim(0, max(bench + ml) * 1.2)
    # Legend above the axes: every in-plot corner is occupied by bars here.
    ax.legend(loc="lower left", bbox_to_anchor=(0.0, 1.01), ncols=2, borderaxespad=0)
    ax.grid(axis="x", visible=False)
    return _save(fig, "walkforward_mae_by_year")


# ---------------------------------------------------------------- figure 4 ---

OFF_AXIS_FEATURES = {"sc_y_re", "sc_z_re", "sc_ryz_re"}

# Physical display labels for the report axes; raw artifact names stay in the JSON and
# in the model card, where the exact column identity matters.
FEATURE_TEX = {
    "speed_km_s": "flow speed $V$",
    "density_p_cc": "proton density $n_p$",
    "bmag_nt": "field strength $|B|$",
    "bz_gsm_nt": "$B_z$ (GSM)",
    "by_gsm_nt": "$B_y$ (GSM)",
    "pdyn_npa": "$P_\\mathrm{dyn}$",
    "em_mv_m": "$E_m$ coupling",
    "clock_angle_deg": "clock angle $\\theta_c$",
    "sc_x_re": "s/c position $X$ (GSE)",
    "sc_y_re": "s/c position $Y$ (GSE)",
    "sc_z_re": "s/c position $Z$ (GSE)",
    "sc_ryz_re": "s/c off-axis $\\sqrt{Y^2+Z^2}$",
    "dist_re": "distance $X_\\mathrm{sc}-X_\\mathrm{BSN}$",
    "mru_delay_min": "MRU ballistic delay",
    "speed_mean_1h_km_s": "$\\langle V \\rangle_{1\\,\\mathrm{h}}$",
    "speed_mean_3h_km_s": "$\\langle V \\rangle_{3\\,\\mathrm{h}}$",
    "speed_std_3h_km_s": "$\\sigma(V)_{3\\,\\mathrm{h}}$",
    "bz_mean_1h_nt": "$\\langle B_z \\rangle_{1\\,\\mathrm{h}}$",
    "bz_mean_3h_nt": "$\\langle B_z \\rangle_{3\\,\\mathrm{h}}$",
    "bz_std_3h_nt": "$\\sigma(B_z)_{3\\,\\mathrm{h}}$",
}


def fig_feature_importance(metrics: dict) -> list[str]:
    top = metrics["featureImportance"][:10][::-1]  # barh draws bottom-up
    names = [r["feature"] for r in top]
    labels = [FEATURE_TEX.get(n, n) for n in names]
    values = [r["deltaMaeMin"] for r in top]
    errs = [r["std"] for r in top]
    off_axis = [r for r in metrics["featureImportance"][:10] if r["feature"] in OFF_AXIS_FEATURES]
    dominant = max(off_axis, key=lambda r: r["deltaMaeMin"])["feature"] if off_axis else None
    colors = [ORANGE if n == dominant else NAVY for n in names]
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.4))
    ax.barh(labels, values, xerr=errs, color=colors, alpha=0.9, height=0.62,
            error_kw={"ecolor": "#555555", "elinewidth": 0.8, "capsize": 2})
    ax.set_xlabel("MAE increase when feature is permuted (min)")
    if dominant is not None:
        ax.legend(handles=[
            Patch(color=ORANGE, alpha=0.9, label="spacecraft off-axis position (dominant)"),
            Patch(color=NAVY, alpha=0.9, label="other upstream L1 features"),
        ], loc="lower right")
    ax.grid(axis="y", visible=False)
    return _save(fig, "feature_importance_permutation")


# ---------------------------------------------------------------- figure 5 ---

def _shade_g_bands(ax, bands: list[dict]) -> None:
    """Observed-G shading: navy tint, darker = stronger storm (grayscale-safe)."""
    for band in bands:
        ax.axvspan(_ms_to_dt(band["from"]), _ms_to_dt(band["to"]),
                   color=NAVY, alpha=0.05 + 0.045 * band["level"], lw=0)


# Discrete per-level shading for the v2 variant: ColorBrewer "Purples" sequential scale.
# Purple stays clearly apart from both series colors (navy lines, orange lines), unlike a
# yellow-red severity ramp that would collide with the Em / forecast traces.
G_LEVEL_FILL = {1: "#dadaeb", 2: "#bcbddc", 3: "#9e9ac8", 4: "#756bb1", 5: "#54278f"}
G_FILL_ALPHA = 0.45


def _shade_g_bands_leveled(ax, bands: list[dict]) -> None:
    """Observed-G shading, one distinct color per level (v2 variant)."""
    for band in bands:
        ax.axvspan(_ms_to_dt(band["from"]), _ms_to_dt(band["to"]),
                   color=G_LEVEL_FILL[band["level"]], alpha=G_FILL_ALPHA, lw=0)


def _worked_example_series(arrival: dict) -> dict:
    """All series the worked-example figure needs, shared by both variants."""
    actual = [p for p in arrival["actual"] if p["speed"] is not None]
    predicted = [p for p in arrival["predicted"] if p["speed"] is not None]
    bands = sorted(arrival["bands"], key=lambda b: b["from"])

    bz_pts = [p for p in actual if p["bz"] is not None]

    # Forecast-G overlay, identical to the console panel: trailing 3 h means of Em and
    # speed through the same strided series, then the Em->Kp anchors with the speed floor.
    HOUR_MS = 3_600_000
    em_inst = [p["speed"] * max(0.0, -(p["bz"] or 0.0)) / 1000.0 for p in actual]
    sp_inst = [p["speed"] for p in actual]
    forecast_g: list[int] = []
    observed_g: list[int] = []
    start = 0
    sum_em = 0.0
    sum_sp = 0.0
    count = 0
    for i, p in enumerate(actual):
        sum_em += em_inst[i]
        sum_sp += sp_inst[i]
        count += 1
        while p["t"] - actual[start]["t"] > 3 * HOUR_MS:
            sum_em -= em_inst[start]
            sum_sp -= sp_inst[start]
            count -= 1
            start += 1
        kp = max(_interp(EM_KP_ANCHORS, sum_em / count), _interp(SPEED_KP_ANCHORS, sum_sp / count))
        forecast_g.append(_g_from_kp(min(9.0, max(0.0, kp))))
        lvl = 0
        for band in bands:
            if p["t"] < band["from"]:
                break
            if p["t"] < band["to"]:
                lvl = max(lvl, band["level"])
        observed_g.append(lvl)

    return {
        "bands": bands,
        "t_act": [_ms_to_dt(p["t"]) for p in actual],
        "v_act": [p["speed"] for p in actual],
        "t_pred": [_ms_to_dt(p["t"]) for p in predicted],
        "v_pred": [p["speed"] for p in predicted],
        "t_bz": [_ms_to_dt(p["t"]) for p in bz_pts],
        "bz": [p["bz"] for p in bz_pts],
        "em": [p["speed"] * max(0.0, -p["bz"]) / 1000.0 for p in bz_pts],
        "forecast_g": forecast_g,
        "observed_g": observed_g,
    }


def fig_worked_example(arrival: dict) -> list[str]:
    series = _worked_example_series(arrival)
    bands = series["bands"]
    t_act, v_act = series["t_act"], series["v_act"]
    t_pred, v_pred = series["t_pred"], series["v_pred"]
    t_bz, bz, em = series["t_bz"], series["bz"], series["em"]
    forecast_g, observed_g = series["forecast_g"], series["observed_g"]

    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(WIDTH_IN, 7.0), sharex=True,
                                        gridspec_kw={"height_ratios": [1.2, 1.0, 0.8], "hspace": 0.12})

    # Top: speed, actual OMNI vs predicted MRU, with observed-G shading.
    _shade_g_bands(ax1, bands)
    ax1.plot(t_act, v_act, color=NAVY, lw=1.0, label="actual arrival (OMNI)")
    ax1.plot(t_pred, v_pred, color=ORANGE, lw=0.9, ls="--", label="predicted arrival (MRU)")
    ax1.set_ylabel("solar-wind speed (km s$^{-1}$)")
    handles, labels_ = ax1.get_legend_handles_labels()
    handles.append(Patch(color=NAVY, alpha=0.18, label="observed G level (darker = stronger)"))
    ax1.legend(handles=handles, loc="upper right", ncols=1)
    ax1.grid(axis="x", visible=False)

    # Middle: Bz GSM and the Em coupling, the quantities the G bands actually track.
    _shade_g_bands(ax2, bands)
    ax2.plot(t_bz, bz, color=NAVY, lw=0.9, label="$B_z$ GSM")
    ax2.axhline(0, color="#444444", lw=0.6)
    ax2.set_ylabel("$B_z$ GSM (nT)")
    ax2b = ax2.twinx()
    ax2b.plot(t_bz, em, color=ORANGE, lw=0.9, label="$E_m = V\\,\\max(0,-B_z)\\cdot 10^{-3}$")
    ax2b.set_ylabel("$E_m$ (mV m$^{-1}$)", color=ORANGE)
    ax2b.tick_params(axis="y", colors=ORANGE)
    ax2b.grid(False)
    h2, l2 = ax2.get_legend_handles_labels()
    h2b, l2b = ax2b.get_legend_handles_labels()
    ax2.legend(h2 + h2b, l2 + l2b, loc="lower right")
    ax2.grid(axis="x", visible=False)

    # Bottom: forecast G vs observed G on a G-level axis.
    ax3.step(t_act, observed_g, where="post", color=NAVY, lw=1.2, label="observed G (Kp archive)")
    ax3.step(t_act, forecast_g, where="post", color=ORANGE, lw=1.0, ls="--", label="forecast G (rules-based)")
    ax3.set_ylim(-0.25, 5.4)
    ax3.set_yticks(range(6), [f"G{i}" for i in range(6)])
    ax3.set_ylabel("NOAA G level")
    ax3.set_xlabel("time (UTC), May 2024")
    ax3.legend(loc="upper right")
    ax3.grid(axis="x", visible=False)

    ax3.xaxis.set_major_locator(mdates.DayLocator())
    ax3.xaxis.set_major_formatter(mdates.DateFormatter("%d"))
    return _save(fig, "worked_example_may2024_panels")


def fig_worked_example_v2(arrival: dict) -> list[str]:
    """Alternative styling of the worked example (same data, same panels):
    - one distinct sequential color per observed G level instead of graded gray,
      with an explicit G1..G5 patch legend above the figure;
    - in-panel legends on a white frame and placed over empty regions, so no
      swatch or label sits on top of the curves."""
    series = _worked_example_series(arrival)
    bands = series["bands"]
    t_act, v_act = series["t_act"], series["v_act"]
    t_pred, v_pred = series["t_pred"], series["v_pred"]
    t_bz, bz, em = series["t_bz"], series["bz"], series["em"]
    forecast_g, observed_g = series["forecast_g"], series["observed_g"]

    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(WIDTH_IN, 7.0), sharex=True,
                                        gridspec_kw={"height_ratios": [1.2, 1.0, 0.8], "hspace": 0.12})

    legend_kw = {"frameon": True, "framealpha": 0.92, "facecolor": "white", "edgecolor": "#cccccc"}

    # Figure-level legend: one patch per observed G level present in the event.
    levels = sorted({band["level"] for band in bands})
    fig.legend(
        handles=[Patch(color=G_LEVEL_FILL[lvl], alpha=G_FILL_ALPHA, label=f"G{lvl}") for lvl in levels],
        title="observed G level", loc="upper center", bbox_to_anchor=(0.5, 1.0),
        ncols=len(levels), frameon=False, columnspacing=1.0, handlelength=1.4,
    )

    # Top: speed, actual OMNI vs predicted MRU. Legend upper-left, where the
    # pre-storm wind is slow and the corner is empty.
    _shade_g_bands_leveled(ax1, bands)
    ax1.plot(t_act, v_act, color=NAVY, lw=1.0, label="actual arrival (OMNI)")
    ax1.plot(t_pred, v_pred, color=ORANGE, lw=0.9, ls="--", label="predicted arrival (MRU)")
    ax1.set_ylabel("solar-wind speed (km s$^{-1}$)")
    ax1.legend(loc="upper left", **legend_kw)
    ax1.grid(axis="x", visible=False)

    # Middle: Bz GSM and the Em coupling, the quantities the G bands actually track.
    _shade_g_bands_leveled(ax2, bands)
    ax2.plot(t_bz, bz, color=NAVY, lw=0.9, label="$B_z$ GSM")
    ax2.axhline(0, color="#444444", lw=0.6)
    ax2.set_ylabel("$B_z$ GSM (nT)")
    ax2b = ax2.twinx()
    ax2b.plot(t_bz, em, color=ORANGE, lw=0.9, label="$E_m = V\\,\\max(0,-B_z)\\cdot 10^{-3}$")
    ax2b.set_ylabel("$E_m$ (mV m$^{-1}$)", color=ORANGE)
    ax2b.tick_params(axis="y", colors=ORANGE)
    ax2b.grid(False)
    h2, l2 = ax2.get_legend_handles_labels()
    h2b, l2b = ax2b.get_legend_handles_labels()
    ax2.legend(h2 + h2b, l2 + l2b, loc="center right", **legend_kw)
    ax2.grid(axis="x", visible=False)

    # Bottom: forecast G vs observed G on a G-level axis.
    ax3.step(t_act, observed_g, where="post", color=NAVY, lw=1.2, label="observed G (Kp archive)")
    ax3.step(t_act, forecast_g, where="post", color=ORANGE, lw=1.0, ls="--", label="forecast G (rules-based)")
    ax3.set_ylim(-0.25, 5.4)
    ax3.set_yticks(range(6), [f"G{i}" for i in range(6)])
    ax3.set_ylabel("NOAA G level")
    ax3.set_xlabel("time (UTC), May 2024")
    ax3.legend(loc="upper right", **legend_kw)
    ax3.grid(axis="x", visible=False)

    ax3.xaxis.set_major_locator(mdates.DayLocator())
    ax3.xaxis.set_major_formatter(mdates.DateFormatter("%d"))
    return _save(fig, "worked_example_may2024_panels_v2")


# ---------------------------------------------------------------- figure 6 ---

def fig_residual_scatter(metrics: dict) -> list[str]:
    sample = np.asarray(metrics["scatterSample"], dtype=float)
    lim = 60.0
    fig, ax = plt.subplots(figsize=(4.6, 4.4))
    ax.hexbin(sample[:, 0], sample[:, 1], gridsize=36, extent=(-lim, lim, -lim, lim),
              cmap="Blues", mincnt=1, linewidths=0.1)
    ax.plot([-lim, lim], [-lim, lim], color=ORANGE, lw=1.0, ls="--", label="perfect correction")
    ax.set_xlim(-lim, lim)
    ax.set_ylim(-lim, lim)
    ax.set_xlabel("actual residual $y$ = OMNI delay $-$ MRU delay (min)")
    ax.set_ylabel("predicted residual $\\hat{y}$ (min)")
    ax.legend(loc="upper left")
    ax.set_aspect("equal")
    return _save(fig, "residual_pred_vs_actual_hexbin")


# ---------------------------------------------------------------- captions ---

CAPTIONS_TEMPLATE = """# Report figures: benchmark vs ML arrival-time correction

Generated {generated} by `python -m ml.arrival_residual.report_figures`.
Every number is read from the console artifacts (`data/console/ml_metrics.json`,
`ml_data_split.json`, `arrival.json`; the observed-G bands in `arrival.json` are derived
from the local hourly Kp archive), so the figures match the console exactly.
Each figure ships as a vector PDF plus a 300-dpi PNG fallback. Colors: navy #1B2A4A for
the benchmark / observed series, orange #D55E00 for the ML / forecast series.

| Figure | Suggested caption | Report section |
| --- | --- | --- |
| `arrival_error_hist_benchmark_vs_ml.pdf` | Held-out arrival-time error distribution ({val_n} samples, {val_start} to {val_end}): the ML residual correction narrows the MRU ballistic error distribution and removes its early bias (MAE {bench_mae} to {ml_mae} min). | 4.7 |
| `mae_by_regime_benchmark_vs_ml.pdf` | Held-out MAE by observed storm regime: the ML correction improves quiet and G1-G2 samples but not the rare G3-G5 stratum ({severe_n} samples), where the benchmark remains slightly better. | 4.7 |
| `walkforward_mae_by_year.pdf` | Walk-forward validation (train on all earlier years, validate on the year shown): the ML correction improves the MAE in every year, growing with training-set size. | 4.7 |
| `feature_importance_permutation.pdf` | Permutation feature importance of the residual model (validation subsample): the spacecraft off-axis position dominates, consistent with phase-front tilt being the main physical gap in flat ballistic propagation. | 3.4.3 / 4.6 |
| `worked_example_may2024_panels.pdf` | May 2024 G5 storm worked example: arrived solar-wind speed under MRU vs OMNI timing (top), the Bz GSM and Em coupling that actually drive the observed G shading (middle), and the rules-based forecast G against the observed G level (bottom). | 4.9 |
| `worked_example_may2024_panels_v2.pdf` | Same data and caption as the previous figure, alternative styling: one sequential purple per observed G level with an explicit G1-G5 legend, and framed legends placed off the curves. | 4.9 |
| `residual_pred_vs_actual_hexbin.pdf` | Predicted vs actual timing residual on the held-out set (the 1,500-point sample persisted in `ml_metrics.json`): the model captures the bulk of the residual but compresses extremes, as expected from an MAE-optimized learner. | 4.6 |

## Data provenance of the model features

The 20 model features are physically read from the OMNI high-resolution 5-min columns
(SPDF `omni_5min_YYYY.asc` files), NOT from the local ACE JSON archive
(`data/console/ace-archive.json`). The plasma and field values in those OMNI columns are
the upstream L1 spacecraft measurements (ACE / Wind / DSCOVR) of each parcel, time-tagged
at its bow-shock arrival, which is what makes the pairing with OMNI `Timeshift` exact.
The local hourly ACE JSON archive is displayed in the console as the upstream L1 dataset
card but is not an input file of the model. The OMNI side contributes only `Timeshift`
(the regression target), `BSN_x` (benchmark geometry) and the hourly Kp archive used for
the storm-regime labels.
"""


def write_captions(metrics: dict) -> str:
    severe = next((r for r in metrics["regimes"] if r["key"] == "severe"), None)
    text = CAPTIONS_TEMPLATE.format(
        generated=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        val_n=f"{metrics['validation']['samples']:,}",
        val_start=metrics["validation"]["startUtc"][:10],
        val_end=metrics["validation"]["endUtc"][:10],
        bench_mae=f"{metrics['overall']['benchmark']['maeMin']:.2f}",
        ml_mae=f"{metrics['overall']['ml']['maeMin']:.2f}",
        severe_n=f"{severe['n']:,}" if severe else "n/a",
    )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "captions.md").write_text(text, encoding="utf-8")
    return "captions.md"


def main() -> int:
    metrics = _load("ml_metrics.json")
    arrival = _load("arrival.json")

    written: list[str] = []
    written += fig_error_hist(metrics)
    written += fig_mae_by_regime(metrics)
    written += fig_walkforward(metrics)
    written += fig_feature_importance(metrics)
    written += fig_worked_example(arrival)
    written += fig_worked_example_v2(arrival)
    written += fig_residual_scatter(metrics)
    written.append(write_captions(metrics))

    print(f"Wrote {len(written)} files to {OUT_DIR}:")
    for name in written:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
