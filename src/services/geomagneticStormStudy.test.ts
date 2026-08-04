import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

interface StudyMetric {
  tp: number;
  fp: number;
  fn: number;
  tn?: number;
  precisionPct: number;
  recallPct: number;
  observedEvents?: number;
  predictedEvents?: number;
}

interface StudyArtifact {
  schemaVersion: string;
  status: string;
  scope: { evaluationBins: number };
  results: {
    g1Event: StudyMetric;
    g1Bin: StudyMetric;
    comparisons: Array<{ id: string; regression: { n: number }; g1Event: StudyMetric }>;
  };
  kpSources: Array<{ id: string; scoredHere: boolean }>;
}

async function loadArtifact() {
  const artifactPath = path.join(process.cwd(), 'data', 'console', 'geomagnetic-storm-study.json');
  return JSON.parse(await readFile(artifactPath, 'utf8')) as StudyArtifact;
}

test('geomagnetic study artifact exposes a self-consistent held-out event score', async () => {
  const study = await loadArtifact();
  const metric = study.results.g1Event;

  assert.equal(study.schemaVersion, 'heliosat-geomagnetic-storm-study-v1');
  assert.equal(study.status, 'retrospective-held-out');
  assert.equal(metric.tp + metric.fn, metric.observedEvents);
  assert.equal(metric.tp + metric.fp, metric.predictedEvents);
  assert.equal(metric.precisionPct, Math.round(1_000 * metric.tp / (metric.tp + metric.fp)) / 10);
  assert.equal(metric.recallPct, Math.round(1_000 * metric.tp / (metric.tp + metric.fn)) / 10);
});

test('every scored bin and each Kp comparison role are explicit', async () => {
  const study = await loadArtifact();
  const metric = study.results.g1Bin;
  const sourceIds = study.kpSources.map(source => source.id);

  assert.equal(metric.tp + metric.fp + metric.fn + (metric.tn ?? 0), study.scope.evaluationBins);
  assert.deepEqual(sourceIds, ['noaa_forecast', 'heliosat', 'noaa_estimated', 'gfz_nowcast', 'gfz_definitive']);
  assert.deepEqual(
    study.kpSources.filter(source => source.scoredHere).map(source => source.id),
    ['noaa_forecast', 'heliosat', 'gfz_nowcast', 'gfz_definitive'],
  );
  assert.deepEqual(
    study.results.comparisons.map(comparison => comparison.id),
    ['noaa_next_day', 'noaa_two_day', 'heliosat', 'gfz_nowcast'],
  );
  assert.ok(study.results.comparisons.every(comparison => comparison.regression.n > 3_700));
});
