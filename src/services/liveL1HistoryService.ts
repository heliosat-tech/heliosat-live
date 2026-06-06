/**
 * Multi-day L1 solar-wind history from NOAA SWPC real-time products, aligned into
 * the sample shape the live-event detector consumes. The live panel feeds use the
 * 2-hour product; for an accumulating EVENT LOG we pull the 7-day mag + plasma
 * products so the history is populated and older events can be verified at once.
 */

import type { L1EventSample } from './liveEventService';

const MAG_7DAY = 'https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json';
const PLASMA_7DAY = 'https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json';
const EPHEMERIS = 'https://services.swpc.noaa.gov/products/solar-wind/ephemerides.json';
const REQUEST_TIMEOUT_MS = 12000;

const NOMINAL_L1_DISTANCE_KM = 1_500_000;
const MIN_RELIABLE_KM = 500_000;
const MAX_RELIABLE_KM = 2_500_000;

export interface L1HistoryResult {
  samples: L1EventSample[];
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

    const magByMinute = new Map<number, { bz: number | null; bt: number | null }>();
    for (let i = 1; i < mag.length; i += 1) {
      const row = mag[i];
      if (!Array.isArray(row)) continue;
      const ms = parseMs(row[0]);
      if (Number.isNaN(ms)) continue;
      magByMinute.set(minuteKey(ms), {
        bz: bzIdx >= 0 ? toNum(row[bzIdx]) : null,
        bt: btIdx >= 0 ? toNum(row[btIdx]) : null,
      });
    }

    const samples: L1EventSample[] = [];
    for (let i = 1; i < plasma.length; i += 1) {
      const row = plasma[i];
      if (!Array.isArray(row)) continue;
      const ms = parseMs(row[0]);
      if (Number.isNaN(ms)) continue;
      const mag = magByMinute.get(minuteKey(ms));
      samples.push({
        ms,
        speedKmS: speedIdx >= 0 ? toNum(row[speedIdx]) : null,
        densityPerCm3: densityIdx >= 0 ? toNum(row[densityIdx]) : null,
        bzNt: mag?.bz ?? null,
        btNt: mag?.bt ?? null,
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
