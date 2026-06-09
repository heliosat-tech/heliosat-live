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
import { propagateL1Sample, propagateL1Series, type L1Sample } from '@/services/mruForecastService';
import { classifyGFromKp, estimateKpFromSolarWind, kpFromCoupling, mergingFieldMvM } from '@/services/stormScaleService';
import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  FORECAST_MODEL_VERSION,
  FORECAST_SCHEMA_VERSION,
  type EstimatedGLevelProxyV1,
  type ForecastConfidence,
  type ForecastDerivedFeaturesV1,
  type ForecastDistanceSource,
  type ForecastRealtimeV1,
  type ForecastSourceV1,
  type ForecastTargetV1,
} from '@/lib/api/forecastContract';

const MIN = 60_000;
const WINDOW_MS = 90 * MIN; // last ~1.5 h of L1 detection (+ ~1 h inbound lead past now)
const LATEST_ID = 'realtime';
const DEFAULT_ARRIVAL_UNCERTAINTY_MINUTES = 12;
const STALE_L1_AFTER_MINUTES = 10;
const VERY_STALE_L1_AFTER_MINUTES = 30;
const LARGE_GAP_MINUTES = 10;

type LiveL1Sample = {
  ms: number;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
};

const SOURCE: ForecastSourceV1 = {
  id: 'noaa_swpc_l1_realtime',
  provider: 'NOAA SWPC',
  observatory: 'L1 upstream monitor',
  products: [
    'solar-wind/mag-7-day.json',
    'solar-wind/plasma-7-day.json',
    'solar-wind/ephemerides.json',
  ],
};

const TARGET: ForecastTargetV1 = {
  id: 'near_earth_bow_shock',
  description: "Estimated solar-wind and IMF conditions at Earth's bow-shock nose.",
};

const LIMITATIONS = [
  "Ballistic MRU propagation assumes each L1 parcel keeps the measured bulk speed until Earth's bow-shock nose arrival.",
  'Arrival time is uncertain because phase-front orientation, acceleration, stream interaction and bow-shock geometry are simplified.',
  'Estimated G level is an operational proxy derived from propagated physical drivers; it is not an official measured Kp/G value.',
];

const estimatedGLevel = (speed: number | null, bz: number | null) =>
  speed !== null && bz !== null ? classifyGFromKp(kpFromCoupling(mergingFieldMvM(speed, bz), speed)).level : null;

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundNullable(value: number | null, digits = 2): number | null {
  return value === null ? null : round(value, digits);
}

function configuredArrivalUncertaintyMinutes(): number {
  const raw = process.env.HELIOSAT_ARRIVAL_UNCERTAINTY_MINUTES ?? process.env.HELIOSAT_ARRIVAL_UNCERTAINTY_MIN;
  const parsed = raw ? Number(raw) : DEFAULT_ARRIVAL_UNCERTAINTY_MINUTES;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ARRIVAL_UNCERTAINTY_MINUTES;
}

/** Proton dynamic pressure: Pdyn = mp * n * V^2, returned in nPa for n[cm^-3], V[km/s]. */
function dynamicPressureNpa(speedKmS: number | null, densityCm3: number | null): number | null {
  const speed = finite(speedKmS);
  const density = finite(densityCm3);
  if (speed === null || density === null || speed <= 0 || density < 0) return null;
  return 1.6726219e-6 * density * speed * speed;
}

function couplingElectricFieldMvM(speedKmS: number | null, bzNt: number | null): number | null {
  const speed = finite(speedKmS);
  const bz = finite(bzNt);
  if (speed === null || bz === null || speed <= 0) return null;
  return speed * Math.max(0, -bz) * 1e-3;
}

function minFinite(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finiteValues.length ? Math.min(...finiteValues) : null;
}

function maxFinite(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finiteValues.length ? Math.max(...finiteValues) : null;
}

function rollingWindow(samples: LiveL1Sample[], referenceMs: number, minutes: number): LiveL1Sample[] {
  const startMs = referenceMs - minutes * MIN;
  return samples.filter(sample => sample.ms >= startMs && sample.ms <= referenceMs);
}

function gradientPerMinute(
  latest: LiveL1Sample,
  samples: LiveL1Sample[],
  pick: (sample: LiveL1Sample) => number | null,
): number | null {
  const current = pick(latest);
  if (current === null) return null;
  const candidates = samples.filter(sample => sample.ms < latest.ms && latest.ms - sample.ms <= 15 * MIN);
  const previous = candidates.length ? candidates[0] : null;
  if (!previous) return null;
  const prior = pick(previous);
  const dtMinutes = (latest.ms - previous.ms) / MIN;
  if (prior === null || dtMinutes <= 0) return null;
  return (current - prior) / dtMinutes;
}

