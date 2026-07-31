import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLeoValidationStudy, readLeoValidationArtifact } from './leoValidationService';

test('validation normalizer preserves separate reference and predicted-arrival modes', () => {
  const study = normalizeLeoValidationStudy({
    run_id: 'pilot-001',
    study_version: '1',
    generated_at_utc: '2026-07-12T12:00:00Z',
    dataset_version: 'sha256:data',
    feature_schema_version: 'features-v1',
    status: 'available',
    missions: ['Swarm A', 'GRACE-FO 1'],
    split: { scheme: 'chronological' },
    modes: {
      reference_aligned: {
        status: 'available',
        metrics: [{ key: 'mae_log10_rho', label: 'MAE log10 rho', value: 0.12, sample_count: 50 }],
        models: [],
      },
      heliosat_predicted_arrival: {
        status: 'available',
        metrics: [{ key: 'mae_log10_rho', label: 'MAE log10 rho', value: 0.18, sample_count: 50 }],
        models: [],
      },
    },
  });
  assert.ok(study);
  assert.equal(study.modes.reference_aligned.metrics[0].value, 0.12);
  assert.equal(study.modes.heliosat_predicted_arrival.metrics[0].value, 0.18);
  assert.equal(study.modes.reference_aligned.evidence_class, 'retrospective');
  assert.equal(study.research_stage, 'pilot');
  assert.equal(study.arrival_modes.mru_ml.status, 'unavailable');
  assert.equal(study.arrival_comparability.status, 'unverified');
});

test('missing end-to-end mode is explicit unavailable rather than copied from reference mode', () => {
  const study = normalizeLeoValidationStudy({
    run_id: 'pilot-002',
    generated_at_utc: '2026-07-12T12:00:00Z',
    status: 'available',
    modes: { reference_aligned: { status: 'available', metrics: { mae: 0.1 } } },
  });
  assert.ok(study);
  assert.equal(study.modes.reference_aligned.metrics[0].value, 0.1);
  assert.equal(study.modes.heliosat_predicted_arrival.status, 'unavailable');
  assert.equal(study.status, 'partial');
  assert.deepEqual(study.modes.heliosat_predicted_arrival.metrics, []);
});

test('invalid study roots and non-finite metrics are rejected', () => {
  assert.equal(normalizeLeoValidationStudy({ generated_at_utc: 'bad', modes: {} }), null);
  const study = normalizeLeoValidationStudy({
    run_id: 'pilot-003',
    generated_at_utc: '2026-07-12T12:00:00Z',
    modes: {
      reference_aligned: { metrics: [{ key: 'bad', value: Number.NaN }] },
      heliosat_predicted_arrival: {},
    },
  });
  assert.deepEqual(study?.modes.reference_aligned.metrics, []);
});

test('scientific artifact catalog exposes only recognized declared plots through opaque URLs', () => {
  const study = normalizeLeoValidationStudy({
    run_id: 'pilot-safe-001',
    generated_at_utc: '2026-07-12T12:00:00Z',
    artifacts: [
      'plots/observed-versus-baseline.png',
      'plots/feature-importance-reference_aligned.png',
      'plots/not-a-scientific-contract-plot.png',
      '../private.png',
      '/tmp/private.png',
      'reference_aligned/m3.joblib',
      'reference_aligned/m3-test-predictions.parquet',
    ],
    modes: { reference_aligned: {}, heliosat_predicted_arrival: {} },
  });
  assert.ok(study);
  assert.equal(study.scientific_artifacts.length, 2);
  assert.ok(study.scientific_artifacts.every(artifact => /^\/api\/console\/leo\/validation\/artifact\?id=[a-f0-9]{24}$/.test(artifact.url)));
  const serialized = JSON.stringify(study);
  assert.ok(!serialized.includes('joblib'));
  assert.ok(!serialized.includes('parquet'));
  assert.ok(!serialized.includes('/tmp/'));
  assert.ok(!serialized.includes('observed-versus-baseline.png'));
});

