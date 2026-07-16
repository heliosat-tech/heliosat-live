/**
 * Canonical NOAA SWPC RTSW connector.
 *
 * The three `/json/rtsw/` products are arrays of spacecraft-tagged objects. Each
 * minute is resolved independently: SWPC's `active` record has first choice for
 * every physical variable, while another official record from that same minute
 * may fill a null field. Products are fetched independently so a missing magnetic,
 * wind, or ephemeris file does not discard usable data from the others.
 */

import type { PhysicalDriverCandidate } from '../physicalDriverResolutionService';
import {
  NOMINAL_L1_DISTANCE_KM,
  parseMs,
  reliableDistanceKm,
  resolveSamples,
  toNum,
} from './normalize';
import type { L1SourceResult, ScPositionGseKm } from './types';

const RTSW_BASE = 'https://services.swpc.noaa.gov/json/rtsw';
const MAG_URL = `${RTSW_BASE}/rtsw_mag_1m.json`;
const WIND_URL = `${RTSW_BASE}/rtsw_wind_1m.json`;
const EPHEMERIS_URL = `${RTSW_BASE}/rtsw_ephemerides_1h.json`;
const REQUEST_TIMEOUT_MS = 12_000;
const SELECTED_RECORD_PRIORITY = 1;
const ACTIVE_LABEL_WINDOW_MS = 10 * 60 * 1000;

interface RtswRecord {
  record: Record<string, unknown>;
  timestampMs: number;
  active: boolean;
  source: string;
}

interface RtswMinuteGroup {
  minuteMs: number;
  records: RtswRecord[];
}

