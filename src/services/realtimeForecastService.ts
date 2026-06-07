/**
 * Real-time forecast computation, shared by the internal console nowcast panel and
 * the public precompute/publish path. Depends ONLY on live NOAA L1 data (no local
 * `data/` files), which is what makes it safe to run from a serverless cron (Fase 4).
 *
 * Flow: precompute → store ('forecast_latest' in Supabase) → serve. `compute…`
 * does the physics; `publish…` writes the public contract; `readLatest…` is what
 * the public API reads (instant, no computation).
 */

import { fetchLiveL1History } from '@/services/liveL1HistoryService';
import { propagateL1Series, type L1Sample } from '@/services/mruForecastService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from '@/services/stormScaleService';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { FORECAST_SCHEMA_VERSION, type ForecastRealtimeV1 } from '@/lib/api/forecastContract';

const MIN = 60_000;
const WINDOW_MS = 90 * MIN; // last ~1.5 h of L1 detection (+ ~1 h inbound lead past now)
const LATEST_ID = 'realtime';

const gLevel = (speed: number | null, bz: number | null) =>
  classifyGFromKp(kpFromCoupling(mergingFieldMvM(speed, bz), speed)).level;

export interface RealtimeForecast {
  now: number;
  startMs: number;
  distanceKm: number;
  l1: Array<{ t: number; speed: number | null; bz: number | null; density: number | null }>;
  mru: Array<{ t: number; speed: number | null; bz: number | null; gLevel: number }>;
  current: {
    sampleTimeUtc: string;
    speedKmS: number | null;
    bzNt: number | null;
    densityPerCm3: number | null;
    gLevel: number;
    arrivalUtc: string | null;
    lagMinutes: number | null;
  } | null;
  inbound: { peakG: number; peakSpeed: number; minBz: number; leadMinutes: number; worstEtaUtc: string } | null;
  warning: string | null;
}

/**
 * The last ~1.5 h of L1 detection plus the MRU forecast projected to its Earth-arrival
 * time (the line runs PAST "now" — inbound solar wind still in transit). Lightweight:
 * just the live L1 feed, no GEO/telemetry.
 */
export async function computeRealtimeForecast(): Promise<RealtimeForecast> {
  const now = Date.now();
  const start = now - WINDOW_MS;
  const history = await fetchLiveL1History();
  const samples = history.samples.slice().sort((a, b) => a.ms - b.ms);

  const l1 = samples
    .filter(s => s.ms >= start)
    .map(s => ({ t: s.ms, speed: s.speedKmS, bz: s.bzNt, density: s.densityPerCm3 }));
  const asL1: L1Sample[] = samples.map(s => ({
    timeUtc: new Date(s.ms).toISOString(),
    speedKmS: s.speedKmS,
    densityPerCm3: s.densityPerCm3,
    bzNt: s.bzNt,
    btNt: s.btNt,
    temperatureK: null,
  }));
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
  let inbound: RealtimeForecast['inbound'] = null;
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

  return { now, startMs: start, distanceKm: history.distanceKm, l1, mru, current, inbound, warning: history.errorMessage };
}

/** Map an internal forecast into the frozen public v1 contract. */
export function toForecastRealtimeV1(forecast: RealtimeForecast, issuedAt: string): ForecastRealtimeV1 {
  const { current, inbound, distanceKm } = forecast;
  return {
    schema_version: FORECAST_SCHEMA_VERSION,
    issued_at: issuedAt,
    observed_at: current?.sampleTimeUtc ?? null,
    l1_distance_km: distanceKm,
    observed: current
      ? {
          speed_km_s: current.speedKmS,
          bz_nt: current.bzNt,
          density_p_cm3: current.densityPerCm3,
          g_level: current.gLevel,
        }
      : null,
    arrival: current
      ? { estimated_utc: current.arrivalUtc, transit_lag_minutes: current.lagMinutes }
      : null,
    inbound_peak: inbound
      ? {
          g_level: inbound.peakG,
          speed_km_s: inbound.peakSpeed,
          min_bz_nt: inbound.minBz,
          eta_utc: inbound.worstEtaUtc,
          lead_minutes: inbound.leadMinutes,
        }
      : null,
  };
}

/**
 * Compute the forecast and upsert it as the single 'realtime' row in Supabase.
 * This is what the Fase 4 cron will call. Returns the published contract.
 * Throws if the service-role client is not configured or the write fails.
 */
export async function publishRealtimeForecast(): Promise<ForecastRealtimeV1> {
  const supabase = createServiceRoleClient();
  if (!supabase) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured; cannot publish forecast.');
  }

  const forecast = await computeRealtimeForecast();
  const issuedAt = new Date().toISOString();
  const payload = toForecastRealtimeV1(forecast, issuedAt);

  const { error } = await supabase.from('forecast_latest').upsert({
    id: LATEST_ID,
    schema_version: payload.schema_version,
    payload,
    issued_at: issuedAt,
    observed_at: payload.observed_at,
    updated_at: issuedAt,
  });
  if (error) throw new Error(`Failed to publish forecast: ${error.message}`);

  return payload;
}

/**
 * Read the last published forecast (no computation). Returns null if nothing has
 * been published yet or the backend is unavailable.
 */
export async function readLatestForecast(): Promise<ForecastRealtimeV1 | null> {
  const supabase = createServiceRoleClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('forecast_latest')
    .select('payload')
    .eq('id', LATEST_ID)
    .maybeSingle<{ payload: ForecastRealtimeV1 }>();

  if (error || !data) return null;
  return data.payload;
}
