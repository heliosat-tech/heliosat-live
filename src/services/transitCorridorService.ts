import { fetchLiveL1History } from './liveL1HistoryService';
import { propagateL1Series, NOMINAL_L1_DISTANCE_KM, type L1Sample } from './mruForecastService';
import { sliceArchive } from './omniArchiveStore';
import { sliceAceArchive } from './aceArchiveStore';
import type { L1EventSample } from './liveEventService';
import {
  resolvePhysicalDriverSample,
  type PhysicalDriverCandidate,
  type PhysicalDriverSourceId,
  type PhysicalDriverVariable,
} from './physicalDriverResolutionService';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const LIVE_SOURCE_LABEL = 'L1 · active RTSW';
const ACE_SOURCE_LABEL = 'ACE L1 archive';
const OMNI_SOURCE_LABEL = 'Internal historical reference fallback';
const LIVE_ALIGNMENT_TOLERANCE_MS = 2 * MINUTE;
const ARCHIVE_ALIGNMENT_TOLERANCE_MS = 30 * MINUTE;

export const TRANSIT_CORRIDOR_TARGET = 2000;

export const TRANSIT_CORRIDOR_WINDOWS: Record<string, { source: 'live' | 'archive'; days: number }> = {
  '24h': { source: 'live', days: 1 },
  '7d': { source: 'live', days: 7 },
  '30d': { source: 'archive', days: 31 },
  '90d': { source: 'archive', days: 92 },
  '1y': { source: 'archive', days: 366 },
};

export interface TransitCorridorSources {
  speedKmS: string | null;
  bzNt: string | null;
  btNt: string | null;
  densityPerCm3: string | null;
  gLevel: string | null;
}

export interface TransitCorridorPoint {
  t: number;
  level: number;
  riskAvailable: boolean;
  detectedMs: number | null;
  leadTimeMinutes: number | null;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
  pdynNpa: number | null;
  emMvM: number | null;
  sources: TransitCorridorSources;
  sourceByVariable: Record<PhysicalDriverVariable, PhysicalDriverSourceId | null>;
  sourceTimeByVariable: Record<PhysicalDriverVariable, string | null>;
  missingVariables: PhysicalDriverVariable[];
  qualityFlags: string[];
}

export interface TransitCorridorSeries {
  window: string;
  startMs: number;
  endMs: number;
  gForecast: TransitCorridorPoint[];
  coverage: TransitCorridorCoverageDiagnostics;
}

export interface TransitCorridorCoverageDiagnostics {
  window: string;
  totalBins: number;
  available: Record<'speed' | 'bz' | 'bt' | 'density' | 'pdyn' | 'em' | 'gRisk', number>;
  missing: Record<'speed' | 'bz' | 'bt' | 'density' | 'pdyn' | 'em' | 'gRisk', number>;
  sourceCounts: Partial<Record<PhysicalDriverSourceId, number>>;
  largestGaps: Array<{
    variable: 'speed' | 'bz' | 'bt' | 'density' | 'pdyn' | 'em' | 'gRisk';
    startUtc: string;
    endUtc: string;
    durationMinutes: number;
    reason: 'no_source_within_tolerance';
  }>;
}

function physicalCoverageScore(point: {
  riskAvailable?: boolean;
  speedKmS?: number | null;
  bzNt?: number | null;
  btNt?: number | null;
  densityPerCm3?: number | null;
}) {
  return (point.riskAvailable ? 4 : 0)
    + (point.speedKmS !== null && point.speedKmS !== undefined ? 1 : 0)
    + (point.bzNt !== null && point.bzNt !== undefined ? 1 : 0)
    + (point.btNt !== null && point.btNt !== undefined ? 1 : 0)
    + (point.densityPerCm3 !== null && point.densityPerCm3 !== undefined ? 1 : 0);
}

export function maxPoolTransitCorridor<T extends { level: number } & Parameters<typeof physicalCoverageScore>[0]>(points: T[], target: number): T[] {
  if (points.length <= target) return points;
  const bucket = Math.ceil(points.length / target);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += bucket) {
    let best = points[i];
    for (let j = i + 1; j < Math.min(i + bucket, points.length); j += 1) {
      if (points[j].level > best.level || (points[j].level === best.level && physicalCoverageScore(points[j]) > physicalCoverageScore(best))) {
        best = points[j];
      }
    }
    out.push(best);
  }
  return out;
}

