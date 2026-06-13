import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { fetchLiveL1History } from '@/services/liveL1HistoryService';
import { fetchPlanetaryKpSeries, fetchNoaaStormScales } from '@/services/noaaStormScalesService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from '@/services/stormScaleService';
import { propagateL1Sample, RE_KM } from '@/services/mruForecastService';
import { buildForecastLog, normalizeCadence } from '@/services/consoleForecastLog';
import { predictArrivalResiduals, BSN_X_RE_NOMINAL, ETA_BAND_ML_MIN, ETA_BAND_MRU_MIN, type MlInputSample } from '@/services/arrivalResidualMlService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const DANGER_WINDOW_MS = 30 * 60 * 1000; // trailing window for a stable "now" danger
// Trailing window of live samples sent to the ML model — enough for the 3 h rolling features.
const ML_FEATURE_WINDOW_MS = 4 * 60 * 60 * 1000;
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
    pdynNpa: number | null;
    emMvM: number | null;
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
    l1DistanceKm: number;
    distanceIsMeasured: boolean;
    lagMinutes: number | null;
    arrivalUtc: string | null;
    // ML residual correction (bow-shock-nose basis). mlApplied=false => headline is raw MRU.
    mlApplied: boolean;
    mruDelayMin: number | null;
    correctedDelayMin: number | null;
    mlResidualMin: number | null;
    etaBandMin: number | null;
    danger: { level: number; code: string; label: string; estKp: number | null; fraction: number };
  } | null = null;

  if (latest) {
    let emSum = 0;
    let emN = 0;
    let spSum = 0;
    let spN = 0;
    for (let i = samples.length - 1; i >= 0 && latest.ms - samples[i].ms <= DANGER_WINDOW_MS; i -= 1) {
      if (typeof samples[i].speedKmS === 'number' && typeof samples[i].bzNt === 'number') {
        emSum += mergingFieldMvM(samples[i].speedKmS, samples[i].bzNt);
        emN += 1;
      }
      if (typeof samples[i].speedKmS === 'number') {
        spSum += samples[i].speedKmS as number;
        spN += 1;
      }
    }
    const riskAvailable = latest.riskAvailable ?? (latest.speedKmS !== null && latest.bzNt !== null);
    const meanEm = emN > 0 ? emSum / emN : null;
    const meanSpeed = spN > 0 ? spSum / spN : null;
    const estKp = riskAvailable && meanEm !== null ? kpFromCoupling(meanEm, meanSpeed) : null;
    const g = classifyGFromKp(estKp);
    const sourceLabelByVariable = latest.sourceLabelByVariable ?? { speed: null, bz: null, bt: null, density: null };
    const gSources = riskAvailable
      ? Array.from(new Set([sourceLabelByVariable.speed, sourceLabelByVariable.bz].filter((s): s is string => !!s))).join(' + ') || null
      : null;

    const propagated = propagateL1Sample(
      {
        timeUtc: new Date(latest.ms).toISOString(),
        speedKmS: latest.speedKmS,
        densityPerCm3: latest.densityPerCm3,
        bzNt: latest.bzNt,
        btNt: latest.btNt,
        temperatureK: null,
      },
      history.mruDistanceKm,
    );

    // ---- ML arrival-residual correction (best-effort) ----
    // corrected_delay = mru_delay + g(features), applied exactly as offline. Features are
    // built and predicted in Python from the trailing window (km->Re position, same units as
    // training). Falls back to raw MRU when the position/By features are missing, the rolling
    // window lacks >=3 h of history, or the model is unavailable — never blocks the forecast.
    const pos = history.scPositionGseKm;
    const mlInput: MlInputSample[] = pos
      ? samples
          .filter(s => latest.ms - s.ms <= ML_FEATURE_WINDOW_MS)
          .map(s => ({
            time: new Date(s.ms).toISOString(),
            speed_km_s: s.speedKmS,
            density_p_cc: s.densityPerCm3,
            bmag_nt: s.btNt,
            bz_gsm_nt: s.bzNt,
            by_gsm_nt: s.byNt,
            sc_x_re: pos.x / RE_KM,
            sc_y_re: pos.y / RE_KM,
            sc_z_re: pos.z / RE_KM,
          }))
      : [];
    const mlByTime = mlInput.length > 0 ? await predictArrivalResiduals(mlInput, BSN_X_RE_NOMINAL) : null;
    const mlLatest = mlByTime?.get(new Date(latest.ms).toISOString()) ?? null;

    // Option A: the displayed MRU is the model's bow-shock-nose delay ((sc_x-bsn_x)/V) so MRU
    // and MRU+ML share one basis and differ only by g. When no position is available we fall
    // back to the raw |pos| ballistic delay as the benchmark, and ML does not apply.
    const bowShockMruMin = mlLatest?.mruDelayMin ?? null;
    const rawMruMin = propagated ? propagated.lagMinutes : null;
    const benchmarkMruMin = bowShockMruMin ?? rawMruMin;
    const correctedMin = mlLatest?.complete && mlLatest.correctedDelayMin !== null ? mlLatest.correctedDelayMin : null;
    const mlApplied = correctedMin !== null;
    const headlineDelayMin = correctedMin ?? benchmarkMruMin;
    const headlineArrivalUtc = headlineDelayMin !== null
      ? new Date(latest.ms + headlineDelayMin * 60000).toISOString()
      : (propagated ? propagated.arrivalTimeUtc : null);

    current = {
      sampleTimeUtc: new Date(latest.ms).toISOString(),
      speedKmS: latest.speedKmS,
      densityPerCm3: latest.densityPerCm3,
      bzNt: latest.bzNt,
      btNt: latest.btNt,
      pdynNpa: latest.pdynNpa ?? null,
      emMvM: latest.emMvM ?? null,
      riskAvailable,
      sources: {
        speedKmS: sourceLabelByVariable.speed,
        bzNt: sourceLabelByVariable.bz,
        btNt: sourceLabelByVariable.bt,
        densityPerCm3: sourceLabelByVariable.density,
        gLevel: gSources,
      },
      missingVariables: latest.missingVariables ?? [],
      qualityFlags: latest.qualityFlags ?? [],
      l1DistanceKm: Math.round(history.distanceKm),
      distanceIsMeasured: history.distanceIsMeasured,
      lagMinutes: headlineDelayMin !== null ? Math.round(headlineDelayMin) : null,
      arrivalUtc: headlineArrivalUtc,
      mlApplied,
      mruDelayMin: benchmarkMruMin !== null ? round(benchmarkMruMin, 1) : null,
      correctedDelayMin: correctedMin !== null ? round(correctedMin, 1) : null,
      mlResidualMin: mlLatest?.residualMin ?? null,
      etaBandMin: mlApplied ? ETA_BAND_ML_MIN : (benchmarkMruMin !== null ? ETA_BAND_MRU_MIN : null),
      danger: { level: g.level, code: g.code, label: g.label, estKp: estKp === null ? null : round(estKp, 1), fraction: estKp === null ? 0 : Math.max(0, Math.min(1, estKp / 9)) },
    };
  }

  // Inbound corridor: every recent L1 sample propagated to Earth that has NOT yet
  // arrived — i.e. the solar wind currently in transit between L1 and Earth. Each carries
  // a per-sample G estimate (lightly smoothed to kill 1-min spikes) so the UI can paint
  // the L1→Earth corridor as a CONTINUOUS band whose colour shows what is inbound. This is
  // independent of the forecast-log cadence (which only thins the table below).
  const INBOUND_LOOKBACK_MS = 150 * 60 * 1000; // generous: covers the slowest transit
  const INBOUND_SMOOTH_MS = 10 * 60 * 1000;
  const inbound: Array<{
    detectedMs: number;
    arrivalMs: number;
    leadTimeMinutes: number;
    gLevel: number;
    riskAvailable: boolean;
    speedKmS: number | null;
    bzNt: number | null;
    btNt: number | null;
    densityPerCm3: number | null;
    pdynNpa: number | null;
    emMvM: number | null;
    sources: {
      speedKmS: string | null;
      bzNt: string | null;
      btNt: string | null;
      densityPerCm3: string | null;
      gLevel: string | null;
    };
    sourceTimeByVariable: {
      speedKmS: string | null;
      bzNt: string | null;
      btNt: string | null;
      densityPerCm3: string | null;
    };
    missingVariables: string[];
    qualityFlags: string[];
  }> = [];
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (latest && latest.ms - s.ms > INBOUND_LOOKBACK_MS) continue;
    const prop = propagateL1Sample(
      { timeUtc: new Date(s.ms).toISOString(), speedKmS: s.speedKmS, densityPerCm3: s.densityPerCm3, bzNt: s.bzNt, btNt: s.btNt, temperatureK: null },
      history.mruDistanceKm,
    );
    if (!prop) continue;
    const arrivalMs = new Date(prop.arrivalTimeUtc).getTime();
    if (!Number.isFinite(arrivalMs) || arrivalMs <= nowMs) continue; // already arrived
    let emSum = 0;
    let emN = 0;
    let spSum = 0;
    let spN = 0;
    for (let j = i; j >= 0 && s.ms - samples[j].ms <= INBOUND_SMOOTH_MS; j -= 1) {
      if (typeof samples[j].speedKmS === 'number' && typeof samples[j].bzNt === 'number') {
        emSum += mergingFieldMvM(samples[j].speedKmS, samples[j].bzNt);
        emN += 1;
      }
      if (typeof samples[j].speedKmS === 'number') {
        spSum += samples[j].speedKmS as number;
        spN += 1;
      }
    }
    const riskAvailable = s.riskAvailable ?? (s.speedKmS !== null && s.bzNt !== null);
    const g = riskAvailable && emN > 0
      ? classifyGFromKp(kpFromCoupling(emSum / emN, spN > 0 ? spSum / spN : s.speedKmS))
      : classifyGFromKp(null);
    const sourceLabelByVariable = s.sourceLabelByVariable ?? { speed: null, bz: null, bt: null, density: null };
    const gSources = riskAvailable
      ? Array.from(new Set([sourceLabelByVariable.speed, sourceLabelByVariable.bz].filter((label): label is string => !!label))).join(' + ') || null
      : null;
    inbound.push({
      detectedMs: s.ms,
      arrivalMs,
      leadTimeMinutes: Math.round(prop.lagMinutes),
      gLevel: g.level,
      riskAvailable,
      speedKmS: s.speedKmS,
      bzNt: s.bzNt,
      btNt: s.btNt,
      densityPerCm3: s.densityPerCm3,
      pdynNpa: s.pdynNpa ?? null,
      emMvM: s.emMvM ?? null,
      sources: {
        speedKmS: sourceLabelByVariable.speed,
        bzNt: sourceLabelByVariable.bz,
        btNt: sourceLabelByVariable.bt,
        densityPerCm3: sourceLabelByVariable.density,
        gLevel: gSources,
      },
      sourceTimeByVariable: {
        speedKmS: s.sourceTimeByVariable?.speed ?? null,
        bzNt: s.sourceTimeByVariable?.bz ?? null,
        btNt: s.sourceTimeByVariable?.bt ?? null,
        densityPerCm3: s.sourceTimeByVariable?.density ?? null,
      },
      missingVariables: s.missingVariables ?? [],
      qualityFlags: s.qualityFlags ?? [],
    });
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
      // Which independent pipeline won this poll, its age, and every source we
      // considered (so the UI can always show what is live).
      liveSource: {
        id: history.sourceId,
        label: history.sourceLabel,
        sampleAgeMinutes: history.latestSampleAgeMinutes,
        freshness: history.freshness,
        considered: history.consideredSources.map(source => ({
          id: source.sourceId,
          label: source.sourceLabel,
          sampleCount: source.sampleCount,
          latestSampleUtc: source.latestSampleMs !== null ? new Date(source.latestSampleMs).toISOString() : null,
          errorMessage: source.errorMessage,
        })),
      },
      feedDegraded: history.samples.length === 0 || !!history.errorMessage || history.freshness !== 'fresh',
      warnings: [history.errorMessage, scales.errorMessage].filter(Boolean),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
