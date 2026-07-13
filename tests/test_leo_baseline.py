from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import numpy as np
import pytest

from leo_drag.baseline import AtmosphereInput, PymsisBaseline
from leo_drag.baseline_processing import research_license_enabled


class _FakePymsis:
    __version__ = "test"
    Variable = SimpleNamespace(MASS_DENSITY=0)

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def calculate(self, dates, lons, lats, alts, **kwargs):
        self.calls.append({
            "dates": dates,
            "lons": lons,
            "lats": lats,
            "alts": alts,
            **kwargs,
        })
        output = np.ones((len(dates), 11), dtype=float)
        output[:, 0] = 1.25e-12
        return output


def _input(**overrides) -> AtmosphereInput:
    values = {
        "timestamp_utc": "2022-02-03T00:00:00Z",
        "latitude_deg": 10.0,
        "longitude_deg": 20.0,
        "altitude_km": 450.0,
        "f107_sfu": 110.0,
        "f107a_sfu": 105.0,
        "ap": [6, 5, 4, 3, 2, 2, 1],
        "ancillary_source": "test fixture",
    }
    values.update(overrides)
    return AtmosphereInput(**values)


def test_baseline_requires_explicit_research_acknowledgement() -> None:
    result = PymsisBaseline(pymsis_module=_FakePymsis()).predict_density(_input())
    assert result.baseline_input_status == "license_not_acknowledged"
    assert result.rho_baseline_kg_m3 is None
    assert result.research_only is True


@pytest.mark.parametrize(
    ("environment", "explicit", "expected"),
    [
        (None, False, False),
        ("true", False, False),
        (None, True, False),
        ("true", True, True),
    ],
)
def test_pipeline_license_gate_requires_environment_and_run_acknowledgement(
    monkeypatch: pytest.MonkeyPatch,
    environment: str | None,
    explicit: bool,
    expected: bool,
) -> None:
    if environment is None:
        monkeypatch.delenv("HELIOSAT_ENABLE_NRLMSIS_RESEARCH", raising=False)
    else:
        monkeypatch.setenv("HELIOSAT_ENABLE_NRLMSIS_RESEARCH", environment)
    assert research_license_enabled(explicit) is expected


def test_baseline_passes_explicit_forcing_and_storm_ap_mode() -> None:
    module = _FakePymsis()
    result = PymsisBaseline(
        allow_research_use=True, pymsis_module=module
    ).predict_density(_input())
    assert result.baseline_input_status == "ok"
    assert result.rho_baseline_kg_m3 == pytest.approx(1.25e-12)
    call = module.calls[0]
    assert call["geomagnetic_activity"] == -1
    assert np.asarray(call["aps"]).shape == (1, 7)
    assert np.asarray(call["f107s"])[0] == pytest.approx(110.0)
    assert result.input_metadata["geomagnetic_activity_mode"] == "storm_time_seven_ap"


def test_baseline_missing_input_returns_no_numeric_value() -> None:
    result = PymsisBaseline(
        allow_research_use=True, pymsis_module=_FakePymsis()
    ).predict_density(_input(f107_sfu=None))
    assert result.baseline_input_status == "missing_inputs"
    assert result.rho_baseline_kg_m3 is None


def test_baseline_rejects_ancillary_that_was_not_available() -> None:
    result = PymsisBaseline(
        allow_research_use=True, pymsis_module=_FakePymsis()
    ).predict_density(_input(
        ancillary_available_at_utc=datetime(2022, 2, 4, tzinfo=timezone.utc)
    ))
    assert result.baseline_input_status == "invalid_input"
    assert "not available" in (result.error or "")


def test_batch_adapter_preserves_order_and_row_status() -> None:
    module = _FakePymsis()
    baseline = PymsisBaseline(allow_research_use=True, pymsis_module=module)
    results = baseline.predict_many([_input(latitude_deg=0), _input(altitude_km=None), _input(latitude_deg=20)])
    assert [result.baseline_input_status for result in results] == ["ok", "missing_inputs", "ok"]
    assert len(module.calls) == 1
    assert len(np.asarray(module.calls[0]["dates"])) == 2
