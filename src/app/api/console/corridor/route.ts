import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { fetchLiveL1History } from '@/services/liveL1HistoryService';
import { propagateL1Series, NOMINAL_L1_DISTANCE_KM, type L1Sample } from '@/services/mruForecastService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from '@/services/stormScaleService';
import { sliceArchive } from '@/services/omniArchiveStore';
import { sliceAceArchive } from '@/services/aceArchiveStore';
import type { L1EventSample } from '@/services/liveEventService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const DAY = 24 * 60 * 60 * 1000;
const TARGET = 2000;

/**
 * LIGHTWEIGHT forecast-G history for the L1→Earth corridor replay. Returns ONLY the
 * arrival-time-indexed G series (`gForecast`) — no L1/MRU/near-Earth/GEO payload — from
 * the FAST sources: NOAA live for short windows, the local OMNI/ACE archives for long
 * ones. It deliberately avoids the slow on-demand ACE 1-min HAPI fetch the chart series
 * uses, so the corridor scrubber loads quickly and transfers little.
 */
const WINDOWS: Record<string, { source: 'live' | 'archive'; days: number }> = {
  '24h': { source: 'live', days: 1 },
  '7d': { source: 'live', days: 7 },
  '30d': { source: 'archive', days: 31 },
};

const gLevel = (speed: number | null, bz: number | null): number =>
  classifyGFromKp(kpFromCoupling(mergingFieldMvM(speed, bz), speed)).level;

/** Even-stride downsample to keep the payload (and client work) bounded. */
function stride<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
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

/** Propagate L1 samples to Earth and reduce to {arrivalTime, gLevel}, within [start, now]. */
function forecastFromL1(samples: L1EventSample[], distanceKm: number, start: number, now: number) {
  const asL1 = samples.map(toL1);
  return propagateL1Series(asL1, distanceKm)
    .map(p => ({ t: new Date(p.arrivalTimeUtc).getTime(), level: gLevel(p.speedKmS, p.bzNt) }))
    .filter(p => p.t >= start && p.t <= now);
}

const HOUR = 60 * 60 * 1000;

async function buildGForecast(source: 'live' | 'archive', days: number, now: number) {
  const start = now - days * DAY;

  // The live NOAA feed (last ~7 d, 1-min) is always the most accurate, current source.
  const history = await fetchLiveL1History();
  const liveSamples = history.samples.slice().sort((a, b) => a.ms - b.ms);
  const liveG = forecastFromL1(liveSamples, history.distanceKm, start, now);

  // Short windows: just the fine-grained live feed.
  if (source === 'live') {
    return { startMs: start, endMs: now, gForecast: stride(liveG, TARGET) };
  }

  // Long windows: merge the local archives (older part) with the live tail (recent ~7 d),
  // bucketed to the hour. Live wins ties, so recent storms always show even if the local
  // archive lags. OMNI is near-Earth (its timestamp IS the arrival time); ACE is at L1.
  const byHour = new Map<number, number>();
  const put = (pts: Array<{ t: number; level: number }>) => {
    for (const p of pts) byHour.set(Math.round(p.t / HOUR) * HOUR, p.level);
  };

  const omni = await sliceArchive(start, now);
  if (omni && omni.samples.length > 0) put(omni.samples.map(s => ({ t: s.ms, level: gLevel(s.speedKmS, s.bzNt) })));
  const ace = await sliceAceArchive(start, now);
  if (ace && ace.samples.length > 0) put(forecastFromL1(ace.samples, NOMINAL_L1_DISTANCE_KM, start, now));
  put(liveG);

  const merged = [...byHour.entries()]
    .map(([t, level]) => ({ t, level }))
    .filter(p => p.t >= start && p.t <= now)
    .sort((a, b) => a.t - b.t);
  return { startMs: start, endMs: now, gForecast: stride(merged, TARGET) };
}

export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const key = new URL(request.url).searchParams.get('window') ?? '7d';
  const window = key in WINDOWS ? key : '7d';
  const cfg = WINDOWS[window];
  const res = await buildGForecast(cfg.source, cfg.days, Date.now());

  return NextResponse.json({ window, ...res }, { headers: { 'Cache-Control': 'no-store' } });
}
