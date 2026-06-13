/**
 * NOAA SWPC connector.
 *
 * Primary: the new multi-spacecraft RTSW JSON under services.swpc.noaa.gov/json/rtsw/
 * (mag / wind / ephemerides as separate files, each an ARRAY OF OBJECTS carrying
 * every available spacecraft tagged with `source` and an `active` flag — SWPC's
 * designated source for that data type, which it can switch at any time and which
 * can differ between mag and plasma). We never hardcode the spacecraft: active
 * records are preferred per variable, with any other available spacecraft as a
 * same-feed fallback.
 *
 * Fallback: the legacy `/products/solar-wind/*-7-day.json` products (header + rows),
 * kept until that endpoint retires (~2026-06-30).
 */

import type { PhysicalDriverCandidate } from '../physicalDriverResolutionService';
import {
  NOMINAL_L1_DISTANCE_KM,
  minuteKey,
  parseMs,
  reliableDistanceKm,
  resolveSamples,
  toNum,
} from './normalize';
import type { L1SourceResult, ScPositionGseKm } from './types';

const RTSW_BASE = 'https://services.swpc.noaa.gov/json/rtsw';
const MAG_NEW = `${RTSW_BASE}/rtsw_mag_1m.json`;
const WIND_NEW = `${RTSW_BASE}/rtsw_wind_1m.json`;
const EPHEM_NEW = `${RTSW_BASE}/rtsw_ephemerides_1h.json`;

const MAG_LEGACY = 'https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json';
const PLASMA_LEGACY = 'https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json';
const EPHEM_LEGACY = 'https://services.swpc.noaa.gov/products/solar-wind/ephemerides.json';