interface BuiltRtswFeed {
  candidates: PhysicalDriverCandidate[];
  distanceKm: number;
  distanceIsMeasured: boolean;
  scPositionGseKm: ScPositionGseKm | null;
  byByMinute: Map<number, number>;
  label: string;
  magMinutes: number;
  windMinutes: number;
  ephemerisMinutes: number;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      throw new Error(`SWPC request failed with ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isActiveRecord(value: unknown) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function recordSource(record: Record<string, unknown>): string {
  const source = record.source;
  return typeof source === 'string' && source.trim() ? source.trim() : 'unknown';
}

function minuteBucket(timestampMs: number) {
  return Math.floor(timestampMs / 60_000) * 60_000;
}

function comparePreferredRecord(a: RtswRecord, b: RtswRecord) {
  if (a.active !== b.active) {
    return a.active ? -1 : 1;
  }

  if (a.timestampMs !== b.timestampMs) {
    return b.timestampMs - a.timestampMs;
  }

  return a.source.localeCompare(b.source);
}

function groupRecordsByMinute(raw: unknown): RtswMinuteGroup[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const grouped = new Map<number, RtswRecord[]>();

  for (const value of raw) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }

    const record = value as Record<string, unknown>;
    const timestampMs = parseMs(record.time_tag);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }

    const minuteMs = minuteBucket(timestampMs);
    const candidate: RtswRecord = {
      record,
      timestampMs,
      active: isActiveRecord(record.active),
      source: recordSource(record),
    };
    grouped.set(minuteMs, [...(grouped.get(minuteMs) ?? []), candidate]);
  }

  return [...grouped.entries()]
    .map(([minuteMs, records]) => ({
      minuteMs,
      records: records.sort(comparePreferredRecord),
    }))
    .sort((a, b) => a.minuteMs - b.minuteMs);
}

function swpcLabel(activeAt: Array<{ source: string; ms: number }>, latestAnySource: string | null) {
  if (activeAt.length > 0) {
    const newestActiveMs = Math.max(...activeAt.map(entry => entry.ms));
    const current = [
      ...new Set(
        activeAt
          .filter(entry => entry.ms >= newestActiveMs - ACTIVE_LABEL_WINDOW_MS)
          .map(entry => entry.source),
      ),
    ].sort();
    return `SWPC · ${current.join('/')}`;
  }

  return latestAnySource ? `SWPC · ${latestAnySource} (no active flag)` : 'SWPC RTSW';
}

function buildFromRtswFeed(magRaw: unknown, windRaw: unknown, ephemerisRaw: unknown): BuiltRtswFeed {
  const magGroups = groupRecordsByMinute(magRaw);
  const windGroups = groupRecordsByMinute(windRaw);
  const ephemerisGroups = groupRecordsByMinute(ephemerisRaw);
  const candidates: PhysicalDriverCandidate[] = [];
  const byByMinute = new Map<number, number>();
  const activeAt: Array<{ source: string; ms: number }> = [];
  let latestAnySource: string | null = null;
  let latestAnyMs = -Infinity;

  const noteRecord = (record: RtswRecord) => {
    if (record.active) {
      activeAt.push({ source: record.source, ms: record.timestampMs });
    }
    if (record.timestampMs > latestAnyMs) {
      latestAnyMs = record.timestampMs;
      latestAnySource = record.source;
    }
  };

  for (const group of magGroups) {
    for (const selected of group.records) {
      noteRecord(selected);
      const bzGsmNt = toNum(selected.record.bz_gsm);
      const btNt = toNum(selected.record.bt);
      const byGsmNt = toNum(selected.record.by_gsm);

      if (byGsmNt !== null && !byByMinute.has(group.minuteMs)) {
        byByMinute.set(group.minuteMs, byGsmNt);
      }

      if (bzGsmNt === null && btNt === null) {
        continue;
      }

      candidates.push({
        timeMs: group.minuteMs,
        observedMs: selected.timestampMs,
        sourceId: 'swpc_rtsw',
        sourceLabel: `SWPC · ${selected.source}`,
        priority: SELECTED_RECORD_PRIORITY,
        bzGsmNt,
        btNt,
      });
    }
  }

  for (const group of windGroups) {
    for (const selected of group.records) {
      noteRecord(selected);
      const speedKmS = toNum(selected.record.proton_speed);
      const densityCm3 = toNum(selected.record.proton_density);

      if (speedKmS === null && densityCm3 === null) {
        continue;
      }

      candidates.push({
        timeMs: group.minuteMs,
        observedMs: selected.timestampMs,
        sourceId: 'swpc_rtsw',
        sourceLabel: `SWPC · ${selected.source}`,
        priority: SELECTED_RECORD_PRIORITY,
        speedKmS,
        densityCm3,
      });
    }
  }

  let distanceKm = NOMINAL_L1_DISTANCE_KM;
  let distanceIsMeasured = false;
  let scPositionGseKm: ScPositionGseKm | null = null;

  // Search newest minute first; within it, active first and then official fallback.
  for (let groupIndex = ephemerisGroups.length - 1; groupIndex >= 0 && !distanceIsMeasured; groupIndex -= 1) {
    for (const selected of ephemerisGroups[groupIndex].records) {
      const x = toNum(selected.record.x_gse);
      const y = toNum(selected.record.y_gse);
      const z = toNum(selected.record.z_gse);
      const measured = reliableDistanceKm(x, y, z);
      if (measured === null) {
        continue;
      }

      distanceKm = measured;
      distanceIsMeasured = true;
      scPositionGseKm = { x: x as number, y: y as number, z: z as number };
      break;
    }
  }

  return {
    candidates,
    distanceKm,
    distanceIsMeasured,
    scPositionGseKm,
    byByMinute,
    label: swpcLabel(activeAt, latestAnySource),
    magMinutes: magGroups.length,
    windMinutes: windGroups.length,
    ephemerisMinutes: ephemerisGroups.length,
  };
}

function resultValue(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled' ? result.value : [];
}

function rejectionMessage(product: string, result: PromiseSettledResult<unknown>) {
  if (result.status === 'fulfilled') {
    return null;
  }

  const detail = result.reason instanceof Error ? result.reason.message : 'request failed';
  return `${product} unavailable (${detail})`;
}

function latestObservationMs(samples: L1SourceResult['samples']): number | null {
  if (samples.length === 0) {
    return null;
  }

  const last = samples[samples.length - 1];
  const observationTimes = Object.values(last.sourceTimeByVariable)
    .map(value => value ? new Date(value).getTime() : Number.NaN)
    .filter(Number.isFinite);

  return observationTimes.length > 0 ? Math.max(...observationTimes) : last.ms;
}

/**
 * Fetch the canonical products without an all-or-nothing dependency between
 * them. An error message may accompany usable samples to expose a partial feed.
 */
export async function fetchSwpc(): Promise<L1SourceResult> {
  const [magResult, windResult, ephemerisResult] = await Promise.allSettled([
    fetchJson(MAG_URL),
    fetchJson(WIND_URL),
    fetchJson(EPHEMERIS_URL),
  ]);
  const feed = buildFromRtswFeed(
    resultValue(magResult),
    resultValue(windResult),
    resultValue(ephemerisResult),
  );
  const partialProblems = [
    rejectionMessage('magnetic field', magResult),
    rejectionMessage('solar wind', windResult),
    rejectionMessage('ephemeris', ephemerisResult),
    magResult.status === 'fulfilled' && feed.magMinutes === 0
      ? 'magnetic field returned no usable object records'
      : null,
    windResult.status === 'fulfilled' && feed.windMinutes === 0
      ? 'solar wind returned no usable object records'
      : null,
    ephemerisResult.status === 'fulfilled' && feed.ephemerisMinutes === 0
      ? 'ephemeris returned no usable object records'
      : null,
  ].filter((message): message is string => message !== null);
  const samples = resolveSamples(feed.candidates);

  for (const sample of samples) {
    sample.byNt = feed.byByMinute.get(sample.ms) ?? null;
  }

  if (samples.length === 0) {
    const detail = partialProblems.length > 0 ? ` ${partialProblems.join('; ')}.` : '';
    return {
      sourceId: 'swpc_rtsw',
      sourceLabel: feed.label,
      samples: [],
      distanceKm: feed.distanceKm,
      distanceIsMeasured: feed.distanceIsMeasured,
      scPositionGseKm: feed.scPositionGseKm,
      latestSampleMs: null,
      errorMessage: `SWPC RTSW returned no usable magnetic-field or solar-wind samples.${detail}`,
    };
  }

  return {
    sourceId: 'swpc_rtsw',
    sourceLabel: feed.label,
    samples,
    distanceKm: feed.distanceKm,
    distanceIsMeasured: feed.distanceIsMeasured,
    scPositionGseKm: feed.scPositionGseKm,
    latestSampleMs: latestObservationMs(samples),
    errorMessage: partialProblems.length > 0
      ? `SWPC RTSW partial feed: ${partialProblems.join('; ')}.`
      : null,
  };
}
