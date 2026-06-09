/**
 * Physical-driver event detection for the New Version Claude MVP (no OMNI).
 *
 * These are HAZARDOUS PHYSICAL-DRIVER INTERVALS detected in the L1 solar wind / IMF — not
 * satellite anomalies and not predictions of named storms. Each interval is later checked
 * for a real terrestrial response (GEO + ground) in the validation layer.
 */

import { NOMINAL_L1_DISTANCE_KM } from '../dataSources/types';
import type { L1Sample } from '../dataSources/types';
import { buildFeaturedSamples, detectCadenceMs, type FeaturedL1Sample } from './derivedFeatures';

const MINUTE_MS = 60_000;

export type EventSeverity = 'minor' | 'moderate' | 'strong' | 'severe';

export type PhysicalDriverEventType =
  | 'high_speed_stream'
  | 'southward_imf'
  | 'high_bt'
  | 'high_density'
  | 'high_dynamic_pressure'
  | 'high_coupling'
  | 'compound_geoeffective'
  | 'compression';

export interface SeverityTiers {
  moderate: number;
  strong?: number;
  severe?: number;
}

/** Thresholds for the single-variable detectors. Direction is implied per event type. */
export const EVENT_THRESHOLDS: Record<
  'high_speed_stream' | 'southward_imf' | 'high_bt' | 'high_density' | 'high_dynamic_pressure' | 'high_coupling',
  SeverityTiers
> = {
  high_speed_stream: { moderate: 550, strong: 700 }, // km/s, >=
  southward_imf: { moderate: -5, strong: -10, severe: -20 }, // nT, <=
  high_bt: { moderate: 10, strong: 20 }, // nT, >=
  high_density: { moderate: 10, strong: 30 }, // cm^-3, >=
  high_dynamic_pressure: { moderate: 5, strong: 10 }, // nPa, >=
  high_coupling: { moderate: 5, strong: 8, severe: 12 }, // mV/m, >=
};

export const COMPOUND_GEOEFFECTIVE = { bzMaxNt: -10, vswMinKmS: 500, minDurationMinutes: 10 } as const;
export const COMPRESSION = { pdynMinNpa: 5, densityMinCm3: 10 } as const;

function severityGe(value: number, tiers: SeverityTiers): EventSeverity {
  if (tiers.severe !== undefined && value >= tiers.severe) return 'severe';
  if (tiers.strong !== undefined && value >= tiers.strong) return 'strong';
  if (value >= tiers.moderate) return 'moderate';
  return 'minor';
}

function severityLe(value: number, tiers: SeverityTiers): EventSeverity {
  if (tiers.severe !== undefined && value <= tiers.severe) return 'severe';
  if (tiers.strong !== undefined && value <= tiers.strong) return 'strong';
  if (value <= tiers.moderate) return 'moderate';
  return 'minor';
}

// --- Interval detection ----------------------------------------------------------------

/** 'break': a null (unevaluable/missing) sample ends a run. 'merge': null samples are
 * transparent and do not count against the merge-gap budget. */
export type MissingDataMode = 'break' | 'merge';

export interface DetectIntervalsOptions {
  /** Minimum interval duration in minutes (sample coverage, not just span). */
  minDurationMinutes?: number;
  /** Merge two matched runs separated by at most this many non-matching samples. */
  mergeGapSamples?: number;
  /** Override the detected cadence (ms) used for duration accounting. */
  cadenceMs?: number | null;
  missingData?: MissingDataMode;
}

export interface DetectedInterval {
  startIndex: number;
  endIndex: number;
  startMs: number;
  endMs: number;
  sampleCount: number;
  durationMinutes: number;
}

/**
 * Detect maximal intervals where `predicate` holds. The predicate returns true/false, or
 * null when it cannot be evaluated (missing data) — see `missingData`. Short gaps can be
 * bridged via `mergeGapSamples`, and short intervals dropped via `minDurationMinutes`.
 */