const REQUEST_TIMEOUT_MS = 12000;
// Active records sort ahead of any other spacecraft from the same feed.
const PRIORITY_ACTIVE = 1;
const PRIORITY_AVAILABLE = 2;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`SWPC request failed with ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function recordSource(record: Record<string, unknown>): string {
  const source = record.source;
  return typeof source === 'string' && source.trim() ? source.trim() : 'unknown';
}

// SWPC can switch the designated active spacecraft at any time, so the 24 h feed
// holds active records from more than one. The live label is the spacecraft(s)
// active in this trailing window of the newest active record.
const ACTIVE_LABEL_WINDOW_MS = 10 * 60 * 1000;

function swpcLabel(activeAt: Array<{ source: string; ms: number }>, latestAnySource: string | null): string {
  if (activeAt.length) {
    const newestActiveMs = Math.max(...activeAt.map(entry => entry.ms));
    const current = [...new Set(activeAt.filter(entry => entry.ms >= newestActiveMs - ACTIVE_LABEL_WINDOW_MS).map(entry => entry.source))].sort();
    return `SWPC · ${current.join('/')}`;
  }
  return latestAnySource ? `SWPC · ${latestAnySource} (no active flag)` : 'SWPC RTSW';
}

// ---------------------------------------------------------------- new feed ---

function buildFromNewFeed(magRaw: unknown, windRaw: unknown, ephemRaw: unknown): {
  candidates: PhysicalDriverCandidate[];
  distanceKm: number;
  distanceIsMeasured: boolean;
  scPositionGseKm: ScPositionGseKm | null;
  byByMinute: Map<number, number>;
  label: string;
} | null {
  const mag = asArray(magRaw).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
  const wind = asArray(windRaw).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
  if (!mag.length && !wind.length) return null;

  const candidates: PhysicalDriverCandidate[] = [];
  const activeAt: Array<{ source: string; ms: number }> = [];
  // By GSM is not a resolver variable; track it active-preferred per minute alongside.
  const byAt = new Map<number, { value: number; active: boolean }>();
  let latestAnySource: string | null = null;
  let latestAnyMs = -Infinity;

  const note = (source: string, ms: number, isActive: boolean) => {
    if (isActive) activeAt.push({ source, ms });
    if (ms > latestAnyMs) { latestAnyMs = ms; latestAnySource = source; }
  };

  for (const record of mag) {
    const ms = parseMs(record.time_tag);
    if (Number.isNaN(ms)) continue;
    const source = recordSource(record);
    const isActive = record.active === true;
    note(source, ms, isActive);
    const key = minuteKey(ms);
    const byValue = toNum(record.by_gsm);
    if (byValue !== null) {
      const existing = byAt.get(key);
      if (!existing || (isActive && !existing.active)) byAt.set(key, { value: byValue, active: isActive });
    }
    candidates.push({
      timeMs: key,
      observedMs: ms,
      sourceId: 'swpc_rtsw',
      sourceLabel: `SWPC · ${source}`,
      priority: isActive ? PRIORITY_ACTIVE : PRIORITY_AVAILABLE,
      bzGsmNt: toNum(record.bz_gsm),
      btNt: toNum(record.bt),
    });
  }

  for (const record of wind) {
    const ms = parseMs(record.time_tag);
    if (Number.isNaN(ms)) continue;
    const source = recordSource(record);
    const isActive = record.active === true;
    note(source, ms, isActive);
    candidates.push({
      timeMs: minuteKey(ms),
      observedMs: ms,
      sourceId: 'swpc_rtsw',
      sourceLabel: `SWPC · ${source}`,
      priority: isActive ? PRIORITY_ACTIVE : PRIORITY_AVAILABLE,
      speedKmS: toNum(record.proton_speed),
      densityCm3: toNum(record.proton_density),
    });
  }

  // Position from the active ephemeris record, else the newest available one.
  const ephem = asArray(ephemRaw).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
  let distanceKm = NOMINAL_L1_DISTANCE_KM;
  let distanceIsMeasured = false;
  let scPositionGseKm: ScPositionGseKm | null = null;
  let bestEphemMs = -Infinity;
  let bestEphemActive = false;
  for (const record of ephem) {
    const ms = parseMs(record.time_tag);
    if (Number.isNaN(ms)) continue;
    const isActive = record.active === true;
    // Prefer an active record; among equal activeness, the newest.
    const better = (isActive && !bestEphemActive) || ((isActive === bestEphemActive) && ms > bestEphemMs);
    if (!better) continue;
    const x = toNum(record.x_gse);
    const y = toNum(record.y_gse);
    const z = toNum(record.z_gse);
    const measured = reliableDistanceKm(x, y, z);
    if (measured === null) continue;
    distanceKm = measured;
    distanceIsMeasured = true;
    scPositionGseKm = { x: x as number, y: y as number, z: z as number };
    bestEphemMs = ms;
    bestEphemActive = isActive;
  }

  const byByMinute = new Map<number, number>();
  for (const [key, entry] of byAt) byByMinute.set(key, entry.value);

  return { candidates, distanceKm, distanceIsMeasured, scPositionGseKm, byByMinute, label: swpcLabel(activeAt, latestAnySource) };
}

// ------------------------------------------------------------- legacy feed ---

function buildFromLegacy(magRaw: unknown, plasmaRaw: unknown, ephemRaw: unknown): {
  candidates: PhysicalDriverCandidate[];
  distanceKm: number;
  distanceIsMeasured: boolean;
  scPositionGseKm: ScPositionGseKm | null;
} | null {
  const mag = asArray(magRaw);
  const plasma = asArray(plasmaRaw);
  if (mag.length <= 1 && plasma.length <= 1) return null;

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
      sourceId: 'swpc_legacy',
      sourceLabel: 'SWPC · legacy RTSW',
      priority: PRIORITY_ACTIVE,
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
      sourceId: 'swpc_legacy',
      sourceLabel: 'SWPC · legacy RTSW',
      priority: PRIORITY_ACTIVE,
      speedKmS: speedIdx >= 0 ? toNum(row[speedIdx]) : null,
      densityCm3: densityIdx >= 0 ? toNum(row[densityIdx]) : null,
    });
  }

  const ephem = asArray(ephemRaw);
  const ephemCols = columnIndex(ephem);
  const xi = ephemCols.x_gse ?? -1;
  const yi = ephemCols.y_gse ?? -1;
  const zi = ephemCols.z_gse ?? -1;
  let distanceKm = NOMINAL_L1_DISTANCE_KM;
  let distanceIsMeasured = false;
  let scPositionGseKm: ScPositionGseKm | null = null;
  if (xi >= 0 && yi >= 0 && zi >= 0 && ephem.length > 1) {
    const last = ephem[ephem.length - 1];
    if (Array.isArray(last)) {
      const x = toNum(last[xi]);
      const y = toNum(last[yi]);
      const z = toNum(last[zi]);
      const measured = reliableDistanceKm(x, y, z);
      if (measured !== null) {
        distanceKm = measured;
        distanceIsMeasured = true;
        scPositionGseKm = { x: x as number, y: y as number, z: z as number };
      }
    }
  }

  return { candidates, distanceKm, distanceIsMeasured, scPositionGseKm };
}

type NewFeed = ReturnType<typeof buildFromNewFeed>;
type LegacyFeed = ReturnType<typeof buildFromLegacy>;

async function fetchNewFeed(): Promise<NewFeed> {
  const [mag, wind, ephem] = await Promise.all([
    fetchJson(MAG_NEW),
    fetchJson(WIND_NEW),
    fetchJson(EPHEM_NEW).catch(() => [] as unknown[]),
  ]);
  return buildFromNewFeed(mag, wind, ephem);
}

async function fetchLegacyFeed(): Promise<LegacyFeed> {
  const [mag, plasma, ephem] = await Promise.all([
    fetchJson(MAG_LEGACY),
    fetchJson(PLASMA_LEGACY),
    fetchJson(EPHEM_LEGACY).catch(() => [] as unknown[]),
  ]);
  return buildFromLegacy(mag, plasma, ephem);
}

const candidateMs = (candidate: PhysicalDriverCandidate): number => candidate.observedMs ?? candidate.timeMs;

/**
 * The SWPC source for this poll. The new multi-spacecraft feed drives the recent
 * window (last 24 h, active-aware); the legacy 7-day products extend the history
 * backward beyond the new feed for chart depth, and stand in entirely when the new
 * feed is down — until that endpoint retires (~2026-06-30). Always resolves (an
 * empty result with an error message) rather than throwing, so the selection layer
 * can still consider the other pipeline.
 */
export async function fetchSwpc(): Promise<L1SourceResult> {
  const [newFeed, legacy] = await Promise.all([
    fetchNewFeed().catch(() => null),
    fetchLegacyFeed().catch(() => null),
  ]);

  const newCandidates = newFeed?.candidates ?? [];
  const hasNewFeed = newCandidates.length > 0;
  // Only the legacy tail older than the new feed extends the history — the recent
  // window stays multi-spacecraft and active-aware, with no legacy overlap.
  const newEarliestMs = hasNewFeed ? Math.min(...newCandidates.map(candidateMs)) : Number.POSITIVE_INFINITY;
  const legacyTail = (legacy?.candidates ?? []).filter(candidate => candidateMs(candidate) < newEarliestMs);
  const samples = resolveSamples([...newCandidates, ...legacyTail]);
  // Position and label come from the new feed when it produced data, else legacy.
  const scPositionGseKm = newFeed?.scPositionGseKm ?? legacy?.scPositionGseKm ?? null;

  if (!samples.length) {
    return {
      sourceId: hasNewFeed ? 'swpc_rtsw' : 'swpc_legacy',
      sourceLabel: 'SWPC RTSW',
      samples: [],
      distanceKm: NOMINAL_L1_DISTANCE_KM,
      distanceIsMeasured: false,
      scPositionGseKm,
      latestSampleMs: null,
      errorMessage: 'SWPC returned no usable samples (new feed and legacy both unavailable).',
    };
  }

  // By GSM is carried only by the new feed; attach it to the resolved samples by minute.
  if (newFeed) {
    for (const sample of samples) sample.byNt = newFeed.byByMinute.get(sample.ms) ?? null;
  }

  const distanceIsMeasured = (hasNewFeed && newFeed!.distanceIsMeasured) || (!hasNewFeed && (legacy?.distanceIsMeasured ?? false));
  const distanceKm = hasNewFeed && newFeed!.distanceIsMeasured
    ? newFeed!.distanceKm
    : legacy?.distanceIsMeasured ? legacy.distanceKm : NOMINAL_L1_DISTANCE_KM;

  return {
    sourceId: hasNewFeed ? 'swpc_rtsw' : 'swpc_legacy',
    sourceLabel: hasNewFeed ? newFeed!.label : 'SWPC · legacy RTSW',
    samples,
    distanceKm,
    distanceIsMeasured,
    scPositionGseKm,
    latestSampleMs: samples[samples.length - 1].ms,
    errorMessage: null,
  };
}
