import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyBzRiskRank,
  computeCouplingElectricFieldMvM,
  computeDerivedFeatures,
  computeDynamicPressureNpa,
  computePhysicalDriverEventStats,
  detectIntervals,
  type PhysicalDriverInputSample,
  type PhysicalDriverDerivedSample,
} from './physicalDriverEventStatsService';

const start = Date.UTC(2026, 0, 1, 0, 0, 0);

function point(minute: number, values: Partial<PhysicalDriverInputSample>): PhysicalDriverInputSample {
  return {
    t: start + minute * 60_000,
    level: 0,
    riskAvailable: true,
    detectedMs: start + minute * 60_000 - 45 * 60_000,
    leadTimeMinutes: 45,
    speedKmS: null,
    bzNt: null,
    btNt: null,
    densityPerCm3: null,
    ...values,
  };
}

function derived(points: PhysicalDriverInputSample[]): PhysicalDriverDerivedSample[] {
  return computeDerivedFeatures(points);
}

test('dynamic pressure uses proton density and speed in nPa', () => {
  assert.equal(round3(computeDynamicPressureNpa(400, 5)), 1.338);
});

test('coupling electric field uses southward Bz only', () => {
  assert.equal(computeCouplingElectricFieldMvM(500, -10), 5);
  assert.equal(computeCouplingElectricFieldMvM(500, 8), 0);
});

test('interval detection filters events shorter than the minimum duration', () => {
  const shortRun = derived(Array.from({ length: 5 }, (_, i) => point(i, { speedKmS: 600 })));
  const longRun = derived(Array.from({ length: 10 }, (_, i) => point(i, { speedKmS: 600 })));
  assert.equal(detectIntervals(shortRun, s => (s.speedKmS ?? 0) >= 550, { minDurationMinutes: 10 }).length, 0);
  assert.equal(detectIntervals(longRun, s => (s.speedKmS ?? 0) >= 550, { minDurationMinutes: 10 }).length, 1);
});

test('interval detection merges short gaps by sample tolerance', () => {
  const samples = derived([
    point(0, { speedKmS: 600 }),
    point(1, { speedKmS: 610 }),
    point(2, { speedKmS: 300 }),
    point(3, { speedKmS: 620 }),
    point(4, { speedKmS: 630 }),
  ]);
  const intervals = detectIntervals(samples, s => (s.speedKmS ?? 0) >= 550, { gapToleranceSamples: 1 });
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].durationMinutes, 5);
});

test('negative Bz is ranked as more hazardous than positive Bz', () => {
  assert.ok(classifyBzRiskRank(-10) > classifyBzRiskRank(5));
  assert.ok(classifyBzRiskRank(-21) > classifyBzRiskRank(-6));
});

test('compound geoeffective and high-coupling intervals are detected', () => {
  const points = Array.from({ length: 12 }, (_, i) => point(i, {
    speedKmS: 550,
    bzNt: -10,
    btNt: 16,
    densityPerCm3: 8,
  }));
  const stats = computePhysicalDriverEventStats(points, {
    window: '24h',
    startMs: points[0].t,
    endMs: points[points.length - 1].t,
    generatedAtMs: start,
  });
  const geoeffective = stats.stats.compound.find(row => row.id === 'compound_geoeffective_southward');
  const coupling = stats.stats.compound.find(row => row.id === 'compound_high_coupling');
  assert.equal(geoeffective?.count, 1);
  assert.equal(coupling?.count, 1);
});

function round3(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}
