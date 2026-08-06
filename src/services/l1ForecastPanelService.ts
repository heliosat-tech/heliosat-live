import { fetchLiveL1History } from './liveL1HistoryService';
import { fetchAceEpamElectronFlux, type AceEpamSeries } from './aceEpamService';
import { loadMlModel, predictAtTimes } from './mlModelService';
import {
  NOMINAL_L1_DISTANCE_KM,
  propagateL1Sample,
  propagateL1Series,
  type L1Sample,
} from './mruForecastService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from './stormScaleService';
import type { L1EarthSample } from './l1EarthData';
import type { ResolvedL1EventSample } from './l1/types';

export interface L1ForecastSeriesPoint {
  t: number;
  speed: number | null;
  density: number | null;
  bt: number | null;
  bz: number | null;
}

export interface L1ForecastHeatmapCell {
  t: number;
  value: number | null;
  label: string;
  color: string;
}

export interface L1ForecastHeatmapRow {
  id: 'g' | 'speed' | 'bz' | 'bt' | 'density';
  label: string;
  unit: string;
  cells: L1ForecastHeatmapCell[];
  latestLabel: string;
}

export interface GeomagneticForecastPeak {
  level: number;
  code: string;
  label: string;
  kp: number;
  arrivalUtc: string;
  speed: number;
  bz: number;
}

export interface GeomagneticSevereEvent {
  thresholdCode: 'G3';
  firstArrivalUtc: string;
  peak: GeomagneticForecastPeak;
  etaMinutes: number;
  durationMinutes: number;
}

export interface GeomagneticForecastSummary {
  method: 'l1-coupling-live-v1';
  thresholdKp: 7;
  forecastStartUtc: string | null;
  forecastEndUtc: string | null;
  availablePoints: number;
  totalPoints: number;
  coveragePct: number;
  peak: GeomagneticForecastPeak | null;
  severeEvent: GeomagneticSevereEvent | null;
}

export interface L1ForecastPanelData {
  generatedAtMs: number;
  generatedAtUtc: string;
  sourceLabel: string | null;
  freshness: 'fresh' | 'degraded' | 'stale';
  latestSampleAgeMinutes: number | null;
  distanceKm: number;
  distanceIsMeasured: boolean;
  mlAvailable: boolean;
  warnings: string[];
  latest: {
    sampleTimeUtc: string | null;
    speed: number | null;
    density: number | null;
    bt: number | null;
    bz: number | null;
    transitMinutes: number | null;
    arrivalUtc: string | null;
    gLevel: number;
    gCode: string;
    kp: number | null;
  };
  series: {
    detected: L1ForecastSeriesPoint[];
    forecast: L1ForecastSeriesPoint[];
    ml: L1ForecastSeriesPoint[];
  };
  electronFlux: AceEpamSeries;
  heatmap: {
    startMs: number | null;
    endMs: number | null;
    rows: L1ForecastHeatmapRow[];
  };
  geomagneticForecast: GeomagneticForecastSummary;
}

const HISTORY_WINDOW_MS = 2.25 * 60 * 60 * 1000;
const HEATMAP_PAST_MS = 8 * 60 * 1000;
const HEATMAP_FUTURE_MS = 90 * 60 * 1000;
const MAX_CHART_POINTS = 180;
const MAX_HEATMAP_CELLS = 96;
const NO_DATA_FILL = '#334155';
const DANGER_COLORS = ['#34d399', '#a3e635', '#fbbf24', '#fb923c', '#f87171', '#e879f9'] as const;
const GEOMAGNETIC_SMOOTHING_MS = 30 * 60 * 1000;
const MIN_SEVERE_EVENT_MS = 10 * 60 * 1000;
const MAX_EVENT_SAMPLE_GAP_MS = 5 * 60 * 1000;

function toFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toL1Sample(sample: ResolvedL1EventSample): L1Sample {
  return {
    timeUtc: new Date(sample.ms).toISOString(),
    speedKmS: toFinite(sample.speedKmS),
    densityPerCm3: toFinite(sample.densityPerCm3),
    bzNt: toFinite(sample.bzNt),
    btNt: toFinite(sample.btNt),
    temperatureK: null,
  };
}