export function detectIntervals(
  samples: FeaturedL1Sample[],
  predicate: (sample: FeaturedL1Sample) => boolean | null,
  options: DetectIntervalsOptions = {},
): DetectedInterval[] {
  const n = samples.length;
  if (n === 0) return [];

  const cadenceMs = options.cadenceMs ?? detectCadenceMs(samples.map(s => s.timeMs)) ?? MINUTE_MS;
  const mergeGap = Math.max(0, options.mergeGapSamples ?? 0);
  const minDurationMinutes = options.minDurationMinutes ?? 0;
  const missingMode: MissingDataMode = options.missingData ?? 'break';

  const verdicts = samples.map(predicate);

  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < n; i += 1) {
    if (verdicts[i] === true) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, n - 1]);

  const merged: Array<[number, number]> = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last) {
      let gapCost = 0;
      for (let k = last[1] + 1; k < run[0]; k += 1) {
        const transparent = missingMode === 'merge' && verdicts[k] === null;
        if (!transparent) gapCost += 1;
      }
      if (gapCost <= mergeGap) {
        last[1] = run[1];
        continue;
      }
    }
    merged.push([run[0], run[1]]);
  }

  return merged
    .map(([a, b]): DetectedInterval => {
      const startMs = samples[a].timeMs;
      const endMs = samples[b].timeMs;
      return {
        startIndex: a,
        endIndex: b,
        startMs,
        endMs,
        sampleCount: b - a + 1,
        durationMinutes: (endMs - startMs + cadenceMs) / MINUTE_MS,
      };
    })
    .filter(interval => interval.durationMinutes >= minDurationMinutes);
}

// --- Event assembly --------------------------------------------------------------------

export interface ResponseWindowEstimate {
  basis: 'ephemeris' | 'nominal';
  l1DistanceKm: number;
  meanSpeedKmS: number | null;
  ballisticDelayMinutes: number | null;
  arrivalStartUtc: string | null;
  arrivalEndUtc: string | null;
  qualityFlags: string[];
}

export interface PhysicalDriverEventPeaks {
  maxSpeedKmS: number | null;
  minBzGsmNt: number | null;
  maxBtNt: number | null;
  maxDensityCm3: number | null;
  maxPdynNpa: number | null;
  maxEmMvM: number | null;
}

export interface PhysicalDriverEvent {
  eventId: string;
  eventType: PhysicalDriverEventType;
  severity: EventSeverity;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  triggerThreshold: number;
  peakValues: PhysicalDriverEventPeaks;
  /** Integrated southward Bz (nT*min) over the interval — geoeffective "dose". */
  integratedSouthwardBz: number | null;
  /** Integrated merging electric field ((mV/m)*min) over the interval. */
  integratedEm: number | null;
  /** Count of L1 samples that make up the interval. */
  sourceSamples: number;
  estimatedResponseWindow: ResponseWindowEstimate;
}

