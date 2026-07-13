from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from leo_drag.drivers import (
    HELIOSAT_MRU_ARRIVAL,
    HELIOSAT_MRU_ML_ARRIVAL,
    REFERENCE_ALIGNED,
)
from leo_drag.features import FEATURE_SCHEMA_VERSION, TARGET_COLUMN
from leo_drag.manifest import empty_manifest, write_manifest_atomic
from leo_drag.multiyear import MULTIYEAR_PLAN_SCHEMA_VERSION
from leo_drag.multiyear_study import (
    EXPECTED_SPACECRAFT,
    MULTIYEAR_STUDY_SCHEMA_VERSION,
    build_year_role_split,
    load_plan_baseline_observations,
    run_multiyear_study_from_feature_frames,
)
from leo_drag.response import (
    DEFAULT_FIXED_LAGS_HOURS,
    DISTRIBUTED_LAG_BINS_HOURS,
    distributed_lag_feature_name,
    fixed_lag_feature_name,
)


def _plan() -> dict[str, object]:
    core: dict[str, object] = {
        "schema_version": MULTIYEAR_PLAN_SCHEMA_VERSION,
        "strategy": "synthetic_contract_test_never_observational_evidence",
        "study_period": {
            "start_utc": "2021-01-01T00:00:00Z",
            "stop_utc": "2026-01-01T00:00:00Z",
            "calendar_years": [2021, 2022, 2023, 2024, 2025],
        },
        "collections": [
            "SW_OPER_DNSAPOD_2_", "SW_OPER_DNSBPOD_2_",
            "SW_OPER_DNSCPOD_2_", "GF_OPER_DNS1ACC_2_",
        ],
        "intervals": [
            {
                "interval_id": "quiet-contract",
                "kind": "quiet",
                "start_utc": "2021-01-01T00:00:00Z",
                "stop_utc": "2026-01-01T00:00:00Z",
            }
        ],
        "download_ranges": [],
        "coverage_summary": {
            "effective_observation_days": 10,
            "quiet_intervals": 1,
            "moderate_storms": 0,
            "severe_storms": 0,
            "spacecraft_count": 4,
        },
        "analysis_cadence": "5min",
    }
    digest = hashlib.sha256(
        json.dumps(core, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {
        **core,
        "plan_id": f"test-{digest[:12]}",
        "plan_sha256": digest,
        "generated_at_utc": "2026-07-13T00:00:00Z",
    }


def _feature_frames() -> dict[str, pd.DataFrame]:
    spacecraft = (
        ("Swarm", "A"), ("Swarm", "B"),
        ("Swarm", "C"), ("GRACE-FO", "1"),
    )
    rows: list[dict[str, object]] = []
    for year in range(2021, 2026):
        for day_index, month_day in enumerate(((1, 1), (7, 1), (10, 1))):
            month, day = month_day
            timestamp = pd.Timestamp(year=year, month=month, day=day, tz="UTC")
            for spacecraft_index, (mission, spacecraft_id) in enumerate(spacecraft):
                phase = (year - 2021) * 0.7 + day_index * 0.3 + spacecraft_index * 0.2
                baseline = 1.0e-12 * (1.0 + 0.03 * np.cos(phase))
                residual = 0.08 * np.sin(phase)
                rows.append({
                    "timestamp_utc": timestamp,
                    "forecast_issuance_time_utc": timestamp,
                    "mission": mission,
                    "spacecraft_id": spacecraft_id,
                    "spacecraft_key": f"{mission}:{spacecraft_id}",
                    "source_product": f"official-{mission}-{spacecraft_id}",
                    "orbit_direction": "ascending" if day_index % 2 else "descending",
                    "rho_obs_kg_m3": baseline * np.exp(residual),
                    "rho_baseline_kg_m3": baseline,
                    TARGET_COLUMN: residual,
                    "altitude_km": 440.0 + 25.0 * spacecraft_index,
                    "latitude_deg": -60.0 + 40.0 * day_index,
                    "local_solar_time_h": float(2 + 7 * day_index),
                    "longitude_sin": np.sin(phase),
                    "longitude_cos": np.cos(phase),
                    "local_solar_time_sin": np.sin(phase / 2),
                    "local_solar_time_cos": np.cos(phase / 2),
                    "day_of_year_sin": np.sin(phase / 3),
                    "day_of_year_cos": np.cos(phase / 3),
                    "f107_sfu": 100.0 + year - 2021,
                    "f107a_sfu": 98.0 + year - 2021,
                    "log_rho_baseline": np.log(baseline),
                    "vsw_km_s": 390.0 + phase * 10,
                    "bz_gsm_nt": -2.0 - phase,
                    "newell_coupling": 2_000.0 + 100.0 * phase,
                    "drv__vsw_km_s__mean__1h": 385.0 + phase * 10,
                    "drv__newell_coupling__integral_h__3h": 5_000.0 + phase,
                    "driver_join_status": "matched",
                    "study_regime": "quiet" if day_index < 2 else "moderate_storm",
                    "study_interval_id": f"interval-{year}-{day_index}",
                    "bootstrap_event_block": (
                        f"event:{year}-{day_index}" if day_index == 2
                        else f"day:{timestamp:%Y-%m-%d}"
                    ),
                })
    base = pd.DataFrame(rows)
    definitions = [
        {"name": "orbit_direction", "group": "context"},
        {"name": "altitude_km", "group": "context"},
        {"name": "latitude_deg", "group": "context"},
        {"name": "local_solar_time_sin", "group": "context"},
        {"name": "local_solar_time_cos", "group": "context"},
        {"name": "log_rho_baseline", "group": "baseline"},
        {"name": "vsw_km_s", "group": "solar_wind"},
        {"name": "bz_gsm_nt", "group": "solar_wind"},
        {"name": "newell_coupling", "group": "solar_wind"},
        {"name": "drv__vsw_km_s__mean__1h", "group": "solar_wind"},
        {"name": "drv__newell_coupling__integral_h__3h", "group": "solar_wind"},
    ]
    frames: dict[str, pd.DataFrame] = {}
    for offset, mode in enumerate(
        (REFERENCE_ALIGNED, HELIOSAT_MRU_ARRIVAL, HELIOSAT_MRU_ML_ARRIVAL)
    ):
        frame = base.copy()
        frame["vsw_km_s"] += offset * 3.0
        frame.attrs["feature_dataset_metadata"] = {
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "dataset_version": f"synthetic-{mode}-v1",
            "experiment_mode": mode,
            "geomagnetic_availability": {},
            "feature_definitions": definitions,
        }
        frames[mode] = frame
    return frames


def test_fixed_year_role_split_is_strict_and_complete() -> None:
    frame = _feature_frames()[REFERENCE_ALIGNED]
    split = build_year_role_split(frame)
    years = pd.to_datetime(frame["timestamp_utc"], utc=True).dt.year
    assert set(years.loc[list(split.train_index)]) == {2021, 2022}
    assert set(years.loc[list(split.validation_index)]) == {2023}
    assert set(years.loc[list(split.calibration_index)]) == {2024}
    assert set(years.loc[list(split.test_index)]) == {2025}
    incomplete = frame.loc[years.ne(2024)].copy()
    with pytest.raises(ValueError, match="2024"):
        build_year_role_split(incomplete)


def test_synthetic_multiyear_run_writes_paired_schema_rich_artifacts(tmp_path: Path) -> None:
    frames = _feature_frames()
    # Real Parquet/calibration joins can preserve a numeric density column as
    # object dtype; plot finalization must coerce it rather than aborting after
    # the scientific fit has completed.
    for frame in frames.values():
        frame["rho_obs_kg_m3"] = frame["rho_obs_kg_m3"].astype(str)
    report = run_multiyear_study_from_feature_frames(
        frames,
        output_root=tmp_path,
        run_id="synthetic-study",
        plan=_plan(),
        random_seed=11,
        bootstrap_resamples=10,
    )
    summary_path = Path(report["study_summary"])
    summary = json.loads(summary_path.read_text())

    assert summary["schema_version"] == MULTIYEAR_STUDY_SCHEMA_VERSION
    assert summary["common_rows"]["common_rows"] == 60
    assert summary["split"]["roles"]["test"]["calendar_years"] == [2025]
    assert set(summary["modes"]) == {
        REFERENCE_ALIGNED, HELIOSAT_MRU_ARRIVAL, HELIOSAT_MRU_ML_ARRIVAL,
    }
    fingerprints = {
        mode["comparison_contract_sha256"] for mode in summary["modes"].values()
    }
    assert fingerprints == {summary["comparison_contract"]["sha256"]}
    for mode in summary["modes"].values():
        assert "mission" not in mode["feature_columns"]
        assert "spacecraft_id" not in mode["feature_columns"]
        assert mode["uncertainty"]["test"]["status"] == "available"
        coverage = mode["uncertainty"]["test"]
        assert 0.0 <= coverage["observed_below_p50_fraction"] <= 1.0
        assert 0.0 <= coverage["observed_above_p50_fraction"] <= 1.0
    assert set(summary["validation"]["leave_one_spacecraft_out"]["results"]) == set(
        EXPECTED_SPACECRAFT
    )
    assert summary["validation"]["cross_mission_swarm_to_grace_fo"]["status"] == "available"
    assert summary["arrival_mode_comparison"]["status"] == "available"
    assert summary["arrival_mode_comparison"]["metric_prediction_variant"] == "uncalibrated_point_prediction"
    assert summary["arrival_mode_comparison"]["headline_density_metrics_variant"] == "p50_calibrated_on_held_out_2024"
    assert summary["ablations"]["results"]["A6"]["status"] == "unavailable"
    assert summary["lag_response"]["status"] == "unavailable"
    assert all(mode["deployable"] is False for mode in summary["modes"].values())
    assert summary["modes"][REFERENCE_ALIGNED]["models"][0]["role"] == "retrospective_diagnostic"
    assert "code_state" in summary
    assert (summary_path.parent / HELIOSAT_MRU_ML_ARRIVAL / "m3.joblib").is_file()
    declared_plots = [item for item in summary["artifacts"] if item.startswith("plots/")]
    assert "plots/observed-versus-baseline.png" in declared_plots
    assert "plots/reference-versus-end-to-end.png" in declared_plots
    assert all((summary_path.parent / item).is_file() for item in declared_plots)
    predictions = pd.read_parquet(
        summary_path.parent / HELIOSAT_MRU_ML_ARRIVAL / "m3-test-predictions.parquet"
    )
    assert {"rho_p10_kg_m3", "rho_p50_kg_m3", "rho_p90_kg_m3"}.issubset(predictions)


def test_runner_lag_integration_selects_on_validation_and_reports_distributed_breakdowns() -> None:
    from leo_drag.multiyear_study import _run_lag_response

    frame = _feature_frames()[HELIOSAT_MRU_ML_ARRIVAL]
    signal = pd.to_numeric(frame[TARGET_COLUMN], errors="coerce")
    for lag in DEFAULT_FIXED_LAGS_HOURS:
        # A deterministic fixture; exact physical lag construction is already
        # tested in test_leo_response.py. Here we test runner integration only.
        frame[fixed_lag_feature_name("newell_coupling", lag)] = signal + lag * 0.001
    for lower, upper in DISTRIBUTED_LAG_BINS_HOURS:
        frame[distributed_lag_feature_name("newell_coupling", "mean", lower, upper)] = (
            signal + upper * 0.001
        )
        frame[
            distributed_lag_feature_name("newell_coupling", "integral_h", lower, upper)
        ] = signal * (upper - lower)
    result = _run_lag_response(frame, build_year_role_split(frame), random_seed=5)

    assert result["status"] == "available"
    assert result["selection_policy"].startswith("fixed lag selected on 2023")
    assert result["fixed_lag"]["results"]["newell_coupling"]["selection_source"] == "validation_only"
    distributed = result["distributed_lag"]
    assert distributed["test_metrics"]["status"] == "available"
    assert "latitude" in distributed["lag_importance_breakdowns"]["dimensions"]


def test_multiyear_lag_plots_accept_nested_saved_importance(tmp_path: Path) -> None:
    from leo_drag.plots import _multiyear_lag_plots

    summary = {
        "lag_response": {
            "fixed_lag": {"results": {"newell_coupling": {
                "candidate_validation": [
                    {"lag_hours": 0.0, "selection_value": 0.12},
                    {"lag_hours": 5.0, "selection_value": 0.10},
                ],
                "selected_lag_hours": 5.0,
            }}},
            "distributed_lag": {"lag_importance_breakdowns": {"overall": {
                "lag_importance": {
                    "response__newell_coupling__mean__3to6h": {
                        "delta_rmse_mean": 0.004,
                    }
                }
            }}},
        }
    }
    artifacts = _multiyear_lag_plots(summary, tmp_path)

    assert artifacts == [
        "plots/lag-response-fixed-mru_ml.png",
        "plots/distributed-lag-mru_ml.png",
    ]
    assert (tmp_path / "lag-response-fixed-mru_ml.png").is_file()
    assert (tmp_path / "distributed-lag-mru_ml.png").is_file()


def test_manifest_loader_uses_only_plan_tagged_causal_exact_five_minute_rows(
    tmp_path: Path,
) -> None:
    plan = _plan()
    root = tmp_path / "data"
    baseline_dir = root / "processed" / "thermosphere-baseline" / "trailing_81_day"
    baseline_dir.mkdir(parents=True)
    timestamps = pd.to_datetime(
        ["2021-01-01T00:00:00Z", "2021-01-01T00:01:00Z", "2021-01-01T00:05:00Z"],
        utc=True,
    )
    tagged = pd.DataFrame({
        "timestamp_utc": timestamps,
        "mission": "Swarm",
        "spacecraft_id": "A",
        "source_product": "SW_OPER_DNSAPOD_2_",
        "rho_obs_kg_m3": [1.0e-12, 2.0e-12, 3.0e-12],
        "quality_flag": pd.Series([0, 0, 0], dtype="Int64"),
        "baseline_input_status": "ok",
        "rho_baseline_kg_m3": 1.0e-12,
    })
    untagged = tagged.copy()
    untagged["rho_obs_kg_m3"] = 99.0e-12
    tagged_path, untagged_path = baseline_dir / "tagged.parquet", baseline_dir / "other.parquet"
    tagged.to_parquet(tagged_path, index=False)
    untagged.to_parquet(untagged_path, index=False)
    manifest = empty_manifest()
    common = {
        "mission": "Swarm", "spacecraft_id": "A",
        "source_product": "SW_OPER_DNSAPOD_2_",
        "baseline_f107a_mode": "trailing_81_day",
        "baseline_forecast_causal_f107a": True,
    }
    manifest["entries"] = [
        {
            **common, "id": "tagged", "corpus_plan_id": plan["plan_id"],
            "corpus_plan_sha256": plan["plan_sha256"],
            "baseline_files": [str(tagged_path.relative_to(root))],
        },
        {
            **common, "id": "not-this-plan", "corpus_plan_id": "different",
            "corpus_plan_sha256": "different",
            "baseline_files": [str(untagged_path.relative_to(root))],
        },
    ]
    manifest_path = root / "processed" / "thermosphere" / "manifest.v1.json"
    write_manifest_atomic(manifest_path, manifest)

    selected, lineage = load_plan_baseline_observations(data_root=root, plan=plan)

    assert len(selected) == 2
    assert selected["timestamp_utc"].dt.minute.tolist() == [0, 5]
    assert selected["rho_obs_kg_m3"].max() == pytest.approx(3.0e-12)
    assert lineage["tagged_entry_ids"] == ["tagged"]
    assert lineage["analysis_cadence"].startswith("exact")
