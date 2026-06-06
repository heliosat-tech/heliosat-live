/**
 * Historical backtest ("hindcast") of the MRU forecast. Replays the model over the
 * archived L1 record: each ACE (upstream L1) sample is propagated ballistically to its
 * Earth-arrival time, then compared against what the solar wind ACTUALLY was at that
 * time — the OMNI record (the same L1 wind shifted to Earth by the community-standard
 * delay). Quantifies how well the simple ballistic model reproduces the arrived wind.
 *
 * Both inputs are L1-class solar wind (ACE upstream; OMNI = L1 shifted to Earth). Skill
 * is reported per variable (MAE / RMSE / bias / correlation) plus the NOAA G-level
 * hit-rate. Computed live from the local archives (sub-second arithmetic).
 */

import { sliceArchive } from './omniArchiveStore';
import { sliceAceArchive } from './aceArchiveStore';
import { propagateL1Series, type L1Sample } from './mruForecastService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from './stormScaleService';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LOOKBACK_YEARS = 6;

export interface VarSkill {
  variable: 'speed' | 'density' | 'bt' | 'bz';
  unit: string;
  n: number;
  mae: number;
  rmse: number;
  bias: number; // mean(forecast − actual)
  corr: number; // Pearson
}

export interface MruBacktest {
  coverage: { startUtc: string; stopUtc: string } | null;
  pairs: number; // forecast/actual hourly pairs evaluated
  variables: VarSkill[];
  g: { n: number; within1Pct: number; exactPct: number; bias: number };
  computedAtUtc: string;
}

const hourKey = (ms: number) => Math.round(ms / HOUR) * HOUR;

function skill(variable: VarSkill['variable'], unit: string, pairs: Array<[number, number]>): VarSkill {
  const n = pairs.length;
  if (n === 0) return { variable, unit, n, mae: 0, rmse: 0, bias: 0, corr: 0 };
  let absSum = 0;
  let sqSum = 0;
  let diffSum = 0;
  let fSum = 0;
  let aSum = 0;
  for (const [f, a] of pairs) {
    absSum += Math.abs(f - a);
    sqSum += (f - a) ** 2;
    diffSum += f - a;
    fSum += f;
    aSum += a;
  }
  const fMean = fSum / n;
  const aMean = aSum / n;
  let cov = 0;
  let fVar = 0;
  let aVar = 0;
  for (const [f, a] of pairs) {
    cov += (f - fMean) * (a - aMean);
    fVar += (f - fMean) ** 2;
    aVar += (a - aMean) ** 2;
  }
  const corr = fVar > 0 && aVar > 0 ? cov / Math.sqrt(fVar * aVar) : 0;
  return { variable, unit, n, mae: absSum / n, rmse: Math.sqrt(sqSum / n), bias: diffSum / n, corr };
}

export async function computeMruBacktest(): Promise<MruBacktest | null> {
  const now = Date.now();
  const start = now - LOOKBACK_YEARS * 365 * DAY;

  const [ace, omni] = await Promise.all([sliceAceArchive(start, now), sliceArchive(start, now)]);
  if (!ace || ace.samples.length === 0 || !omni || omni.samples.length === 0) return null;

  // Actual arrived wind + Kp, indexed by hour (OMNI = the L1 wind shifted to Earth).
  const truth = new Map<number, { speed: number | null; density: number | null; bt: number | null; bz: number | null }>();
  for (const s of omni.samples) truth.set(hourKey(s.ms), { speed: s.speedKmS, density: s.densityPerCm3, bt: s.btNt, bz: s.bzNt });
  const kp = new Map<number, number>();
  for (const p of omni.kpSeries) kp.set(hourKey(p.ms), p.kp);

  // MRU forecast = each ACE upstream sample (with a speed) propagated to its arrival.
  const asL1: L1Sample[] = ace.samples
    .filter(s => typeof s.speedKmS === 'number' && (s.speedKmS as number) > 0)
    .map(s => ({ timeUtc: new Date(s.ms).toISOString(), speedKmS: s.speedKmS, densityPerCm3: s.densityPerCm3, bzNt: s.bzNt, btNt: s.btNt, temperatureK: null }));
  const forecasts = propagateL1Series(asL1);

  const pairs: Record<VarSkill['variable'], Array<[number, number]>> = { speed: [], density: [], bt: [], bz: [] };
  let gN = 0;
  let gWithin1 = 0;
  let gExact = 0;
  let gBiasSum = 0;
  let evaluated = 0;
  let minT = Infinity;
  let maxT = -Infinity;

  for (const f of forecasts) {
    const arrivalMs = new Date(f.arrivalTimeUtc).getTime();
    const h = hourKey(arrivalMs);
    const t = truth.get(h);
    if (!t) continue;
    evaluated += 1;
    minT = Math.min(minT, h);
    maxT = Math.max(maxT, h);
    if (f.speedKmS !== null && t.speed !== null) pairs.speed.push([f.speedKmS, t.speed]);
    if (f.densityPerCm3 !== null && t.density !== null) pairs.density.push([f.densityPerCm3, t.density]);
    if (f.btNt !== null && t.bt !== null) pairs.bt.push([f.btNt, t.bt]);
    if (f.bzNt !== null && t.bz !== null) pairs.bz.push([f.bzNt, t.bz]);

    const observedKp = kp.get(h);
    if (observedKp !== undefined) {
      const fG = classifyGFromKp(kpFromCoupling(mergingFieldMvM(f.speedKmS, f.bzNt), f.speedKmS)).level;
      const oG = classifyGFromKp(observedKp).level;
      gN += 1;
      if (Math.abs(fG - oG) <= 1) gWithin1 += 1;
      if (fG === oG) gExact += 1;
      gBiasSum += fG - oG;
    }
  }

  if (evaluated === 0) return null;

  return {
    coverage: { startUtc: new Date(minT).toISOString(), stopUtc: new Date(maxT).toISOString() },
    pairs: evaluated,
    variables: [
      skill('speed', 'km/s', pairs.speed),
      skill('density', 'n/cc', pairs.density),
      skill('bt', 'nT', pairs.bt),
      skill('bz', 'nT', pairs.bz),
    ],
    g: {
      n: gN,
      within1Pct: gN > 0 ? (gWithin1 / gN) * 100 : 0,
      exactPct: gN > 0 ? (gExact / gN) * 100 : 0,
      bias: gN > 0 ? gBiasSum / gN : 0,
    },
    computedAtUtc: new Date(now).toISOString(),
  };
}
