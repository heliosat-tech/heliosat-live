import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { fetchLiveL1History } from '@/services/liveL1HistoryService';
import { fetchPlanetaryKpSeries, fetchNoaaStormScales } from '@/services/noaaStormScalesService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from '@/services/stormScaleService';
import { propagateL1Sample } from '@/services/mruForecastService';
import { buildForecastLog, normalizeCadence } from '@/services/consoleForecastLog';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const DANGER_WINDOW_MS = 30 * 60 * 1000; // trailing window for a stable "now" danger

function round(value: number, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Internal Console status: the live MRU forecast (when L1 wind reaches Earth + how
 * dangerous it is on the NOAA G scale), the observed NOAA G/S/R, and a continuous
 * forecast log — one forecast per L1 sample, thinned to the requested cadence, each
 * verified against the real near-Earth Kp with an accuracy rating.
 */
export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const cadence = normalizeCadence(new URL(request.url).searchParams.get('cadence'));

  const [history, kpSeries, scales] = await Promise.all([
    fetchLiveL1History(),
    fetchPlanetaryKpSeries(),
    fetchNoaaStormScales(),
  ]);
  const nowMs = Date.now();

  const samples = history.samples.slice().sort((a, b) => a.ms - b.ms);
  const latest = samples.at(-1) ?? null;

  // "Now" danger: trailing ~30-min averaged coupling (stable) -> estimated Kp -> G.
  let current: {
    sampleTimeUtc: string | null;
    speedKmS: number | null;
    densityPerCm3: number | null;
    bzNt: number | null;
    btNt: number | null;
    l1DistanceKm: number;
    distanceIsMeasured: boolean;
    lagMinutes: number | null;
    arrivalUtc: string | null;
    danger: { level: number; code: string; label: string; estKp: number; fraction: number };
  } | null = null;

  if (latest) {
    let emSum = 0;
    let emN = 0;
    let spSum = 0;
    let spN = 0;
    for (let i = samples.length - 1; i >= 0 && latest.ms - samples[i].ms <= DANGER_WINDOW_MS; i -= 1) {
      emSum += mergingFieldMvM(samples[i].speedKmS, samples[i].bzNt);
      emN += 1;
      if (typeof samples[i].speedKmS === 'number') {
        spSum += samples[i].speedKmS as number;
        spN += 1;
      }
    }
    const meanEm = emN > 0 ? emSum / emN : 0;
    const meanSpeed = spN > 0 ? spSum / spN : null;
    const estKp = kpFromCoupling(meanEm, meanSpeed);
    const g = classifyGFromKp(estKp);

    const propagated = propagateL1Sample(
      {
        timeUtc: new Date(latest.ms).toISOString(),
        speedKmS: latest.speedKmS,
        densityPerCm3: latest.densityPerCm3,
        bzNt: latest.bzNt,
        btNt: latest.btNt,
        temperatureK: null,
      },
      history.distanceKm,
    );

    current = {
      sampleTimeUtc: new Date(latest.ms).toISOString(),
      speedKmS: latest.speedKmS,
      densityPerCm3: latest.densityPerCm3,
      bzNt: latest.bzNt,
      btNt: latest.btNt,
      l1DistanceKm: Math.round(history.distanceKm),
      distanceIsMeasured: history.distanceIsMeasured,
      lagMinutes: propagated ? Math.round(propagated.lagMinutes) : null,
      arrivalUtc: propagated ? propagated.arrivalTimeUtc : null,
      danger: { level: g.level, code: g.code, label: g.label, estKp: round(estKp, 1), fraction: Math.max(0, Math.min(1, estKp / 9)) },
    };
  }

  // Inbound corridor: every recent L1 sample propagated to Earth that has NOT yet
  // arrived — i.e. the solar wind currently in transit between L1 and Earth. Each carries
  // a per-sample G estimate (lightly smoothed to kill 1-min spikes) so the UI can paint
  // the L1→Earth corridor as a CONTINUOUS band whose colour shows what is inbound. This is
  // independent of the forecast-log cadence (which only thins the table below).
  const INBOUND_LOOKBACK_MS = 150 * 60 * 1000; // generous: covers the slowest transit
  const INBOUND_SMOOTH_MS = 10 * 60 * 1000;
  const inbound: Array<{ detectedMs: number; arrivalMs: number; gLevel: number; speedKmS: number | null }> = [];
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (latest && latest.ms - s.ms > INBOUND_LOOKBACK_MS) continue;
    const prop = propagateL1Sample(
      { timeUtc: new Date(s.ms).toISOString(), speedKmS: s.speedKmS, densityPerCm3: s.densityPerCm3, bzNt: s.bzNt, btNt: s.btNt, temperatureK: null },
      history.distanceKm,
    );
    if (!prop) continue;
    const arrivalMs = new Date(prop.arrivalTimeUtc).getTime();
    if (!Number.isFinite(arrivalMs) || arrivalMs <= nowMs) continue; // already arrived
    let emSum = 0;
    let emN = 0;
    let spSum = 0;
    let spN = 0;
    for (let j = i; j >= 0 && s.ms - samples[j].ms <= INBOUND_SMOOTH_MS; j -= 1) {
      emSum += mergingFieldMvM(samples[j].speedKmS, samples[j].bzNt);
      emN += 1;
      if (typeof samples[j].speedKmS === 'number') {
        spSum += samples[j].speedKmS as number;
        spN += 1;
      }
    }
    const g = classifyGFromKp(kpFromCoupling(emN > 0 ? emSum / emN : 0, spN > 0 ? spSum / spN : null));
    inbound.push({ detectedMs: s.ms, arrivalMs, gLevel: g.level, speedKmS: s.speedKmS });
  }

  // Continuous forecast log: every L1 sample → an MRU forecast, verified vs real Kp,
  // thinned to the requested cadence.
  const log = buildForecastLog(history, kpSeries, cadence);

  return NextResponse.json(
    {
      generatedAtUtc: new Date(nowMs).toISOString(),
      current,
      inbound,
      scales: scales.observed,
      cadence: log.cadence,
      forecasts: log.rows,
      summary: log.summary,
      feedDegraded: history.samples.length === 0 || !!history.errorMessage,
      warnings: [history.errorMessage, scales.errorMessage].filter(Boolean),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
