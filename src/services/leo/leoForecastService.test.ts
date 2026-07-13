import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_LEO_FORECAST_SUMMARY, normalizeLeoForecastSnapshot, outOfDistribution } from './leoForecastService';

function validSnapshot() {
  const timestamp = '2026-07-12T12:05:00Z';
  return {
    schema_version: '1',
    generated_at_utc: '2026-07-12T12:00:00Z',
    forecast_mode: 'experimental',
    selector: { group: 'stations', selected_norad_id: '25544' },
    model: { status: 'available', version: 'm3-pilot', artifact: 'model.joblib', training_range: { start_utc: '2022-01-01T00:00:00Z', end_utc: '2022-06-01T00:00:00Z' } },
    baseline: { status: 'available', model_name: 'research baseline', model_version: '1', licensing_status: 'internal research' },
    spacecraft_parameters: {
      id: 'nominal',
      direct_ballistic_coefficient_m2_kg: 0.01,
      is_real_satellite_property: false,
      parameter_source: 'documented contract-test scenario; not an observation',
    },
    validated_domain: {
      altitude_min_km: 350,
      altitude_max_km: 550,
      missions: ['Swarm'],
      mission_category_validated: false,
      feature_range_violations: ['vsw_km_s'],
    },
    trajectory: {
      status: 'available',
      satellite: { norad_id: '25544', name: 'CONTRACT TEST', source: 'celestrak-stations', tle_epoch_utc: '2026-07-12T11:00:00Z', tle_age_hours: 1, tle_freshness: 'fresh' },
      frame: 'TEME',
      propagator: 'SGP4 via satellite.js',
      generated_at_utc: '2026-07-12T12:00:00Z',
      horizon_minutes: 180,
      cadence_minutes: 5,
      points: [{
        timestamp_utc: timestamp,
        frame: 'TEME',
        position_km: { x: 6800, y: 0, z: 0 },
        velocity_km_s: { x: 0, y: 7.7, z: 0 },
        atmosphere_corotation_velocity_km_s: { x: 0, y: 0.496, z: 0 },
        air_relative_velocity_km_s: { x: 0, y: 7.204, z: 0 },
        air_relative_speed_km_s: 7.204,
        latitude_deg: 0,
        longitude_deg: 0,
        altitude_km: 421.9,
        local_solar_time_h: 12,
      }],
      warnings: [],
    },
    forcing: {
      source_status: 'available',
      l1_sample_time_utc: '2026-07-12T11:59:00Z',
      arrival_model: 'MRU contract test',
      confirmed_inbound: { start_utc: timestamp, end_utc: timestamp },
      assumption_extension: { start_utc: null, end_utc: null, policy: 'No extension in this contract fixture.' },
      timeline: [{
        arrival_time_bow_shock_utc: timestamp,
        forcing_mode: 'confirmed_inbound',
        speed_km_s: 450,
        bz_gsm_nt: -3,
        dynamic_pressure_npa: 2,
        em_mv_m: 1.35,
        newell_coupling: 100,
      }],
      warnings: [],
    },
    timeline: [{
      timestamp_utc: timestamp,
      forcing_mode: 'confirmed_inbound',
      rho_baseline_kg_m3: 1e-12,
      rho_p50_kg_m3: 1.2e-12,
      drag_acceleration_p50_m_s2: 4e-7,
    }],
    summary: { rho_p50_kg_m3: 1.2e-12 },
    warnings: ['Contract fixture only.'],
  };
}

test('unavailable forecast summary uses nulls rather than zeros', () => {
  assert.ok(Object.values(EMPTY_LEO_FORECAST_SUMMARY).every(value => value === null));
});

test('forecast snapshot requires a versioned model, scenario provenance and real timeline rows', () => {
  const snapshot = normalizeLeoForecastSnapshot(validSnapshot(), 'data/model-runs/leo-density/test/forecast-latest.v1.json');
  assert.ok(snapshot);
  assert.equal(snapshot.timeline[0].density_evidence_class, 'experimental_forecast');
  assert.equal(snapshot.spacecraftParameters.is_real_satellite_property, false);
  assert.equal(snapshot.summary.rho_p50_kg_m3, 1.2e-12);
  assert.equal(snapshot.summary.cumulative_delta_v_m_s, null);
  assert.equal(snapshot.trajectory.points[0].timestamp_utc, snapshot.timeline[0].timestamp_utc);
  assert.equal(snapshot.forcing.timeline[0].arrival_time_bow_shock_utc, snapshot.timeline[0].timestamp_utc);
  assert.equal(snapshot.domainReasons.length, 2);
  assert.equal(snapshot.model.uncertainty.status, 'unavailable');
});