function computeDerivedFeatures(
  latest: LiveL1Sample | null,
  samples: LiveL1Sample[],
): ForecastDerivedFeaturesV1 | null {
  if (!latest) return null;

  const rollingMinBz = (minutes: number) =>
    roundNullable(minFinite(rollingWindow(samples, latest.ms, minutes).map(sample => finite(sample.bzNt))), 2);
  const rollingMaxPdyn = (minutes: number) =>
    roundNullable(maxFinite(rollingWindow(samples, latest.ms, minutes).map(sample => dynamicPressureNpa(sample.speedKmS, sample.densityPerCm3))), 2);
  const rollingMaxEm = (minutes: number) =>
    roundNullable(maxFinite(rollingWindow(samples, latest.ms, minutes).map(sample => couplingElectricFieldMvM(sample.speedKmS, sample.bzNt))), 2);

  return {
    dynamic_pressure_npa: roundNullable(dynamicPressureNpa(latest.speedKmS, latest.densityPerCm3), 2),
    coupling_electric_field_mv_m: roundNullable(couplingElectricFieldMvM(latest.speedKmS, latest.bzNt), 2),
    gradients_per_minute: {
      speed_km_s: roundNullable(gradientPerMinute(latest, samples, sample => finite(sample.speedKmS)), 2),
      density_cm3: roundNullable(gradientPerMinute(latest, samples, sample => finite(sample.densityPerCm3)), 2),
      bz_gsm_nt: roundNullable(gradientPerMinute(latest, samples, sample => finite(sample.bzNt)), 2),
      bt_nt: roundNullable(gradientPerMinute(latest, samples, sample => finite(sample.btNt)), 2),
      dynamic_pressure_npa: roundNullable(gradientPerMinute(latest, samples, sample => dynamicPressureNpa(sample.speedKmS, sample.densityPerCm3)), 2),
    },
    rolling_min_bz_gsm_nt: {
      minutes_15: rollingMinBz(15),
      minutes_30: rollingMinBz(30),
      minutes_60: rollingMinBz(60),
    },
    rolling_max_dynamic_pressure_npa: {
      minutes_15: rollingMaxPdyn(15),
      minutes_30: rollingMaxPdyn(30),
      minutes_60: rollingMaxPdyn(60),
    },
    rolling_max_coupling_electric_field_mv_m: {
      minutes_15: rollingMaxEm(15),
      minutes_30: rollingMaxEm(30),
      minutes_60: rollingMaxEm(60),
    },
  };
}

function asL1Sample(sample: LiveL1Sample): L1Sample {
  return {
    timeUtc: new Date(sample.ms).toISOString(),
    speedKmS: sample.speedKmS,
    densityPerCm3: sample.densityPerCm3,
    bzNt: sample.bzNt,
    btNt: sample.btNt,
    temperatureK: null,
  };
}

function computeQualityFlags(input: {
  now: number;
  samples: LiveL1Sample[];
  latest: LiveL1Sample | null;
  latestCanPropagate: boolean;
  distanceIsMeasured: boolean;
  errorMessage: string | null;
}): string[] {
  const flags = new Set<string>();
  const { now, samples, latest, latestCanPropagate, distanceIsMeasured, errorMessage } = input;

  if (errorMessage) flags.add('NOAA_L1_FETCH_WARNING');
  if (!distanceIsMeasured) flags.add('USING_NOMINAL_L1_DISTANCE');
  if (!samples.length) flags.add('NO_L1_SAMPLES');

  if (latest) {
    const ageMinutes = (now - latest.ms) / MIN;
    if (ageMinutes > VERY_STALE_L1_AFTER_MINUTES) flags.add('VERY_STALE_L1_SAMPLE');
    else if (ageMinutes > STALE_L1_AFTER_MINUTES) flags.add('STALE_L1_SAMPLE');

    if (finite(latest.speedKmS) === null) flags.add('MISSING_SPEED');
    if (finite(latest.densityPerCm3) === null) flags.add('MISSING_DENSITY');
    if (finite(latest.bzNt) === null) flags.add('MISSING_BZ_GSM');
    if (finite(latest.btNt) === null) flags.add('MISSING_BT');
    if (!latestCanPropagate) flags.add('NO_PHYSICAL_ARRIVAL_TIME');

    const speed = finite(latest.speedKmS);
    const density = finite(latest.densityPerCm3);
    const bz = finite(latest.bzNt);
    const bt = finite(latest.btNt);
    if (speed !== null && (speed < 200 || speed > 1_200)) flags.add('SPEED_OUTSIDE_EXPECTED_RANGE');
    if (density !== null && (density < 0 || density > 200)) flags.add('DENSITY_OUTSIDE_EXPECTED_RANGE');
    if (bz !== null && Math.abs(bz) > 100) flags.add('BZ_OUTSIDE_EXPECTED_RANGE');
    if (bt !== null && (bt < 0 || bt > 150)) flags.add('BT_OUTSIDE_EXPECTED_RANGE');
  }

  const recent = samples.filter(sample => sample.ms >= now - WINDOW_MS).sort((a, b) => a.ms - b.ms);
  if (recent.length < 2) {
    flags.add('INSUFFICIENT_RECENT_L1_HISTORY');
  } else {
    for (let i = 1; i < recent.length; i += 1) {
      if ((recent[i].ms - recent[i - 1].ms) / MIN > LARGE_GAP_MINUTES) {
        flags.add('LARGE_L1_GAP');
        break;
      }
    }
  }

  return [...flags].sort();
}

