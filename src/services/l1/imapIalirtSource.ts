/**
 * NASA IMAP I-ALiRT connector — a second, independent real-time pipeline.
 *
 * IMAP rides its own ground path and processing, separate from NOAA SWPC, so it
 * provides genuine redundancy: if SWPC lags, I-ALiRT may still be flowing. The
 * fetch is hidden behind a swappable adapter. Today it reads NASA CDAWeb HAPI
 * (IMAP_IALIRT_L1_REALTIME); the adapter boundary lets the lower-latency IMAP SDC
 * realtime API (api.imap-mission.com) drop in later without touching selection.
 *
 * It is a REDUNDANCY source, so it must never dominate latency: every request has
 * a short timeout and no retries, and the whole fetch is bounded by a deadline. If
 * IMAP is slow this poll, SWPC simply wins and IMAP contributes nothing — rather
 * than stalling the shared live path (the console poll, the transit corridor).
 *
 * Output is normalized to the exact same internal sample schema as SWPC.
 */

import type { PhysicalDriverCandidate } from '../physicalDriverResolutionService';
import {
  NOMINAL_L1_DISTANCE_KM,
  minuteKey,
  parseMs,
  reliableDistanceKm,
  resolveSamples,
} from './normalize';
import type { L1SourceResult, ScPositionGseKm } from './types';

const IMAP_LABEL = 'NASA IMAP I-ALiRT';
const HAPI_DATA_URL = 'https://cdaweb.gsfc.nasa.gov/hapi/data';
// Recent window — enough for the live edge plus the inbound corridor (~150 min).
const IMAP_WINDOW_MS = 6 * 60 * 60 * 1000;
// A redundancy source must not stall the primary path: cap each request, and the
// whole adapter, well under a poll interval.
const REQUEST_TIMEOUT_MS = 3500;
const ADAPTER_DEADLINE_MS = 4000;

/** Swappable backend for the I-ALiRT stream (CDAWeb HAPI now, SDC API later). */
export interface ImapIalirtAdapter {
  id: string;
  label: string;
  fetch(nowMs: number): Promise<L1SourceResult>;
}

/** HAPI fill values are large sentinels (e.g. ±1e31); keep only physical numbers. */
function hapiNum(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) >= 1e20) return null;
  return parsed;
}

/** A component of a HAPI vector parameter (returned as a nested array in JSON). */
function vectorComponent(value: unknown, index: number): number | null {
  return Array.isArray(value) ? hapiNum(value[index]) : null;
}

const emptyResult = (errorMessage: string | null): L1SourceResult => ({
  sourceId: 'imap_ialirt',
  sourceLabel: IMAP_LABEL,
  samples: [],
  distanceKm: NOMINAL_L1_DISTANCE_KM,
  distanceIsMeasured: false,
  scPositionGseKm: null,
  latestSampleMs: null,
  errorMessage,
});

/**
 * One HAPI /data request, JSON format (vectors come back as nested arrays). Short
 * timeout, no retries, no /info pre-flight — returns [] on any error so a slow or
 * down CDAWeb never blocks the live path.
 */
