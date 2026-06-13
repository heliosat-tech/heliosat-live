/**
 * Per-sample forecast log for the Internal Console. Every live L1 sample becomes a
 * forecast (its MRU Earth-arrival time + the NOAA G level its wind implies), then gets
 * verified against the real planetary Kp once that arrival window is covered.
 *
 * Stateless — recomputed each poll from the L1 history + Kp series, since a sample's
 * forecast and its verdict are both deterministic. Downsampled to a chosen cadence so
 * the UI can thin a dense 1-min stream (all / 10 min / 1 h / 6 h / 1 day) without
 * dropping the strongest sample in each bucket.
 */

import type { L1EventSample } from './liveEventService';
import { propagateL1Sample } from './mruForecastService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from './stormScaleService';

export type ForecastCadence = 'all' | '10m' | '1h' | '6h' | '1d';
export const FORECAST_CADENCES: ForecastCadence[] = ['all', '10m', '1h', '6h', '1d'];

const CADENCE_MS: Record<ForecastCadence, number> = {
  all: 0,
  '10m': 10 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};
const MAX_ROWS = 500; // cap rendered rows; coarser cadence therefore reaches further back
const KP_BIN_MS = 3 * 60 * 60_000; // planetary Kp is published in 3-hour bins

export interface ForecastLogRow {
  id: string;
  sampleTimeUtc: string;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
  forecast: { arrivalUtc: string; lagMinutes: number; gLevel: number; gCode: string; estKp: number } | null;
  verification: {
    status: 'pending' | 'verified' | 'unverifiable';
    observedGLevel: number | null;
    observedGCode: string | null;
    observedMaxKp: number | null;
    rating: { score: number; label: string } | null;
  };
}

export interface ForecastLogResult {
  cadence: ForecastCadence;
  rows: ForecastLogRow[];
  summary: { total: number; verified: number; pending: number; hits: number; avgRating: number | null };
}

export function normalizeCadence(value: string | null | undefined): ForecastCadence {
  return (FORECAST_CADENCES as string[]).includes(value ?? '') ? (value as ForecastCadence) : '1h';
}

/** Prediction rating from |forecast G − observed G| (mirrors the status route). */
function ratingFor(predLevel: number, obsLevel: number): { score: number; label: string } {
  const diff = Math.abs(predLevel - obsLevel);
  if (diff === 0) return { score: 100, label: 'Excellent' };
  if (diff === 1) return { score: 75, label: 'Good' };
  if (diff === 2) return { score: 40, label: 'Fair' };
  return { score: 10, label: 'Poor' };
}

function forecastGLevel(sample: L1EventSample): number {
  return classifyGFromKp(kpFromCoupling(mergingFieldMvM(sample.speedKmS, sample.bzNt), sample.speedKmS)).level;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function buildForecastLog(
  history: { samples: L1EventSample[]; mruDistanceKm: number },
  kpSeries: Array<{ ms: number; kp: number }>,
  cadence: ForecastCadence,
): ForecastLogResult {
  // Forecastable samples (need a positive speed to propagate), oldest → newest.
  const samples = history.samples
    .filter(s => typeof s.speedKmS === 'number' && (s.speedKmS as number) > 0)
    .sort((a, b) => a.ms - b.ms);

  // Cadence downsample: within each time bucket keep the strongest sample (max forecast
  // G, tie → latest) so thinning never hides the worst conditions of that bucket.
  let picked: L1EventSample[];
  if (cadence === 'all' || CADENCE_MS[cadence] === 0) {
    picked = samples;
  } else {
    const step = CADENCE_MS[cadence];
    const byBucket = new Map<number, L1EventSample>();
    for (const s of samples) {
      const bucket = Math.floor(s.ms / step) * step;
      const cur = byBucket.get(bucket);
      if (!cur) {
        byBucket.set(bucket, s);
        continue;
      }
      const gNew = forecastGLevel(s);
      const gCur = forecastGLevel(cur);
      if (gNew > gCur || (gNew === gCur && s.ms > cur.ms)) byBucket.set(bucket, s);
    }
    picked = [...byBucket.values()].sort((a, b) => a.ms - b.ms);
  }

  // Newest first, capped.
  picked = picked.sort((a, b) => b.ms - a.ms).slice(0, MAX_ROWS);

  // Kp coverage horizon — beyond this an arrival simply hasn't been observed yet.
  const lastKpMs = kpSeries.length ? Math.max(...kpSeries.map(p => p.ms)) : Number.NEGATIVE_INFINITY;
  const coveredUntilMs = lastKpMs + KP_BIN_MS;

  let verified = 0;
  let pending = 0;
  let hits = 0;
  let ratingSum = 0;

  const rows: ForecastLogRow[] = picked.map(s => {
    const iso = new Date(s.ms).toISOString();
    const propagated = propagateL1Sample(
      { timeUtc: iso, speedKmS: s.speedKmS, densityPerCm3: s.densityPerCm3, bzNt: s.bzNt, btNt: s.btNt, temperatureK: null },
      history.mruDistanceKm,
    );
    const em = mergingFieldMvM(s.speedKmS, s.bzNt);
    const estKp = kpFromCoupling(em, s.speedKmS);
    const fG = classifyGFromKp(estKp);
    const forecast = propagated
      ? { arrivalUtc: propagated.arrivalTimeUtc, lagMinutes: Math.round(propagated.lagMinutes), gLevel: fG.level, gCode: fG.code, estKp: round1(estKp) }
      : null;

    let verification: ForecastLogRow['verification'] = {
      status: 'unverifiable',
      observedGLevel: null,
      observedGCode: null,
      observedMaxKp: null,
      rating: null,
    };
    if (forecast) {
      const arrivalMs = new Date(forecast.arrivalUtc).getTime();
      const bin = kpSeries.find(p => p.ms <= arrivalMs && arrivalMs < p.ms + KP_BIN_MS) ?? null;
      if (bin) {
        const oG = classifyGFromKp(bin.kp);
        const rating = ratingFor(forecast.gLevel, oG.level);
        verification = { status: 'verified', observedGLevel: oG.level, observedGCode: oG.code, observedMaxKp: round1(bin.kp), rating };
        verified += 1;
        ratingSum += rating.score;
        if (Math.abs(forecast.gLevel - oG.level) <= 1) hits += 1;
      } else if (arrivalMs >= coveredUntilMs) {
        // Arrival lands after the latest published Kp bin — awaiting Earth data.
        verification = { ...verification, status: 'pending' };
        pending += 1;
      }
    }

    return {
      id: iso,
      sampleTimeUtc: iso,
      speedKmS: s.speedKmS,
      bzNt: s.bzNt,
      btNt: s.btNt,
      densityPerCm3: s.densityPerCm3,
      forecast,
      verification,
    };
  });

  return {
    cadence,
    rows,
    summary: { total: rows.length, verified, pending, hits, avgRating: verified > 0 ? Math.round(ratingSum / verified) : null },
  };
}
