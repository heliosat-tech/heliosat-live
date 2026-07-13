"""Feature engineering for the arrival-time residual model.

Every feature is a quantity known AT PREDICTION TIME from the upstream L1
sample (or its recent past). Nothing is taken from the OMNI/arrival side: the
only arrival-side quantity in the whole pipeline is `Timeshift`, which is used
exclusively as the target. `assert_no_leakage` enforces this with an explicit
whitelist.

Physics notes on why these features should carry signal:
- The spacecraft GSE Y/Z offset is the main structural reason flat radial
  (ballistic) propagation differs from OMNI's phase-front timeshift: a tilted
  phase front sweeps an off-axis spacecraft earlier or later than the
  ballistic estimate. Hence sc_y_re, sc_z_re and the off-axis distance.
- Speed and its short history capture compression/acceleration between L1 and
  the bow shock (ballistic assumes constant speed).
- Field strength, Bz, clock angle and the Em merging field describe the
  parcel's structure (ICME vs ambient wind), which correlates with how tilted
  the phase fronts are.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Proton-only dynamic pressure, nPa: Pdyn = 1.6726e-6 * n[/cc] * V[km/s]^2.
PDYN_COEF = 1.6726e-6
NOMINAL_BOW_SHOCK_X_RE = 13.5
FEATURE_SCHEMA_VERSION = "arrival-residual-features-v2-nominal-bow-shock"

# (name, units, description) for documentation artifacts. Single source of truth.
FEATURES: list[tuple[str, str, str]] = [
    ("speed_km_s", "km/s", "Upstream bulk flow speed at L1"),
    ("density_p_cc", "1/cc", "Upstream proton density at L1"),
    ("bmag_nt", "nT", "Upstream field magnitude |B| at L1"),
    ("bz_gsm_nt", "nT", "Upstream Bz GSM at L1"),
    ("by_gsm_nt", "nT", "Upstream By GSM at L1"),
    ("pdyn_npa", "nPa", "Derived dynamic pressure 1.6726e-6 * n * V^2"),
    ("em_mv_m", "mV/m", "Merging electric field V * max(0, -Bz) * 1e-3, the repo's coupling convention"),
    ("clock_angle_deg", "deg", "IMF clock angle atan2(|By|, Bz), 0 north to 180 south"),
    ("sc_x_re", "Re", "Spacecraft GSE X position"),
    ("sc_y_re", "Re", "Spacecraft GSE Y position (off-axis offset)"),
    ("sc_z_re", "Re", "Spacecraft GSE Z position (off-axis offset)"),
    ("sc_ryz_re", "Re", "Off-axis distance sqrt(Y^2 + Z^2)"),
    ("dist_re", "Re", "Causal ballistic distance x_sc - nominal bow-shock nose (13.5 Re)"),
    ("mru_delay_min", "min", "The MRU ballistic delay itself (the benchmark's own prediction)"),
    ("speed_mean_1h_km_s", "km/s", "Trailing 1 h mean of speed"),
    ("speed_mean_3h_km_s", "km/s", "Trailing 3 h mean of speed"),
    ("speed_std_3h_km_s", "km/s", "Trailing 3 h standard deviation of speed"),
    ("bz_mean_1h_nt", "nT", "Trailing 1 h mean of Bz GSM"),
    ("bz_mean_3h_nt", "nT", "Trailing 3 h mean of Bz GSM"),
    ("bz_std_3h_nt", "nT", "Trailing 3 h standard deviation of Bz GSM"),
]

FEATURE_NAMES: list[str] = [name for name, _, _ in FEATURES]

# Columns that exist in the paired frame but must NEVER become features:
# everything derived from the OMNI/arrival side or from the answer itself.
FORBIDDEN_FEATURE_COLUMNS = {
    "timeshift_s",
    "lead_min",
    "target_resid_min",
    "benchmark_err_min",
    "kp",
    "g_level",
    "regime",
}


def build_features(frame: pd.DataFrame) -> pd.DataFrame:
    """Add derived and trailing-rolling features to the paired frame.

    Rolling windows are TIME-based and trailing (current sample plus past
    only), so they are leak-safe by construction: at prediction time the
    upstream monitor has already streamed that history.
    """
    out = frame.copy()
    out["pdyn_npa"] = PDYN_COEF * out["density_p_cc"] * out["speed_km_s"] ** 2
    out["em_mv_m"] = out["speed_km_s"] * np.maximum(0.0, -out["bz_gsm_nt"]) * 1e-3
    out["clock_angle_deg"] = np.degrees(
        np.arctan2(out["by_gsm_nt"].abs(), out["bz_gsm_nt"])
    )
    out["sc_ryz_re"] = np.hypot(out["sc_y_re"], out["sc_z_re"])
    benchmark_bsn = (
        pd.to_numeric(out["benchmark_bsn_x_re"], errors="coerce")
        if "benchmark_bsn_x_re" in out
        else pd.Series(NOMINAL_BOW_SHOCK_X_RE, index=out.index, dtype=float)
    )
    out["dist_re"] = out["sc_x_re"] - benchmark_bsn

    order = out.sort_values("time", kind="mergesort").index
    rolled = out.loc[order].set_index("time")
    speed = rolled["speed_km_s"]
    bz = rolled["bz_gsm_nt"]

    def restore(values: pd.Series) -> pd.Series:
        return pd.Series(values.to_numpy(), index=order).reindex(out.index)

    out["speed_mean_1h_km_s"] = restore(speed.rolling("1h", min_periods=3).mean())
    out["speed_mean_3h_km_s"] = restore(speed.rolling("3h", min_periods=6).mean())
    out["speed_std_3h_km_s"] = restore(speed.rolling("3h", min_periods=6).std())
    out["bz_mean_1h_nt"] = restore(bz.rolling("1h", min_periods=3).mean())
    out["bz_mean_3h_nt"] = restore(bz.rolling("3h", min_periods=6).mean())
    out["bz_std_3h_nt"] = restore(bz.rolling("3h", min_periods=6).std())
    return out


def assert_no_leakage(feature_names: list[str]) -> None:
    """Hard guard: features must be whitelisted and never arrival-side."""
    whitelist = set(FEATURE_NAMES)
    for name in feature_names:
        if name in FORBIDDEN_FEATURE_COLUMNS:
            raise AssertionError(f"Leakage: forbidden arrival-side feature '{name}'")
        if name not in whitelist:
            raise AssertionError(f"Unknown feature '{name}' not in the documented list")
        lowered = name.lower()
        if "timeshift" in lowered or "target" in lowered or "arrival" in lowered:
            raise AssertionError(f"Leakage: suspicious feature name '{name}'")