function toSeriesPoint(sample: ResolvedL1EventSample): L1ForecastSeriesPoint {
  return {
    t: sample.ms,
    speed: toFinite(sample.speedKmS),
    density: toFinite(sample.densityPerCm3),
    bt: toFinite(sample.btNt),
    bz: toFinite(sample.bzNt),
  };
}

function downsamplePoints(points: L1ForecastSeriesPoint[], target: number): L1ForecastSeriesPoint[] {
  if (points.length <= target) return points;
  const startMs = points[0].t;
  const endMs = points[points.length - 1].t;
  const span = Math.max(1, endMs - startMs);
  const bucketMs = span / target;
  const buckets = new Map<number, { t: number; speed: number[]; density: number[]; bt: number[]; bz: number[] }>();

  for (const point of points) {
    const key = Math.floor((point.t - startMs) / bucketMs);
    const bucket = buckets.get(key) ?? { t: startMs + (key + 0.5) * bucketMs, speed: [], density: [], bt: [], bz: [] };
    if (point.speed !== null) bucket.speed.push(point.speed);
    if (point.density !== null) bucket.density.push(point.density);
    if (point.bt !== null) bucket.bt.push(point.bt);
    if (point.bz !== null) bucket.bz.push(point.bz);
    buckets.set(key, bucket);
  }

  const avg = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  return [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map(bucket => ({
      t: Math.round(bucket.t),
      speed: avg(bucket.speed),
      density: avg(bucket.density),
      bt: avg(bucket.bt),
      bz: avg(bucket.bz),
    }));
}

function thinCells<T>(items: T[], target: number, rank: (item: T) => number): T[] {
  if (items.length <= target) return items;
  const bucketSize = Math.ceil(items.length / target);
  const out: T[] = [];
  for (let i = 0; i < items.length; i += bucketSize) {
    let selected = items[i];
    let selectedRank = rank(selected);
    for (let j = i + 1; j < Math.min(i + bucketSize, items.length); j += 1) {
      const candidateRank = rank(items[j]);
      if (candidateRank > selectedRank) {
        selected = items[j];
        selectedRank = candidateRank;
      }
    }
    out.push(selected);
  }
  return out;
}

function formatValue(value: number | null, digits: number) {
  return value === null ? '--' : value.toFixed(digits);
}

function speedColor(value: number | null) {
  if (value === null) return NO_DATA_FILL;
  if (value < 400) return '#34d399';
  if (value < 550) return '#a3e635';
  if (value < 700) return '#fbbf24';
  return '#f87171';
}

function bzColor(value: number | null) {
  if (value === null) return NO_DATA_FILL;
  if (value >= 0) return '#34d399';
  if (value >= -5) return '#a3e635';
  if (value >= -10) return '#fbbf24';
  if (value >= -20) return '#fb923c';
  return '#e879f9';
}

function btColor(value: number | null) {
  if (value === null) return NO_DATA_FILL;
  if (value < 5) return '#34d399';
  if (value < 10) return '#a3e635';
  if (value < 20) return '#fbbf24';
  return '#fb923c';
}

function densityColor(value: number | null) {
  if (value === null) return NO_DATA_FILL;
  if (value < 5) return '#34d399';
  if (value < 10) return '#a3e635';
  if (value < 30) return '#fbbf24';
  return '#fb923c';
}

function speedRank(value: number | null) {
  if (value === null) return -1;
  return value < 400 ? 0 : value < 550 ? 1 : value < 700 ? 2 : 3;
}

function bzRank(value: number | null) {
  if (value === null) return -1;
  return value >= 0 ? 0 : value >= -5 ? 1 : value >= -10 ? 2 : value >= -20 ? 3 : 4;
}

function btRank(value: number | null) {
  if (value === null) return -1;
  return value < 5 ? 0 : value < 10 ? 1 : value < 20 ? 2 : 3;
}

function densityRank(value: number | null) {
  if (value === null) return -1;
  return value < 5 ? 0 : value < 10 ? 1 : value < 30 ? 2 : 3;
}

function estimateGLevel(point: L1ForecastSeriesPoint) {
  if (point.speed === null || point.bz === null) return null;
  const kp = kpFromCoupling(mergingFieldMvM(point.speed, point.bz), point.speed);
  return classifyGFromKp(kp).level;
}

interface EstimatedGeomagneticPoint extends GeomagneticForecastPeak {
  t: number;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function publicPeak(point: EstimatedGeomagneticPoint): GeomagneticForecastPeak {
  return {
    level: point.level,
    code: point.code,
    label: point.label,
    kp: point.kp,
    arrivalUtc: point.arrivalUtc,
    speed: point.speed,
    bz: point.bz,
  };
}

/**
 * Operator-facing G forecast over the already propagated L1 arrival series. A 30-minute
 * trailing mean damps one-minute spikes, and G3 notifications require ten sustained minutes.
 * This is the transparent live calculation; the separately validated GBDT remains a research
 * candidate and is intentionally not loaded here.
 */
export function summarizeGeomagneticForecast(
  points: L1ForecastSeriesPoint[],
  nowMs: number,
): GeomagneticForecastSummary {
  const sorted = points
    .filter(point => Number.isFinite(point.t))
    .slice()
    .sort((a, b) => a.t - b.t);
  const future = sorted.filter(point => point.t >= nowMs && point.t <= nowMs + HEATMAP_FUTURE_MS);
  const estimated: EstimatedGeomagneticPoint[] = [];

  for (const point of future) {
    const trailing = sorted.filter(candidate => candidate.t <= point.t && candidate.t >= point.t - GEOMAGNETIC_SMOOTHING_MS);
    const speedValues = trailing.map(candidate => candidate.speed).filter((value): value is number => value !== null && Number.isFinite(value));
    const bzValues = trailing.map(candidate => candidate.bz).filter((value): value is number => value !== null && Number.isFinite(value));
    if (speedValues.length === 0 || bzValues.length === 0) continue;
    const speed = mean(speedValues);
    const bz = mean(bzValues);
    const kp = Math.round(kpFromCoupling(mergingFieldMvM(speed, bz), speed) * 10) / 10;
    const scale = classifyGFromKp(kp);
    estimated.push({
      t: point.t,
      level: scale.level,
      code: scale.code,
      label: scale.label,
      kp,
      arrivalUtc: new Date(point.t).toISOString(),
      speed: Math.round(speed),
      bz: Math.round(bz * 10) / 10,
    });
  }

  const peak = estimated.reduce<EstimatedGeomagneticPoint | null>((best, point) => {
    if (!best || point.level > best.level || (point.level === best.level && point.kp > best.kp)) return point;
    return best;
  }, null);

  const runs: EstimatedGeomagneticPoint[][] = [];
  let current: EstimatedGeomagneticPoint[] = [];
  for (const point of estimated) {
    if (point.level < 3) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && point.t - previous.t > MAX_EVENT_SAMPLE_GAP_MS) {
      runs.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length) runs.push(current);

  const severeRun = runs.find(run => {
    const first = run[0];
    const last = run[run.length - 1];
    return last.t - first.t >= MIN_SEVERE_EVENT_MS;
  }) ?? null;
  const severePeak = severeRun?.reduce((best, point) => (
    point.level > best.level || (point.level === best.level && point.kp > best.kp) ? point : best
  )) ?? null;

  return {
    method: 'l1-coupling-live-v1',
    thresholdKp: 7,
    forecastStartUtc: future.length ? new Date(future[0].t).toISOString() : null,
    forecastEndUtc: future.length ? new Date(future[future.length - 1].t).toISOString() : null,
    availablePoints: estimated.length,
    totalPoints: future.length,
    coveragePct: future.length ? Math.round((estimated.length / future.length) * 1000) / 10 : 0,
    peak: peak ? publicPeak(peak) : null,
    severeEvent: severeRun && severePeak ? {
      thresholdCode: 'G3',
      firstArrivalUtc: severeRun[0].arrivalUtc,
      peak: publicPeak(severePeak),
      etaMinutes: Math.max(0, Math.round((severeRun[0].t - nowMs) / 60_000)),
      durationMinutes: Math.max(10, Math.round((severeRun[severeRun.length - 1].t - severeRun[0].t) / 60_000)),
    } : null,
  };
}

function buildHeatmapRows(points: L1ForecastSeriesPoint[]): L1ForecastHeatmapRow[] {
  const heatmapPoints = thinCells(points, MAX_HEATMAP_CELLS, point => {
    const level = estimateGLevel(point);
    return Math.max(
      level ?? -1,
      speedRank(point.speed),
      bzRank(point.bz),
      btRank(point.bt),
      densityRank(point.density),
    );
  });

  const latest = heatmapPoints[heatmapPoints.length - 1] ?? null;
  const cell = (
    point: L1ForecastSeriesPoint,
    value: number | null,
    label: string,
    color: string,
  ): L1ForecastHeatmapCell => ({ t: point.t, value, label, color });

  return [
    {
      id: 'g',
      label: 'G',
      unit: 'risk',
      cells: heatmapPoints.map(point => {
        const level = estimateGLevel(point);
        return cell(point, level, level === null ? 'G --' : `G${level}`, level === null ? NO_DATA_FILL : DANGER_COLORS[Math.max(0, Math.min(5, level))]);
      }),
      latestLabel: latest ? `G${estimateGLevel(latest) ?? '--'}` : '--',
    },
    {
      id: 'speed',
      label: 'Vsw',
      unit: 'km/s',
      cells: heatmapPoints.map(point => cell(point, point.speed, `${formatValue(point.speed, 0)} km/s`, speedColor(point.speed))),
      latestLabel: latest ? `${formatValue(latest.speed, 0)}` : '--',
    },
    {
      id: 'bz',
      label: 'Bz',
      unit: 'nT',
      cells: heatmapPoints.map(point => cell(point, point.bz, `${formatValue(point.bz, 1)} nT`, bzColor(point.bz))),
      latestLabel: latest ? `${formatValue(latest.bz, 1)}` : '--',
    },
    {
      id: 'bt',
      label: '|B|',
      unit: 'nT',
      cells: heatmapPoints.map(point => cell(point, point.bt, `${formatValue(point.bt, 1)} nT`, btColor(point.bt))),
      latestLabel: latest ? `${formatValue(latest.bt, 1)}` : '--',
    },
    {
      id: 'density',
      label: 'Np',
      unit: 'cm^-3',
      cells: heatmapPoints.map(point => cell(point, point.density, `${formatValue(point.density, 1)} cm^-3`, densityColor(point.density))),
      latestLabel: latest ? `${formatValue(latest.density, 1)}` : '--',
    },
  ];
}

async function buildMlSeries(
  sourceSamples: ResolvedL1EventSample[],
  visibleSamples: ResolvedL1EventSample[],
  distanceKm: number,
): Promise<{ points: L1ForecastSeriesPoint[]; available: boolean }> {
  const artifact = await loadMlModel();
  if (!artifact) return { points: [], available: false };

  const mlSamples: L1EarthSample[] = sourceSamples.map(sample => ({
    ms: sample.ms,
    speed: toFinite(sample.speedKmS),
    density: toFinite(sample.densityPerCm3),
    bt: toFinite(sample.btNt),
    bz: toFinite(sample.bzNt),
  }));
  const arrivalTimes = visibleSamples
    .filter(sample => sample.speedKmS !== null && Number.isFinite(sample.speedKmS) && sample.speedKmS > 0)
    .map(sample => sample.ms + (distanceKm / (sample.speedKmS as number)) * 1000);

  if (arrivalTimes.length === 0) return { points: [], available: true };

  const options = { imputeMissing: true, anchorToInput: true };
  const [speed, density, bt, bz] = await Promise.all([
    Promise.resolve(predictAtTimes(artifact, mlSamples, 'speed', arrivalTimes, options)),
    Promise.resolve(predictAtTimes(artifact, mlSamples, 'density', arrivalTimes, options)),
    Promise.resolve(predictAtTimes(artifact, mlSamples, 'bt', arrivalTimes, options)),
    Promise.resolve(predictAtTimes(artifact, mlSamples, 'bz', arrivalTimes, options)),
  ]);

  const points = arrivalTimes.map((t, index) => ({
    t,
    speed: speed[index],
    density: density[index],
    bt: bt[index],
    bz: bz[index],
  }));

  return {
    points: downsamplePoints(points, MAX_CHART_POINTS),
    available: points.some(point => point.speed !== null || point.density !== null || point.bt !== null || point.bz !== null),
  };
}

export async function buildL1ForecastPanelData(): Promise<L1ForecastPanelData> {
  const nowMs = Date.now();
  const [history, electronFlux] = await Promise.all([
    fetchLiveL1History(),
    fetchAceEpamElectronFlux({ startMs: nowMs - HISTORY_WINDOW_MS, endMs: nowMs + 5 * 60 * 1000, maxPoints: MAX_CHART_POINTS }),
  ]);
  const warnings: string[] = [];
  if (history.errorMessage) warnings.push(history.errorMessage);
  if (electronFlux.warning) warnings.push(electronFlux.warning);

  const allSamples = history.samples
    .filter(sample => Number.isFinite(sample.ms))
    .sort((a, b) => a.ms - b.ms);
  const newestMs = allSamples.length ? allSamples[allSamples.length - 1].ms : nowMs;
  const visibleSamples = allSamples.filter(sample => sample.ms >= newestMs - HISTORY_WINDOW_MS);
  const propagationDistanceKm = Number.isFinite(history.mruDistanceKm) && history.mruDistanceKm > 0
    ? history.mruDistanceKm
    : NOMINAL_L1_DISTANCE_KM;
  const displayDistanceKm = Number.isFinite(history.distanceKm) && history.distanceKm > 0
    ? history.distanceKm
    : propagationDistanceKm;

  const detected = downsamplePoints(visibleSamples.map(toSeriesPoint), MAX_CHART_POINTS);
  const forecast = downsamplePoints(
    propagateL1Series(visibleSamples.map(toL1Sample), propagationDistanceKm).map(sample => ({
      t: new Date(sample.arrivalTimeUtc).getTime(),
      speed: sample.speedKmS,
      density: sample.densityPerCm3,
      bt: sample.btNt,
      bz: sample.bzNt,
    })),
    MAX_CHART_POINTS,
  );
  const ml = await buildMlSeries(allSamples, visibleSamples, propagationDistanceKm);
  if (!ml.available) warnings.push('ML model overlay unavailable.');

  const latestSample = allSamples[allSamples.length - 1] ?? null;
  const latestL1 = latestSample ? toL1Sample(latestSample) : null;
  const latestForecast = latestL1 ? propagateL1Sample(latestL1, propagationDistanceKm) : null;
  const latestG = latestSample
    ? classifyGFromKp(kpFromCoupling(mergingFieldMvM(latestSample.speedKmS, latestSample.bzNt), latestSample.speedKmS))
    : classifyGFromKp(null);
  const latestKp = latestSample
    ? kpFromCoupling(mergingFieldMvM(latestSample.speedKmS, latestSample.bzNt), latestSample.speedKmS)
    : null;

  const heatmapPoints = forecast.filter(point => point.t >= nowMs - HEATMAP_PAST_MS && point.t <= nowMs + HEATMAP_FUTURE_MS);
  const fallbackHeatmapPoints = heatmapPoints.length ? heatmapPoints : forecast.slice(-MAX_HEATMAP_CELLS);
  const heatmapStart = fallbackHeatmapPoints.length ? fallbackHeatmapPoints[0].t : null;
  const heatmapEnd = fallbackHeatmapPoints.length ? fallbackHeatmapPoints[fallbackHeatmapPoints.length - 1].t : null;
  const geomagneticForecast = summarizeGeomagneticForecast(forecast, nowMs);

  return {
    generatedAtMs: nowMs,
    generatedAtUtc: new Date(nowMs).toISOString(),
    sourceLabel: history.sourceLabel,
    freshness: history.freshness,
    latestSampleAgeMinutes: history.latestSampleAgeMinutes,
    distanceKm: displayDistanceKm,
    distanceIsMeasured: history.distanceIsMeasured,
    mlAvailable: ml.available,
    warnings,
    latest: {
      sampleTimeUtc: latestSample ? new Date(latestSample.ms).toISOString() : null,
      speed: latestSample ? toFinite(latestSample.speedKmS) : null,
      density: latestSample ? toFinite(latestSample.densityPerCm3) : null,
      bt: latestSample ? toFinite(latestSample.btNt) : null,
      bz: latestSample ? toFinite(latestSample.bzNt) : null,
      transitMinutes: latestForecast ? latestForecast.lagMinutes : null,
      arrivalUtc: latestForecast?.arrivalTimeUtc ?? null,
      gLevel: latestG.level,
      gCode: latestG.code,
      kp: latestKp === null ? null : Math.round(latestKp * 10) / 10,
    },
    series: {
      detected,
      forecast,
      ml: ml.points,
    },
    electronFlux,
    heatmap: {
      startMs: heatmapStart,
      endMs: heatmapEnd,
      rows: buildHeatmapRows(fallbackHeatmapPoints),
    },
    geomagneticForecast,
  };
}