async function hapiRows(dataset: string, params: string[], startUtc: string, stopUtc: string): Promise<unknown[][]> {
  const url = new URL(HAPI_DATA_URL);
  url.searchParams.set('id', dataset);
  url.searchParams.set('parameters', params.join(','));
  url.searchParams.set('time.min', startUtc);
  url.searchParams.set('time.max', stopUtc);
  url.searchParams.set('format', 'json');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return [];
    const json = (await response.json()) as { data?: unknown[][] };
    return Array.isArray(json.data) ? json.data : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchViaHapi(nowMs: number): Promise<L1SourceResult> {
  const startUtc = new Date(nowMs - IMAP_WINDOW_MS).toISOString();
  const stopUtc = new Date(nowMs).toISOString();

  const [mag, swapi, ephem] = await Promise.all([
    hapiRows('IMAP_IALIRT_L1_REALTIME@1', ['mag_B_magnitude', 'mag_B_GSM'], startUtc, stopUtc),
    hapiRows('IMAP_IALIRT_L1_REALTIME@2', ['swapi_pseudo_proton_density', 'swapi_pseudo_proton_speed'], startUtc, stopUtc),
    hapiRows('IMAP_IALIRT_L1_REALTIME@4', ['sc_position_GSE'], startUtc, stopUtc),
  ]);

  const candidates: PhysicalDriverCandidate[] = [];
  const byByMinute = new Map<number, number>();

  for (const row of mag) {
    if (!Array.isArray(row)) continue;
    const ms = parseMs(row[0]);
    if (Number.isNaN(ms)) continue;
    const key = minuteKey(ms);
    const by = vectorComponent(row[2], 1); // mag_B_GSM = [Bx, By, Bz]
    if (by !== null) byByMinute.set(key, by);
    candidates.push({
      timeMs: key,
      observedMs: ms,
      sourceId: 'imap_ialirt',
      sourceLabel: IMAP_LABEL,
      priority: 1,
      btNt: hapiNum(row[1]),
      bzGsmNt: vectorComponent(row[2], 2),
    });
  }

  for (const row of swapi) {
    if (!Array.isArray(row)) continue;
    const ms = parseMs(row[0]);
    if (Number.isNaN(ms)) continue;
    candidates.push({
      timeMs: minuteKey(ms),
      observedMs: ms,
      sourceId: 'imap_ialirt',
      sourceLabel: IMAP_LABEL,
      priority: 1,
      densityCm3: hapiNum(row[1]),
      speedKmS: hapiNum(row[2]),
    });
  }

  let distanceKm = NOMINAL_L1_DISTANCE_KM;
  let distanceIsMeasured = false;
  let scPositionGseKm: ScPositionGseKm | null = null;
  for (let i = ephem.length - 1; i >= 0; i -= 1) {
    const row = ephem[i];
    if (!Array.isArray(row)) continue;
    const x = vectorComponent(row[1], 0);
    const y = vectorComponent(row[1], 1);
    const z = vectorComponent(row[1], 2);
    const measured = reliableDistanceKm(x, y, z);
    if (measured === null) continue;
    distanceKm = measured;
    distanceIsMeasured = true;
    scPositionGseKm = { x: x as number, y: y as number, z: z as number };
    break;
  }

  const samples = resolveSamples(candidates);
  if (!samples.length) return emptyResult('IMAP I-ALiRT returned no samples in the recent window.');
  for (const sample of samples) sample.byNt = byByMinute.get(sample.ms) ?? null;

  return {
    sourceId: 'imap_ialirt',
    sourceLabel: IMAP_LABEL,
    samples,
    distanceKm,
    distanceIsMeasured,
    scPositionGseKm,
    latestSampleMs: samples[samples.length - 1].ms,
    errorMessage: null,
  };
}

/** CDAWeb HAPI adapter. */
export const cdawebHapiImapAdapter: ImapIalirtAdapter = {
  id: 'cdaweb-hapi',
  label: IMAP_LABEL,
  fetch: fetchViaHapi,
};

/**
 * Fetch the I-ALiRT stream, never throwing and never exceeding the adapter
 * deadline (an empty result on failure or timeout).
 */
export function fetchImapIalirt(nowMs: number, adapter: ImapIalirtAdapter = cdawebHapiImapAdapter): Promise<L1SourceResult> {
  const deadline = new Promise<L1SourceResult>(resolve =>
    setTimeout(() => resolve(emptyResult('IMAP I-ALiRT timed out')), ADAPTER_DEADLINE_MS),
  );
  return Promise.race([
    adapter.fetch(nowMs).catch(error => emptyResult(error instanceof Error ? `IMAP I-ALiRT: ${error.message}` : 'IMAP I-ALiRT request failed')),
    deadline,
  ]);
}
