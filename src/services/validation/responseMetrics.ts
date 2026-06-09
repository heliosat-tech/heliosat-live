/**
 * GEO (GOES) and ground geomagnetic response metrics over an event's response windows.
 *
 * These measure the REAL terrestrial response — they do not establish causality and are
 * never satellite anomalies. GOES is GEO context; Kp/Dst/SYM-H are ground response.
 */

import type { GoesSample, GroundIndexSample } from '../dataSources/types';
import type { ResponseWindows } from './responseWindows';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

interface TimedValue {
  timeMs: number;
  value: number;
}

interface Extreme {
  value: number | null;
  timeMs: number | null;
  count: number;
}

function toTimed(samples: Array<{ timeUtc: string }>, accessor: (s: never) => number | null): Array<{ timeMs: number; value: number | null }> {
  return samples.map(s => ({ timeMs: Date.parse(s.timeUtc), value: (accessor as (x: typeof s) => number | null)(s) }));
}

function windowExtreme(series: Array<{ timeMs: number; value: number | null }>, startMs: number, endMs: number, dir: 'min' | 'max'): Extreme {
  let best: TimedValue | null = null;
  let count = 0;
  for (const point of series) {
    if (Number.isNaN(point.timeMs) || point.timeMs < startMs || point.timeMs > endMs) continue;
    if (point.value === null || !Number.isFinite(point.value)) continue;
    count += 1;
    if (best === null || (dir === 'min' ? point.value < best.value : point.value > best.value)) {
      best = { timeMs: point.timeMs, value: point.value };
    }
  }
  return { value: best?.value ?? null, timeMs: best?.timeMs ?? null, count };
}

