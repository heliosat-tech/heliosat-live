"""Replaceable atmospheric-density baselines for HelioSat LEO research.

The production application must never silently substitute a climatology value
when the model or one of its forcing inputs is unavailable.  Consequently the
public interface in this module returns a status-rich :class:`BaselineResult`
for every requested point.  A successful result is the *only* state carrying a
numeric density.

``PymsisBaseline`` is an optional adapter around the official ``pymsis`` API.
It deliberately supplies F10.7, F10.7a and all seven Ap values to
``pymsis.calculate``.  Omitting these arguments would let pymsis download or
interpolate ancillary data implicitly, which would make a study difficult to
reproduce and could leak information that was unavailable at forecast issue
time.
"""

from __future__ import annotations

import importlib
import math
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Literal, Sequence

import numpy as np

BaselineStatus = Literal[
    "ok",
    "missing_inputs",
    "invalid_input",
    "dependency_unavailable",
    "license_not_acknowledged",
    "model_error",
]

PYMSIS_LICENSE_WARNING = (
    "NRLMSIS 2.x/pymsis is enabled for internal research only until HelioSat "
    "has completed commercial-use and onward-distribution review."
)


def _utc_datetime(value: datetime | str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("timestamp_utc must include a timezone")
    return parsed.astimezone(timezone.utc)


def _finite_number(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def _normalise_ap(value: float | Sequence[float] | None) -> tuple[float, ...] | None:
    """Return the seven Ap inputs required for storm-time MSIS operation.

    A scalar is accepted as an explicitly chosen constant history and expanded
    to seven entries.  This is recorded in the result metadata; it is never
    interpreted as an observed seven-bin history.
    """

    if value is None:
        return None
    if isinstance(value, (str, bytes)):
        return None
    if isinstance(value, Sequence) or isinstance(value, np.ndarray):
        values = tuple(_finite_number(item) for item in value)
        if len(values) != 7 or any(item is None for item in values):
            return None
        result = tuple(float(item) for item in values if item is not None)
    else:
        item = _finite_number(value)
        if item is None:
            return None
        result = (item,) * 7
    if any(item < 0 for item in result):
        return None
    return result


@dataclass(frozen=True)
class AtmosphereInput:
    """One geodetic point and its explicit atmosphere forcing inputs.

    ``f107_sfu`` is the previous-day daily flux expected by MSIS and
    ``f107a_sfu`` is the explicitly selected 81-day mean (centered only for a
    labelled retrospective run, trailing through D-1 for a causal run). ``ap`` may be a seven-value
    storm-time history in the order required by pymsis, or a scalar that the
    caller intentionally applies to all seven slots.
    """

    timestamp_utc: datetime | str
    latitude_deg: float | None
    longitude_deg: float | None
    altitude_km: float | None
    f107_sfu: float | None
    f107a_sfu: float | None
    ap: float | Sequence[float] | None
    local_solar_time_h: float | None = None
    ancillary_source: str | None = None
    ancillary_version: str | None = None
    ancillary_available_at_utc: datetime | str | None = None


@dataclass(frozen=True)
class BaselineResult:
    rho_baseline_kg_m3: float | None
    baseline_model_name: str
    baseline_model_version: str | None
    baseline_input_status: BaselineStatus
    input_metadata: dict[str, Any]
    research_only: bool
    license_warning: str | None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AtmosphereBaseline(ABC):
    """Replaceable atmosphere baseline contract."""

    model_name: str
    model_version: str | None
    research_only: bool = False
    license_warning: str | None = None

    @abstractmethod
    def predict_density(self, inputs: AtmosphereInput) -> BaselineResult:
        """Predict density at one point or return a non-numeric status."""

    def predict_many(self, inputs: Iterable[AtmosphereInput]) -> list[BaselineResult]:
        return [self.predict_density(item) for item in inputs]


class PymsisBaseline(AtmosphereBaseline):
    """Optional NRLMSIS 2.1 adapter using explicit ancillary inputs only.

    The adapter does not import pymsis until it is used, so the rest of the LEO
    archive and drag code remains usable without this optional research
    dependency.  ``allow_research_use`` is an explicit acknowledgement rather
    than a licensing conclusion.
    """

    model_name = "NRLMSIS 2.1 via pymsis"
    research_only = True
    license_warning = PYMSIS_LICENSE_WARNING

    def __init__(
        self,
        *,
        allow_research_use: bool = False,
        pymsis_module: Any | None = None,
        msis_version: float = 2.1,
    ) -> None:
        self.allow_research_use = allow_research_use
        self._module = pymsis_module
        self.msis_version = float(msis_version)
        module_version = getattr(pymsis_module, "__version__", None)
        self.model_version = (
            f"NRLMSIS-{self.msis_version:g}; pymsis-{module_version}"
            if module_version
            else f"NRLMSIS-{self.msis_version:g}; pymsis-unavailable"
        )

    def _load_module(self) -> Any | None:
        if self._module is not None:
            return self._module
        try:
            self._module = importlib.import_module("pymsis")
        except ImportError:
            return None
        module_version = getattr(self._module, "__version__", "unknown")
        self.model_version = f"NRLMSIS-{self.msis_version:g}; pymsis-{module_version}"
        return self._module

    @staticmethod
    def _input_metadata(inputs: AtmosphereInput, ap_values: tuple[float, ...] | None) -> dict[str, Any]:
        timestamp: str | None
        try:
            timestamp = _utc_datetime(inputs.timestamp_utc).isoformat().replace("+00:00", "Z")
        except (TypeError, ValueError):
            timestamp = None
        available_at: str | None = None
        if inputs.ancillary_available_at_utc is not None:
            try:
                available_at = _utc_datetime(inputs.ancillary_available_at_utc).isoformat().replace("+00:00", "Z")
            except (TypeError, ValueError):
                available_at = None
        return {
            "timestamp_utc": timestamp,
            "latitude_deg": _finite_number(inputs.latitude_deg),
            "longitude_deg": _finite_number(inputs.longitude_deg),
            "altitude_km": _finite_number(inputs.altitude_km),
            "local_solar_time_h": _finite_number(inputs.local_solar_time_h),
            "f107_sfu": _finite_number(inputs.f107_sfu),
            "f107a_sfu": _finite_number(inputs.f107a_sfu),
            "ap_values": list(ap_values) if ap_values is not None else None,
            "ap_input_kind": "scalar_expanded" if _finite_number(inputs.ap) is not None else "seven_value_history",
            "ancillary_source": inputs.ancillary_source,
            "ancillary_version": inputs.ancillary_version,
            "ancillary_available_at_utc": available_at,
            "ancillary_inputs_explicit": True,
            "geomagnetic_activity_mode": "storm_time_seven_ap",
        }

    def _status_result(
        self,
        status: BaselineStatus,
        inputs: AtmosphereInput,
        ap_values: tuple[float, ...] | None,
        error: str,
    ) -> BaselineResult:
        return BaselineResult(
            rho_baseline_kg_m3=None,
            baseline_model_name=self.model_name,
            baseline_model_version=self.model_version,
            baseline_input_status=status,
            input_metadata=self._input_metadata(inputs, ap_values),
            research_only=self.research_only,
            license_warning=self.license_warning,
            error=error,
        )

    def _validate(self, inputs: AtmosphereInput) -> tuple[datetime | None, tuple[float, ...] | None, BaselineResult | None]:
        ap_values = _normalise_ap(inputs.ap)
        try:
            timestamp = _utc_datetime(inputs.timestamp_utc)
        except (TypeError, ValueError) as exc:
            return None, ap_values, self._status_result("invalid_input", inputs, ap_values, str(exc))

        required = {
            "latitude_deg": _finite_number(inputs.latitude_deg),
            "longitude_deg": _finite_number(inputs.longitude_deg),
            "altitude_km": _finite_number(inputs.altitude_km),
            "f107_sfu": _finite_number(inputs.f107_sfu),
            "f107a_sfu": _finite_number(inputs.f107a_sfu),
        }
        missing = [name for name, value in required.items() if value is None]
        if ap_values is None:
            missing.append("ap (scalar or seven finite values)")
        if missing:
            return timestamp, ap_values, self._status_result(
                "missing_inputs", inputs, ap_values, f"missing required input(s): {', '.join(missing)}"
            )

        latitude = float(required["latitude_deg"])
        longitude = float(required["longitude_deg"])
        altitude = float(required["altitude_km"])
        f107 = float(required["f107_sfu"])
        f107a = float(required["f107a_sfu"])
        if not -90 <= latitude <= 90:
            return timestamp, ap_values, self._status_result("invalid_input", inputs, ap_values, "latitude_deg must be in [-90, 90]")
        if not -180 <= longitude <= 360:
            return timestamp, ap_values, self._status_result("invalid_input", inputs, ap_values, "longitude_deg must be in [-180, 360]")
        if not 0 <= altitude <= 1_000:
            return timestamp, ap_values, self._status_result("invalid_input", inputs, ap_values, "altitude_km must be in [0, 1000]")
        if f107 <= 0 or f107a <= 0:
            return timestamp, ap_values, self._status_result("invalid_input", inputs, ap_values, "F10.7 inputs must be positive")
        if inputs.ancillary_available_at_utc is not None:
            try:
                available_at = _utc_datetime(inputs.ancillary_available_at_utc)
            except (TypeError, ValueError) as exc:
                return timestamp, ap_values, self._status_result("invalid_input", inputs, ap_values, str(exc))
            if available_at > timestamp:
                return timestamp, ap_values, self._status_result(
                    "invalid_input",
                    inputs,
                    ap_values,
                    "ancillary inputs were not available at the requested timestamp",
                )
        return timestamp, ap_values, None

    def predict_density(self, inputs: AtmosphereInput) -> BaselineResult:
        timestamp, ap_values, invalid = self._validate(inputs)
        if invalid is not None:
            return invalid
        assert timestamp is not None and ap_values is not None

        if not self.allow_research_use:
            return self._status_result(
                "license_not_acknowledged",
                inputs,
                ap_values,
                "internal research-use acknowledgement is required",
            )
        module = self._load_module()
        if module is None:
            return self._status_result(
                "dependency_unavailable",
                inputs,
                ap_values,
                "optional dependency 'pymsis' is not installed",
            )

        try:
            output = module.calculate(
                np.asarray([np.datetime64(timestamp.replace(tzinfo=None), "us")]),
                np.asarray([float(inputs.longitude_deg)]),
                np.asarray([float(inputs.latitude_deg)]),
                np.asarray([float(inputs.altitude_km)]),
                f107s=np.asarray([float(inputs.f107_sfu)]),
                f107as=np.asarray([float(inputs.f107a_sfu)]),
                aps=np.asarray([ap_values], dtype=float),
                version=self.msis_version,
                geomagnetic_activity=-1,
            )
            density_index = int(module.Variable.MASS_DENSITY)
            flattened = np.asarray(output, dtype=float).reshape(-1, np.asarray(output).shape[-1])
            density = float(flattened[0, density_index])
            if not math.isfinite(density) or density <= 0:
                raise ValueError(f"model returned non-positive/non-finite mass density: {density!r}")
        except Exception as exc:  # noqa: BLE001 - returned as an explicit model status
            return self._status_result("model_error", inputs, ap_values, f"{type(exc).__name__}: {exc}")

        return BaselineResult(
            rho_baseline_kg_m3=density,
            baseline_model_name=self.model_name,
            baseline_model_version=self.model_version,
            baseline_input_status="ok",
            input_metadata=self._input_metadata(inputs, ap_values),
            research_only=self.research_only,
            license_warning=self.license_warning,
            error=None,
        )

    def predict_many(self, inputs: Iterable[AtmosphereInput]) -> list[BaselineResult]:
        """Evaluate valid points in one fly-through call.

        The scalar contract remains the source of truth for validation and
        statuses.  Batching avoids one native-library invocation per minute
        when a retrospective mission archive is processed.  If the native
        batch call fails, each point is retried through ``predict_density`` so
        one malformed model result cannot erase the status of every row.
        """

        points = list(inputs)
        if not points:
            return []

        results: list[BaselineResult | None] = [None] * len(points)
        valid: list[tuple[int, AtmosphereInput, datetime, tuple[float, ...]]] = []
        for index, item in enumerate(points):
            timestamp, ap_values, invalid = self._validate(item)
            if invalid is not None:
                results[index] = invalid
            else:
                assert timestamp is not None and ap_values is not None
                valid.append((index, item, timestamp, ap_values))

        if not valid:
            return [result for result in results if result is not None]
        if not self.allow_research_use:
            for index, item, _, ap_values in valid:
                results[index] = self._status_result(
                    "license_not_acknowledged",
                    item,
                    ap_values,
                    "internal research-use acknowledgement is required",
                )
            return [result for result in results if result is not None]

        module = self._load_module()
        if module is None:
            for index, item, _, ap_values in valid:
                results[index] = self._status_result(
                    "dependency_unavailable",
                    item,
                    ap_values,
                    "optional dependency 'pymsis' is not installed",
                )
            return [result for result in results if result is not None]

        try:
            output = module.calculate(
                np.asarray([
                    np.datetime64(timestamp.replace(tzinfo=None), "us")
                    for _, _, timestamp, _ in valid
                ]),
                np.asarray([float(item.longitude_deg) for _, item, _, _ in valid]),
                np.asarray([float(item.latitude_deg) for _, item, _, _ in valid]),
                np.asarray([float(item.altitude_km) for _, item, _, _ in valid]),
                f107s=np.asarray([float(item.f107_sfu) for _, item, _, _ in valid]),
                f107as=np.asarray([float(item.f107a_sfu) for _, item, _, _ in valid]),
                aps=np.asarray([ap_values for _, _, _, ap_values in valid], dtype=float),
                version=self.msis_version,
                geomagnetic_activity=-1,
            )
            density_index = int(module.Variable.MASS_DENSITY)
            flattened = np.asarray(output, dtype=float).reshape(-1, np.asarray(output).shape[-1])
            if len(flattened) != len(valid):
                raise ValueError(
                    f"model returned {len(flattened)} fly-through rows for {len(valid)} inputs"
                )
            for row, (index, item, _, ap_values) in zip(flattened, valid, strict=True):
                density = float(row[density_index])
                if not math.isfinite(density) or density <= 0:
                    results[index] = self._status_result(
                        "model_error",
                        item,
                        ap_values,
                        f"model returned non-positive/non-finite mass density: {density!r}",
                    )
                    continue
                results[index] = BaselineResult(
                    rho_baseline_kg_m3=density,
                    baseline_model_name=self.model_name,
                    baseline_model_version=self.model_version,
                    baseline_input_status="ok",
                    input_metadata=self._input_metadata(item, ap_values),
                    research_only=self.research_only,
                    license_warning=self.license_warning,
                    error=None,
                )
        except Exception:  # noqa: BLE001 - scalar retry preserves row-level errors
            for index, item, _, _ in valid:
                results[index] = self.predict_density(item)

        assert all(result is not None for result in results)
        return [result for result in results if result is not None]
