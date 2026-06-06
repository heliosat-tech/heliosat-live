/**
 * Live "ground truth" for the NOAA storm scales (G / S / R), fetched from NOAA
 * SWPC. This is the real, near-Earth observed state that HELIOSAT's forecast is
 * compared against:
 *
 *   - noaa-scales.json        official current G/S/R + NOAA's own day-ahead outlook
 *   - planetary-k-index.json  the real planetary Kp time-series (defines observed G)
 *
 * Both are derived from instruments AT Earth (ground magnetometers for Kp, GOES at
 * GEO for X-ray -> R and protons -> S), i.e. exactly the "detected near Earth"
 * measurements. Server-side fetch (this runs in an API route) avoids browser CORS.
 */

import {
  scaleFromNoaaLevel,
  classifyGFromKp,
  type StormScaleValue,
} from './stormScaleService';

const SCALES_ENDPOINT = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
const KP_ENDPOINT = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const REQUEST_TIMEOUT_MS = 8000;

export interface ObservedStormScales {
  /** Current observed G/S/R (from NOAA scales "0" bucket). */
  g: StormScaleValue;
  s: StormScaleValue;
  r: StormScaleValue;
  /** Latest measured planetary Kp (3-hour cadence), or null if unavailable. */
  latestKp: number | null;
  latestKpTimeUtc: string | null;
  /** G derived from the latest measured Kp (matches NOAA G but with the Kp value). */
  gFromKp: StormScaleValue;
  /** Timestamp NOAA attached to the current scales bucket. */
  observedAtUtc: string | null;
}

export interface NoaaOutlookDay {
  dateUtc: string;
  /** NOAA's forecast G scale for the day (their own outlook). */
  g: StormScaleValue;
  /** Probability (%) of an R1+ / R3+ radio blackout, if provided. */
  rMinorProbPct: number | null;
  rMajorProbPct: number | null;
  /** Probability (%) of an S1+ radiation storm, if provided. */
  sProbPct: number | null;
}

export interface NoaaStormScalesResult {
  observed: ObservedStormScales | null;
  /** NOAA's official short-range outlook (today / +1 / +2 days). */
  outlook: NoaaOutlookDay[];
  fetchedAtUtc: string;
  errorMessage: string | null;
}

interface ScaleBucket {
  DateStamp?: string;
  TimeStamp?: string;
  R?: { Scale?: string | null; Text?: string | null; MinorProb?: string | null; MajorProb?: string | null };
  S?: { Scale?: string | null; Text?: string | null; Prob?: string | null };
  G?: { Scale?: string | null; Text?: string | null };
}

