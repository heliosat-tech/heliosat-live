import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPhysicalDriverEvents } from '../dataProcessing/eventDetection';
import type { GoesSample, GroundIndexSample, L1Sample } from '../dataSources/types';
import { gLevelFromKp, validateEvent, validatePhysicalDriverEvents } from './eventValidation';
import { computeResponseWindows } from './responseWindows';

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

function goes(ms: number, partial: Partial<GoesSample>): GoesSample {
  return {
    timeUtc: new Date(ms).toISOString(),
    source: 'goes',
    satellite: 'GOES-18',
    protonFlux: null,
    electronFlux: null,
    xrayFlux: null,
    hpNt: null,
    hTotalNt: null,
    qualityFlags: [],
    sourceAttribution: [],
    ...partial,
  };
}

function ground(ms: number, partial: Partial<GroundIndexSample>): GroundIndexSample {
  return {
    timeUtc: new Date(ms).toISOString(),
    kp: null,
    dstNt: null,
    symhNt: null,
    qualityFlags: [],
    sourceAttribution: [],
    ...partial,
  };
}

// A 15-minute strong southward + fast-wind interval -> southward_imf (severe) etc.
const driverSamples = Array.from({ length: 15 }, (_, i) =>
  l1(i, { speedKmS: 600, bzGsmNt: -25, densityCm3: 5, btNt: 28 }),
);

test('response windows have the documented durations', () => {
  const { events } = detectPhysicalDriverEvents(driverSamples);
  const southward = events.find(e => e.eventType === 'southward_imf');
  assert.ok(southward);
  const windows = computeResponseWindows(southward!);
  const arrival = Date.parse(windows.arrivalUtc);
  assert.equal(Date.parse(windows.geoMagnetic.endUtc) - arrival, 3 * 3_600_000);
  assert.equal(Date.parse(windows.particle.endUtc) - arrival, 24 * 3_600_000);
  assert.equal(Date.parse(windows.groundLong.endUtc) - arrival, 12 * 3_600_000);
});

test('a real GEO + ground response is detected as consistent', () => {
  const { events } = detectPhysicalDriverEvents(driverSamples);
  const southward = events.find(e => e.eventType === 'southward_imf')!;
  const arrival = Date.parse(computeResponseWindows(southward).arrivalUtc);

  const goesSamples = [
    goes(arrival - 60 * MIN, { hpNt: 100 }), // quiet baseline
    goes(arrival - 30 * MIN, { hpNt: 100 }),
    goes(arrival + 20 * MIN, { hpNt: 160, protonFlux: 50 }), // +60 nT disturbance
  ];
  const groundSamples = [ground(arrival + 90 * MIN, { kp: 7, dstNt: -80 })];

  const record = validateEvent(southward, goesSamples, groundSamples);
  assert.equal(record.geo.baselineHpNt, 100);
  assert.ok((record.geo.maxHpDisturbanceNt ?? 0) >= 20);
  assert.equal(record.geoDisturbanceObserved, true);
  assert.equal(record.ground.maxKp6h, 7);
  assert.equal(record.groundResponseObserved, true);
  assert.equal(record.responseConsistent, true);
});

test('a quiet aftermath is not a false consistency', () => {
  const { events } = detectPhysicalDriverEvents(driverSamples);
  const southward = events.find(e => e.eventType === 'southward_imf')!;
  const arrival = Date.parse(computeResponseWindows(southward).arrivalUtc);
  const record = validateEvent(southward, [goes(arrival - 30 * MIN, { hpNt: 100 }), goes(arrival + 10 * MIN, { hpNt: 102 })], [ground(arrival + 60 * MIN, { kp: 2, dstNt: -8 })]);
  assert.equal(record.responseConsistent, false);
});

test('summary computes precision/recall and the headline fractions', () => {
  const { events } = detectPhysicalDriverEvents(driverSamples);
  const southward = events.find(e => e.eventType === 'southward_imf')!;
  const arrival = Date.parse(computeResponseWindows(southward).arrivalUtc);
  const goesSamples = [goes(arrival - 30 * MIN, { hpNt: 100 }), goes(arrival + 20 * MIN, { hpNt: 160 })];
  const groundSamples = [ground(arrival + 90 * MIN, { kp: 7, dstNt: -80 })];

  const { summary } = validatePhysicalDriverEvents(events, goesSamples, groundSamples);
  assert.ok(summary.predictionCount >= 1);
  assert.equal(summary.precision, 1); // every geoeffective prediction had a response
  assert.equal(summary.recall, 1); // the Kp>=5 onset was caught
  assert.equal(summary.missedResponseEvents, 0);
  assert.equal(summary.severeBzFollowedByKp6.fraction, 1);
});

test('G-level proxy follows the NOAA Kp thresholds', () => {
  assert.equal(gLevelFromKp(null).level, 0);
  assert.equal(gLevelFromKp(4).level, 0);
  assert.equal(gLevelFromKp(5).level, 1);
  assert.equal(gLevelFromKp(7).level, 3);
  assert.equal(gLevelFromKp(9).level, 5);
});
