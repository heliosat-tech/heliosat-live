/**
 * Time-ranged Earth-side solar-wind history for the Live Forecast charts.
 *
 * Range -> best source:
 *   live (~2 h), 1d, 1w   -> canonical live L1 selector (current NOAA RTSW JSON,
 *                            with any shorter upstream coverage reported explicitly)
 *   1m, 1y                -> OMNI hourly (CDAWeb HAPI), which also carries Kp/Dst
 *                            and feeds the year-long event catalog.
 *
 * Long series are downsampled to a chart-friendly point budget (averaging within
 * time buckets, gaps preserved) so a year still renders smoothly with a scroll brush.
 */

import { fetchOmniHourlyHistory, type OmniHistoryResult } from './omniHistoryService';
import { NOMINAL_L1_DISTANCE_KM, propagateL1Series, type L1Sample } from './mruForecastService';
import { loadMlModel, predictAtTimes } from './mlModelService';
import type { L1EarthSample } from './l1EarthData';
import {
  fetchLiveL1History,
  type ResolvedL1EventSample,
} from './liveL1HistoryService';

export type HistoryRange = 'live' | '1d' | '1w' | '1m' | '1y';

export interface ForecastHistoryPoint {
  t: number;
  speed: number | null;
  density: number | null;
  bt: number | null;
  bz: number | null;
}

export interface ForecastHistory {
  range: HistoryRange;
  source: 'rtsw' | 'omni';
  cadenceLabel: string;
  startMs: number;
  endMs: number;
  points: ForecastHistoryPoint[];
  /** MRU (ballistic shift) + ML model series at Earth-arrival time, for L1 ranges. */
  mru: ForecastHistoryPoint[];
  ml: ForecastHistoryPoint[];
  mlAvailable: boolean;
  /** Present for OMNI ranges so the route can build the catalog without refetching. */
  omni?: OmniHistoryResult;
  warnings: string[];
}

interface RangeConfig {
  source: 'rtsw' | 'omni';
  days: number;
  targetPoints: number;
  cadenceLabel: string;
}

export const RANGE_CONFIG: Record<HistoryRange, RangeConfig> = {
  live: { source: 'rtsw', days: 0.1, targetPoints: 200, cadenceLabel: '1-min · NOAA active RTSW at L1' },
  '1d': { source: 'rtsw', days: 1, targetPoints: 700, cadenceLabel: '1-min · NOAA active RTSW at L1' },
  '1w': { source: 'rtsw', days: 7, targetPoints: 1400, cadenceLabel: '1-min · NOAA active RTSW at L1' },
  '1m': { source: 'omni', days: 31, targetPoints: 744, cadenceLabel: 'hourly · OMNI at Earth' },
  '1y': { source: 'omni', days: 366, targetPoints: 1500, cadenceLabel: 'hourly · OMNI at Earth' },
};

export function pointsFromLiveL1Samples(
  samples: ResolvedL1EventSample[],
  startMs: number,
): ForecastHistoryPoint[] {
  return samples
    .filter(sample => sample.ms >= startMs)
    .map(sample => ({
      t: sample.ms,
      speed: sample.speedKmS,
      density: sample.densityPerCm3,
      bt: sample.btNt,
      bz: sample.bzNt,
    }))
    .sort((a, b) => a.t - b.t);
}

function incompleteCoverageWarning(
  points: ForecastHistoryPoint[],
  requestedStartMs: number,
  requestedDays: number,
): string | null {
  if (points.length < 2) return null;
  const toleranceMs = 15 * 60_000;
  if (points[0].t <= requestedStartMs + toleranceMs) return null;
  const coveredHours = (points.at(-1)!.t - points[0].t) / 3_600_000;
  return `The current live L1 source supplied ${coveredHours.toFixed(1)} h of the requested ${requestedDays.toFixed(1)} d window; no synthetic or delayed backfill was inserted.`;
}