test('events, regimes and lineage are normalized without local filenames or raw records', () => {
  const eventId = 'kp-g1plus-20220204T1500-2';
  const mode = {
    status: 'available',
    breakdowns: {
      event_holdout: {
        event: { event_id: eventId },
        event_definition: 'retrospective Kp >= 5; not a model input',
        test_rows: 1440,
        event_metrics: {
          status: 'available',
          spacecraft_count: 4,
          peak_density_absolute_relative_error: 0.14,
          peak_timing_mae_min: 114,
          onset_timing_mae_min: null,
          recovery_timing_mae_min: null,
          reason: 'No density threshold was defined.',
        },
      },
      breakdowns: {
        altitude: {
          '<450 km': {
            status: 'available', sample_count: 100,
            mae_log10_rho: 0.04, rmse_log10_rho: 0.05,
            median_absolute_relative_error: 0.08, bias_log10_rho: 0.01,
            correlation_log10_rho: 0.9,
            skill_vs_m0: { rmse_skill: 0.2 },
          },
        },
      },
    },
  };
  const study = normalizeLeoValidationStudy({
    run_id: 'pilot-safe-002',
    generated_at_utc: '2026-07-12T12:00:00Z',
    event_definitions: [{ event_id: eventId, start_utc: '2022-02-04T15:00:00Z', stop_utc: '2022-02-04T21:00:00Z' }],
    modes: { reference_aligned: mode, heliosat_predicted_arrival: mode },
    data_lineage: {
      coverage_start_utc: '2022-02-03T00:00:00Z', coverage_end_utc: '2022-02-08T00:00:00Z',
      input_rows: 200, selected_rows: 180, source_files: ['/private/density.parquet'],
      source_checksums_sha256: { '/private/density.parquet': 'abc' },
      manifest_path: '/private/manifest.json', manifest_checksum_sha256: 'def',
      baseline_models: ['NRLMSIS'], baseline_versions: ['2.1'],
    },
    driver_lineage: {
      source: 'official driver archive', source_files: ['/private/driver.asc'], checksums_sha256: { '/private/driver.asc': 'ghi' },
    },
  });
  assert.ok(study);
  assert.equal(study.events[0].mode_results.reference_aligned.peak_timing_mae_min, 114);
  assert.equal(study.regimes.reference_aligned[0].groups[0].rmse_skill_vs_m0, 0.2);
  assert.equal(study.lineage?.density_source_file_count, 1);
  assert.equal(study.lineage?.driver_checksum_count, 1);
  assert.ok(!JSON.stringify(study).includes('/private/'));
});

test('artifact reader rejects path-like and non-opaque identifiers before file lookup', async () => {
  assert.equal(await readLeoValidationArtifact('../../etc/passwd'), null);
  assert.equal(await readLeoValidationArtifact('observed-versus-baseline.png'), null);
});

test('multi-year v2 fields preserve arrival comparability, transfer, lag and CI provenance', () => {
  const metric = {
    key: 'rmse_log10_rho',
    label: 'RMSE log10 density',
    value: 0.05,
    unit: 'dex',
    model_id: 'M3',
    sample_count: 1000,
    confidence_interval: {
      low: 0.04,
      high: 0.06,
      level_pct: 95,
      method: 'event_block_bootstrap',
      block_count: 12,
      resamples: 500,
      random_seed: 42,
    },
  };
  const mode = {
    status: 'available',
    metrics: [metric],
    models: [{
      id: 'M3', status: 'available', role: 'deployable_candidate',
      uses_mission_identity: false, causality: 'issuance_safe', metrics: [metric],
    }],
  };
  const study = normalizeLeoValidationStudy({
    run_id: 'multiyear-001',
    research_stage: 'multi_year_study',
    generated_at_utc: '2026-07-13T12:00:00Z',
    status: 'available',
    missions: ['Swarm', 'GRACE-FO'],
    coverage_summary: {
      start_utc: '2019-01-01T00:00:00Z', end_utc: '2024-12-31T23:59:00Z',
      effective_observation_days: 365, calendar_years: [2019, 2020, 2022, 2024],
      spacecraft_count: 4, spacecraft_ids: ['A', 'B', 'C', 'GF1'], mission_count: 2,
      quiet_interval_count: 8, storm_events: { total: 20, moderate: 14, severe: 6 },
    },
    modes: { reference_aligned: {}, heliosat_predicted_arrival: {} },
    arrival_modes: { omni_reference_aligned: mode, mru: mode, mru_ml: mode },
    arrival_comparability: {
      status: 'identical', matched_row_fingerprint: 'rows:abc', split_fingerprint: 'split:def',
      hyperparameter_fingerprint: 'params:ghi', random_seed: 42, reasons: [],
    },
    transfer_experiments: [{
      id: 'loso-a', kind: 'leave_one_spacecraft_out', arrival_mode: 'mru_ml', status: 'available',
      role: 'deployable_candidate', held_out_spacecraft_id: 'A', train_spacecraft_ids: ['B', 'C', 'GF1'],
      test_rows: 1000, metrics: [metric],
    }],
    lag_experiments: [{
      id: 'lag-global', kind: 'distributed_lag', arrival_mode: 'mru_ml', status: 'available',
      lag_min_hours: 0, lag_max_hours: 12, lag_step_minutes: 30, best_lag_hours: 2.5, metric,
    }],
    uncertainty_calibration: {
      status: 'calibrated', method: 'event_block_conformal',
      calibration_start_utc: '2023-01-01T00:00:00Z', calibration_end_utc: '2023-12-31T23:59:00Z',
      sample_count: 10000, block_count: 12, nominal_coverage: 0.8, empirical_coverage: 0.81,
      p10_coverage: 0.11, p50_coverage: 0.51, p90_coverage: 0.91,
    },
    artifacts: [
      'plots/lag-response-distributed-mru_ml.png',
      'plots/lag-response-unknown-mru_ml.png',
    ],
  });
  assert.ok(study);
  assert.equal(study.research_stage, 'multi_year_study');
  assert.equal(study.coverage_summary.effective_observation_days, 365);
  assert.equal(study.arrival_comparability.status, 'identical');
  assert.equal(study.arrival_modes.mru_ml.models[0].uses_mission_identity, false);
  assert.equal(study.arrival_modes.mru_ml.metrics[0].confidence_interval?.method, 'event_block_bootstrap');
  assert.equal(study.arrival_modes.mru_ml.metrics[0].confidence_interval?.block_count, 12);
  assert.equal(study.transfer_experiments[0].kind, 'leave_one_spacecraft_out');
  assert.equal(study.lag_experiments[0].best_lag_hours, 2.5);
  assert.equal(study.uncertainty_calibration.status, 'calibrated');
  assert.equal(study.scientific_artifacts.length, 1);
  assert.equal(study.scientific_artifacts[0].category, 'lag_response');
});

