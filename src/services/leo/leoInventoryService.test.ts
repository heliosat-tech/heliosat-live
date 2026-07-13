import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLeoInventoryFromManifest, type ThermosphereManifest } from './leoInventoryService';

const generatedAtUtc = '2026-07-12T12:00:00Z';

test('missing thermosphere manifest returns five explicit unavailable mission cards', () => {
  const response = buildLeoInventoryFromManifest(null, { generatedAtUtc });
  assert.equal(response.schema_version, '2');
  assert.equal(response.evidence_class, 'observed');
  assert.equal(response.manifest.status, 'unavailable');
  assert.equal(response.datasets.length, 5);
  assert.ok(response.datasets.every(dataset => dataset.status === 'unavailable'));
  assert.ok(response.datasets.every(dataset => dataset.row_count_processed === null));
});

test('inventory exposes explicit effective coverage without inferring days from the date span', () => {
  const manifest: ThermosphereManifest = {
    schema_version: 'thermosphere-manifest-v2',
    generated_at_utc: generatedAtUtc,
    coverage_summary: {
      start_utc: '2019-01-02T00:00:00Z',
      end_utc: '2024-10-05T00:00:00Z',
      effective_observation_days: 24,
      calendar_years: [2019, 2021, 2024],
      spacecraft_count: 4,
      spacecraft_ids: ['Swarm A', 'Swarm B', 'Swarm C', 'GRACE-FO 1'],
      mission_count: 2,
      quiet_interval_count: 8,
      storm_events: { total: 16, moderate: 11, severe: 5 },
    },
    entries: [],
  };
  const response = buildLeoInventoryFromManifest(manifest, { generatedAtUtc });
  assert.equal(response.coverage_summary.effective_observation_days, 24);
  assert.deepEqual(response.coverage_summary.calendar_years, [2019, 2021, 2024]);
  assert.equal(response.coverage_summary.storm_events.severe, 5);
});

test('inventory lineage omits absolute and traversing host paths', () => {
  const manifest: ThermosphereManifest = {
    entries: [{
      mission: 'swarm',
      spacecraft_id: 'A',
      source_product: 'SW_OPER_DNSAPOD_2_',
      raw_file: '/private/raw.hapi.json',
      processed_files: ['../private.parquet', 'processed/safe.parquet'],
      row_count_processed: 1,
      start_utc: '2022-02-03T00:00:00Z',
      end_utc: '2022-02-03T00:01:00Z',
    }],
  };
  const swarmA = buildLeoInventoryFromManifest(manifest, { generatedAtUtc }).datasets[0];
  assert.equal(swarmA.lineage[0].source_file, null);
  assert.deepEqual(swarmA.lineage[0].processed_files, ['processed/safe.parquet']);
});

test('raw-only official entry is partial and never becomes processed coverage', () => {
  const manifest: ThermosphereManifest = {
    schema_version: 'thermosphere-manifest-v1',
    generated_at_utc: generatedAtUtc,
    entries: [{
      mission: 'swarm',
      spacecraft_id: 'A',
      source_product: 'SW_OPER_DNSAPOD_2_',
      raw_file: 'raw/official.hapi.json',
      processed_files: [],
      row_count_raw: 60,
      row_count_processed: null,
      start_utc: '2022-02-03T00:00:00Z',
      end_utc: '2022-02-03T00:30:00Z',
      processing_status: 'pending',
    }],
  };
  const response = buildLeoInventoryFromManifest(manifest, { generatedAtUtc });
  const swarmA = response.datasets.find(dataset => dataset.id === 'swarm-a');
  assert.equal(swarmA?.status, 'partial');
  assert.equal(swarmA?.coverage.raw.status, 'available');
  assert.equal(swarmA?.coverage.raw.rows, 60);
  assert.equal(swarmA?.coverage.processed.status, 'unavailable');
  assert.equal(swarmA?.processing_status, 'pending');
});

test('processed official entry exposes measured counts, quality and lineage only', () => {
  const manifest: ThermosphereManifest = {
    schema_version: 'thermosphere-manifest-v1',
    generated_at_utc: generatedAtUtc,
    entries: [{
      mission: 'grace_fo',
      spacecraft_id: '1',
      source_product: 'GF_OPER_DNS1ACC_2_',
      raw_file: 'raw/gf1.hapi.json',
      processed_files: ['processed/gf1.parquet'],
      checksum_sha256: 'abc123',
      row_count_raw: 100,
      row_count_processed: 10,
      quality_nominal_rows: 90,
      quality_anomalous_rows: 10,
      storage_bytes: 1_024,
      start_utc: '2022-02-03T00:00:00Z',
      end_utc: '2022-02-03T00:10:00Z',
      processing_status: 'processed',
      baseline_status: 'pending',
      driver_join_status: 'pending',
    }],
  };
  const response = buildLeoInventoryFromManifest(manifest, { generatedAtUtc });
  const gf1 = response.datasets.find(dataset => dataset.id === 'grace-fo-1');
  assert.equal(gf1?.status, 'available');
  assert.equal(gf1?.row_count_raw, 100);
  assert.equal(gf1?.row_count_processed, 10);
  assert.equal(gf1?.quality_pass_pct, 90);
  assert.equal(gf1?.lineage[0].checksum_sha256, 'abc123');
  assert.equal(gf1?.baseline_status, 'pending');
  assert.equal(response.datasets.find(dataset => dataset.id === 'grace-fo-2')?.status, 'unavailable');
});

test('mixed source files expose explicit chronological role coverage', () => {
  const manifest: ThermosphereManifest = {
    schema_version: 'thermosphere-manifest-v1',
    generated_at_utc: generatedAtUtc,
    entries: [{
      mission: 'swarm',
      spacecraft_id: 'A',
      source_product: 'SW_OPER_DNSAPOD_2_',
      processed_files: ['processed/swarm-a.parquet'],
      row_count_processed: 7_200,
      start_utc: '2022-02-03T00:00:00Z',
      end_utc: '2022-02-08T00:00:00Z',
      processing_status: 'processed',
      driver_join_status: 'processed',
      research_stage: 'multi_year_study',
      training_role: 'mixed',
      role_coverage: {
        train: { start_utc: '2022-02-03T00:00:00Z', end_utc: '2022-02-05T12:00:00Z' },
        validation: { start_utc: '2022-02-05T12:01:00Z', end_utc: '2022-02-05T23:59:00Z' },
        test: { start_utc: '2022-02-06T00:00:00Z', end_utc: '2022-02-07T23:59:00Z' },
      },
    }],
  };
  const swarmA = buildLeoInventoryFromManifest(manifest, { generatedAtUtc }).datasets
    .find(dataset => dataset.id === 'swarm-a');
  assert.equal(swarmA?.coverage.train.status, 'available');
  assert.equal(swarmA?.coverage.validation.start_utc, '2022-02-05T12:01:00Z');
  assert.equal(swarmA?.coverage.test.end_utc, '2022-02-07T23:59:00Z');
  assert.equal(buildLeoInventoryFromManifest(manifest, { generatedAtUtc }).research_stage, 'multi_year_study');
});
