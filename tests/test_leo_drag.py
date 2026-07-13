from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from leo_drag.drag import (
    BALLISTIC_COEFFICIENT_CONVENTION,
    EARTH_GRAVITATIONAL_PARAMETER_M3_S2,
    EARTH_ROTATION_RATE_RAD_S,
    ParameterUncertainty,
    SpacecraftParameters,
    air_relative_velocity_m_s,
    atmospheric_corotation_velocity_m_s,
    calculate_ballistic_coefficient,
    compare_baseline_and_corrected_drag,
    drag_acceleration_magnitude_m_s2,
    drag_acceleration_vector_m_s2,
    estimate_semimajor_axis_change,
    get_spacecraft_scenario,
    integrate_orbital_impact,
)


def _timestamps(count: int, step_seconds: int = 10) -> list[datetime]:
    start = datetime(2024, 5, 10, tzinfo=timezone.utc)
    return [start + timedelta(seconds=index * step_seconds) for index in range(count)]


def test_ballistic_coefficient_uses_cd_area_over_mass_convention():
    coefficient = calculate_ballistic_coefficient(
        drag_coefficient=2.2,
        reference_area_m2=4.0,
        mass_kg=400.0,
    )

    assert coefficient == pytest.approx(0.022)
    parameters = SpacecraftParameters(
        mass_kg=400.0,
        reference_area_m2=4.0,
        drag_coefficient=2.2,
        parameter_source="synthetic unit-test fixture",
    )
    assert parameters.resolved_ballistic_coefficient_m2_kg == pytest.approx(coefficient)
    assert parameters.ballistic_coefficient_source == "derived"
    assert parameters.to_metadata()["ballistic_coefficient_convention"] == (
        BALLISTIC_COEFFICIENT_CONVENTION
    )


def test_direct_ballistic_coefficient_is_explicit_override_and_keeps_provenance():
    uncertainty = ParameterUncertainty(
        parameter="ballistic_coefficient",
        units="m^2/kg",
        status="quantified",
        lower_bound=0.011,
        upper_bound=0.013,
        confidence_level=0.95,
        method="operator covariance",
        source="synthetic unit-test fixture",
    )
    parameters = SpacecraftParameters(
        mass_kg=400.0,
        reference_area_m2=4.0,
        drag_coefficient=2.2,
        ballistic_coefficient_m2_kg=0.012,
        attitude_or_area_mode="operator-defined test mode",
        parameter_source="synthetic unit-test fixture",
        uncertainties=(uncertainty,),
        evidence_class="operator_supplied",
        is_real_satellite_property=True,
    )

    metadata = parameters.to_metadata()
    assert parameters.resolved_ballistic_coefficient_m2_kg == pytest.approx(0.012)
    assert metadata["ballistic_coefficient_source"] == "direct"
    assert metadata["derived_ballistic_coefficient_m2_kg"] == pytest.approx(0.022)
    assert metadata["direct_derived_relative_difference"] != 0
    assert metadata["uncertainties"][0]["confidence_level"] == pytest.approx(0.95)


def test_generic_scenarios_are_ordered_and_never_claim_real_satellite_properties():
    low = get_spacecraft_scenario("low-drag")
    nominal = get_spacecraft_scenario("nominal")
    high = get_spacecraft_scenario("high-drag")

    values = [
        scenario.parameters.resolved_ballistic_coefficient_m2_kg
        for scenario in (low, nominal, high)
    ]
    assert values == sorted(values)
    assert len(set(values)) == 3
    for scenario in (low, nominal, high):
        metadata = scenario.to_metadata()
        assert metadata["evidence_class"] == "scenario"
        assert metadata["is_real_satellite_property"] is False
        assert metadata["parameters"]["is_real_satellite_property"] is False
        assert metadata["parameters"]["uncertainties"][0]["status"] == "not_quantified"
        assert "not" in metadata["warning"].lower()


