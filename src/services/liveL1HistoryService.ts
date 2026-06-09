/**
 * Multi-day L1 solar-wind history from NOAA SWPC real-time products, aligned into
 * the sample shape the live-event detector consumes. The live panel feeds use the
 * 2-hour product; for an accumulating EVENT LOG we pull the 7-day mag + plasma
 * products so the history is populated and older events can be verified at once.
 */

import type { L1EventSample } from './liveEventService';
import {
  resolvePhysicalDriverSample,
  type PhysicalDriverCandidate,
  type PhysicalDriverSourceId,
  type PhysicalDriverVariable,
} from './physicalDriverResolutionService';

const MAG_7DAY = 'https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json';
const PLASMA_7DAY = 'https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json';
const EPHEMERIS = 'https://services.swpc.noaa.gov/products/solar-wind/ephemerides.json';
const REQUEST_TIMEOUT_MS = 12000;
const LIVE_ALIGNMENT_TOLERANCE_MS = 2 * 60 * 1000;
const ACTIVE_RTSW_SOURCE_LABEL = 'L1 · active RTSW';

const NOMINAL_L1_DISTANCE_KM = 1_500_000;
const MIN_RELIABLE_KM = 500_000;
const MAX_RELIABLE_KM = 2_500_000;

export interface ResolvedL1EventSample extends L1EventSample {
  sourceByVariable: Record<PhysicalDriverVariable, PhysicalDriverSourceId | null>;
  sourceLabelByVariable: Record<PhysicalDriverVariable, string | null>;
  sourceTimeByVariable: Record<PhysicalDriverVariable, string | null>;
  missingVariables: PhysicalDriverVariable[];
  qualityFlags: string[];
  riskAvailable: boolean;
  pdynNpa: number | null;
  emMvM: number | null;
  estimatedGLevel: number | null;
}

export interface L1HistoryResult {
  samples: ResolvedL1EventSample[];
  distanceKm: number;
  distanceIsMeasured: boolean;
  errorMessage: string | null;
}

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

/** "products" arrays are [header, ...rows]; build a column index map. */
function columnIndex(table: unknown[]): Record<string, number> {
  const header = table[0];
  const map: Record<string, number> = {};
  if (Array.isArray(header)) {
    header.forEach((name, index) => {
      if (typeof name === 'string') map[name] = index;
    });
  }
  return map;
}

/** Round a timestamp to the minute so mag and plasma rows align. */
function minuteKey(ms: number): number {
  return Math.round(ms / 60000) * 60000;
}

export async function fetchLiveL1History(): Promise<L1HistoryResult> {
  try {
    const [mag, plasma, ephem] = await Promise.all([
      fetchProduct(MAG_7DAY),
      fetchProduct(PLASMA_7DAY),
      fetchProduct(EPHEMERIS).catch(() => [] as unknown[]),
    ]);

    const magCols = columnIndex(mag);
    const plasmaCols = columnIndex(plasma);
    const bzIdx = magCols.bz_gsm ?? -1;
    const btIdx = magCols.bt ?? -1;
    const speedIdx = plasmaCols.speed ?? -1;
    const densityIdx = plasmaCols.density ?? -1;

    const candidates: PhysicalDriverCandidate[] = [];
    for (let i = 1; i < mag.length; i += 1) {
      const row = mag[i];
      if (!Array.isArray(row)) continue;
      const ms = parseMs(row[0]);
      if (Number.isNaN(ms)) continue;
      candidates.push({
        timeMs: minuteKey(ms),
        observedMs: ms,
        sourceId: 'swpc_rtsw',
        sourceLabel: ACTIVE_RTSW_SOURCE_LABEL,
        priority: 1,
        bzGsmNt: bzIdx >= 0 ? toNum(row[bzIdx]) : null,
        btNt: btIdx >= 0 ? toNum(row[btIdx]) : null,
      });
    }

    for (let i = 1; i < plasma.length; i += 1) {
      const row = plasma[i];
      if (!Array.isArray(row)) continue;
      const ms = parseMs(row[0]);
      if (Number.isNaN(ms)) continue;
      candidates.push({
        timeMs: minuteKey(ms),
        observedMs: ms,
        sourceId: 'swpc_rtsw',
        sourceLabel: ACTIVE_RTSW_SOURCE_LABEL,
        priority: 1,
        speedKmS: speedIdx >= 0 ? toNum(row[speedIdx]) : null,
        densityCm3: densityIdx >= 0 ? toNum(row[densityIdx]) : null,
      });
    }

    // L1 distance from the latest ephemeris point, if reliable.
    let distanceKm = NOMINAL_L1_DISTANCE_KM;
    let distanceIsMeasured = false;
    const ephemCols = columnIndex(ephem);
    const xi = ephemCols.x_gse ?? -1;
    const yi = ephemCols.y_gse ?? -1;
    const zi = ephemCols.z_gse ?? -1;
    if (xi >= 0 && yi >= 0 && zi >= 0 && ephem.length > 1) {
      const last = ephem[ephem.length - 1];
      if (Array.isArray(last)) {
        const x = toNum(last[xi]);
        const y = toNum(last[yi]);
        const z = toNum(last[zi]);
        if (x !== null && y !== null && z !== null) {
          const measured = Math.sqrt(x * x + y * y + z * z);
          if (measured >= MIN_RELIABLE_KM && measured <= MAX_RELIABLE_KM) {
            distanceKm = measured;
            distanceIsMeasured = true;
          }
        }
      }
    }

    const targetTimes = [...new Set(candidates.map(candidate => candidate.timeMs))]
      .filter(ms => Number.isFinite(ms))
      .sort((a, b) => a - b);
    const samples = targetTimes
      .map((ms): ResolvedL1EventSample => {
        const resolved = resolvePhysicalDriverSample(ms, candidates, { toleranceMs: LIVE_ALIGNMENT_TOLERANCE_MS });
        return {
          ms,
          speedKmS: resolved.speedKmS,
          densityPerCm3: resolved.densityCm3,
          bzNt: resolved.bzGsmNt,
          btNt: resolved.btNt,
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

    return { samples, distanceKm, distanceIsMeasured, errorMessage: null };
  } catch (error) {
    return {
      samples: [],
      distanceKm: NOMINAL_L1_DISTANCE_KM,
      distanceIsMeasured: false,
      errorMessage: error instanceof Error ? error.message : 'NOAA L1 history request failed',
    };
  }
}
