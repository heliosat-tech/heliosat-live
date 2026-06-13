/**
 * Shared helpers that turn per-variable candidates from any L1 pipeline into the
 * internal resolved-sample schema. Keeping this in one place means the SWPC and
 * IMAP connectors normalize identically (same alignment tolerance, same derived
 * quantities, same provenance), so a downstream sample is source-agnostic.
 */

import {
  resolvePhysicalDriverSample,
  type PhysicalDriverCandidate,
} from '../physicalDriverResolutionService';
import type { ResolvedL1EventSample } from './types';

export const NOMINAL_L1_DISTANCE_KM = 1_500_000;
const MIN_RELIABLE_KM = 500_000;
const MAX_RELIABLE_KM = 2_500_000;
/** Mag and plasma rows within this offset of a target minute resolve together. */
const LIVE_ALIGNMENT_TOLERANCE_MS = 2 * 60 * 1000;

/** Tolerate both ISO ("…Z") and NOAA-style ("2025-05-30 20:48:00") stamps. */
export function parseMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

export function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Round a timestamp to the minute so mag and plasma rows align. */
export function minuteKey(ms: number): number {
  return Math.round(ms / 60000) * 60000;
}

/**
 * A measured L1 distance from a GSE position (km), or null when the components
 * are missing or the magnitude is implausible (keeps a bad ephemeris from
 * poisoning the propagation distance).
 */
export function reliableDistanceKm(x: number | null, y: number | null, z: number | null): number | null {
  if (x === null || y === null || z === null) return null;
  const distance = Math.sqrt(x * x + y * y + z * z);
  return distance >= MIN_RELIABLE_KM && distance <= MAX_RELIABLE_KM ? distance : null;
}

/**
 * Resolve a candidate pool into ascending 1-minute samples. Drops samples with
 * no physical variable at all (a bare timestamp carries no information).
 */
export function resolveSamples(candidates: PhysicalDriverCandidate[]): ResolvedL1EventSample[] {
  const targetTimes = [...new Set(candidates.map(candidate => candidate.timeMs))]
    .filter(ms => Number.isFinite(ms))
    .sort((a, b) => a - b);

  return targetTimes
    .map((ms): ResolvedL1EventSample => {
      const resolved = resolvePhysicalDriverSample(ms, candidates, { toleranceMs: LIVE_ALIGNMENT_TOLERANCE_MS });
      return {
        ms,
        speedKmS: resolved.speedKmS,
        densityPerCm3: resolved.densityCm3,
        bzNt: resolved.bzGsmNt,
        btNt: resolved.btNt,
        byNt: null, // attached by the connector from its own By stream (not resolver-tracked)
        sourceByVariable: resolved.sourceByVariable,
        sourceLabelByVariable: resolved.sourceLabelByVariable,
        sourceTimeByVariable: resolved.sourceTimeByVariable,
        missingVariables: resolved.missingVariables,
        qualityFlags: resolved.qualityFlags,
        riskAvailable: resolved.riskAvailable,
        pdynNpa: resolved.derived.pdynNpa,
        emMvM: resolved.derived.emMvM,
        estimatedGLevel: resolved.derived.estimatedGLevel,
      };
    })
    .filter(sample => sample.speedKmS !== null || sample.bzNt !== null || sample.btNt !== null || sample.densityPerCm3 !== null);
}

export function latestSampleMs(samples: ResolvedL1EventSample[]): number | null {
  return samples.length ? samples[samples.length - 1].ms : null;
}
