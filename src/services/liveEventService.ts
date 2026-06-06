/**
 * Live event detection, multi-model arrival prediction, and retrospective
 * verification for the L1 -> Earth forecast.
 *
 * As the L1 solar-wind stream advances, this module flags discrete disturbances
 * (interplanetary shocks / fast-stream interfaces and southward-Bz episodes),
 * predicts WHEN each reaches Earth and HOW intense it will be (NOAA G scale) under
 * each model, and — once the predicted arrival window has passed — checks the
 * forecast against the real planetary Kp measured at Earth (ground magnetometers).
 *
 * Pure (no I/O, no framework): detection runs identically on server and client and
 * is deterministic given the same samples, so it is unit-testable.
 */

import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from './stormScaleService';

export interface L1EventSample {
  ms: number;
  speedKmS: number | null;
  densityPerCm3: number | null;
  bzNt: number | null;
  btNt: number | null;
}

export type ModelId = 'MRU' | 'ML';

export interface ModelArrivalPrediction {
  model: ModelId;
  arrivalUtc: string;
  lagMinutes: number;
  /** Speed used to time the arrival (leading-edge speed for that model). */
  arrivalSpeedKmS: number | null;
  /** Most geoeffective conditions of the structure under this model. */
  peakSpeedKmS: number | null;
  peakBzNt: number | null;
  estimatedKp: number;
  gLevel: number;
  gCode: string;
}

export interface EventVerification {
  status: 'pending' | 'verified' | 'unverifiable';
  observedMaxKp: number | null;
  observedGLevel: number | null;
  observedGCode: string | null;
  windowStartUtc: string | null;
  windowEndUtc: string | null;
  checkedAtUtc: string | null;
  verdicts: Array<{ model: ModelId; predictedGLevel: number; hit: boolean | null }>;
}

export type EventType = 'shock' | 'southward_bz' | 'shock_southward';

export interface LiveEvent {
  id: string;
  type: EventType;
  detectedAtL1Utc: string;
  endAtL1Utc: string;
  loggedAtUtc: string;
  driver: {
    label: string;
    peakSpeedKmS: number | null;
    deltaSpeedKmS: number | null;
    minBzNt: number | null;
    peakBtNt: number | null;
  };
  l1DistanceKm: number;
  predictions: ModelArrivalPrediction[];
  verification: EventVerification;
}

export interface KpPoint {
  ms: number;
  kp: number;
}

/**
 * Detection parameters. The defaults are calibrated on 1-minute RTSW data; the
 * `omniHourly` preset coarsens the time windows for hourly OMNI history so the
 * year-long catalog is detected sensibly (a 1-hour speed-jump window spans a
 * single sample at hourly cadence).
 */
export interface DetectionOptions {
  shockDeltaVKmS: number;
  southwardBzNt: number;
  speedJumpWindowMs: number;
  couplingWindowMs: number;
  endCalmMs: number;
  maxEventMs: number;
  refractoryMs: number;
  sigMinKp: number;
  sigMinDeltaV: number;
  sigMinBz: number;
}

const HOUR = 60 * 60 * 1000;

export const DETECTION_PRESETS: Record<'rtswMinute' | 'omniHourly', DetectionOptions> = {
  rtswMinute: {
    shockDeltaVKmS: 50,
    southwardBzNt: -8,
    speedJumpWindowMs: 1 * HOUR,
    couplingWindowMs: 3 * HOUR, // matches the 3-hour Kp index
    endCalmMs: 3 * HOUR,
    maxEventMs: 18 * HOUR,
    refractoryMs: 2 * HOUR,
    sigMinKp: 3.8,
    sigMinDeltaV: 70,
    sigMinBz: -10,
  },
  omniHourly: {
    shockDeltaVKmS: 60,
    southwardBzNt: -8,
    speedJumpWindowMs: 6 * HOUR,
    couplingWindowMs: 3 * HOUR,
    endCalmMs: 6 * HOUR,
    maxEventMs: 36 * HOUR,
    refractoryMs: 6 * HOUR,
    sigMinKp: 3.8,
    sigMinDeltaV: 80,
    sigMinBz: -10,
  },
};

// Verification window padding around the predicted arrival(s).
const VERIFY_LEAD_MS = 90 * 60 * 1000; // Kp can rise slightly before the leading edge
const VERIFY_SETTLE_MS = 3 * 60 * 60 * 1000; // and persists after; 3-hour Kp cadence
const VERIFY_HIT_TOLERANCE = 1; // within one G level counts as a hit (Kp is coarse)

function toFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function trailingMean(
  samples: L1EventSample[],
  index: number,
  windowMs: number,
  pick: (sample: L1EventSample) => number | null,
): number | null {
  let sum = 0;
  let count = 0;
  const tEnd = samples[index].ms;
  for (let j = index; j >= 0 && tEnd - samples[j].ms <= windowMs; j -= 1) {
    const value = pick(samples[j]);
    if (value !== null) {
      sum += value;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

/** Speed rise over the trailing jump window: v[i] − min(v in window). */
function deltaSpeed(samples: L1EventSample[], index: number, windowMs: number): number {
  const here = toFinite(samples[index].speedKmS);
  if (here === null) return 0;
  let min = here;
  const tEnd = samples[index].ms;
  for (let j = index; j >= 0 && tEnd - samples[j].ms <= windowMs; j -= 1) {
    const v = toFinite(samples[j].speedKmS);
    if (v !== null && v < min) min = v;
  }
  return here - min;
}

function isShock(samples: L1EventSample[], index: number, opts: DetectionOptions): boolean {
  return deltaSpeed(samples, index, opts.speedJumpWindowMs) >= opts.shockDeltaVKmS;
}

function isSouthward(sample: L1EventSample, opts: DetectionOptions): boolean {
  const bz = toFinite(sample.bzNt);
  return bz !== null && bz <= opts.southwardBzNt;
}

function eventId(onsetMs: number): string {
  // Stable per ~minute onset so re-ticks upsert the same event.
  return `evt-${Math.round(onsetMs / 60000) * 60000}`;
}

/**
 * Build one model's arrival + intensity prediction for an event.
 * `arrivalSpeed` times the leading edge; `peakEm`/`peakSpeed`/`peakBz` set intensity.
 */
export function buildModelPrediction(
  model: ModelId,
  onsetMs: number,
  distanceKm: number,
  arrivalSpeedKmS: number | null,
  peakSpeedKmS: number | null,
  peakBzNt: number | null,
  peakEmMvM: number,
): ModelArrivalPrediction {
  const speed = toFinite(arrivalSpeedKmS);
  const lagMinutes = speed && speed > 0 ? distanceKm / speed / 60 : Number.NaN;
  const arrivalMs = Number.isFinite(lagMinutes) ? onsetMs + lagMinutes * 60 * 1000 : onsetMs;
  const kp = Math.round(kpFromCoupling(peakEmMvM, peakSpeedKmS) * 10) / 10;
  const g = classifyGFromKp(kp);
  return {
    model,
    arrivalUtc: new Date(arrivalMs).toISOString(),
    lagMinutes: Number.isFinite(lagMinutes) ? Math.round(lagMinutes) : Number.NaN,
    arrivalSpeedKmS: speed,
    peakSpeedKmS: toFinite(peakSpeedKmS),
    peakBzNt: toFinite(peakBzNt),
    estimatedKp: kp,
    gLevel: g.level,
    gCode: g.code,
  };
}

/**
 * Detect events in an L1 sample stream and attach the MRU model prediction.
 * Samples may arrive unsorted; they are sorted ascending by time first.
 */
export function detectLiveEvents(
  rawSamples: L1EventSample[],
  distanceKm: number,
  options: DetectionOptions = DETECTION_PRESETS.rtswMinute,
): LiveEvent[] {
  const opts = options;
  const samples = rawSamples.slice().filter(s => Number.isFinite(s.ms)).sort((a, b) => a.ms - b.ms);
  const n = samples.length;
  const events: LiveEvent[] = [];
  let lastEndMs = Number.NEGATIVE_INFINITY;
  let i = 0;

  while (i < n) {
    const shock = isShock(samples, i, opts);
    const south = isSouthward(samples[i], opts);
    if ((shock || south) && samples[i].ms - lastEndMs >= opts.refractoryMs) {
      const start = i;
      let lastDisturbed = i;
      let j = i;
      while (j < n) {
        if (isShock(samples, j, opts) || isSouthward(samples[j], opts)) lastDisturbed = j;
        if (samples[j].ms - samples[lastDisturbed].ms > opts.endCalmMs) break;
        if (samples[j].ms - samples[start].ms > opts.maxEventMs) break;
        j += 1;
      }

      // Characterise the structure across [start, lastDisturbed].
      let peakIndex = start;
      let peakEm = -1;
      let deltaV = 0;
      let minBz: number | null = null;
      let peakBt: number | null = null;
      let peakSpeed: number | null = null;
      let sawShock = false;
      let sawSouth = false;
      for (let k = start; k <= lastDisturbed; k += 1) {
        const em = trailingMean(samples, k, opts.couplingWindowMs, s => mergingFieldMvM(s.speedKmS, s.bzNt)) ?? 0;
        if (em > peakEm) {
          peakEm = em;
          peakIndex = k;
        }
        deltaV = Math.max(deltaV, deltaSpeed(samples, k, opts.speedJumpWindowMs));
        const bz = toFinite(samples[k].bzNt);
        if (bz !== null) minBz = minBz === null ? bz : Math.min(minBz, bz);
        const bt = toFinite(samples[k].btNt);
        if (bt !== null) peakBt = peakBt === null ? bt : Math.max(peakBt, bt);
        if (isShock(samples, k, opts)) sawShock = true;
        if (isSouthward(samples[k], opts)) sawSouth = true;
      }

      const peakMeanSpeed = trailingMean(samples, peakIndex, opts.couplingWindowMs, s => s.speedKmS);
      const peakKp = kpFromCoupling(peakEm, peakMeanSpeed);
      const significant = peakKp >= opts.sigMinKp || deltaV >= opts.sigMinDeltaV || (minBz !== null && minBz <= opts.sigMinBz);

      if (significant) {
        const onsetMs = samples[start].ms;
        const onsetSpeed = toFinite(samples[start].speedKmS) ?? peakMeanSpeed;
        const peakSpeedSample = toFinite(samples[peakIndex].speedKmS);
        peakSpeed = peakSpeedSample;
        const type: EventType = sawShock && sawSouth ? 'shock_southward' : sawShock ? 'shock' : 'southward_bz';
        const driverLabel = type === 'shock_southward'
          ? 'Shock + southward field'
          : type === 'shock'
            ? 'Interplanetary shock / fast-stream interface'
            : 'Southward magnetic field';

        const mru = buildModelPrediction(
          'MRU',
          onsetMs,
          distanceKm,
          onsetSpeed,
          peakSpeedSample,
          toFinite(samples[peakIndex].bzNt),
          peakEm,
        );

        events.push({
          id: eventId(onsetMs),
          type,
          detectedAtL1Utc: new Date(onsetMs).toISOString(),
          endAtL1Utc: new Date(samples[lastDisturbed].ms).toISOString(),
          loggedAtUtc: new Date().toISOString(),
          driver: {
            label: driverLabel,
            peakSpeedKmS: peakSpeed,
            deltaSpeedKmS: Math.round(deltaV),
            minBzNt: minBz === null ? null : Math.round(minBz * 10) / 10,
            peakBtNt: peakBt === null ? null : Math.round(peakBt * 10) / 10,
          },
          l1DistanceKm: Math.round(distanceKm),
          predictions: [mru],
          verification: {
            status: 'pending',
            observedMaxKp: null,
            observedGLevel: null,
            observedGCode: null,
            windowStartUtc: null,
            windowEndUtc: null,
            checkedAtUtc: null,
            verdicts: [],
          },
        });
      }

      lastEndMs = samples[lastDisturbed].ms;
      i = lastDisturbed + 1;
    } else {
      i += 1;
    }
  }

  return events;
}

/**
 * Retrospectively verify an event against the real Kp series. Mutates and returns
 * a fresh verification object (does not touch the input).
 */
export function verifyEvent(event: LiveEvent, kpSeries: KpPoint[], nowMs: number): EventVerification {
  const arrivals = event.predictions
    .map(p => new Date(p.arrivalUtc).getTime())
    .filter(ms => Number.isFinite(ms));
  if (arrivals.length === 0) {
    return { ...event.verification, status: 'unverifiable', checkedAtUtc: new Date(nowMs).toISOString() };
  }

  const windowStart = Math.min(...arrivals) - VERIFY_LEAD_MS;
  const windowEnd = Math.max(...arrivals) + VERIFY_SETTLE_MS;

  // Still in transit / not enough settle time elapsed -> pending.
  if (nowMs < windowEnd) {
    return {
      status: 'pending',
      observedMaxKp: null,
      observedGLevel: null,
      observedGCode: null,
      windowStartUtc: new Date(windowStart).toISOString(),
      windowEndUtc: new Date(windowEnd).toISOString(),
      checkedAtUtc: new Date(nowMs).toISOString(),
      verdicts: [],
    };
  }

  const inWindow = kpSeries.filter(p => p.ms >= windowStart && p.ms <= windowEnd);
  if (inWindow.length === 0) {
    return {
      status: 'unverifiable',
      observedMaxKp: null,
      observedGLevel: null,
      observedGCode: null,
      windowStartUtc: new Date(windowStart).toISOString(),
      windowEndUtc: new Date(windowEnd).toISOString(),
      checkedAtUtc: new Date(nowMs).toISOString(),
      verdicts: [],
    };
  }

  const observedMaxKp = Math.max(...inWindow.map(p => p.kp));
  const observedG = classifyGFromKp(observedMaxKp);
  const verdicts = event.predictions.map(p => ({
    model: p.model,
    predictedGLevel: p.gLevel,
    hit: Math.abs(p.gLevel - observedG.level) <= VERIFY_HIT_TOLERANCE,
  }));

  return {
    status: 'verified',
    observedMaxKp: Math.round(observedMaxKp * 100) / 100,
    observedGLevel: observedG.level,
    observedGCode: observedG.code,
    windowStartUtc: new Date(windowStart).toISOString(),
    windowEndUtc: new Date(windowEnd).toISOString(),
    checkedAtUtc: new Date(nowMs).toISOString(),
    verdicts,
  };
}