def test_rigid_corotation_and_air_relative_velocity_at_equator():
    radius_m = 6_778_000.0
    position = np.array([radius_m, 0.0, 0.0])
    satellite_velocity = np.array([0.0, 7_700.0, 0.0])

    atmosphere_velocity = atmospheric_corotation_velocity_m_s(position)
    relative_velocity = air_relative_velocity_m_s(position, satellite_velocity)

    expected_corotation = EARTH_ROTATION_RATE_RAD_S * radius_m
    np.testing.assert_allclose(atmosphere_velocity, [0.0, expected_corotation, 0.0])
    np.testing.assert_allclose(
        relative_velocity,
        [0.0, 7_700.0 - expected_corotation, 0.0],
    )
    # A point on the spin axis has no rigid-corotation speed.
    np.testing.assert_allclose(
        atmospheric_corotation_velocity_m_s([0.0, 0.0, radius_m]),
        [0.0, 0.0, 0.0],
    )


def test_drag_scalar_units_and_vector_sign_match_documented_equations():
    density = 4.0e-12
    coefficient = 0.01
    velocity = np.array([7_500.0, 0.0, 0.0])
    expected = 0.5 * density * coefficient * 7_500.0**2

    scalar = drag_acceleration_magnitude_m_s2(density, coefficient, 7_500.0)
    vector = drag_acceleration_vector_m_s2(density, coefficient, velocity)

    assert scalar == pytest.approx(expected)
    assert np.linalg.norm(vector) == pytest.approx(expected)
    assert vector[0] < 0
    assert np.dot(vector, velocity) < 0
    np.testing.assert_allclose(
        drag_acceleration_vector_m_s2(density, coefficient, [0.0, 0.0, 0.0]),
        [0.0, 0.0, 0.0],
    )


def test_causal_integration_of_constant_drag_has_expected_sign_and_units():
    impact = integrate_orbital_impact(
        _timestamps(3, step_seconds=10),
        np.full(3, 0.1),
    )

    np.testing.assert_allclose(impact.cumulative_delta_v_loss_m_s, [0.0, 1.0, 2.0])
    np.testing.assert_allclose(
        impact.cumulative_impulse_per_unit_mass_n_s_kg,
        [0.0, 1.0, 2.0],
    )
    np.testing.assert_allclose(
        impact.cumulative_signed_along_track_delta_v_m_s,
        [0.0, -1.0, -2.0],
    )
    np.testing.assert_allclose(impact.along_track_displacement_m, [0.0, -5.0, -20.0])
    assert "negative" in impact.along_track_sign_convention


def test_integration_is_causal_when_a_future_sample_changes():
    timestamps = _timestamps(4)
    first = integrate_orbital_impact(timestamps, [1.0, 1.0, 1.0, 1.0])
    future_spike = integrate_orbital_impact(timestamps, [1.0, 1.0, 1.0, 100.0])

    np.testing.assert_allclose(
        first.cumulative_delta_v_loss_m_s[:3],
        future_spike.cumulative_delta_v_loss_m_s[:3],
    )
    np.testing.assert_allclose(
        first.along_track_displacement_m[:3],
        future_spike.along_track_displacement_m[:3],
    )


def test_baseline_corrected_comparison_uses_same_trajectory_and_parameters():
    radius_m = 6_778_000.0
    position = np.tile([radius_m, 0.0, 0.0], (3, 1))
    velocity = np.tile([0.0, 7_700.0, 0.0], (3, 1))
    baseline_density = np.full(3, 2.0e-12)
    corrected_density = 2.0 * baseline_density
    scenario = get_spacecraft_scenario("nominal").parameters

    comparison = compare_baseline_and_corrected_drag(
        _timestamps(3, step_seconds=60),
        position,
        velocity,
        baseline_density,
        corrected_density,
        scenario,
    )

    np.testing.assert_allclose(comparison.density_enhancement_ratio, 2.0)
    np.testing.assert_allclose(
        comparison.corrected.drag_acceleration_m_s2,
        2.0 * comparison.baseline.drag_acceleration_m_s2,
    )
    np.testing.assert_allclose(
        comparison.corrected.impact.cumulative_delta_v_loss_m_s,
        2.0 * comparison.baseline.impact.cumulative_delta_v_loss_m_s,
    )
    # More drag creates a more negative (larger lag) signed displacement.
    assert comparison.additional_along_track_displacement_m[-1] < 0


