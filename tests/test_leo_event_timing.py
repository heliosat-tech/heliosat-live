from __future__ import annotations

import pandas as pd
import pytest

from leo_drag.metrics import PaddedEventWindow, spacecraft_event_enhancement_metrics


def _event_frame(*, predicted_recovers: bool = True) -> pd.DataFrame:
    timestamp = pd.date_range("2024-05-10T00:00:00Z", periods=9, freq="1h")
    observed_ratio = [1.0, 1.1, 1.25, 1.5, 2.0, 1.5, 1.1, 1.0, 1.0]
    predicted_ratio = [1.0, 1.0, 1.1, 1.25, 1.6, 2.0, 1.4, 1.1, 1.0]
    if not predicted_recovers:
        predicted_ratio[-2:] = [1.4, 1.3]
    rows: list[dict[str, object]] = []
    for spacecraft, baseline in (("A", 1.0e-12), ("B", 9.0e-12)):
        for time, observed, predicted in zip(
            timestamp, observed_ratio, predicted_ratio, strict=True
        ):
            rows.append(
                {
                    "timestamp_utc": time,
                    "mission": "Swarm",
                    "spacecraft_id": spacecraft,
                    "rho_baseline_kg_m3": baseline,
                    "rho_obs_kg_m3": baseline * observed,
                    "rho_predicted_kg_m3": baseline * predicted,
                }
            )
    return pd.DataFrame(rows)


def _window() -> PaddedEventWindow:
    return PaddedEventWindow(
        event_id="storm-20240510",
        event_start_utc="2024-05-10T02:00:00Z",
        event_stop_utc="2024-05-10T05:00:00Z",
        padded_start_utc="2024-05-10T00:00:00Z",
        padded_stop_utc="2024-05-10T08:00:00Z",
        event_block_id="storm-block-20240510",
    )


def test_enhancement_timing_is_computed_per_spacecraft_before_aggregation() -> None:
    result = spacecraft_event_enhancement_metrics(_event_frame(), [_window()])

    assert result["status"] == "available"
    assert result["enhancement_threshold"] == pytest.approx(1.2)
    assert result["spacecraft_event_count"] == 2
    records = result["per_spacecraft_event"]
    assert {record["spacecraft_key"] for record in records} == {"Swarm:A", "Swarm:B"}
    for record in records:
        assert record["onset"]["error_min"] == pytest.approx(60.0)
        assert record["peak_magnitude"]["observed_enhancement_ratio"] == pytest.approx(2.0)
        assert record["peak_magnitude"]["predicted_enhancement_ratio"] == pytest.approx(2.0)
        assert record["peak_magnitude"]["absolute_relative_error"] == pytest.approx(0.0)
        assert record["peak_timing"]["error_min"] == pytest.approx(60.0)
        assert record["recovery"]["error_min"] == pytest.approx(60.0)

    aggregate = result["aggregate"]
    assert aggregate["onset"]["median"] == pytest.approx(60.0)
    assert aggregate["peak_magnitude"]["median"] == pytest.approx(0.0)
    assert aggregate["peak_timing"]["median"] == pytest.approx(60.0)
    assert aggregate["recovery"]["median"] == pytest.approx(60.0)


def test_missing_recovery_remains_null_and_reasoned() -> None:
    result = spacecraft_event_enhancement_metrics(
        _event_frame(predicted_recovers=False), [_window()]
    )

    for record in result["per_spacecraft_event"]:
        assert record["recovery"]["status"] == "unavailable"
        assert record["recovery"]["predicted_utc"] is None
        assert record["recovery"]["error_min"] is None
        assert "predicted" in record["recovery"]["reason"]
        assert "absent" in record["recovery"]["reason"]
    assert result["aggregate"]["recovery"]["status"] == "unavailable"
    assert result["aggregate"]["recovery"]["median"] is None


def test_event_window_must_have_strict_pre_and_post_padding() -> None:
    unpadded = PaddedEventWindow(
        event_id="unpadded",
        event_start_utc="2024-05-10T00:00:00Z",
        event_stop_utc="2024-05-10T05:00:00Z",
        padded_start_utc="2024-05-10T00:00:00Z",
        padded_stop_utc="2024-05-10T05:00:00Z",
    )
    with pytest.raises(ValueError, match="padding"):
        spacecraft_event_enhancement_metrics(_event_frame(), [unpadded])


def test_nonpositive_baseline_never_enters_enhancement_metrics() -> None:
    frame = _event_frame()
    frame.loc[frame["spacecraft_id"] == "B", "rho_baseline_kg_m3"] = 0.0
    result = spacecraft_event_enhancement_metrics(frame, [_window()])
    by_spacecraft = {
        record["spacecraft_key"]: record for record in result["per_spacecraft_event"]
    }

    assert by_spacecraft["Swarm:A"]["status"] == "available"
    assert by_spacecraft["Swarm:B"]["status"] == "unavailable"
    assert by_spacecraft["Swarm:B"]["valid_rows"] == 0
    assert "positive" in by_spacecraft["Swarm:B"]["reason"]


def test_event_outputs_carry_complete_block_bootstrap_identifiers() -> None:
    result = spacecraft_event_enhancement_metrics(_event_frame(), [_window()])

    assert result["bootstrap"] == {
        "compatible": True,
        "block_id_field": "event_block_id",
        "spacecraft_event_id_field": "spacecraft_event_id",
        "event_block_ids": ["storm-block-20240510"],
        "instruction": "resample complete event_block_id groups, never minute rows",
    }
    for record in result["per_spacecraft_event"]:
        assert record["event_id"] == "storm-20240510"
        assert record["event_block_id"] == "storm-block-20240510"
        assert record["spacecraft_event_id"].startswith("storm-20240510::Swarm:")
