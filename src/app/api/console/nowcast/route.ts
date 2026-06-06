import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { fetchLiveL1History } from '@/services/liveL1HistoryService';
import { propagateL1Series, type L1Sample } from '@/services/mruForecastService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from '@/services/stormScaleService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

const MIN = 60_000;
const WINDOW_MS = 90 * MIN; // last ~1.5 h of L1 detection (+ ~1 h inbound lead past now)

const gLevel = (speed: number | null, bz: number | null) => classifyGFromKp(kpFromCoupling(mergingFieldMvM(speed, bz), speed)).level;

/**
 * Real-time nowcast for the demo hero panel: the last ~2.5 h of L1 detection plus the
 * MRU forecast projected to its Earth-arrival time (so the line runs PAST "now" — the
 * inbound solar wind still in transit). Deliberately lightweight (just the live L1
 * feed, no GEO/telemetry) so it can poll every ~30 s.
 */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const now = Date.now();
  const start = now - WINDOW_MS;
  const history = await fetchLiveL1History();
  const samples = history.samples.slice().sort((a, b) => a.ms - b.ms);

  const l1 = samples.filter(s => s.ms >= start).map(s => ({ t: s.ms, speed: s.speedKmS, bz: s.bzNt, density: s.densityPerCm3 }));
  const asL1: L1Sample[] = samples.map(s => ({ timeUtc: new Date(s.ms).toISOString(), speedKmS: s.speedKmS, densityPerCm3: s.densityPerCm3, bzNt: s.bzNt, btNt: s.btNt, temperatureK: null }));
  const propagated = propagateL1Series(asL1, history.distanceKm);
  const mru = propagated
    .map(p => ({ t: new Date(p.arrivalTimeUtc).getTime(), speed: p.speedKmS, bz: p.bzNt, gLevel: gLevel(p.speedKmS, p.bzNt) }))
    .filter(p => p.t >= start);

  const last = samples.length ? samples[samples.length - 1] : null;
  const lastProp = propagated.length ? propagated[propagated.length - 1] : null;
  const current = last
    ? {
        sampleTimeUtc: new Date(last.ms).toISOString(),
        speedKmS: last.speedKmS,
        bzNt: last.bzNt,
        densityPerCm3: last.densityPerCm3,
        gLevel: gLevel(last.speedKmS, last.bzNt),
        arrivalUtc: lastProp?.arrivalTimeUtc ?? null,
        lagMinutes: lastProp ? Math.round(lastProp.lagMinutes) : null,
      }
    : null;

  // Inbound = forecast parcels whose Earth-arrival is still in the future.
  const inboundPts = mru.filter(p => p.t >= now);
  let inbound: { peakG: number; peakSpeed: number; minBz: number; leadMinutes: number; worstEtaUtc: string } | null = null;
  if (inboundPts.length > 0) {
    const worst = inboundPts.reduce((a, b) => (b.gLevel > a.gLevel ? b : a), inboundPts[0]);
    inbound = {
      peakG: Math.max(...inboundPts.map(p => p.gLevel)),
      peakSpeed: Math.round(Math.max(...inboundPts.map(p => p.speed ?? 0))),
      minBz: Math.round(Math.min(...inboundPts.map(p => p.bz ?? 0))),
      leadMinutes: Math.round((inboundPts[inboundPts.length - 1].t - now) / MIN),
      worstEtaUtc: new Date(worst.t).toISOString(),
    };
  }

  return NextResponse.json(
    { now, startMs: start, distanceKm: history.distanceKm, l1, mru, current, inbound, warning: history.errorMessage },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
