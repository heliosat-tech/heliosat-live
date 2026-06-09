import assert from 'node:assert/strict';
import test from 'node:test';
import type { L1Sample } from '../dataSources/types';
import {
  buildFeaturedSamples,
  detectCadenceMs,
  dynamicPressureNpa,
  mergingElectricFieldMvM,
  PDYN_COEFFICIENT,
} from './derivedFeatures';

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

test('dynamic pressure follows Pdyn = 1.6726e-6 * n * V^2', () => {
  const pdyn = dynamicPressureNpa(5, 400);
  assert.ok(pdyn !== null);
  assert.ok(Math.abs((pdyn as number) - PDYN_COEFFICIENT * 5 * 400 * 400) < 1e-9);
  assert.equal(dynamicPressureNpa(null, 400), null);
  assert.equal(dynamicPressureNpa(5, null), null);
});

test('merging electric field uses southward Bz only', () => {
  assert.equal(mergingElectricFieldMvM(500, -10), 500 * 10 * 1e-3); // 5 mV/m
  assert.equal(mergingElectricFieldMvM(500, 10), 0); // northward IMF is not geoeffective
  assert.equal(mergingElectricFieldMvM(null, -10), null);
});

test('rolling min Bz looks back over the window', () => {
  const samples = [-1, -5, -3, -8, -2].map((bz, i) => l1(i, { bzGsmNt: bz, speedKmS: 400, densityCm3: 5 }));
  const featured = buildFeaturedSamples(samples);
  assert.equal(featured[1].rolling.minBz15, -5);
  assert.equal(featured[3].rolling.minBz15, -8);
  assert.equal(featured[4].rolling.minBz60, -8);
});

test('gradients are a per-minute backward difference', () => {
  const samples = [l1(0, { speedKmS: 400 }), l1(1, { speedKmS: 420 }), l1(3, { speedKmS: 420 })];
  const featured = buildFeaturedSamples(samples);
  assert.equal(featured[0].gradients.dSpeedDtPerMin, null);
  assert.equal(featured[1].gradients.dSpeedDtPerMin, 20); // (420-400)/1 min
  assert.equal(featured[2].gradients.dSpeedDtPerMin, 0); // (420-420)/2 min
});

test('cadence detection returns the median spacing', () => {
  assert.equal(detectCadenceMs([t0, t0 + MIN, t0 + 2 * MIN, t0 + 3 * MIN]), MIN);
  assert.equal(detectCadenceMs([t0]), null);
});
