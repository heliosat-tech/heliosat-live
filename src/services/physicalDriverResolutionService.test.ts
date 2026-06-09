import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePhysicalDriverSample, type PhysicalDriverCandidate } from './physicalDriverResolutionService';

const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;

function candidate(offsetMin: number, values: Partial<PhysicalDriverCandidate>): PhysicalDriverCandidate {
  return {
    timeMs: t0 + offsetMin * MIN,
    observedMs: t0 + offsetMin * MIN,
    sourceId: 'swpc_rtsw',
    sourceLabel: 'L1 · active RTSW',
    priority: 1,
    speedKmS: null,
    bzGsmNt: null,
    btNt: null,
    densityCm3: null,
    ...values,
  };
}

test('per-variable fallback keeps valid values when another source has nulls', () => {
  const resolved = resolvePhysicalDriverSample(t0, [
    candidate(0, { sourceId: 'swpc_rtsw', priority: 1, speedKmS: null, bzGsmNt: -8 }),
    candidate(0, { sourceId: 'ace', sourceLabel: 'ACE L1 fallback', priority: 2, speedKmS: 520, bzGsmNt: null }),
  ], { toleranceMs: 2 * MIN });
  assert.equal(resolved.speedKmS, 520);
  assert.equal(resolved.bzGsmNt, -8);
  assert.equal(resolved.sourceByVariable.speed, 'ace');
  assert.equal(resolved.sourceByVariable.bz, 'swpc_rtsw');
});

test('mixed source samples carry a quality flag', () => {
  const resolved = resolvePhysicalDriverSample(t0, [
    candidate(0, { sourceId: 'swpc_rtsw', priority: 1, speedKmS: 500 }),
    candidate(0, { sourceId: 'ace', sourceLabel: 'ACE L1 fallback', priority: 2, bzGsmNt: -6 }),
  ], { toleranceMs: 2 * MIN });
  assert.ok(resolved.qualityFlags.includes('mixed_sources'));
});

test('Bz can be available while density is missing', () => {
  const resolved = resolvePhysicalDriverSample(t0, [
    candidate(0, { speedKmS: 500, bzGsmNt: -4, btNt: 8, densityCm3: null }),
  ], { toleranceMs: 2 * MIN });
  assert.equal(resolved.bzGsmNt, -4);
  assert.equal(resolved.densityCm3, null);
  assert.deepEqual(resolved.missingVariables, ['density']);
});

test('G-risk is unavailable when Bz is missing', () => {
  const resolved = resolvePhysicalDriverSample(t0, [
    candidate(0, { speedKmS: 650, bzGsmNt: null }),
  ], { toleranceMs: 2 * MIN });
  assert.equal(resolved.riskAvailable, false);
  assert.equal(resolved.derived.estimatedGLevel, null);
  assert.ok(resolved.qualityFlags.includes('g_risk_unavailable'));
});

test('nearest-neighbor alignment uses values within tolerance', () => {
  const resolved = resolvePhysicalDriverSample(t0, [
    candidate(1, { bzGsmNt: -7 }),
    candidate(2, { speedKmS: 530 }),
  ], { toleranceMs: 2 * MIN });
  assert.equal(resolved.speedKmS, 530);
  assert.equal(resolved.bzGsmNt, -7);
  assert.ok(resolved.qualityFlags.includes('time_aligned_fallback'));
});

test('values outside tolerance are not used', () => {
  const resolved = resolvePhysicalDriverSample(t0, [
    candidate(3, { speedKmS: 530, bzGsmNt: -7 }),
  ], { toleranceMs: 2 * MIN });
  assert.equal(resolved.speedKmS, null);
  assert.equal(resolved.bzGsmNt, null);
  assert.equal(resolved.riskAvailable, false);
});

test('grey segment semantics: missing variable is not quiet G0', () => {
  const resolved = resolvePhysicalDriverSample(t0, [], { toleranceMs: 2 * MIN });
  assert.deepEqual(resolved.missingVariables, ['speed', 'bz', 'bt', 'density']);
  assert.equal(resolved.derived.estimatedGLevel, null);
  assert.ok(resolved.qualityFlags.includes('missing_bz'));
});