function finiteMean(values: Array<number | null>): number | null {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (v !== null && Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

function finiteExtreme(values: Array<number | null>, dir: 'min' | 'max'): number | null {
  let acc: number | null = null;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    acc = acc === null ? v : dir === 'min' ? Math.min(acc, v) : Math.max(acc, v);
  }
  return acc;
}

function computePeaks(slice: FeaturedL1Sample[]): PhysicalDriverEventPeaks {
  return {
    maxSpeedKmS: finiteExtreme(slice.map(s => s.speedKmS), 'max'),
    minBzGsmNt: finiteExtreme(slice.map(s => s.bzGsmNt), 'min'),
    maxBtNt: finiteExtreme(slice.map(s => s.btNt), 'max'),
    maxDensityCm3: finiteExtreme(slice.map(s => s.densityCm3), 'max'),
    maxPdynNpa: finiteExtreme(slice.map(s => s.pdynNpa), 'max'),
    maxEmMvM: finiteExtreme(slice.map(s => s.emMvM), 'max'),
  };
}

/** Rectangular time-integral of a per-sample quantity over the interval, in unit*minutes. */
function integrate(
  slice: FeaturedL1Sample[],
  accessor: (sample: FeaturedL1Sample) => number | null,
  cadenceMs: number,
): number | null {
  let acc = 0;
  let any = false;
  for (let i = 0; i < slice.length; i += 1) {
    const value = accessor(slice[i]);
    if (value === null || !Number.isFinite(value)) continue;
    const widthMs = i < slice.length - 1 ? slice[i + 1].timeMs - slice[i].timeMs : cadenceMs;
    acc += value * (widthMs / MINUTE_MS);
    any = true;
  }
  return any ? acc : null;
}

function estimateResponseWindow(
  slice: FeaturedL1Sample[],
  startMs: number,
  endMs: number,
  l1DistanceKm: number,
  basis: 'ephemeris' | 'nominal',
): ResponseWindowEstimate {
  const meanSpeedKmS = finiteMean(slice.map(s => s.speedKmS));
  const qualityFlags: string[] = [];
  if (basis === 'nominal') qualityFlags.push('nominal_l1_distance');
  if (meanSpeedKmS === null) {
    qualityFlags.push('missing_speed_for_propagation');
    return {
      basis,
      l1DistanceKm,
      meanSpeedKmS: null,
      ballisticDelayMinutes: null,
      arrivalStartUtc: null,
      arrivalEndUtc: null,
      qualityFlags,
    };
  }
  const ballisticDelayMinutes = l1DistanceKm / meanSpeedKmS / 60; // (km / (km/s)) -> s -> min
  const delayMs = ballisticDelayMinutes * MINUTE_MS;
  return {
    basis,
    l1DistanceKm,
    meanSpeedKmS,
    ballisticDelayMinutes,
    arrivalStartUtc: new Date(startMs + delayMs).toISOString(),
    arrivalEndUtc: new Date(endMs + delayMs).toISOString(),
    qualityFlags,
  };
}

export interface DetectPhysicalDriverEventsOptions {
  l1DistanceKm?: number;
  distanceBasis?: 'ephemeris' | 'nominal';
  /** Global detection knobs; sensible defaults are applied per event type. */
  minDurationMinutes?: number;
  mergeGapSamples?: number;
  missingData?: MissingDataMode;
}

export interface PhysicalDriverEventResult {
  events: PhysicalDriverEvent[];
  featuredSamples: FeaturedL1Sample[];
  cadenceMs: number | null;
  l1DistanceKm: number;
  distanceBasis: 'ephemeris' | 'nominal';
}

interface DetectorSpec {
  eventType: PhysicalDriverEventType;
  predicate: (sample: FeaturedL1Sample) => boolean | null;
  severity: (slice: FeaturedL1Sample[]) => EventSeverity;
  triggerThreshold: number;
  minDurationMinutes?: number;
}

function buildEvents(
  spec: DetectorSpec,
  featured: FeaturedL1Sample[],
  cadenceMs: number,
  detectOptions: DetectIntervalsOptions,
  l1DistanceKm: number,
  basis: 'ephemeris' | 'nominal',
): PhysicalDriverEvent[] {
  const intervals = detectIntervals(featured, spec.predicate, {
    ...detectOptions,
    minDurationMinutes: spec.minDurationMinutes ?? detectOptions.minDurationMinutes,
  });

  return intervals.map(interval => {
    const slice = featured.slice(interval.startIndex, interval.endIndex + 1);
    return {
      eventId: `${spec.eventType}-${new Date(interval.startMs).toISOString()}`,
      eventType: spec.eventType,
      severity: spec.severity(slice),
      startUtc: new Date(interval.startMs).toISOString(),
      endUtc: new Date(interval.endMs).toISOString(),
      durationMinutes: interval.durationMinutes,
      triggerThreshold: spec.triggerThreshold,
      peakValues: computePeaks(slice),
      integratedSouthwardBz: integrate(slice, s => (s.bzGsmNt === null ? null : Math.max(0, -s.bzGsmNt)), cadenceMs),
      integratedEm: integrate(slice, s => s.emMvM, cadenceMs),
      sourceSamples: interval.sampleCount,
      estimatedResponseWindow: estimateResponseWindow(slice, interval.startMs, interval.endMs, l1DistanceKm, basis),
    };
  });
}

/** Run all physical-driver detectors over a list of L1 samples. */
export function detectPhysicalDriverEvents(
  samples: L1Sample[],
  options: DetectPhysicalDriverEventsOptions = {},
): PhysicalDriverEventResult {
  const featured = buildFeaturedSamples(samples);
  const cadenceMs = detectCadenceMs(featured.map(s => s.timeMs));
  const effectiveCadenceMs = cadenceMs ?? MINUTE_MS;
  const l1DistanceKm = options.l1DistanceKm ?? NOMINAL_L1_DISTANCE_KM;
  const basis: 'ephemeris' | 'nominal' = options.distanceBasis ?? (options.l1DistanceKm ? 'ephemeris' : 'nominal');

  const detectOptions: DetectIntervalsOptions = {
    cadenceMs: effectiveCadenceMs,
    mergeGapSamples: options.mergeGapSamples ?? 2,
    minDurationMinutes: options.minDurationMinutes ?? 0,
    missingData: options.missingData ?? 'break',
  };

  const specs: DetectorSpec[] = [
    {
      eventType: 'high_speed_stream',
      predicate: s => (s.speedKmS === null ? null : s.speedKmS >= EVENT_THRESHOLDS.high_speed_stream.moderate),
      severity: slice => severityGe(finiteExtreme(slice.map(s => s.speedKmS), 'max') ?? 0, EVENT_THRESHOLDS.high_speed_stream),
      triggerThreshold: EVENT_THRESHOLDS.high_speed_stream.moderate,
    },
    {
      eventType: 'southward_imf',
      predicate: s => (s.bzGsmNt === null ? null : s.bzGsmNt <= EVENT_THRESHOLDS.southward_imf.moderate),
      severity: slice => severityLe(finiteExtreme(slice.map(s => s.bzGsmNt), 'min') ?? 0, EVENT_THRESHOLDS.southward_imf),
      triggerThreshold: EVENT_THRESHOLDS.southward_imf.moderate,
    },
    {
      eventType: 'high_bt',
      predicate: s => (s.btNt === null ? null : s.btNt >= EVENT_THRESHOLDS.high_bt.moderate),
      severity: slice => severityGe(finiteExtreme(slice.map(s => s.btNt), 'max') ?? 0, EVENT_THRESHOLDS.high_bt),
      triggerThreshold: EVENT_THRESHOLDS.high_bt.moderate,
    },
    {
      eventType: 'high_density',
      predicate: s => (s.densityCm3 === null ? null : s.densityCm3 >= EVENT_THRESHOLDS.high_density.moderate),
      severity: slice => severityGe(finiteExtreme(slice.map(s => s.densityCm3), 'max') ?? 0, EVENT_THRESHOLDS.high_density),
      triggerThreshold: EVENT_THRESHOLDS.high_density.moderate,
    },
    {
      eventType: 'high_dynamic_pressure',
      predicate: s => (s.pdynNpa === null ? null : s.pdynNpa >= EVENT_THRESHOLDS.high_dynamic_pressure.moderate),
      severity: slice => severityGe(finiteExtreme(slice.map(s => s.pdynNpa), 'max') ?? 0, EVENT_THRESHOLDS.high_dynamic_pressure),
      triggerThreshold: EVENT_THRESHOLDS.high_dynamic_pressure.moderate,
    },
    {
      eventType: 'high_coupling',
      predicate: s => (s.emMvM === null ? null : s.emMvM >= EVENT_THRESHOLDS.high_coupling.moderate),
      severity: slice => severityGe(finiteExtreme(slice.map(s => s.emMvM), 'max') ?? 0, EVENT_THRESHOLDS.high_coupling),
      triggerThreshold: EVENT_THRESHOLDS.high_coupling.moderate,
    },
    {
      eventType: 'compound_geoeffective',
      predicate: s => {
        if (s.bzGsmNt === null || s.speedKmS === null) return null;
        return s.bzGsmNt <= COMPOUND_GEOEFFECTIVE.bzMaxNt && s.speedKmS >= COMPOUND_GEOEFFECTIVE.vswMinKmS;
      },
      severity: slice => severityLe(finiteExtreme(slice.map(s => s.bzGsmNt), 'min') ?? 0, { moderate: -10, strong: -15, severe: -20 }),
      triggerThreshold: COMPOUND_GEOEFFECTIVE.bzMaxNt,
      minDurationMinutes: COMPOUND_GEOEFFECTIVE.minDurationMinutes,
    },
    {
      eventType: 'compression',
      predicate: s => {
        const pressureHit =
          (s.pdynNpa !== null && s.pdynNpa >= COMPRESSION.pdynMinNpa) ||
          (s.densityCm3 !== null && s.densityCm3 >= COMPRESSION.densityMinCm3);
        if (s.pdynNpa === null && s.densityCm3 === null) return null;
        const increasingSpeed = s.gradients.dSpeedDtPerMin !== null && s.gradients.dSpeedDtPerMin > 0;
        return pressureHit && increasingSpeed;
      },
      severity: slice => severityGe(finiteExtreme(slice.map(s => s.pdynNpa), 'max') ?? 0, { moderate: 5, strong: 10 }),
      triggerThreshold: COMPRESSION.pdynMinNpa,
    },
  ];

  const events = specs
    .flatMap(spec => buildEvents(spec, featured, effectiveCadenceMs, detectOptions, l1DistanceKm, basis))
    .sort((a, b) => new Date(a.startUtc).getTime() - new Date(b.startUtc).getTime());

  return { events, featuredSamples: featured, cadenceMs, l1DistanceKm, distanceBasis: basis };
}
