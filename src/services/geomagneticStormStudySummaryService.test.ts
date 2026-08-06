import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeG3StudySummary } from './geomagneticStormStudySummaryService';

test('public G3 study summary exposes event metrics without the full research artifact', () => {
  const summary = normalizeG3StudySummary({
    modelVersion: 'candidate-v2',
    status: 'candidate-retrospective-held-out',
    scope: { evaluationStartUtc: '2024-01-01T00:00:00Z', evaluationStopUtc: '2026-05-01T00:00:00Z' },
    results: { g3Event: { observedEvents: 27, precisionPct: 80, recallPct: 59.3, falseAlarmRatioPct: 20 } },
  });
  assert.deepEqual(summary, {
    modelVersion: 'candidate-v2',
    status: 'candidate-retrospective-held-out',
    evaluationStartUtc: '2024-01-01T00:00:00Z',
    evaluationStopUtc: '2026-05-01T00:00:00Z',
    observedEvents: 27,
    precisionPct: 80,
    recallPct: 59.3,
    falseAlarmRatioPct: 20,
  });
});