interface KpRow {
  time_tag?: string;
  Kp?: number | string | null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      throw new Error(`NOAA request failed with ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bucketTimestampUtc(bucket: ScaleBucket): string | null {
  if (!bucket.DateStamp) return null;
  const time = bucket.TimeStamp && /^\d{2}:\d{2}/.test(bucket.TimeStamp) ? bucket.TimeStamp : '00:00:00';
  const iso = `${bucket.DateStamp}T${time}Z`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function parseLatestKp(raw: unknown): { kp: number | null; timeUtc: string | null } {
  if (!Array.isArray(raw)) return { kp: null, timeUtc: null };

  // The product is either an array of header+rows arrays, or an array of objects.
  let bestKp: number | null = null;
  let bestTime: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;

  for (const entry of raw) {
    let timeTag: string | null = null;
    let kp: number | null = null;

    if (Array.isArray(entry)) {
      // header row looks like ["time_tag","Kp","a_running","station_count"]
      if (entry[0] === 'time_tag') continue;
      timeTag = typeof entry[0] === 'string' ? entry[0] : null;
      kp = toNumberOrNull(entry[1]);
    } else if (entry && typeof entry === 'object') {
      const row = entry as KpRow;
      timeTag = typeof row.time_tag === 'string' ? row.time_tag : null;
      kp = toNumberOrNull(row.Kp);
    }

    if (timeTag === null || kp === null) continue;
    const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(timeTag) ? timeTag : `${timeTag.replace(' ', 'T')}Z`;
    const ms = new Date(normalized).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      bestKp = kp;
      bestTime = new Date(ms).toISOString();
    }
  }

  return { kp: bestKp, timeUtc: bestTime };
}

/**
 * The full planetary Kp time-series (3-hour cadence, ~7 days) as {ms, kp} points,
 * used to retrospectively verify forecast G levels against the real geomagnetic
 * response measured at Earth.
 */
export async function fetchPlanetaryKpSeries(): Promise<Array<{ ms: number; kp: number }>> {
  try {
    const raw = await fetchJson(KP_ENDPOINT);
    if (!Array.isArray(raw)) return [];
    const out: Array<{ ms: number; kp: number }> = [];
    for (const entry of raw) {
      let timeTag: string | null = null;
      let kp: number | null = null;
      if (Array.isArray(entry)) {
        if (entry[0] === 'time_tag') continue;
        timeTag = typeof entry[0] === 'string' ? entry[0] : null;
        kp = toNumberOrNull(entry[1]);
      } else if (entry && typeof entry === 'object') {
        const row = entry as KpRow;
        timeTag = typeof row.time_tag === 'string' ? row.time_tag : null;
        kp = toNumberOrNull(row.Kp);
      }
      if (timeTag === null || kp === null) continue;
      const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(timeTag) ? timeTag : `${timeTag.replace(' ', 'T')}Z`;
      const ms = new Date(normalized).getTime();
      if (!Number.isNaN(ms)) out.push({ ms, kp });
    }
    return out.sort((a, b) => a.ms - b.ms);
  } catch {
    return [];
  }
}

export async function fetchNoaaStormScales(): Promise<NoaaStormScalesResult> {
  const fetchedAtUtc = new Date().toISOString();

  try {
    const [scalesRaw, kpRaw] = await Promise.all([
      fetchJson(SCALES_ENDPOINT),
      fetchJson(KP_ENDPOINT).catch(() => null),
    ]);

    if (!scalesRaw || typeof scalesRaw !== 'object') {
      return { observed: null, outlook: [], fetchedAtUtc, errorMessage: 'Unexpected NOAA scales response shape' };
    }

    const scalesMap = scalesRaw as Record<string, ScaleBucket>;
    const current = scalesMap['0'];
    const { kp: latestKp, timeUtc: latestKpTimeUtc } = parseLatestKp(kpRaw);

    const observed: ObservedStormScales | null = current
      ? {
          g: scaleFromNoaaLevel('G', current.G?.Scale),
          s: scaleFromNoaaLevel('S', current.S?.Scale),
          r: scaleFromNoaaLevel('R', current.R?.Scale),
          latestKp,
          latestKpTimeUtc,
          gFromKp: classifyGFromKp(latestKp),
          observedAtUtc: bucketTimestampUtc(current),
        }
      : null;

    // NOAA's own outlook lives in the positive-index buckets (1 = today, 2 = +1d, ...).
    const outlook: NoaaOutlookDay[] = [];
    for (const key of ['1', '2', '3']) {
      const bucket = scalesMap[key];
      if (!bucket) continue;
      const timeUtc = bucketTimestampUtc(bucket);
      outlook.push({
        dateUtc: timeUtc ?? bucket.DateStamp ?? key,
        g: scaleFromNoaaLevel('G', bucket.G?.Scale),
        rMinorProbPct: toNumberOrNull(bucket.R?.MinorProb),
        rMajorProbPct: toNumberOrNull(bucket.R?.MajorProb),
        sProbPct: toNumberOrNull(bucket.S?.Prob),
      });
    }

    return { observed, outlook, fetchedAtUtc, errorMessage: null };
  } catch (error) {
    return {
      observed: null,
      outlook: [],
      fetchedAtUtc,
      errorMessage: error instanceof Error ? error.message : 'NOAA scales request failed',
    };
  }
}