const toL1 = (s: L1EventSample): L1Sample => ({
  timeUtc: new Date(s.ms).toISOString(),
  speedKmS: s.speedKmS,
  densityPerCm3: s.densityPerCm3,
  bzNt: s.bzNt,
  btNt: s.btNt,
  temperatureK: null,
});

const blankSources = (): TransitCorridorSources => ({
  speedKmS: null,
  bzNt: null,
  btNt: null,
  densityPerCm3: null,
  gLevel: null,
});

function candidatesFromL1(
  samples: L1EventSample[],
  distanceKm: number,
  start: number,
  now: number,
  sourceId: PhysicalDriverSourceId,
  sourceLabel: string,
  priority: number,
): PhysicalDriverCandidate[] {
  const asL1 = samples.map(toL1);
  return propagateL1Series(asL1, distanceKm)
    .map(p => {
      return {
        timeMs: new Date(p.arrivalTimeUtc).getTime(),
        observedMs: new Date(p.l1TimeUtc).getTime(),
        sourceId,
        sourceLabel,
        priority,
        speedKmS: p.speedKmS,
        bzGsmNt: p.bzNt,
        btNt: p.btNt,
        densityCm3: p.densityPerCm3,
      };
    })
    .filter(p => p.timeMs >= start && p.timeMs <= now);
}

function arrivalAlignedArchiveCandidate(s: L1EventSample): PhysicalDriverCandidate {
  return {
    timeMs: s.ms,
    observedMs: null,
    sourceId: 'omni_reference',
    sourceLabel: OMNI_SOURCE_LABEL,
    priority: 3,
    speedKmS: s.speedKmS,
    bzGsmNt: s.bzNt,
    btNt: s.btNt,
    densityCm3: s.densityPerCm3,
  };
}

function pointFromResolved(t: number, candidates: PhysicalDriverCandidate[], toleranceMs: number): TransitCorridorPoint {
  const resolved = resolvePhysicalDriverSample(t, candidates, { toleranceMs });
  const sources = blankSources();
  sources.speedKmS = resolved.sourceLabelByVariable.speed;
  sources.bzNt = resolved.sourceLabelByVariable.bz;
  sources.btNt = resolved.sourceLabelByVariable.bt;
  sources.densityPerCm3 = resolved.sourceLabelByVariable.density;
  sources.gLevel = resolved.riskAvailable
    ? Array.from(new Set([sources.speedKmS, sources.bzNt].filter((s): s is string => !!s))).join(' + ') || null
    : null;
  const detectedMs = resolved.sourceTimeByVariable.speed ? new Date(resolved.sourceTimeByVariable.speed).getTime() : null;
  return {
    t,
    level: resolved.derived.estimatedGLevel ?? 0,
    riskAvailable: resolved.riskAvailable,
    detectedMs,
    leadTimeMinutes: detectedMs !== null ? Math.round((t - detectedMs) / MINUTE) : null,
    speedKmS: resolved.speedKmS,
    bzNt: resolved.bzGsmNt,
    btNt: resolved.btNt,
    densityPerCm3: resolved.densityCm3,
    pdynNpa: resolved.derived.pdynNpa,
    emMvM: resolved.derived.emMvM,
    sources,
    sourceByVariable: resolved.sourceByVariable,
    sourceTimeByVariable: resolved.sourceTimeByVariable,
    missingVariables: resolved.missingVariables,
    qualityFlags: resolved.qualityFlags,
  };
}

function buildHourlyBins(start: number, end: number) {
  const first = Math.ceil(start / HOUR) * HOUR;
  const bins: number[] = [];
  for (let t = first; t <= end; t += HOUR) bins.push(t);
  return bins;
}

function availableFor(point: TransitCorridorPoint, variable: keyof TransitCorridorCoverageDiagnostics['available']) {
  if (variable === 'speed') return point.speedKmS !== null;
  if (variable === 'bz') return point.bzNt !== null;
  if (variable === 'bt') return point.btNt !== null;
  if (variable === 'density') return point.densityPerCm3 !== null;
  if (variable === 'pdyn') return point.pdynNpa !== null;
  if (variable === 'em') return point.emMvM !== null;
  return point.riskAvailable;
}