function windowMean(series: Array<{ timeMs: number; value: number | null }>, startMs: number, endMs: number): number | null {
  let sum = 0;
  let n = 0;
  for (const point of series) {
    if (Number.isNaN(point.timeMs) || point.timeMs < startMs || point.timeMs > endMs) continue;
    if (point.value === null || !Number.isFinite(point.value)) continue;
    sum += point.value;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

export interface GeoResponseMetrics {
  maxProtonFlux: number | null;
  maxElectronFlux: number | null;
  maxXrayFlux: number | null;
  /** Quiet-time Hp baseline (mean over the 3 h before arrival). */
  baselineHpNt: number | null;
  /** Max |Hp - baseline| over the GEO magnetic window. */
  maxHpDisturbanceNt: number | null;
  /** Minutes from arrival to the peak Hp disturbance. */
  hpResponseDelayMinutes: number | null;
  geoSampleCount: number;
  qualityFlags: string[];
}

export function computeGeoResponse(goes: GoesSample[], windows: ResponseWindows): GeoResponseMetrics {
  const arrivalMs = Date.parse(windows.arrivalUtc);
  const proton = toTimed(goes, (s: GoesSample) => s.protonFlux);
  const electron = toTimed(goes, (s: GoesSample) => s.electronFlux);
  const xray = toTimed(goes, (s: GoesSample) => s.xrayFlux);
  const hp = toTimed(goes, (s: GoesSample) => s.hpNt);

  const particleStart = Date.parse(windows.particle.startUtc);
  const particleEnd = Date.parse(windows.particle.endUtc);
  const geoStart = Date.parse(windows.geoMagnetic.startUtc);
  const geoEnd = Date.parse(windows.geoMagnetic.endUtc);

  const maxProton = windowExtreme(proton, particleStart, particleEnd, 'max');
  const maxElectron = windowExtreme(electron, particleStart, particleEnd, 'max');
  const maxXray = windowExtreme(xray, particleStart, particleEnd, 'max');

  const baselineHpNt = windowMean(hp, arrivalMs - 3 * HOUR_MS, arrivalMs);

  let maxHpDisturbanceNt: number | null = null;
  let hpPeakMs: number | null = null;
  let hpCount = 0;
  if (baselineHpNt !== null) {
    for (const point of hp) {
      if (Number.isNaN(point.timeMs) || point.timeMs < geoStart || point.timeMs > geoEnd) continue;
      if (point.value === null || !Number.isFinite(point.value)) continue;
      hpCount += 1;
      const disturbance = Math.abs(point.value - baselineHpNt);
      if (maxHpDisturbanceNt === null || disturbance > maxHpDisturbanceNt) {
        maxHpDisturbanceNt = disturbance;
        hpPeakMs = point.timeMs;
      }
    }
  }

  const qualityFlags: string[] = [];
  if (goes.length === 0) qualityFlags.push('no_geo_samples');
  if (baselineHpNt === null) qualityFlags.push('no_hp_baseline');
  if (maxProton.count === 0 && maxElectron.count === 0 && maxXray.count === 0) qualityFlags.push('no_geo_flux_in_window');

  return {
    maxProtonFlux: maxProton.value,
    maxElectronFlux: maxElectron.value,
    maxXrayFlux: maxXray.value,
    baselineHpNt,
    maxHpDisturbanceNt,
    hpResponseDelayMinutes: hpPeakMs !== null ? (hpPeakMs - arrivalMs) / MINUTE_MS : null,
    geoSampleCount: Math.max(maxProton.count, maxElectron.count, maxXray.count, hpCount),
    qualityFlags,
  };
}

export interface GroundResponseMetrics {
  maxKp3h: number | null;
  maxKp6h: number | null;
  minDst6h: number | null;
  minDst12h: number | null;
  minSymh: number | null;
  /** Minutes from arrival to the peak Kp (over the 6 h window). */
  kpResponseDelayMinutes: number | null;
  /** Minutes from arrival to the Dst minimum (over the 12 h window). */
  dstResponseDelayMinutes: number | null;
  groundSampleCount: number;
  qualityFlags: string[];
}

export function computeGroundResponse(ground: GroundIndexSample[], windows: ResponseWindows): GroundResponseMetrics {
  const arrivalMs = Date.parse(windows.arrivalUtc);
  const kp = toTimed(ground, (s: GroundIndexSample) => s.kp);
  const dst = toTimed(ground, (s: GroundIndexSample) => s.dstNt);
  const symh = toTimed(ground, (s: GroundIndexSample) => s.symhNt);

  const maxKp3h = windowExtreme(kp, arrivalMs, arrivalMs + 3 * HOUR_MS, 'max');
  const maxKp6h = windowExtreme(kp, arrivalMs, arrivalMs + 6 * HOUR_MS, 'max');
  const minDst6h = windowExtreme(dst, arrivalMs, arrivalMs + 6 * HOUR_MS, 'min');
  const minDst12h = windowExtreme(dst, arrivalMs, arrivalMs + 12 * HOUR_MS, 'min');
  const minSymh = windowExtreme(symh, arrivalMs, arrivalMs + 12 * HOUR_MS, 'min');

  const qualityFlags: string[] = [];
  if (ground.length === 0) qualityFlags.push('no_ground_samples');
  if (maxKp6h.count === 0) qualityFlags.push('no_kp_in_window');
  if (minDst12h.count === 0) qualityFlags.push('no_dst_in_window');
  if (minSymh.count === 0) qualityFlags.push('symh_unavailable');

  return {
    maxKp3h: maxKp3h.value,
    maxKp6h: maxKp6h.value,
    minDst6h: minDst6h.value,
    minDst12h: minDst12h.value,
    minSymh: minSymh.value,
    kpResponseDelayMinutes: maxKp6h.timeMs !== null ? (maxKp6h.timeMs - arrivalMs) / MINUTE_MS : null,
    dstResponseDelayMinutes: minDst12h.timeMs !== null ? (minDst12h.timeMs - arrivalMs) / MINUTE_MS : null,
    groundSampleCount: Math.max(maxKp6h.count, minDst12h.count, minSymh.count),
    qualityFlags,
  };
}