/** Average into `target` equal time buckets; gaps (empty buckets) are dropped. */
export function downsamplePoints(points: ForecastHistoryPoint[], target: number): ForecastHistoryPoint[] {
  if (points.length <= target) return points;
  const startMs = points[0].t;
  const endMs = points[points.length - 1].t;
  const span = Math.max(1, endMs - startMs);
  const bucketMs = span / target;

  const buckets = new Map<number, { t: number; speed: number[]; density: number[]; bt: number[]; bz: number[] }>();
  for (const p of points) {
    const key = Math.floor((p.t - startMs) / bucketMs);
    const bucket = buckets.get(key) ?? { t: startMs + (key + 0.5) * bucketMs, speed: [], density: [], bt: [], bz: [] };
    if (p.speed !== null) bucket.speed.push(p.speed);
    if (p.density !== null) bucket.density.push(p.density);
    if (p.bt !== null) bucket.bt.push(p.bt);
    if (p.bz !== null) bucket.bz.push(p.bz);
    buckets.set(key, bucket);
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map(b => ({ t: Math.round(b.t), speed: avg(b.speed), density: avg(b.density), bt: avg(b.bt), bz: avg(b.bz) }));
}

/**
 * Compute the MRU (ballistic shift) and ML model series at Earth-arrival time from
 * a measured L1 series — the same two models shown live, so the historical L1
 * ranges can overlay them on the detected signal. OMNI ranges skip this (OMNI is
 * already the at-Earth observed record, so there is no L1→Earth shift to apply).
 */
async function computeOverlays(
  raw: ForecastHistoryPoint[],
  targetPoints: number,
): Promise<{ mru: ForecastHistoryPoint[]; ml: ForecastHistoryPoint[]; mlAvailable: boolean }> {
  const distanceKm = NOMINAL_L1_DISTANCE_KM;

  const l1: L1Sample[] = raw.map(p => ({
    timeUtc: new Date(p.t).toISOString(),
    speedKmS: p.speed,
    densityPerCm3: p.density,
    bzNt: p.bz,
    btNt: p.bt,
    temperatureK: null,
  }));
  const propagated = propagateL1Series(l1, distanceKm);
  const mru: ForecastHistoryPoint[] = propagated.map(s => ({
    t: new Date(s.arrivalTimeUtc).getTime(),
    speed: s.speedKmS,
    density: s.densityPerCm3,
    bt: s.btNt,
    bz: s.bzNt,
  }));

  let ml: ForecastHistoryPoint[] = [];
  let mlAvailable = false;
  try {
    const artifact = await loadMlModel();
    if (artifact) {
      mlAvailable = true;
      const samples: L1EarthSample[] = raw.map(p => ({ ms: p.t, speed: p.speed, density: p.density, bt: p.bt, bz: p.bz }));
      const arrivalTimes = raw
        .filter(p => p.speed !== null && p.speed > 0)
        .map(p => p.t + (distanceKm / (p.speed as number)) * 1000);
      const opts = { imputeMissing: true, anchorToInput: true };
      const speed = predictAtTimes(artifact, samples, 'speed', arrivalTimes, opts);
      const density = predictAtTimes(artifact, samples, 'density', arrivalTimes, opts);
      const bt = predictAtTimes(artifact, samples, 'bt', arrivalTimes, opts);
      const bz = predictAtTimes(artifact, samples, 'bz', arrivalTimes, opts);
      ml = arrivalTimes.map((t, i) => ({ t, speed: speed[i], density: density[i], bt: bt[i], bz: bz[i] }));
    }
  } catch {
    // ML overlay is best-effort; MRU still stands.
  }

  return {
    mru: downsamplePoints(mru, targetPoints),
    ml: ml.length ? downsamplePoints(ml, targetPoints) : [],
    mlAvailable,
  };
}

export async function fetchForecastHistory(range: HistoryRange): Promise<ForecastHistory> {
  const config = RANGE_CONFIG[range];
  const warnings: string[] = [];

  if (config.source === 'omni') {
    const omni = await fetchOmniHourlyHistory(config.days);
    if (omni.errorMessage) warnings.push(omni.errorMessage);
    const raw: ForecastHistoryPoint[] = omni.samples.map(s => ({ t: s.ms, speed: s.speedKmS, density: s.densityPerCm3, bt: s.btNt, bz: s.bzNt }));
    return {
      range,
      source: 'omni',
      cadenceLabel: config.cadenceLabel,
      startMs: omni.startMs,
      endMs: omni.endMs,
      points: downsamplePoints(raw, config.targetPoints),
      mru: [],
      ml: [],
      mlAvailable: false,
      omni,
      warnings,
    };
  }

  const requestedStartMs = Date.now() - config.days * 24 * 60 * 60 * 1000;
  let raw: ForecastHistoryPoint[] = [];
  let cadenceLabel = config.cadenceLabel;
  try {
    const liveHistory = await fetchLiveL1History();
    raw = pointsFromLiveL1Samples(liveHistory.samples, requestedStartMs);
    if (liveHistory.errorMessage) warnings.push(liveHistory.errorMessage);
    if (liveHistory.sourceLabel) cadenceLabel = `1-min · ${liveHistory.sourceLabel} at L1`;
    const coverageWarning = incompleteCoverageWarning(raw, requestedStartMs, config.days);
    if (coverageWarning) warnings.push(coverageWarning);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : 'NOAA history request failed');
  }
  const endMs = raw.length ? raw[raw.length - 1].t : Date.now();
  const startMs = raw.length ? raw[0].t : requestedStartMs;
  const overlays = raw.length ? await computeOverlays(raw, config.targetPoints) : { mru: [], ml: [], mlAvailable: false };
  return {
    range,
    source: 'rtsw',
    cadenceLabel,
    startMs,
    endMs,
    points: downsamplePoints(raw, config.targetPoints),
    mru: overlays.mru,
    ml: overlays.ml,
    mlAvailable: overlays.mlAvailable,
    warnings,
  };
}