function buildLargestGaps(points: TransitCorridorPoint[], variables: Array<keyof TransitCorridorCoverageDiagnostics['available']>) {
  const gaps: TransitCorridorCoverageDiagnostics['largestGaps'] = [];
  for (const variable of variables) {
    let current: { start: number; end: number } | null = null;
    const variableGaps: Array<{ start: number; end: number }> = [];
    for (const point of points) {
      if (!availableFor(point, variable)) {
        current = current ? { start: current.start, end: point.t } : { start: point.t, end: point.t };
      } else if (current) {
        variableGaps.push(current);
        current = null;
      }
    }
    if (current) variableGaps.push(current);
    variableGaps
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))
      .slice(0, 2)
      .forEach(gap => {
        gaps.push({
          variable,
          startUtc: new Date(gap.start).toISOString(),
          endUtc: new Date(gap.end + HOUR).toISOString(),
          durationMinutes: Math.round((gap.end + HOUR - gap.start) / MINUTE),
          reason: 'no_source_within_tolerance',
        });
      });
  }
  return gaps.sort((a, b) => b.durationMinutes - a.durationMinutes).slice(0, 8);
}

function buildCoverage(window: string, points: TransitCorridorPoint[]): TransitCorridorCoverageDiagnostics {
  const variables = ['speed', 'bz', 'bt', 'density', 'pdyn', 'em', 'gRisk'] as const;
  const available = Object.fromEntries(variables.map(variable => [variable, 0])) as TransitCorridorCoverageDiagnostics['available'];
  const sourceCounts: Partial<Record<PhysicalDriverSourceId, number>> = {};
  for (const point of points) {
    for (const variable of variables) {
      if (availableFor(point, variable)) available[variable] += 1;
    }
    for (const variable of ['speed', 'bz', 'bt', 'density'] as const) {
      const source = point.sourceByVariable[variable];
      if (source) sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
    }
  }
  const missing = Object.fromEntries(variables.map(variable => [variable, points.length - available[variable]])) as TransitCorridorCoverageDiagnostics['missing'];
  return {
    window,
    totalBins: points.length,
    available,
    missing,
    sourceCounts,
    largestGaps: buildLargestGaps(points, [...variables]),
  };
}

async function buildTransitCorridorPoints(source: 'live' | 'archive', days: number, now: number): Promise<{ startMs: number; endMs: number; points: TransitCorridorPoint[] }> {
  const start = now - days * DAY;

  const history = await fetchLiveL1History();
  const liveSamples = history.samples.slice().sort((a, b) => a.ms - b.ms);
  const liveCandidates = candidatesFromL1(liveSamples, history.distanceKm, start, now, 'swpc_rtsw', LIVE_SOURCE_LABEL, 1);

  if (source === 'live') {
    const times = [...new Set(liveCandidates.map(candidate => candidate.timeMs))]
      .filter(t => t >= start && t <= now)
      .sort((a, b) => a - b);
    return { startMs: start, endMs: now, points: times.map(t => pointFromResolved(t, liveCandidates, LIVE_ALIGNMENT_TOLERANCE_MS)) };
  }

  const candidates: PhysicalDriverCandidate[] = [];
  const omni = await sliceArchive(start, now);
  if (omni && omni.samples.length > 0) candidates.push(...omni.samples.map(arrivalAlignedArchiveCandidate));
  const ace = await sliceAceArchive(start, now);
  if (ace && ace.samples.length > 0) candidates.push(...candidatesFromL1(ace.samples, NOMINAL_L1_DISTANCE_KM, start, now, 'ace_archive', ACE_SOURCE_LABEL, 2));
  candidates.push(...liveCandidates);

  const points = buildHourlyBins(start, now).map(t => pointFromResolved(t, candidates, ARCHIVE_ALIGNMENT_TOLERANCE_MS));
  return { startMs: start, endMs: now, points };
}

export async function buildTransitCorridorSeries(options: {
  windowKey: string;
  nowMs?: number;
  maxPoints?: number | null;
}): Promise<TransitCorridorSeries> {
  const window = options.windowKey in TRANSIT_CORRIDOR_WINDOWS ? options.windowKey : '7d';
  const cfg = TRANSIT_CORRIDOR_WINDOWS[window];
  const now = options.nowMs ?? Date.now();
  const { startMs, endMs, points } = await buildTransitCorridorPoints(cfg.source, cfg.days, now);
  const gForecast = options.maxPoints === null ? points : maxPoolTransitCorridor(points, options.maxPoints ?? TRANSIT_CORRIDOR_TARGET);
  return { window, startMs, endMs, gForecast, coverage: buildCoverage(window, points) };
}
