import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedL1EventSample } from './liveL1HistoryService';
import { pointsFromLiveL1Samples } from './forecastHistoryService';

const MINUTE_MS = 60_000;
const baseMs = Date.parse('2026-07-16T10:00:00Z');

function sample(offsetMinutes: number, overrides: Partial<ResolvedL1EventSample> = {}) {
  return {
    ms: baseMs + offsetMinutes * MINUTE_MS,
    speedKmS: 450,
    densityPerCm3: 4,
    bzNt: -2,
    btNt: 5,
    ...overrides,
  } as ResolvedL1EventSample;
}

test('live forecast history maps the canonical L1 stream without inventing missing values', () => {
  const points = pointsFromLiveL1Samples([
    sample(2, { speedKmS: null, densityPerCm3: null }),
    sample(0),
    sample(1, { bzNt: null, btNt: null }),
  ], baseMs + MINUTE_MS);

  assert.deepEqual(points, [
    { t: baseMs + MINUTE_MS, speed: 450, density: 4, bt: null, bz: null },
    { t: baseMs + 2 * MINUTE_MS, speed: null, density: null, bt: 5, bz: -2 },
  ]);
});