test('declared identical comparison is downgraded when a required fingerprint is missing', () => {
  const study = normalizeLeoValidationStudy({
    run_id: 'comparison-incomplete',
    generated_at_utc: '2026-07-13T12:00:00Z',
    modes: { reference_aligned: {}, heliosat_predicted_arrival: {} },
    arrival_comparability: {
      status: 'identical', matched_row_fingerprint: 'rows:abc', split_fingerprint: 'split:def',
    },
  });
  assert.equal(study?.arrival_comparability.status, 'unverified');
  assert.match(study?.arrival_comparability.reasons.join(' ') ?? '', /required fingerprints/);
});

test('arrival-mode metrics expose nested RMSE skill versus the physical baseline', () => {
  const study = normalizeLeoValidationStudy({
    run_id: 'nested-skill',
    generated_at_utc: '2026-07-13T12:00:00Z',
    modes: { reference_aligned: {}, heliosat_predicted_arrival: {} },
    arrival_modes: {
      mru_ml: {
        status: 'available',
        metrics: {
          rmse_log10_rho: 0.1,
          sample_count: 100,
          skill_vs_m0: { rmse_skill: 0.05 },
        },
      },
    },
  });
  assert.equal(study?.arrival_modes.mru_ml.metrics.find(metric => metric.key === 'rmse_skill_vs_m0')?.value, 0.05);
});

test('legacy MRU fallback is exposed as MRU while MRU plus ML stays unavailable', () => {
  const study = normalizeLeoValidationStudy({
    run_id: 'pilot-mru-fallback',
    pilot_study_version: 'legacy-v1',
    generated_at_utc: '2026-07-12T12:00:00Z',
    modes: {
      reference_aligned: { status: 'available', metrics: [{ key: 'rmse', value: 0.1 }] },
      heliosat_predicted_arrival: { status: 'available', metrics: [{ key: 'rmse', value: 0.2 }], warnings: ['MRU fallback was used.'] },
    },
  });
  assert.equal(study?.arrival_modes.mru.status, 'available');
  assert.equal(study?.arrival_modes.mru_ml.status, 'unavailable');
});

