"""Transparent first-order drag and orbital-impact calculations for LEO.

This module implements the Level 1 scientific MVP described in the HelioSat
LEO research plan.  It deliberately does *not* propagate a drag-perturbed
orbit.  Instead, it evaluates drag along supplied inertial trajectory points
and causally integrates the resulting acceleration.

Ballistic-coefficient convention
--------------------------------
HelioSat uses the area-to-mass convention everywhere in this module::

    B = C_D A / m       [m^2 kg^-1]

Some orbit-dynamics literature calls the reciprocal ``m / (C_D A)`` the
ballistic coefficient.  That reciprocal convention is never used here.

Coordinate and atmosphere assumptions
--------------------------------------
Position and velocity vectors must share an Earth-centred inertial frame whose
z-axis is aligned with Earth's rotation axis (the existing TEME trajectory is
adequate for this first-order calculation).  The atmosphere is assumed to
co-rotate rigidly with Earth.  Neutral winds are ignored.  These assumptions
are returned in result metadata so callers can surface them in the Internal
Console.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Iterable, Literal, Mapping, Sequence

import numpy as np

BALLISTIC_COEFFICIENT_CONVENTION = "B = C_D * A / m [m^2/kg]"
EARTH_ROTATION_RATE_RAD_S = 7.2921150e-5
EARTH_GRAVITATIONAL_PARAMETER_M3_S2 = 3.986004418e14

DRAG_MODEL_ASSUMPTIONS = (
    "Trajectory position and velocity are supplied in one Earth-centred inertial frame.",
    "The neutral atmosphere rigidly co-rotates with Earth at 7.2921150e-5 rad/s.",
    "Detailed neutral winds are not included.",
    "Spacecraft parameters remain constant over the integration window.",
)

ORBITAL_IMPACT_ASSUMPTIONS = (
    "Acceleration is evaluated on the supplied, unperturbed trajectory.",
    "Cumulative delta-v uses causal trapezoidal integration with no future samples.",
    "Along-track displacement is a signed first-order lag proxy, not precise orbit determination.",
)

ScenarioId = Literal["low-drag", "nominal", "high-drag"]


def _finite_float(value: object, name: str) -> float:
    if isinstance(value, (bool, np.bool_)):
        raise ValueError(f"{name} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def _positive_float(value: object, name: str) -> float:
    result = _finite_float(value, name)
    if result <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return result


def _non_negative_float(value: object, name: str) -> float:
    result = _finite_float(value, name)
    if result < 0:
        raise ValueError(f"{name} must be greater than or equal to zero")
    return result


def _validated_array(
    values: object,
    name: str,
    *,
    ndim: int | None = None,
    last_dimension: int | None = None,
    non_negative: bool = False,
) -> np.ndarray:
    try:
        result = np.asarray(values, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must contain numeric values") from exc
    if ndim is not None and result.ndim != ndim:
        raise ValueError(f"{name} must have {ndim} dimensions")
    if last_dimension is not None and (result.ndim == 0 or result.shape[-1] != last_dimension):
        raise ValueError(f"{name} must have a final dimension of {last_dimension}")
    if not np.all(np.isfinite(result)):
        raise ValueError(f"{name} must contain only finite values")
    if non_negative and np.any(result < 0):
        raise ValueError(f"{name} must contain only non-negative values")
    return result


def _return_scalar_when_scalar(result: np.ndarray, *inputs: object) -> float | np.ndarray:
    if all(np.asarray(item).ndim == 0 for item in inputs):
        return float(np.asarray(result))
    return result


@dataclass(frozen=True)
class ParameterUncertainty:
    """Traceable uncertainty metadata for one spacecraft parameter.

    Bounds and standard uncertainty are optional because many scenario or
    operator inputs do not have a defensible statistical uncertainty.  In that
    case callers should set ``status="not_quantified"`` and explain why in
    ``notes`` rather than inventing a confidence interval.
    """

    parameter: str
    units: str
    status: Literal["quantified", "not_quantified"]
    lower_bound: float | None = None
    upper_bound: float | None = None
    standard_uncertainty: float | None = None
    confidence_level: float | None = None
    method: str | None = None
    source: str | None = None
    notes: str | None = None

    def __post_init__(self) -> None:
        if not self.parameter.strip():
            raise ValueError("uncertainty parameter must not be empty")
        if not self.units.strip():
            raise ValueError("uncertainty units must not be empty")

        numeric_fields = ("lower_bound", "upper_bound", "standard_uncertainty")
        for name in numeric_fields:
            value = getattr(self, name)
            if value is not None:
                numeric = _finite_float(value, name)
                object.__setattr__(self, name, numeric)

        if self.standard_uncertainty is not None and self.standard_uncertainty < 0:
            raise ValueError("standard_uncertainty must be non-negative")
        if (
            self.lower_bound is not None
            and self.upper_bound is not None
            and self.lower_bound > self.upper_bound
        ):
            raise ValueError("uncertainty lower_bound must not exceed upper_bound")
        if self.confidence_level is not None:
            confidence = _finite_float(self.confidence_level, "confidence_level")
            if not 0 < confidence <= 1:
                raise ValueError("confidence_level must be in (0, 1]")
            object.__setattr__(self, "confidence_level", confidence)
        if self.status == "quantified" and all(
            item is None
            for item in (self.lower_bound, self.upper_bound, self.standard_uncertainty)
        ):
            raise ValueError("quantified uncertainty requires a bound or standard uncertainty")

    def to_metadata(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SpacecraftParameters:
    """Physical inputs used by the drag calculation.

    A direct ``ballistic_coefficient_m2_kg`` takes precedence when supplied.
    If it is absent, mass, reference area and drag coefficient are all required
    and ``B`` is derived using the module convention.  Supplying a direct value
    never causes it to be inferred from a TLE.
    """

    mass_kg: float | None = None
    reference_area_m2: float | None = None
    drag_coefficient: float | None = None
    ballistic_coefficient_m2_kg: float | None = None
    attitude_or_area_mode: str = "unspecified"
    parameter_source: str = "unspecified"
    uncertainties: tuple[ParameterUncertainty, ...] = field(default_factory=tuple)
    evidence_class: Literal["operator_supplied", "scenario", "research_assumption", "unspecified"] = (
        "unspecified"
    )
    is_real_satellite_property: bool = False

    def __post_init__(self) -> None:
        for name in ("mass_kg", "reference_area_m2", "drag_coefficient"):
            value = getattr(self, name)
            if value is not None:
                object.__setattr__(self, name, _positive_float(value, name))
        if self.ballistic_coefficient_m2_kg is not None:
            object.__setattr__(
                self,
                "ballistic_coefficient_m2_kg",
                _positive_float(
                    self.ballistic_coefficient_m2_kg,
                    "ballistic_coefficient_m2_kg",
                ),
            )
        elif any(
            value is None
            for value in (self.mass_kg, self.reference_area_m2, self.drag_coefficient)
        ):
            raise ValueError(
                "provide a direct ballistic coefficient or all of mass_kg, "
                "reference_area_m2 and drag_coefficient"
            )

        if not self.attitude_or_area_mode.strip():
            raise ValueError("attitude_or_area_mode must not be empty")
        if not self.parameter_source.strip():
            raise ValueError("parameter_source must not be empty")
        object.__setattr__(self, "uncertainties", tuple(self.uncertainties))
        if not all(isinstance(item, ParameterUncertainty) for item in self.uncertainties):
            raise ValueError("uncertainties must contain ParameterUncertainty values")
        if self.evidence_class == "scenario" and self.is_real_satellite_property:
            raise ValueError("a sensitivity scenario cannot be marked as a real satellite property")

    @property
    def resolved_ballistic_coefficient_m2_kg(self) -> float:
        if self.ballistic_coefficient_m2_kg is not None:
            return self.ballistic_coefficient_m2_kg
        # __post_init__ guarantees that all three values are present here.
        return calculate_ballistic_coefficient(
            drag_coefficient=float(self.drag_coefficient),
            reference_area_m2=float(self.reference_area_m2),
            mass_kg=float(self.mass_kg),
        )

    @property
    def ballistic_coefficient_source(self) -> Literal["direct", "derived"]:
        return "direct" if self.ballistic_coefficient_m2_kg is not None else "derived"

    def to_metadata(self) -> dict[str, Any]:
        derived_value: float | None = None
        if all(
            item is not None
            for item in (self.mass_kg, self.reference_area_m2, self.drag_coefficient)
        ):
            derived_value = calculate_ballistic_coefficient(
                drag_coefficient=float(self.drag_coefficient),
                reference_area_m2=float(self.reference_area_m2),
                mass_kg=float(self.mass_kg),
            )
        direct_derived_relative_difference: float | None = None
        if self.ballistic_coefficient_m2_kg is not None and derived_value is not None:
            direct_derived_relative_difference = (
                self.ballistic_coefficient_m2_kg - derived_value
            ) / derived_value
        return {
            "ballistic_coefficient_convention": BALLISTIC_COEFFICIENT_CONVENTION,
            "resolved_ballistic_coefficient_m2_kg": self.resolved_ballistic_coefficient_m2_kg,
            "ballistic_coefficient_source": self.ballistic_coefficient_source,
            "mass_kg": self.mass_kg,
            "reference_area_m2": self.reference_area_m2,
            "drag_coefficient": self.drag_coefficient,
            "direct_ballistic_coefficient_m2_kg": self.ballistic_coefficient_m2_kg,
            "derived_ballistic_coefficient_m2_kg": derived_value,
            "direct_derived_relative_difference": direct_derived_relative_difference,
            "attitude_or_area_mode": self.attitude_or_area_mode,
            "parameter_source": self.parameter_source,
            "evidence_class": self.evidence_class,
            "is_real_satellite_property": self.is_real_satellite_property,
            "uncertainties": [item.to_metadata() for item in self.uncertainties],
        }


@dataclass(frozen=True)
class SpacecraftScenario:
    id: ScenarioId
    label: str
    parameters: SpacecraftParameters
    evidence_class: Literal["scenario"] = "scenario"
    is_real_satellite_property: Literal[False] = False
    warning: str = (
        "Generic sensitivity scenario; it is not a measured or inferred property "
        "of the selected satellite."
    )

    def __post_init__(self) -> None:
        if self.parameters.evidence_class != "scenario":
            raise ValueError("scenario parameters must use evidence_class='scenario'")
        if self.parameters.is_real_satellite_property:
            raise ValueError("scenario parameters cannot represent a real satellite property")

    def to_metadata(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "evidence_class": self.evidence_class,
            "is_real_satellite_property": self.is_real_satellite_property,
            "warning": self.warning,
            "parameters": self.parameters.to_metadata(),
        }


def _scenario_parameters(value_m2_kg: float) -> SpacecraftParameters:
    return SpacecraftParameters(
        ballistic_coefficient_m2_kg=value_m2_kg,
        attitude_or_area_mode="generic sensitivity scenario",
        parameter_source=(
            "HelioSat internal generic sensitivity assumption; not satellite telemetry, "
            "operator metadata or a TLE-derived property"
        ),
        uncertainties=(
            ParameterUncertainty(
                parameter="ballistic_coefficient",
                units="m^2/kg",
                status="not_quantified",
                method="discrete sensitivity scenario",
                source="HelioSat internal research assumption",
                notes="No statistical confidence interval is asserted for this generic scenario.",
            ),
        ),
        evidence_class="scenario",
        is_real_satellite_property=False,
    )


# These values are intentionally broad sensitivity assumptions, not catalogued
# spacecraft parameters.  The immutable mapping and metadata prevent the UI
# from silently relabelling them as properties of the selected NORAD object.
SPACECRAFT_SCENARIOS: Mapping[ScenarioId, SpacecraftScenario] = MappingProxyType(
    {
        "low-drag": SpacecraftScenario(
            id="low-drag",
            label="Low ballistic coefficient",
            parameters=_scenario_parameters(0.002),
        ),
        "nominal": SpacecraftScenario(
            id="nominal",
            label="Nominal ballistic coefficient",
            parameters=_scenario_parameters(0.01),
        ),
        "high-drag": SpacecraftScenario(
            id="high-drag",
            label="High ballistic coefficient",
            parameters=_scenario_parameters(0.03),
        ),
    }
)


def get_spacecraft_scenario(scenario_id: ScenarioId) -> SpacecraftScenario:
    """Return a generic, explicitly non-observational sensitivity scenario."""

    try:
        return SPACECRAFT_SCENARIOS[scenario_id]
    except KeyError as exc:
        choices = ", ".join(SPACECRAFT_SCENARIOS)
        raise ValueError(f"unknown spacecraft scenario {scenario_id!r}; choose {choices}") from exc


def calculate_ballistic_coefficient(
    *,
    drag_coefficient: float,
    reference_area_m2: float,
    mass_kg: float,
) -> float:
    """Return ``C_D * A / m`` in square metres per kilogram."""

    cd = _positive_float(drag_coefficient, "drag_coefficient")
    area = _positive_float(reference_area_m2, "reference_area_m2")
    mass = _positive_float(mass_kg, "mass_kg")
    return cd * area / mass


def atmospheric_corotation_velocity_m_s(
    position_m: Sequence[float] | np.ndarray,
    *,
    earth_rotation_rate_rad_s: float = EARTH_ROTATION_RATE_RAD_S,
) -> np.ndarray:
    """Return rigid-atmosphere inertial velocity ``omega x r`` in m/s.

    ``position_m`` may be one ``(3,)`` vector or an array shaped ``(..., 3)``.
    The inertial z-axis is assumed to coincide with Earth's spin axis.
    """

    position = _validated_array(position_m, "position_m", last_dimension=3)
    omega = _finite_float(earth_rotation_rate_rad_s, "earth_rotation_rate_rad_s")
    omega_vector = np.array([0.0, 0.0, omega], dtype=float)
    return np.cross(omega_vector, position)


def air_relative_velocity_m_s(
    position_m: Sequence[float] | np.ndarray,
    satellite_velocity_m_s: Sequence[float] | np.ndarray,
    *,
    earth_rotation_rate_rad_s: float = EARTH_ROTATION_RATE_RAD_S,
) -> np.ndarray:
    """Return satellite velocity relative to a rigidly co-rotating atmosphere."""

    position = _validated_array(position_m, "position_m", last_dimension=3)
    velocity = _validated_array(
        satellite_velocity_m_s,
        "satellite_velocity_m_s",
        last_dimension=3,
    )
    if position.shape != velocity.shape:
        raise ValueError("position_m and satellite_velocity_m_s must have identical shapes")
    return velocity - atmospheric_corotation_velocity_m_s(
        position,
        earth_rotation_rate_rad_s=earth_rotation_rate_rad_s,
    )


def drag_acceleration_magnitude_m_s2(
    density_kg_m3: float | Sequence[float] | np.ndarray,
    ballistic_coefficient_m2_kg: float,
    relative_speed_m_s: float | Sequence[float] | np.ndarray,
) -> float | np.ndarray:
    """Return ``0.5 * rho * B * |v_rel|^2`` in m/s^2."""

    density = _validated_array(
        density_kg_m3,
        "density_kg_m3",
        non_negative=True,
    )
    speed = _validated_array(
        relative_speed_m_s,
        "relative_speed_m_s",
        non_negative=True,
    )
    coefficient = _positive_float(
        ballistic_coefficient_m2_kg,
        "ballistic_coefficient_m2_kg",
    )
    try:
        result = 0.5 * density * coefficient * np.square(speed)
    except ValueError as exc:
        raise ValueError("density_kg_m3 and relative_speed_m_s are not broadcast-compatible") from exc
    return _return_scalar_when_scalar(result, density_kg_m3, relative_speed_m_s)


def drag_acceleration_vector_m_s2(
    density_kg_m3: float | Sequence[float] | np.ndarray,
    ballistic_coefficient_m2_kg: float,
    relative_velocity_m_s: Sequence[float] | np.ndarray,
) -> np.ndarray:
    """Return the drag vector, opposite the air-relative velocity.

    The vector form is ``-0.5 * rho * B * |v_rel| * v_rel``.  A zero relative
    velocity produces a zero vector without an undefined normalization.
    """

    velocity = _validated_array(
        relative_velocity_m_s,
        "relative_velocity_m_s",
        last_dimension=3,
    )
    density = _validated_array(
        density_kg_m3,
        "density_kg_m3",
        non_negative=True,
    )
    coefficient = _positive_float(
        ballistic_coefficient_m2_kg,
        "ballistic_coefficient_m2_kg",
    )
    leading_shape = velocity.shape[:-1]
    try:
        broadcast_density = np.broadcast_to(density, leading_shape)
    except ValueError as exc:
        raise ValueError(
            "density_kg_m3 must be scalar or match the relative-velocity leading dimensions"
        ) from exc
    speed = np.linalg.norm(velocity, axis=-1)
    return -0.5 * coefficient * broadcast_density[..., np.newaxis] * speed[..., np.newaxis] * velocity


def _parse_utc_timestamp(value: datetime | str | np.datetime64) -> datetime:
    if isinstance(value, np.datetime64):
        if np.isnat(value):
            raise ValueError("timestamps_utc must not contain NaT")
        epoch_ns = value.astype("datetime64[ns]").astype(np.int64)
        return datetime.fromtimestamp(float(epoch_ns) / 1e9, tz=timezone.utc)
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        text = value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError as exc:
            raise ValueError(f"invalid timestamp {value!r}") from exc
    else:
        raise ValueError("timestamps_utc must contain datetimes or ISO-8601 strings")
    if parsed.tzinfo is None:
        raise ValueError("timestamps_utc must be timezone-aware")
    return parsed.astimezone(timezone.utc)


def _validated_timestamps(
    timestamps_utc: Iterable[datetime | str | np.datetime64],
) -> tuple[tuple[datetime, ...], np.ndarray]:
    timestamps = tuple(_parse_utc_timestamp(item) for item in timestamps_utc)
    if not timestamps:
        raise ValueError("timestamps_utc must contain at least one timestamp")
    elapsed = np.array(
        [(item - timestamps[0]).total_seconds() for item in timestamps],
        dtype=float,
    )
    if len(elapsed) > 1 and np.any(np.diff(elapsed) <= 0):
        raise ValueError("timestamps_utc must be strictly increasing")
    return timestamps, elapsed


def _cumulative_trapezoid(values: np.ndarray, elapsed_s: np.ndarray) -> np.ndarray:
    result = np.zeros(len(values), dtype=float)
    if len(values) > 1:
        increments = 0.5 * (values[:-1] + values[1:]) * np.diff(elapsed_s)
        result[1:] = np.cumsum(increments)
    return result


@dataclass(frozen=True)
class OrbitalImpactSeries:
    timestamps_utc: tuple[datetime, ...]
    instantaneous_drag_acceleration_m_s2: np.ndarray
    signed_along_track_acceleration_m_s2: np.ndarray
    cumulative_delta_v_loss_m_s: np.ndarray
    cumulative_impulse_per_unit_mass_n_s_kg: np.ndarray
    cumulative_signed_along_track_delta_v_m_s: np.ndarray
    along_track_displacement_m: np.ndarray
    integration_method: str = "causal trapezoidal integration"
    along_track_sign_convention: str = (
        "negative means lag behind the supplied unperturbed trajectory"
    )
    assumptions: tuple[str, ...] = ORBITAL_IMPACT_ASSUMPTIONS

    def to_metadata(self) -> dict[str, Any]:
        return {
            "integration_method": self.integration_method,
            "along_track_sign_convention": self.along_track_sign_convention,
            "assumptions": list(self.assumptions),
            "cumulative_impulse_per_unit_mass_units": "N*s/kg (numerically equal to m/s)",
        }


def integrate_orbital_impact(
    timestamps_utc: Iterable[datetime | str | np.datetime64],
    drag_acceleration_m_s2: Sequence[float] | np.ndarray,
    *,
    signed_along_track_acceleration_m_s2: Sequence[float] | np.ndarray | None = None,
) -> OrbitalImpactSeries:
    """Causally integrate drag acceleration on already-supplied trajectory points.

    ``drag_acceleration_m_s2`` is the non-negative acceleration magnitude used
    for cumulative delta-v loss.  When no signed along-track projection is
    supplied, drag is assumed exactly anti-track and its signed acceleration is
    the negative magnitude.  No extrapolation or gap filling is performed.
    """

    timestamps, elapsed = _validated_timestamps(timestamps_utc)
    magnitude = _validated_array(
        drag_acceleration_m_s2,
        "drag_acceleration_m_s2",
        ndim=1,
        non_negative=True,
    )
    if len(magnitude) != len(timestamps):
        raise ValueError("drag_acceleration_m_s2 length must match timestamps_utc")
    if signed_along_track_acceleration_m_s2 is None:
        signed_along = -magnitude
    else:
        signed_along = _validated_array(
            signed_along_track_acceleration_m_s2,
            "signed_along_track_acceleration_m_s2",
            ndim=1,
        )
        if len(signed_along) != len(timestamps):
            raise ValueError(
                "signed_along_track_acceleration_m_s2 length must match timestamps_utc"
            )

    delta_v_loss = _cumulative_trapezoid(magnitude, elapsed)
    signed_delta_v = _cumulative_trapezoid(signed_along, elapsed)
    along_track_displacement = _cumulative_trapezoid(signed_delta_v, elapsed)
    return OrbitalImpactSeries(
        timestamps_utc=timestamps,
        instantaneous_drag_acceleration_m_s2=magnitude.copy(),
        signed_along_track_acceleration_m_s2=signed_along.copy(),
        cumulative_delta_v_loss_m_s=delta_v_loss,
        cumulative_impulse_per_unit_mass_n_s_kg=delta_v_loss.copy(),
        cumulative_signed_along_track_delta_v_m_s=signed_delta_v,
        along_track_displacement_m=along_track_displacement,
    )


SemimajorAxisStatus = Literal["ok", "not_defensible"]


@dataclass(frozen=True)
class SemimajorAxisEstimate:
    status: SemimajorAxisStatus
    change_m: np.ndarray | None
    initial_semimajor_axis_m: float | None
    initial_eccentricity: float | None
    method: str
    reason: str | None
    assumptions: tuple[str, ...]

    def to_metadata(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "initial_semimajor_axis_m": self.initial_semimajor_axis_m,
            "initial_eccentricity": self.initial_eccentricity,
            "method": self.method,
            "reason": self.reason,
            "assumptions": list(self.assumptions),
        }


def estimate_semimajor_axis_change(
    timestamps_utc: Iterable[datetime | str | np.datetime64],
    position_m: Sequence[Sequence[float]] | np.ndarray,
    satellite_velocity_m_s: Sequence[Sequence[float]] | np.ndarray,
    drag_acceleration_vector: Sequence[Sequence[float]] | np.ndarray,
    *,
    gravitational_parameter_m3_s2: float = EARTH_GRAVITATIONAL_PARAMETER_M3_S2,
    maximum_initial_eccentricity: float = 0.1,
    maximum_relative_energy_change: float = 0.01,
) -> SemimajorAxisEstimate:
    """Optionally estimate first-order semi-major-axis change from energy loss.

    The estimate is returned only for an initially bound, near-circular state
    and a perturbatively small energy change.  Specific drag power
    ``v_inertial dot a_drag`` is causally integrated, then mapped through
    ``a = -mu/(2 epsilon)`` linearized about the initial osculating state.
    """

    timestamps, elapsed = _validated_timestamps(timestamps_utc)
    position = _validated_array(position_m, "position_m", ndim=2, last_dimension=3)
    velocity = _validated_array(
        satellite_velocity_m_s,
        "satellite_velocity_m_s",
        ndim=2,
        last_dimension=3,
    )
    acceleration = _validated_array(
        drag_acceleration_vector,
        "drag_acceleration_vector",
        ndim=2,
        last_dimension=3,
    )
    if not (len(position) == len(velocity) == len(acceleration) == len(timestamps)):
        raise ValueError("trajectory, acceleration and timestamp lengths must match")
    mu = _positive_float(gravitational_parameter_m3_s2, "gravitational_parameter_m3_s2")
    max_e = _non_negative_float(maximum_initial_eccentricity, "maximum_initial_eccentricity")
    max_energy = _positive_float(
        maximum_relative_energy_change,
        "maximum_relative_energy_change",
    )

    r0 = position[0]
    v0 = velocity[0]
    radius = float(np.linalg.norm(r0))
    if radius <= 0:
        raise ValueError("initial position norm must be greater than zero")
    specific_energy = 0.5 * float(np.dot(v0, v0)) - mu / radius
    method = "first-order specific-orbital-energy perturbation"
    assumptions = (
        "Initial osculating orbit is bound and near circular.",
        "Drag is evaluated along the supplied unperturbed trajectory.",
        "The energy perturbation remains small enough for first-order linearization.",
        "This is not a drag-aware orbit propagation or precise orbit determination product.",
    )
    if specific_energy >= 0:
        return SemimajorAxisEstimate(
            status="not_defensible",
            change_m=None,
            initial_semimajor_axis_m=None,
            initial_eccentricity=None,
            method=method,
            reason="initial state is not a bound orbit",
            assumptions=assumptions,
        )

    semimajor_axis = -mu / (2.0 * specific_energy)
    angular_momentum = np.cross(r0, v0)
    eccentricity_vector = np.cross(v0, angular_momentum) / mu - r0 / radius
    eccentricity = float(np.linalg.norm(eccentricity_vector))
    if eccentricity > max_e:
        return SemimajorAxisEstimate(
            status="not_defensible",
            change_m=None,
            initial_semimajor_axis_m=semimajor_axis,
            initial_eccentricity=eccentricity,
            method=method,
            reason=(
                f"initial eccentricity {eccentricity:.6g} exceeds the configured "
                f"near-circular limit {max_e:.6g}"
            ),
            assumptions=assumptions,
        )

    specific_power = np.einsum("ij,ij->i", velocity, acceleration)
    energy_change = _cumulative_trapezoid(specific_power, elapsed)
    relative_change = np.max(np.abs(energy_change)) / abs(specific_energy)
    if relative_change > max_energy:
        return SemimajorAxisEstimate(
            status="not_defensible",
            change_m=None,
            initial_semimajor_axis_m=semimajor_axis,
            initial_eccentricity=eccentricity,
            method=method,
            reason=(
                f"relative specific-energy change {relative_change:.6g} exceeds "
                f"the linearization limit {max_energy:.6g}"
            ),
            assumptions=assumptions,
        )

    change = (2.0 * semimajor_axis**2 / mu) * energy_change
    return SemimajorAxisEstimate(
        status="ok",
        change_m=change,
        initial_semimajor_axis_m=semimajor_axis,
        initial_eccentricity=eccentricity,
        method=method,
        reason=None,
        assumptions=assumptions,
    )


@dataclass(frozen=True)
class DragProfile:
    density_kg_m3: np.ndarray
    atmospheric_velocity_m_s: np.ndarray
    relative_velocity_m_s: np.ndarray
    relative_speed_m_s: np.ndarray
    drag_acceleration_m_s2: np.ndarray
    drag_acceleration_vector_m_s2: np.ndarray
    impact: OrbitalImpactSeries
    semimajor_axis_estimate: SemimajorAxisEstimate | None
    spacecraft_metadata: dict[str, Any]
    assumptions: tuple[str, ...] = DRAG_MODEL_ASSUMPTIONS


def calculate_drag_profile(
    timestamps_utc: Iterable[datetime | str | np.datetime64],
    position_m: Sequence[Sequence[float]] | np.ndarray,
    satellite_velocity_m_s: Sequence[Sequence[float]] | np.ndarray,
    density_kg_m3: Sequence[float] | np.ndarray,
    spacecraft: SpacecraftParameters,
    *,
    include_semimajor_axis_estimate: bool = False,
    earth_rotation_rate_rad_s: float = EARTH_ROTATION_RATE_RAD_S,
) -> DragProfile:
    """Evaluate density-driven drag along an existing inertial trajectory."""

    if not isinstance(spacecraft, SpacecraftParameters):
        raise ValueError("spacecraft must be a SpacecraftParameters instance")
    # Materialize timestamps once because callers may pass a generator.
    timestamps = tuple(timestamps_utc)
    parsed_timestamps, _ = _validated_timestamps(timestamps)
    position = _validated_array(position_m, "position_m", ndim=2, last_dimension=3)
    velocity = _validated_array(
        satellite_velocity_m_s,
        "satellite_velocity_m_s",
        ndim=2,
        last_dimension=3,
    )
    density = _validated_array(
        density_kg_m3,
        "density_kg_m3",
        ndim=1,
        non_negative=True,
    )
    if not (len(position) == len(velocity) == len(density) == len(parsed_timestamps)):
        raise ValueError("trajectory, density and timestamp lengths must match")

    atmospheric_velocity = atmospheric_corotation_velocity_m_s(
        position,
        earth_rotation_rate_rad_s=earth_rotation_rate_rad_s,
    )
    relative_velocity = velocity - atmospheric_velocity
    relative_speed = np.linalg.norm(relative_velocity, axis=1)
    coefficient = spacecraft.resolved_ballistic_coefficient_m2_kg
    acceleration_vector = drag_acceleration_vector_m_s2(
        density,
        coefficient,
        relative_velocity,
    )
    acceleration_magnitude = np.linalg.norm(acceleration_vector, axis=1)

    satellite_speed = np.linalg.norm(velocity, axis=1)
    if np.any(satellite_speed <= 0):
        raise ValueError("satellite_velocity_m_s norms must be greater than zero")
    along_track_unit = velocity / satellite_speed[:, np.newaxis]
    signed_along_track_acceleration = np.einsum(
        "ij,ij->i",
        acceleration_vector,
        along_track_unit,
    )
    impact = integrate_orbital_impact(
        parsed_timestamps,
        acceleration_magnitude,
        signed_along_track_acceleration_m_s2=signed_along_track_acceleration,
    )
    semimajor_axis = None
    if include_semimajor_axis_estimate:
        semimajor_axis = estimate_semimajor_axis_change(
            parsed_timestamps,
            position,
            velocity,
            acceleration_vector,
        )
    return DragProfile(
        density_kg_m3=density.copy(),
        atmospheric_velocity_m_s=atmospheric_velocity,
        relative_velocity_m_s=relative_velocity,
        relative_speed_m_s=relative_speed,
        drag_acceleration_m_s2=acceleration_magnitude,
        drag_acceleration_vector_m_s2=acceleration_vector,
        impact=impact,
        semimajor_axis_estimate=semimajor_axis,
        spacecraft_metadata=spacecraft.to_metadata(),
    )


@dataclass(frozen=True)
class DragComparison:
    baseline: DragProfile
    corrected: DragProfile
    density_enhancement_ratio: np.ndarray
    additional_cumulative_delta_v_m_s: np.ndarray
    additional_along_track_displacement_m: np.ndarray
    evidence_note: str = (
        "Baseline and corrected density are evaluated on the same supplied, "
        "unperturbed trajectory and with identical spacecraft assumptions."
    )


def compare_baseline_and_corrected_drag(
    timestamps_utc: Iterable[datetime | str | np.datetime64],
    position_m: Sequence[Sequence[float]] | np.ndarray,
    satellite_velocity_m_s: Sequence[Sequence[float]] | np.ndarray,
    baseline_density_kg_m3: Sequence[float] | np.ndarray,
    corrected_density_kg_m3: Sequence[float] | np.ndarray,
    spacecraft: SpacecraftParameters,
    *,
    include_semimajor_axis_estimate: bool = False,
    earth_rotation_rate_rad_s: float = EARTH_ROTATION_RATE_RAD_S,
) -> DragComparison:
    """Compare baseline and corrected density using one trajectory and scenario."""

    timestamps = tuple(timestamps_utc)
    baseline = calculate_drag_profile(
        timestamps,
        position_m,
        satellite_velocity_m_s,
        baseline_density_kg_m3,
        spacecraft,
        include_semimajor_axis_estimate=include_semimajor_axis_estimate,
        earth_rotation_rate_rad_s=earth_rotation_rate_rad_s,
    )
    corrected = calculate_drag_profile(
        timestamps,
        position_m,
        satellite_velocity_m_s,
        corrected_density_kg_m3,
        spacecraft,
        include_semimajor_axis_estimate=include_semimajor_axis_estimate,
        earth_rotation_rate_rad_s=earth_rotation_rate_rad_s,
    )
    ratio = np.full_like(corrected.density_kg_m3, np.nan)
    np.divide(
        corrected.density_kg_m3,
        baseline.density_kg_m3,
        out=ratio,
        where=baseline.density_kg_m3 > 0,
    )
    return DragComparison(
        baseline=baseline,
        corrected=corrected,
        density_enhancement_ratio=ratio,
        additional_cumulative_delta_v_m_s=(
            corrected.impact.cumulative_delta_v_loss_m_s
            - baseline.impact.cumulative_delta_v_loss_m_s
        ),
        additional_along_track_displacement_m=(
            corrected.impact.along_track_displacement_m
            - baseline.impact.along_track_displacement_m
        ),
    )


__all__ = [
    "BALLISTIC_COEFFICIENT_CONVENTION",
    "DRAG_MODEL_ASSUMPTIONS",
    "EARTH_GRAVITATIONAL_PARAMETER_M3_S2",
    "EARTH_ROTATION_RATE_RAD_S",
    "ORBITAL_IMPACT_ASSUMPTIONS",
    "SPACECRAFT_SCENARIOS",
    "DragComparison",
    "DragProfile",
    "OrbitalImpactSeries",
    "ParameterUncertainty",
    "SemimajorAxisEstimate",
    "SpacecraftParameters",
    "SpacecraftScenario",
    "air_relative_velocity_m_s",
    "atmospheric_corotation_velocity_m_s",
    "calculate_ballistic_coefficient",
    "calculate_drag_profile",
    "compare_baseline_and_corrected_drag",
    "drag_acceleration_magnitude_m_s2",
    "drag_acceleration_vector_m_s2",
    "estimate_semimajor_axis_change",
    "get_spacecraft_scenario",
    "integrate_orbital_impact",
]