function confidenceFromFlags(flags: string[]): ForecastConfidence {
  const lowFlags = new Set([
    'NO_L1_SAMPLES',
    'NO_PHYSICAL_ARRIVAL_TIME',
    'MISSING_SPEED',
    'VERY_STALE_L1_SAMPLE',
    'NOAA_L1_FETCH_WARNING',
  ]);
  if (flags.some(flag => lowFlags.has(flag))) return 'low';
  if (flags.length > 0) return 'medium';
  return 'high';
}

function leadTimeMinutes(arrivalUtc: string | null, issuedAt: string): number | null {
  if (!arrivalUtc) return null;
  const arrivalMs = new Date(arrivalUtc).getTime();
  const issuedMs = new Date(issuedAt).getTime();
  if (Number.isNaN(arrivalMs) || Number.isNaN(issuedMs)) return null;
  return Math.round((arrivalMs - issuedMs) / MIN);
}

function estimatedGLevelProxy(speedKmS: number | null, bzNt: number | null): EstimatedGLevelProxyV1 | null {
  if (speedKmS === null || bzNt === null) return null;
  const estimate = estimateKpFromSolarWind(speedKmS, bzNt);
  if (!estimate) return null;
  const scale = classifyGFromKp(estimate.kp);
  return {
    level: scale.level,
    code: scale.code,
    kp_estimate: estimate.kp,
    method: 'rules_based_coupling_proxy',
    note: 'Operational G-level proxy derived from propagated solar-wind drivers, not an official measured Kp/G value.',
  };
}