test('real v2 aliases expose stop coverage, MRU plus ML legacy aggregate, direct regimes and per-event timing', () => {
  const mruMlMode = {
    status: 'available',
    metrics: [{ key: 'rmse_log10_rho', value: 0.102, model_id: 'M3', sample_count: 144344 }],
    models: [{ id: 'M3', status: 'available', metrics: [{ key: 'rmse_log10_rho', value: 0.102 }] }],
    breakdowns: {
      storm_intensity: {
        quiet: {
          status: 'available', sample_count: 46474, mae_log10_rho: 0.097,
          rmse_log10_rho: 0.114, median_absolute_relative_error: 0.207,
          bias_log10_rho: -0.033, correlation_log10_rho: 0.927,
          skill_vs_m0: { rmse_skill: -0.276 },
        },
        severe_storm: {
          status: 'available', sample_count: 40021, mae_log10_rho: 0.092,
          rmse_log10_rho: 0.113, median_absolute_relative_error: 0.196,
          bias_log10_rho: 0.053, correlation_log10_rho: 0.933,
          skill_vs_m0: { rmse_skill: 0.072 },
        },
      },
    },
  };
  const study = normalizeLeoValidationStudy({
    schema_version: 'leo-density-study-summary-v2',
    study_version: 'heliosat-leo-multiyear-v1',
    run_id: 'staged-2021-2025-test',
    research_stage: 'multi_year_study',
    generated_at_utc: '2026-07-13T12:00:00Z',
    status: 'available',
    coverage: {
      start_utc: '2021-04-28T00:00:00Z', stop_utc: '2025-12-16T02:55:00Z',
      effective_observation_days: 606,
    },
    data_lineage: {
      coverage_start_utc: '2021-04-28T00:00:00Z', coverage_stop_utc: '2025-12-16T02:55:00Z',
    },
    driver_lineage: {
      coverage_start_utc: '2021-04-27T00:00:00Z', coverage_stop_utc: '2025-12-17T00:00:00Z',
    },
    modes: {
      reference_aligned: { status: 'available', metrics: [{ key: 'rmse_log10_rho', value: 0.101 }] },
      heliosat_mru_ml_arrival: mruMlMode,
    },
    arrival_modes: {
      omni_reference_aligned: { status: 'available', metrics: [] },
      mru: { status: 'available', metrics: [] },
      mru_ml: { status: 'available', metrics: [] },
    },
    event_timing: {
      method: 'per-spacecraft enhancement ratio; spacecraft median within event',
      enhancement_threshold: 1.2,
      per_event: [{
        event_id: 'severe-2025-20250101T0900',
        event_start_utc: '2025-01-01T09:00:00Z',
        event_stop_utc: '2025-01-01T21:00:00Z',
        available_spacecraft_records: 4,
        metrics: {
          onset: { status: 'available', median: 345, spacecraft_count: 3 },
          peak_magnitude: { status: 'available', median: 0.347, spacecraft_count: 4 },
          peak_timing: { status: 'available', median: 130, spacecraft_count: 4 },
          recovery: { status: 'available', median: 152.5, spacecraft_count: 4 },
        },
      }],
    },
  });
  assert.ok(study);
  assert.equal(study.coverage_summary.end_utc, '2025-12-16T02:55:00Z');
  assert.equal(study.lineage?.density_coverage_end_utc, '2025-12-16T02:55:00Z');
  assert.equal(study.lineage?.driver_coverage_end_utc, '2025-12-17T00:00:00Z');
  assert.equal(study.modes.heliosat_predicted_arrival.metrics[0].value, 0.102);
  const geomagnetic = study.regimes.heliosat_predicted_arrival.find(dimension => dimension.id === 'geomagnetic_regime');
  assert.deepEqual(geomagnetic?.groups.map(group => group.label), ['quiet', 'severe_storm']);
  assert.equal(study.events.length, 1);
  assert.equal(study.events[0].prediction_mode_label, 'HelioSat MRU plus ML arrival (v2 aggregate)');
  assert.equal(study.events[0].mode_results.reference_aligned.status, 'unavailable');
  assert.match(study.events[0].mode_results.reference_aligned.reason ?? '', /MRU plus ML/);
  assert.equal(study.events[0].mode_results.heliosat_predicted_arrival.peak_density_absolute_relative_error, 0.347);
  assert.equal(study.events[0].mode_results.heliosat_predicted_arrival.peak_timing_mae_min, 130);
  assert.equal(study.events[0].mode_results.heliosat_predicted_arrival.onset_timing_mae_min, 345);
  assert.equal(study.events[0].mode_results.heliosat_predicted_arrival.recovery_timing_mae_min, 152.5);
  assert.equal(study.events[0].mode_results.heliosat_predicted_arrival.spacecraft_count, 4);
});

test('explicit legacy predicted-arrival aggregate takes precedence over the v2 MRU plus ML fallback', () => {
  const study = normalizeLeoValidationStudy({
    run_id: 'v2-with-legacy-alias',
    generated_at_utc: '2026-07-13T12:00:00Z',
    modes: {
      reference_aligned: {},
      heliosat_predicted_arrival: { status: 'available', metrics: [{ key: 'rmse', value: 0.2 }] },
      heliosat_mru_ml_arrival: { status: 'available', metrics: [{ key: 'rmse', value: 0.1 }] },
    },
  });
  assert.equal(study?.modes.heliosat_predicted_arrival.metrics[0].value, 0.2);
});