def test_semimajor_axis_estimate_is_opt_in_and_negative_for_small_circular_drag():
    radius_m = 6_778_000.0
    circular_speed = np.sqrt(EARTH_GRAVITATIONAL_PARAMETER_M3_S2 / radius_m)
    position = np.tile([radius_m, 0.0, 0.0], (3, 1))
    velocity = np.tile([0.0, circular_speed, 0.0], (3, 1))
    acceleration = np.tile([0.0, -1.0e-6, 0.0], (3, 1))

    estimate = estimate_semimajor_axis_change(
        _timestamps(3, step_seconds=60),
        position,
        velocity,
        acceleration,
    )

    assert estimate.status == "ok"
    assert estimate.initial_eccentricity == pytest.approx(0.0, abs=1e-12)
    assert estimate.change_m is not None
    assert estimate.change_m[0] == 0
    assert estimate.change_m[-1] < 0
    assert "not" in estimate.assumptions[-1].lower()


def test_semimajor_axis_estimate_refuses_non_near_circular_state():
    radius_m = 6_778_000.0
    circular_speed = np.sqrt(EARTH_GRAVITATIONAL_PARAMETER_M3_S2 / radius_m)
    position = np.tile([radius_m, 0.0, 0.0], (2, 1))
    # A much slower bound state has eccentricity well above the configured MVP limit.
    velocity = np.tile([0.0, 0.7 * circular_speed, 0.0], (2, 1))
    acceleration = np.tile([0.0, -1.0e-6, 0.0], (2, 1))

    estimate = estimate_semimajor_axis_change(
        _timestamps(2),
        position,
        velocity,
        acceleration,
    )

    assert estimate.status == "not_defensible"
    assert estimate.change_m is None
    assert "eccentricity" in str(estimate.reason)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"drag_coefficient": 0, "reference_area_m2": 1, "mass_kg": 1}, "greater than zero"),
        ({"drag_coefficient": 2, "reference_area_m2": -1, "mass_kg": 1}, "greater than zero"),
        ({"drag_coefficient": 2, "reference_area_m2": 1, "mass_kg": np.nan}, "finite"),
    ],
)
def test_invalid_ballistic_coefficient_inputs_are_rejected(kwargs, message):
    with pytest.raises(ValueError, match=message):
        calculate_ballistic_coefficient(**kwargs)


def test_invalid_drag_and_integration_inputs_are_rejected():
    with pytest.raises(ValueError, match="non-negative"):
        drag_acceleration_magnitude_m_s2(-1.0e-12, 0.01, 7_500.0)
    with pytest.raises(ValueError, match="finite"):
        drag_acceleration_vector_m_s2(1.0e-12, 0.01, [np.nan, 0.0, 0.0])
    with pytest.raises(ValueError, match="identical shapes"):
        air_relative_velocity_m_s([1.0, 2.0, 3.0], [[1.0, 2.0, 3.0]])
    with pytest.raises(ValueError, match="strictly increasing"):
        integrate_orbital_impact(
            [_timestamps(1)[0], _timestamps(1)[0]],
            [1.0, 1.0],
        )
    with pytest.raises(ValueError, match="timezone-aware"):
        integrate_orbital_impact([datetime(2024, 1, 1)], [1.0])
    with pytest.raises(ValueError, match="length"):
        integrate_orbital_impact(_timestamps(2), [1.0])


def test_invalid_spacecraft_and_uncertainty_metadata_are_rejected():
    with pytest.raises(ValueError, match="provide a direct ballistic coefficient"):
        SpacecraftParameters(mass_kg=100.0)
    with pytest.raises(ValueError, match="cannot be marked"):
        SpacecraftParameters(
            ballistic_coefficient_m2_kg=0.01,
            parameter_source="synthetic unit-test fixture",
            evidence_class="scenario",
            is_real_satellite_property=True,
        )
    with pytest.raises(ValueError, match="requires a bound"):
        ParameterUncertainty(
            parameter="mass",
            units="kg",
            status="quantified",
        )
    with pytest.raises(ValueError, match="lower_bound"):
        ParameterUncertainty(
            parameter="area",
            units="m^2",
            status="quantified",
            lower_bound=2.0,
            upper_bound=1.0,
        )


def test_unknown_scenario_is_an_explicit_error():
    with pytest.raises(ValueError, match="unknown spacecraft scenario"):
        get_spacecraft_scenario("catalog-satellite")  # type: ignore[arg-type]
