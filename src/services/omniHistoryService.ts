/**
 * Long-range Earth-side solar-wind history from OMNI hourly (CDAWeb HAPI,
 * OMNI2_H0_MRG1HR). One request covers up to a year and carries the merged,
 * cleaned solar wind AND the planetary Kp + Dst — so it sources both the 1-month /
 * 1-year charts and the verifiable year-long event catalog.
 */

import type { L1EventSample, KpPoint } from './liveEventService';

const HAPI_BASE = 'https://cdaweb.gsfc.nasa.gov/hapi/data';
const DATASET = 'OMNI2_H0_MRG1HR';
// Parameters must be requested in dataset order (HAPI rule 1411).
const PARAMS = 'F1800,BZ_GSM1800,N1800,V1800,KP1800,DST1800';
const REQUEST_TIMEOUT_MS = 90_000;

// HAPI fill values for these parameters (treated as missing).
const FILL = { F: 999.9, BZ: 999.9, N: 999.9, V: 9999.0, KP: 99, DST: 99999 };

export interface OmniHistoryResult {
  samples: L1EventSample[];
  kpSeries: KpPoint[];
  /** Hourly Dst (nT), for an optional storm-intensity overlay. */
  dst: Array<{ ms: number; dst: number }>;
  startMs: number;
  endMs: number;
  errorMessage: string | null;
}

function cell(value: string, fill: number): number | null {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  // Fills are sentinel highs; treat anything at/above as missing.
  return Math.abs(v) >= fill - 0.5 ? null : v;
}

function parseMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? Number.NaN : ms;
}

export async function fetchOmniHourlyHistory(days: number): Promise<OmniHistoryResult> {
  const endMs = Date.now();
  return fetchOmniHourlyRange(endMs - days * 24 * 60 * 60 * 1000, endMs);
}

/**
 * OMNI hourly for an explicit [startMs, endMs] window. CDAWeb is slow for multi-year
 * spans, so the archive builder calls this in ≤1-year chunks. One request carries the
 * cleaned solar wind AND the planetary Kp + Dst.
 */
export async function fetchOmniHourlyRange(startMs: number, endMs: number): Promise<OmniHistoryResult> {
  const timeMin = new Date(startMs).toISOString();
  const timeMax = new Date(endMs).toISOString();
  const url = `${HAPI_BASE}?id=${DATASET}&parameters=${PARAMS}&time.min=${timeMin}&time.max=${timeMax}&format=csv`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`OMNI request failed with ${response.status}`);
    const text = await response.text();

    const samples: L1EventSample[] = [];
    const kpSeries: KpPoint[] = [];
    const dst: Array<{ ms: number; dst: number }> = [];

    for (const line of text.split('\n')) {
      const cols = line.split(',');
      if (cols.length < 7) continue;
      const ms = parseMs(cols[0]);
      if (Number.isNaN(ms)) continue;

      const bt = cell(cols[1], FILL.F);
      const bz = cell(cols[2], FILL.BZ);
      const density = cell(cols[3], FILL.N);
      const speed = cell(cols[4], FILL.V);
      const kpRaw = cell(cols[5], FILL.KP); // OMNI Kp is ×10 (e.g. 33 -> Kp 3.3)
      const dstVal = cell(cols[6], FILL.DST);

      samples.push({ ms, speedKmS: speed, densityPerCm3: density, bzNt: bz, btNt: bt });
      if (kpRaw !== null) kpSeries.push({ ms, kp: kpRaw / 10 });
      if (dstVal !== null) dst.push({ ms, dst: dstVal });
    }

    return {
      samples: samples.sort((a, b) => a.ms - b.ms),
      kpSeries: kpSeries.sort((a, b) => a.ms - b.ms),
      dst: dst.sort((a, b) => a.ms - b.ms),
      startMs,
      endMs,
      errorMessage: null,
    };
  } catch (error) {
    return {
      samples: [],
      kpSeries: [],
      dst: [],
      startMs,
      endMs,
      errorMessage: error instanceof Error ? error.message : 'OMNI history request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}
