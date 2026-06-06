/**
 * Time-ranged Earth-side solar-wind history for the Live Forecast charts.
 *
 * Range -> best source:
 *   live (~2 h), 1d, 1w   -> NOAA SWPC real-time products (2-hour / 1-day / 7-day)
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
  magUrl?: string;
  plasmaUrl?: string;
}

const PRODUCT = (suffix: string) => `https://services.swpc.noaa.gov/products/solar-wind/${suffix}.json`;

export const RANGE_CONFIG: Record<HistoryRange, RangeConfig> = {
  live: { source: 'rtsw', days: 0.1, targetPoints: 200, cadenceLabel: '1-min · DSCOVR/ACE at L1', magUrl: PRODUCT('mag-2-hour'), plasmaUrl: PRODUCT('plasma-2-hour') },
  '1d': { source: 'rtsw', days: 1, targetPoints: 700, cadenceLabel: '1-min · DSCOVR/ACE at L1', magUrl: PRODUCT('mag-1-day'), plasmaUrl: PRODUCT('plasma-1-day') },
  '1w': { source: 'rtsw', days: 7, targetPoints: 1400, cadenceLabel: '1-min · DSCOVR/ACE at L1', magUrl: PRODUCT('mag-7-day'), plasmaUrl: PRODUCT('plasma-7-day') },
  '1m': { source: 'omni', days: 31, targetPoints: 744, cadenceLabel: 'hourly · OMNI at Earth' },
  '1y': { source: 'omni', days: 366, targetPoints: 1500, cadenceLabel: 'hourly · OMNI at Earth' },
};

const REQUEST_TIMEOUT_MS = 15_000;

async function fetchProduct(url: string): Promise<unknown[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`NOAA request failed with ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timeout);
  }
}

function columnIndex(table: unknown[]): Record<string, number> {
  const header = table[0];
  const map: Record<string, number> = {};
  if (Array.isArray(header)) header.forEach((name, i) => { if (typeof name === 'string') map[name] = i; });
  return map;
}

function parseMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const minuteKey = (ms: number) => Math.round(ms / 60000) * 60000;

async function fetchRtswWindow(config: RangeConfig): Promise<ForecastHistoryPoint[]> {
  const [mag, plasma] = await Promise.all([fetchProduct(config.magUrl!), fetchProduct(config.plasmaUrl!)]);
  const magCols = columnIndex(mag);
  const plasmaCols = columnIndex(plasma);
  const bzIdx = magCols.bz_gsm ?? -1;
  const btIdx = magCols.bt ?? -1;
  const speedIdx = plasmaCols.speed ?? -1;
  const densityIdx = plasmaCols.density ?? -1;

  const magByMinute = new Map<number, { bz: number | null; bt: number | null }>();
  for (let i = 1; i < mag.length; i += 1) {
    const row = mag[i];
    if (!Array.isArray(row)) continue;
    const ms = parseMs(row[0]);
    if (Number.isNaN(ms)) continue;
    magByMinute.set(minuteKey(ms), { bz: bzIdx >= 0 ? toNum(row[bzIdx]) : null, bt: btIdx >= 0 ? toNum(row[btIdx]) : null });
  }

  const points: ForecastHistoryPoint[] = [];
  for (let i = 1; i < plasma.length; i += 1) {
    const row = plasma[i];
    if (!Array.isArray(row)) continue;
    const ms = parseMs(row[0]);
    if (Number.isNaN(ms)) continue;
    const mag = magByMinute.get(minuteKey(ms));
    points.push({
      t: ms,
      speed: speedIdx >= 0 ? toNum(row[speedIdx]) : null,
      density: densityIdx >= 0 ? toNum(row[densityIdx]) : null,
      bt: mag?.bt ?? null,
      bz: mag?.bz ?? null,
    });
  }
  return points.sort((a, b) => a.t - b.t);
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

  let raw: ForecastHistoryPoint[] = [];
  try {
    raw = await fetchRtswWindow(config);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : 'NOAA history request failed');
  }
  const endMs = raw.length ? raw[raw.length - 1].t : Date.now();
  const startMs = raw.length ? raw[0].t : endMs - config.days * 24 * 60 * 60 * 1000;
  const overlays = raw.length ? await computeOverlays(raw, config.targetPoints) : { mru: [], ml: [], mlAvailable: false };
  return {
    range,
    source: 'rtsw',
    cadenceLabel: config.cadenceLabel,
    startMs,
    endMs,
    points: downsamplePoints(raw, config.targetPoints),
    mru: overlays.mru,
    ml: overlays.ml,
    mlAvailable: overlays.mlAvailable,
    warnings,
  };
}
