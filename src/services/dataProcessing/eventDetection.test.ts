import assert from 'node:assert/strict';
import test from 'node:test';
import type { L1Sample } from '../dataSources/types';
import { buildFeaturedSamples } from './derivedFeatures';
import { detectIntervals, detectPhysicalDriverEvents } from './eventDetection';

const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;

function l1(offsetMin: number, partial: Partial<L1Sample>): L1Sample {
  return {
    timeUtc: new Date(t0 + offsetMin * MIN).toISOString(),
    source: 'swpc_rtsw',
    spacecraft: 'active',
    speedKmS: null,
    densityCm3: null,
    temperatureK: null,
    bxGsmNt: null,
    byGsmNt: null,
    bzGsmNt: null,
    btNt: null,
    qualityFlags: [],
    sourceAttribution: [],
    ...partial,
  };
}

test('detectIntervals finds maximal runs where the predicate holds', () => {
  const speeds = [500, 560, 580, 540, 560, 500];
  const featured = buildFeaturedSamples(speeds.map((v, i) => l1(i, { speedKmS: v })));
  const intervals = detectIntervals(featured, s => (s.speedKmS === null ? null : s.speedKmS >= 550), { cadenceMs: MIN });
  assert.equal(intervals.length, 2);
  assert.deepEqual([intervals[0].startIndex, intervals[0].endIndex], [1, 2]);
  assert.deepEqual([intervals[1].startIndex, intervals[1].endIndex], [4, 4]);
});

test('mergeGapSamples bridges a short dropout', () => {
  const speeds = [500, 560, 580, 540, 560, 500];
  const featured = buildFeaturedSamples(speeds.map((v, i) => l1(i, { speedKmS: v })));
  const intervals = detectIntervals(featured, s => (s.speedKmS === null ? null : s.speedKmS >= 550), {
    cadenceMs: MIN,
    mergeGapSamples: 1,
  });
  assert.equal(intervals.length, 1);
  assert.deepEqual([intervals[0].startIndex, intervals[0].endIndex], [1, 4]);
});

test('minDurationMinutes drops short intervals', () => {
  const speeds = [560, 580];
  const featured = buildFeaturedSamples(speeds.map((v, i) => l1(i, { speedKmS: v })));
  const kept = detectIntervals(featured, s => (s.speedKmS ?? 0) >= 550, { cadenceMs: MIN, minDurationMinutes: 3 });
  assert.equal(kept.length, 0);
});

test('missing-data mode controls bridging of null verdicts', () => {
  const featured = buildFeaturedSamples([
    l1(0, { speedKmS: 560 }),
    l1(1, {}), // speed null -> predicate null
    l1(2, { speedKmS: 560 }),
  ]);
  const predicate = (s: { speedKmS: number | null }) => (s.speedKmS === null ? null : s.speedKmS >= 550);

  const broken = detectIntervals(featured, predicate, { cadenceMs: MIN, missingData: 'break' });
  assert.equal(broken.length, 2);

  const bridged = detectIntervals(featured, predicate, { cadenceMs: MIN, missingData: 'merge' });
  assert.equal(bridged.length, 1);
  assert.deepEqual([bridged[0].startIndex, bridged[0].endIndex], [0, 2]);
});

test('southward IMF event is detected with severity from the Bz minimum', () => {
  const bz = [-2, -6, -12, -8, -1];
  const samples = bz.map((value, i) => l1(i, { bzGsmNt: value, speedKmS: 450, densityCm3: 6, btNt: 12 }));
  const { events } = detectPhysicalDriverEvents(samples);
  const southward = events.find(e => e.eventType === 'southward_imf');
  assert.ok(southward, 'expected a southward_imf event');
  assert.equal(southward?.severity, 'strong'); // min Bz = -12 <= -10
  assert.ok((southward?.integratedSouthwardBz ?? 0) > 0);
  assert.equal(southward?.peakValues.minBzGsmNt, -12);
});

test('high coupling event reaches severe when Em >= 12 mV/m', () => {
  // Em = V * max(0,-Bz) * 1e-3 = 600 * 25 * 1e-3 = 15 mV/m
  const samples = [0, 1, 2].map(i => l1(i, { speedKmS: 600, bzGsmNt: -25, densityCm3: 8, btNt: 28 }));
  const { events } = detectPhysicalDriverEvents(samples);
  const coupling = events.find(e => e.eventType === 'high_coupling');
  assert.ok(coupling, 'expected a high_coupling event');
  assert.equal(coupling?.severity, 'severe');
});

test('compound geoeffective event needs Bz<=-10, Vsw>=500 for >=10 min', () => {
  const longEnough = Array.from({ length: 12 }, (_, i) => l1(i, { bzGsmNt: -14, speedKmS: 560, densityCm3: 6, btNt: 18 }));
  const tooShort = Array.from({ length: 4 }, (_, i) => l1(i, { bzGsmNt: -14, speedKmS: 560, densityCm3: 6, btNt: 18 }));
  assert.ok(detectPhysicalDriverEvents(longEnough).events.some(e => e.eventType === 'compound_geoeffective'));
  assert.ok(!detectPhysicalDriverEvents(tooShort).events.some(e => e.eventType === 'compound_geoeffective'));
});

test('response window applies a ballistic L1->Earth delay', () => {
  const samples = [0, 1, 2].map(i => l1(i, { speedKmS: 500, bzGsmNt: -12, densityCm3: 6, btNt: 14 }));
  const { events } = detectPhysicalDriverEvents(samples, { l1DistanceKm: 1_500_000, distanceBasis: 'nominal' });
  const event = events.find(e => e.eventType === 'southward_imf');
  // 1.5e6 km / 500 km/s = 3000 s = 50 min
  assert.ok(event);
  assert.ok(Math.abs((event?.estimatedResponseWindow.ballisticDelayMinutes ?? 0) - 50) < 1e-6);
});