export interface RealtimeForecast {
  now: number;
  startMs: number;
  distanceKm: number;
  distanceIsMeasured: boolean;
  distanceSource: ForecastDistanceSource;
  arrivalUncertaintyMinutes: number;
  qualityFlags: string[];
  confidence: ForecastConfidence;
  derivedFeatures: ForecastDerivedFeaturesV1 | null;
  l1: Array<{ t: number; speed: number | null; bz: number | null; density: number | null }>;
  mru: Array<{ t: number; speed: number | null; bz: number | null; gLevel: number | null; riskAvailable: boolean }>;
  current: {
    sampleTimeUtc: string;
    speedKmS: number | null;
    bzNt: number | null;
    btNt: number | null;
    densityPerCm3: number | null;
    gLevel: number | null;
    riskAvailable: boolean;
    sources: {
      speedKmS: string | null;
      bzNt: string | null;
      btNt: string | null;
      densityPerCm3: string | null;
      gLevel: string | null;
    };
    missingVariables: string[];
    qualityFlags: string[];
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
  const distanceSource: ForecastDistanceSource = history.distanceIsMeasured ? 'measured_ephemeris' : 'nominal_l1_distance';

  const l1 = samples
    .filter(s => s.ms >= start)
    .map(s => ({ t: s.ms, speed: s.speedKmS, bz: s.bzNt, density: s.densityPerCm3 }));
  const asL1: L1Sample[] = samples.map(asL1Sample);
  const propagated = propagateL1Series(asL1, history.distanceKm);
  const mru = propagated
    .map(p => {
      const gLevel = estimatedGLevel(p.speedKmS, p.bzNt);
      return { t: new Date(p.arrivalTimeUtc).getTime(), speed: p.speedKmS, bz: p.bzNt, gLevel, riskAvailable: gLevel !== null };
    })
    .filter(p => p.t >= start);

  const last = samples.length ? samples[samples.length - 1] : null;
  const latestProp = last ? propagateL1Sample(asL1Sample(last), history.distanceKm) : null;
  const derivedFeatures = computeDerivedFeatures(last, samples);
  const qualityFlags = computeQualityFlags({
    now,
    samples,
    latest: last,
    latestCanPropagate: latestProp !== null,
    distanceIsMeasured: history.distanceIsMeasured,
    errorMessage: history.errorMessage,
  });
  const confidence = confidenceFromFlags(qualityFlags);
  const arrivalUncertaintyMinutes = configuredArrivalUncertaintyMinutes();
  const current = last
    ? {
        sampleTimeUtc: new Date(last.ms).toISOString(),
        speedKmS: last.speedKmS,
        bzNt: last.bzNt,
        btNt: last.btNt,
        densityPerCm3: last.densityPerCm3,
        gLevel: estimatedGLevel(last.speedKmS, last.bzNt),
        riskAvailable: last.riskAvailable ?? (last.speedKmS !== null && last.bzNt !== null),
        sources: {
          speedKmS: last.sourceLabelByVariable?.speed ?? null,
          bzNt: last.sourceLabelByVariable?.bz ?? null,
          btNt: last.sourceLabelByVariable?.bt ?? null,
          densityPerCm3: last.sourceLabelByVariable?.density ?? null,
          gLevel: (last.riskAvailable ?? (last.speedKmS !== null && last.bzNt !== null))
            ? Array.from(new Set([last.sourceLabelByVariable?.speed, last.sourceLabelByVariable?.bz].filter((label): label is string => !!label))).join(' + ') || null
            : null,
        },
        missingVariables: last.missingVariables ?? [],
        qualityFlags: last.qualityFlags ?? [],
        arrivalUtc: latestProp?.arrivalTimeUtc ?? null,
        lagMinutes: latestProp ? Math.round(latestProp.lagMinutes) : null,
      }
    : null;

  // Inbound = forecast parcels whose Earth-arrival is still in the future.
  const inboundPts = mru.filter(p => p.t >= now && p.riskAvailable && p.gLevel !== null);
  let inbound: RealtimeForecast['inbound'] = null;
  if (inboundPts.length > 0) {
    const worst = inboundPts.reduce((a, b) => ((b.gLevel ?? 0) > (a.gLevel ?? 0) ? b : a), inboundPts[0]);
    inbound = {
      peakG: Math.max(...inboundPts.map(p => p.gLevel ?? 0)),
      peakSpeed: Math.round(Math.max(...inboundPts.map(p => p.speed ?? 0))),
      minBz: Math.round(Math.min(...inboundPts.map(p => p.bz ?? 0))),
      leadMinutes: Math.round((inboundPts[inboundPts.length - 1].t - now) / MIN),
      worstEtaUtc: new Date(worst.t).toISOString(),
    };
  }

  return {
    now,
    startMs: start,
    distanceKm: history.distanceKm,
    distanceIsMeasured: history.distanceIsMeasured,
    distanceSource,
    arrivalUncertaintyMinutes,
    qualityFlags,
    confidence,
    derivedFeatures,
    l1,
    mru,
    current,
    inbound,
    warning: history.errorMessage,
  };
}

/** Map an internal forecast into the frozen public v1 contract. */
export function toForecastRealtimeV1(forecast: RealtimeForecast, issuedAt: string): ForecastRealtimeV1 {
  const { current, inbound, distanceKm } = forecast;
  const arrivalTimeUtc = current?.arrivalUtc ?? null;
  const propagatedVariables = current
    ? {
        speed_km_s: current.speedKmS,
        density_cm3: current.densityPerCm3,
        bz_gsm_nt: current.bzNt,
        bt_nt: current.btNt,
      }
    : null;

  return {
    schema_version: FORECAST_SCHEMA_VERSION,
    model_version: FORECAST_MODEL_VERSION,
    issued_at: issuedAt,
    generated_at: issuedAt,
    observed_at: current?.sampleTimeUtc ?? null,
    l1_sample_time_utc: current?.sampleTimeUtc ?? null,
    l1_distance_km: distanceKm,
    distance_km: distanceKm,
    distance_source: forecast.distanceSource,
    source: SOURCE,
    target: TARGET,
    observed: current
      ? {
          speed_km_s: current.speedKmS,
          bz_nt: current.bzNt,
          density_p_cm3: current.densityPerCm3,
          g_level: current.gLevel ?? 0,
        }
      : null,
    arrival: current
      ? { estimated_utc: current.arrivalUtc, transit_lag_minutes: current.lagMinutes }
      : null,
    arrival_time_utc: arrivalTimeUtc,
    lead_time_minutes: leadTimeMinutes(arrivalTimeUtc, issuedAt),
    arrival_uncertainty_minutes: forecast.arrivalUncertaintyMinutes,
    propagated_variables: propagatedVariables,
    derived_features: forecast.derivedFeatures,
    quality_flags: forecast.qualityFlags,
    confidence: forecast.confidence,
    limitations: LIMITATIONS,
    estimated_g_level_proxy: current ? estimatedGLevelProxy(current.speedKmS, current.bzNt) : null,
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
