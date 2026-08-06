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
  csiPct: number;
  observedEvents?: number;
  predictedEvents?: number;
}

interface StudyArtifact {
  schemaVersion: string;
  status: string;
  scope: { evaluationBins: number; evaluationStartUtc: string; developmentStopUtc: string; inputCadenceMinutes: number; nativeTruthCadenceHours: number; evaluationWindowSensitivity: Array<{ startUtc: string; g3Events: number; eligibleAsFinalTest: boolean }> };
  training: { rawFiveMinuteRows: number; developmentBins: number; developmentG1Events: number; developmentG3Events: number; featureCount: number };
  results: {
    g1Event: StudyMetric;
    g1Bin: StudyMetric;
    g3Event: StudyMetric;
    g3Bin: StudyMetric;
    baseline: { g1Event: StudyMetric; g3Event: StudyMetric; regression: { maeKp: number } };
    regression: { maeKp: number };
    externalComparison: {
      scope: { commonBins: number; observedG1Events: number; observedG3Events: number };
      products: Array<{ id: string; regression: { n: number }; g1Event: StudyMetric; g3Event: StudyMetric }>;
    };
  };
  kpSources: Array<{ id: string; scoredHere: boolean }>;
}

async function loadArtifact() {
  const artifactPath = path.join(process.cwd(), 'data', 'console', 'geomagnetic-storm-study.json');
  return JSON.parse(await readFile(artifactPath, 'utf8')) as StudyArtifact;
}

function assertConsistentEventMetric(metric: StudyMetric) {
  assert.equal(metric.tp + metric.fn, metric.observedEvents);
  assert.equal(metric.tp + metric.fp, metric.predictedEvents);
  assert.equal(metric.precisionPct, Math.round(1_000 * metric.tp / (metric.tp + metric.fp)) / 10);
  assert.equal(metric.recallPct, Math.round(1_000 * metric.tp / (metric.tp + metric.fn)) / 10);
}

test('geomagnetic study is a large, chronological, held-out trained evaluation', async () => {
  const study = await loadArtifact();

  assert.equal(study.schemaVersion, 'heliosat-geomagnetic-storm-study-v2');
  assert.equal(study.status, 'candidate-retrospective-held-out');
  assert.equal(study.scope.developmentStopUtc, study.scope.evaluationStartUtc);
  assert.equal(study.scope.evaluationStartUtc, '2024-01-01T00:00:00Z');
  assert.equal(study.scope.inputCadenceMinutes, 5);
  assert.equal(study.scope.nativeTruthCadenceHours, 3);
  assert.ok(study.training.rawFiveMinuteRows > 2_900_000);
  assert.ok(study.training.developmentBins > 70_000);
  assert.ok(study.training.developmentG1Events > 900);
  assert.ok(study.training.developmentG3Events >= 90);
  assert.ok(study.training.featureCount >= 50);
  assert.equal(study.scope.evaluationWindowSensitivity.at(-1)?.g3Events, study.results.g3Event.observedEvents);
  assert.equal(study.scope.evaluationWindowSensitivity.filter(row => row.eligibleAsFinalTest).length, 1);
  assert.ok((study.scope.evaluationWindowSensitivity[0]?.g3Events ?? 0) > (study.results.g3Event.observedEvents ?? 0));
});

test('G1 and G3 event and bin counts are internally consistent', async () => {
  const study = await loadArtifact();

  assertConsistentEventMetric(study.results.g1Event);
  assertConsistentEventMetric(study.results.g3Event);
  for (const metric of [study.results.g1Bin, study.results.g3Bin]) {
    assert.equal(metric.tp + metric.fp + metric.fn + (metric.tn ?? 0), study.scope.evaluationBins);
  }
});

test('trained candidate materially improves the severe-storm baseline on held-out data', async () => {
  const study = await loadArtifact();

  assert.ok(study.results.g3Event.recallPct > study.results.baseline.g3Event.recallPct);
  assert.ok(study.results.g3Event.csiPct > study.results.baseline.g3Event.csiPct);
  assert.ok(study.results.g3Event.fp <= study.results.baseline.g3Event.fp);
  assert.ok(study.results.regression.maeKp < study.results.baseline.regression.maeKp);
});

test('Kp forecast, nowcast, and definitive roles are explicit', async () => {
  const study = await loadArtifact();
  const sourceIds = study.kpSources.map(source => source.id);

  assert.deepEqual(sourceIds, ['noaa_forecast', 'heliosat', 'noaa_estimated', 'gfz_nowcast', 'gfz_definitive']);
  assert.deepEqual(study.kpSources.filter(source => source.scoredHere).map(source => source.id), ['noaa_forecast', 'heliosat', 'gfz_nowcast', 'gfz_definitive']);
});

test('external products are compared on one common set of observed Kp bins', async () => {
  const comparison = (await loadArtifact()).results.externalComparison;

  assert.ok(comparison.scope.commonBins > 3_600);
  assert.equal(comparison.scope.observedG1Events, 90);
  assert.equal(comparison.scope.observedG3Events, 14);
  assert.deepEqual(comparison.products.map(product => product.id), ['noaa_next_day', 'noaa_two_day', 'heliosat', 'gfz_nowcast']);
  for (const product of comparison.products) {
    assert.equal(product.regression.n, comparison.scope.commonBins);
    for (const metric of [product.g1Event, product.g3Event]) {
      assert.equal(metric.tp + metric.fn, metric.observedEvents);
      assert.equal(metric.tp + metric.fp, metric.predictedEvents);
      if (metric.predictedEvents) {
        assertConsistentEventMetric(metric);
      } else {
        assert.equal(metric.precisionPct, null);
      }
    }
  }
});