test('snapshot rejects forcing from a different issuance grid', () => {
  const candidate = validSnapshot();
  candidate.forcing.timeline[0].arrival_time_bow_shock_utc = '2026-07-12T12:10:00Z';
  assert.equal(normalizeLeoForecastSnapshot(candidate, 'forecast-latest.v1.json'), null);
});

test('out-of-distribution combines altitude and fitted feature/category warnings', () => {
  const snapshot = normalizeLeoForecastSnapshot(validSnapshot(), 'forecast-latest.v1.json');
  assert.ok(snapshot);
  const ood = outOfDistribution(
    snapshot.validatedDomain,
    snapshot.trajectory,
    snapshot.domainReasons,
  );
  assert.equal(ood.is_out_of_domain, true);
  assert.equal(ood.reasons.length, 2);
});

test('a snapshot cannot present a TLE-inferred real spacecraft property', () => {
  assert.equal(normalizeLeoForecastSnapshot({
    schema_version: '1',
    generated_at_utc: '2026-07-12T12:00:00Z',
    forecast_mode: 'experimental',
    selector: { selected_norad_id: '25544' },
    model: { status: 'available', version: 'bad' },
    spacecraft_parameters: { id: 'nominal', direct_ballistic_coefficient_m2_kg: 0.01, is_real_satellite_property: true },
    timeline: [{ timestamp_utc: '2026-07-12T12:05:00Z', forcing_mode: 'confirmed_inbound' }],
  }, 'bad.json'), null);
});

test('uncalibrated snapshot quantiles are withheld while p50 remains available', () => {
  const candidate = validSnapshot();
  Object.assign(candidate.timeline[0], {
    rho_p10_kg_m3: 0.9e-12,
    rho_p90_kg_m3: 1.5e-12,
    drag_acceleration_p10_m_s2: 3e-7,
    drag_acceleration_p90_m_s2: 5e-7,
  });
  const snapshot = normalizeLeoForecastSnapshot(candidate, 'forecast-latest.v1.json');
  assert.ok(snapshot);
  assert.equal(snapshot.timeline[0].rho_p50_kg_m3, 1.2e-12);
  assert.equal(snapshot.timeline[0].rho_p10_kg_m3, null);
  assert.equal(snapshot.timeline[0].rho_p90_kg_m3, null);
  assert.match(snapshot.warnings.join(' '), /quantiles were withheld/);
});

test('calibrated snapshot preserves ordered quantiles only for the matching model version', () => {
  const candidate = validSnapshot();
  Object.assign(candidate.model, {
    uncertainty: {
      status: 'calibrated',
      model_version: 'm3-pilot',
      method: 'event_block_conformal',
      calibration_start_utc: '2025-01-01T00:00:00Z',
      calibration_end_utc: '2025-12-31T23:59:00Z',
      sample_count: 5000,
      block_count: 10,
      nominal_coverage: 0.8,
      empirical_coverage: 0.81,
      p10_coverage: 0.1,
      p50_coverage: 0.5,
      p90_coverage: 0.9,
    },
  });
  Object.assign(candidate.timeline[0], { rho_p10_kg_m3: 0.9e-12, rho_p90_kg_m3: 1.5e-12 });
  const snapshot = normalizeLeoForecastSnapshot(candidate, 'forecast-latest.v2.json');
  assert.ok(snapshot);
  assert.equal(snapshot.model.uncertainty.status, 'calibrated');
  assert.equal(snapshot.timeline[0].rho_p10_kg_m3, 0.9e-12);
  assert.equal(snapshot.timeline[0].rho_p90_kg_m3, 1.5e-12);

  const mismatch = validSnapshot();
  Object.assign(mismatch.model, {
    uncertainty: {
      status: 'calibrated', model_version: 'different-model', method: 'event_block_conformal',
      calibration_start_utc: '2025-01-01T00:00:00Z', calibration_end_utc: '2025-12-31T23:59:00Z',
      sample_count: 5000, nominal_coverage: 0.8, empirical_coverage: 0.81,
    },
  });
  Object.assign(mismatch.timeline[0], { rho_p10_kg_m3: 0.9e-12, rho_p90_kg_m3: 1.5e-12 });
  const mismatchSnapshot = normalizeLeoForecastSnapshot(mismatch, 'forecast-latest.v2.json');
  assert.ok(mismatchSnapshot);
  assert.equal(mismatchSnapshot.model.uncertainty.status, 'unavailable');
  assert.equal(mismatchSnapshot.timeline[0].rho_p10_kg_m3, null);
});
