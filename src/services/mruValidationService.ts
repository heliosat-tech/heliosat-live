/**
 * MRU validation: backtest the uniform-rectilinear-motion baseline against
 * reality on a historical window.
 *
 *   L1 input  : ACE key-parameter feeds (solar wind measured at L1)
 *   Earth truth: OMNI HRO 1-min (the community-standard solar wind propagated
 *                to Earth's bow shock nose)
 *
 * We propagate the ACE samples to Earth with the MRU rule and compare the
 * result against OMNI on a common time grid. Speed, density and |B| are
 * frame-independent and are scored; Bz is shown for context only (ACE reports
 * GSE here, OMNI reports GSM, so a direct error would mix in a frame rotation).
 */
import { resolveCoverageAnchoredRange } from './dataCoverageService';
import { fetchHapiSeriesChunked, toFiniteNumber, type HapiSeriesResult } from './historicPlotService';
import type { L1EarthSample } from './l1EarthData';
import { loadMlModel, predictAtTimes } from './mlModelService';
import {
  NOMINAL_L1_DISTANCE_KM,
  propagateL1Series,
  type L1Sample,
  type PropagatedSample,
} from './mruForecastService';

export type ScoredVariableId = 'speed' | 'density' | 'bt';
export type SeriesVariableId = ScoredVariableId | 'bz';

export interface MruValidationMetric {
  variableId: ScoredVariableId;
  label: string;
  unit: string;
  count: number;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  r2: number | null;
  truthMean: number | null;
  relativeMaePct: number | null;
}

export interface MruValidationPoint {
  timeUtc: string;
  value: number | null;
}

export interface MruValidationSeries {
  variableId: SeriesVariableId;
  label: string;
  unit: string;
  l1: MruValidationPoint[];
  predicted: MruValidationPoint[];
  mlPredicted: MruValidationPoint[];
  truth: MruValidationPoint[];
  note?: string;
}

export interface MruValidationSnapshot {
  generatedAtUtc: string;
  range: { startUtc: string; stopUtc: string };
  autoSelected: boolean;
  l1Source: string;
  truthSource: string;
  distanceKm: number;
  meanLagMinutes: number | null;
  sampleCount: { l1: number; truth: number; matched: number };
  metrics: MruValidationMetric[];
  mlAvailable: boolean;
  mlTrainedAtUtc: string | null;
  mlMetrics: MruValidationMetric[] | null;
  mlOverallSkillPct: number | null;
  series: MruValidationSeries[];
  warnings: string[];
}

const MAX_SERIES_POINTS = 320;
const MAX_WINDOW_DAYS = 120;
const PLASMA_MAG_JOIN_TOLERANCE_MS = 120_000;
const PREDICTED_TRUTH_JOIN_TOLERANCE_MS = 90_000;

const PHYSICAL_RANGE: Record<SeriesVariableId, { min: number; max: number }> = {
  speed: { min: 100, max: 3000 },
  density: { min: 0.01, max: 200 },
  bt: { min: 0, max: 200 },
  bz: { min: -200, max: 200 },
};

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function sanitize(value: number | null, variableId: SeriesVariableId): number | null {
  if (value === null) {
    return null;
  }

  const { min, max } = PHYSICAL_RANGE[variableId];
  return value >= min && value <= max ? value : null;
}

/** Read a possibly-vector HAPI cell (e.g. ACE BGSEc => [bx, by, bz]). */
function readVectorComponent(cell: unknown, index: number): number | null {
  return Array.isArray(cell) ? toFiniteNumber(cell[index]) : null;
}

type TimedItem<T> = { ms: number; item: T };

/** Nearest-neighbour join of two ascending-by-time series within a tolerance. */
function joinNearest<TA, TB>(
  a: TimedItem<TA>[],
  b: TimedItem<TB>[],
  toleranceMs: number,
): Array<{ a: TA; b: TB }> {
  if (a.length === 0 || b.length === 0) {
    return [];
  }

  const matches: Array<{ a: TA; b: TB }> = [];
  let j = 0;

  for (const entry of a) {
    while (j + 1 < b.length && Math.abs(b[j + 1].ms - entry.ms) <= Math.abs(b[j].ms - entry.ms)) {
      j += 1;
    }

    if (Math.abs(b[j].ms - entry.ms) <= toleranceMs) {
      matches.push({ a: entry.item, b: b[j].item });
    }
  }

  return matches;
}

function downsample<T>(points: T[], maxPoints = MAX_SERIES_POINTS): T[] {
  if (points.length <= maxPoints) {
    return points;
  }

  const stride = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % stride === 0);
}

function computeMetric(
  variableId: ScoredVariableId,
  label: string,
  unit: string,
  pairs: Array<{ predicted: number | null; truth: number | null }>,
): MruValidationMetric {
  const valid = pairs.filter(
    (pair): pair is { predicted: number; truth: number } =>
      pair.predicted !== null && pair.truth !== null,
  );
  const count = valid.length;

  if (count === 0) {
    return { variableId, label, unit, count: 0, mae: null, rmse: null, bias: null, r2: null, truthMean: null, relativeMaePct: null };
  }

  let sumAbs = 0;
  let sumSq = 0;
  let sumResidual = 0;
  let sumTruth = 0;

  for (const { predicted, truth } of valid) {
    const residual = predicted - truth;
    sumAbs += Math.abs(residual);
    sumSq += residual * residual;
    sumResidual += residual;
    sumTruth += truth;
  }

  const mae = sumAbs / count;
  const truthMean = sumTruth / count;
  const ssTot = valid.reduce((sum, { truth }) => sum + (truth - truthMean) ** 2, 0);

  return {
    variableId,
    label,
    unit,
    count,
    mae,
    rmse: Math.sqrt(sumSq / count),
    bias: sumResidual / count,
    r2: ssTot > 0 ? 1 - sumSq / ssTot : null,
    truthMean,
    relativeMaePct: truthMean !== 0 ? (mae / Math.abs(truthMean)) * 100 : null,
  };
}

function toPoint(ms: number, value: number | null): MruValidationPoint {
  return { timeUtc: new Date(ms).toISOString(), value };
}

export async function buildMruValidationSnapshot(range?: {
  startUtc?: string;
  stopUtc?: string;
}): Promise<MruValidationSnapshot> {
  const generatedAtUtc = new Date().toISOString();
  const warnings: string[] = [];
  const l1Source = 'ACE key parameters (CDAWeb HAPI)';
  const truthSource = 'OMNI HRO 1-min (CDAWeb HAPI)';

  // When no window is given, anchor to the datasets' real coverage so the
  // backtest lands on data automatically (the machine clock runs ahead of the
  // ~2-week-lagged archives).
  const autoSelected = !range?.startUtc || !range?.stopUtc;
  const rawRange = autoSelected
    ? ((await resolveCoverageAnchoredRange(3)) ?? { startUtc: range?.startUtc ?? '', stopUtc: range?.stopUtc ?? '' })
    : { startUtc: range.startUtc as string, stopUtc: range.stopUtc as string };

  // Cap very long windows: even with chunked fetching, multi-month 1-min data is
  // slow and heavy. This keeps backtests responsive and avoids aborts.
  const rawStartMs = parseTimeMs(rawRange.startUtc);
  const rawStopMs = parseTimeMs(rawRange.stopUtc);
  let resolvedRange = rawRange;
  if (rawStartMs !== null && rawStopMs !== null && rawStopMs - rawStartMs > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    resolvedRange = {
      startUtc: new Date(rawStopMs - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      stopUtc: rawRange.stopUtc,
    };
    warnings.push(`Window capped to ${MAX_WINDOW_DAYS} days — longer backtests are too slow; pick a sub-window or a recommended interval.`);
  }

  const base: MruValidationSnapshot = {
    generatedAtUtc,
    range: resolvedRange,
    autoSelected,
    l1Source,
    truthSource,
    distanceKm: NOMINAL_L1_DISTANCE_KM,
    meanLagMinutes: null,
    sampleCount: { l1: 0, truth: 0, matched: 0 },
    metrics: [],
    mlAvailable: false,
    mlTrainedAtUtc: null,
    mlMetrics: null,
    mlOverallSkillPct: null,
    series: [],
    warnings,
  };

  const startMs = parseTimeMs(resolvedRange.startUtc);
  const stopMs = parseTimeMs(resolvedRange.stopUtc);

  if (startMs === null || stopMs === null || stopMs <= startMs) {
    warnings.push('No usable data window (coverage probe failed and no valid range was given).');
    return base;
  }

  const [plasmaResult, magResult, omniResult]: HapiSeriesResult[] = await Promise.all([
    fetchHapiSeriesChunked('AC_K0_SWE', ['Np', 'Vp', 'Tpr'], resolvedRange),
    fetchHapiSeriesChunked('AC_K0_MFI', ['Magnitude', 'BGSEc'], resolvedRange),
    fetchHapiSeriesChunked('OMNI_HRO_1MIN', ['F', 'BZ_GSM', 'flow_speed', 'proton_density'], resolvedRange),
  ]);

  warnings.push(...plasmaResult.warnings, ...magResult.warnings, ...omniResult.warnings);

  // --- L1 input: join ACE plasma (Np, Vp) with ACE magnetometer (|B|, Bz GSE) ---
  const plasmaPoints: TimedItem<{ speed: number | null; density: number | null; temp: number | null }>[] =
    plasmaResult.rows
      .map(row => {
        const ms = parseTimeMs(row[0]);
        if (ms === null) {
          return null;
        }
        return {
          ms,
          item: {
            density: sanitize(toFiniteNumber(row[1]), 'density'),
            speed: sanitize(toFiniteNumber(row[2]), 'speed'),
            temp: toFiniteNumber(row[3]),
          },
        };
      })
      .filter((entry): entry is TimedItem<{ speed: number | null; density: number | null; temp: number | null }> => entry !== null)
      .sort((a, b) => a.ms - b.ms);

  const magPoints: TimedItem<{ bt: number | null; bz: number | null }>[] = magResult.rows
    .map(row => {
      const ms = parseTimeMs(row[0]);
      if (ms === null) {
        return null;
      }
      return {
        ms,
        item: {
          bt: sanitize(toFiniteNumber(row[1]), 'bt'),
          bz: sanitize(readVectorComponent(row[2], 2), 'bz'),
        },
      };
    })
    .filter((entry): entry is TimedItem<{ bt: number | null; bz: number | null }> => entry !== null)
    .sort((a, b) => a.ms - b.ms);

  const l1Samples: L1Sample[] = plasmaPoints
    .map(plasma => {
      // attach nearest magnetometer reading
      const joined = joinNearest([plasma], magPoints, PLASMA_MAG_JOIN_TOLERANCE_MS)[0];
      return {
        timeUtc: new Date(plasma.ms).toISOString(),
        speedKmS: plasma.item.speed,
        densityPerCm3: plasma.item.density,
        temperatureK: plasma.item.temp,
        btNt: joined?.b.bt ?? null,
        bzNt: joined?.b.bz ?? null,
      } satisfies L1Sample;
    })
    .filter(sample => sample.speedKmS !== null);

  const predicted: PropagatedSample[] = propagateL1Series(l1Samples, NOMINAL_L1_DISTANCE_KM);

  // --- Earth truth: OMNI ---
  const truthPoints = omniResult.rows
    .map(row => {
      const ms = parseTimeMs(row[0]);
      if (ms === null) {
        return null;
      }
      return {
        ms,
        bt: sanitize(toFiniteNumber(row[1]), 'bt'),
        bz: sanitize(toFiniteNumber(row[2]), 'bz'),
        speed: sanitize(toFiniteNumber(row[3]), 'speed'),
        density: sanitize(toFiniteNumber(row[4]), 'density'),
      };
    })
    .filter((entry): entry is { ms: number; bt: number | null; bz: number | null; speed: number | null; density: number | null } => entry !== null)
    .sort((a, b) => a.ms - b.ms);

  if (predicted.length === 0 || truthPoints.length === 0) {
    if (predicted.length === 0) {
      warnings.push('No usable ACE solar-wind samples for this window.');
    }
    if (truthPoints.length === 0) {
      warnings.push('No usable OMNI samples for this window.');
    }
    return {
      ...base,
      sampleCount: { l1: predicted.length, truth: truthPoints.length, matched: 0 },
    };
  }

  // --- Align MRU prediction (by arrival time) with OMNI truth (by time) ---
  const predictedTimed: TimedItem<PropagatedSample>[] = predicted.map(sample => ({
    ms: new Date(sample.arrivalTimeUtc).getTime(),
    item: sample,
  }));
  const truthTimed: TimedItem<(typeof truthPoints)[number]>[] = truthPoints.map(point => ({
    ms: point.ms,
    item: point,
  }));

  const matched = joinNearest(truthTimed, predictedTimed, PREDICTED_TRUTH_JOIN_TOLERANCE_MS);

  const metrics: MruValidationMetric[] = [
    computeMetric('speed', 'Solar-wind speed', 'km/s', matched.map(m => ({ predicted: m.b.speedKmS, truth: m.a.speed }))),
    computeMetric('density', 'Proton density', 'n/cc', matched.map(m => ({ predicted: m.b.densityPerCm3, truth: m.a.density }))),
    computeMetric('bt', 'Field magnitude |B|', 'nT', matched.map(m => ({ predicted: m.b.btNt, truth: m.a.bt }))),
  ];

  const meanLagMinutes = predicted.reduce((sum, sample) => sum + sample.lagMinutes, 0) / predicted.length;

  // --- ML model (if a trained artifact exists): predict the same truth points ---
  const l1ForMl: L1EarthSample[] = l1Samples.map(s => ({
    ms: new Date(s.timeUtc).getTime(),
    speed: s.speedKmS,
    density: s.densityPerCm3,
    bt: s.btNt,
    bz: s.bzNt,
  }));
  const mlArtifact = await loadMlModel();
  const mlAvailable = mlArtifact !== null;
  const truthTimesMs = truthPoints.map(point => point.ms);
  // anchorToInput mirrors how the model is served live (correction over the input
  // baseline, not the ACE->OMNI absolute level) so validation matches live forecast.
  const mlAtTruth = (variableId: 'speed' | 'density' | 'bt' | 'bz') =>
    mlArtifact ? predictAtTimes(mlArtifact, l1ForMl, variableId, truthTimesMs, { anchorToInput: true }) : truthTimesMs.map(() => null);
  const mlSpeedTruth = mlAtTruth('speed');
  const mlDensityTruth = mlAtTruth('density');
  const mlBtTruth = mlAtTruth('bt');
  const mlBzTruth = mlAtTruth('bz');

  let mlMetrics: MruValidationMetric[] | null = null;
  let mlOverallSkillPct: number | null = null;
  if (mlArtifact) {
    const matchedTimes = matched.map(m => m.a.ms);
    const mlSpeed = predictAtTimes(mlArtifact, l1ForMl, 'speed', matchedTimes, { anchorToInput: true });
    const mlDensity = predictAtTimes(mlArtifact, l1ForMl, 'density', matchedTimes, { anchorToInput: true });
    const mlBt = predictAtTimes(mlArtifact, l1ForMl, 'bt', matchedTimes, { anchorToInput: true });
    mlMetrics = [
      computeMetric('speed', 'Solar-wind speed', 'km/s', matched.map((m, i) => ({ predicted: mlSpeed[i], truth: m.a.speed }))),
      computeMetric('density', 'Proton density', 'n/cc', matched.map((m, i) => ({ predicted: mlDensity[i], truth: m.a.density }))),
      computeMetric('bt', 'Field magnitude |B|', 'nT', matched.map((m, i) => ({ predicted: mlBt[i], truth: m.a.bt }))),
    ];
    const skills: number[] = [];
    for (let i = 0; i < mlMetrics.length; i += 1) {
      const mlRmse = mlMetrics[i].rmse;
      const mruRmse = metrics[i].rmse;
      if (mlRmse !== null && mruRmse !== null && mruRmse > 0) {
        skills.push((1 - mlRmse / mruRmse) * 100);
      }
    }
    mlOverallSkillPct = skills.length > 0 ? skills.reduce((sum, value) => sum + value, 0) / skills.length : null;
  }

  const series: MruValidationSeries[] = [
    {
      variableId: 'speed',
      label: 'Solar-wind speed',
      unit: 'km/s',
      l1: downsample(l1Samples.map(s => toPoint(new Date(s.timeUtc).getTime(), s.speedKmS))),
      predicted: downsample(predicted.map(s => toPoint(new Date(s.arrivalTimeUtc).getTime(), s.speedKmS))),
      mlPredicted: downsample(truthPoints.map((p, i) => toPoint(p.ms, mlSpeedTruth[i]))),
      truth: downsample(truthPoints.map(p => toPoint(p.ms, p.speed))),
    },
    {
      variableId: 'density',
      label: 'Proton density',
      unit: 'n/cc',
      l1: downsample(l1Samples.map(s => toPoint(new Date(s.timeUtc).getTime(), s.densityPerCm3))),
      predicted: downsample(predicted.map(s => toPoint(new Date(s.arrivalTimeUtc).getTime(), s.densityPerCm3))),
      mlPredicted: downsample(truthPoints.map((p, i) => toPoint(p.ms, mlDensityTruth[i]))),
      truth: downsample(truthPoints.map(p => toPoint(p.ms, p.density))),
    },
    {
      variableId: 'bt',
      label: 'Field magnitude |B|',
      unit: 'nT',
      l1: downsample(l1Samples.map(s => toPoint(new Date(s.timeUtc).getTime(), s.btNt))),
      predicted: downsample(predicted.map(s => toPoint(new Date(s.arrivalTimeUtc).getTime(), s.btNt))),
      mlPredicted: downsample(truthPoints.map((p, i) => toPoint(p.ms, mlBtTruth[i]))),
      truth: downsample(truthPoints.map(p => toPoint(p.ms, p.bt))),
    },
    {
      variableId: 'bz',
      label: 'Bz (north-south field)',
      unit: 'nT',
      note: 'Shown for context only — ACE reports Bz in GSE here while OMNI reports GSM, so this is not scored.',
      l1: downsample(l1Samples.map(s => toPoint(new Date(s.timeUtc).getTime(), s.bzNt))),
      predicted: downsample(predicted.map(s => toPoint(new Date(s.arrivalTimeUtc).getTime(), s.bzNt))),
      mlPredicted: downsample(truthPoints.map((p, i) => toPoint(p.ms, mlBzTruth[i]))),
      truth: downsample(truthPoints.map(p => toPoint(p.ms, p.bz))),
    },
  ];

  return {
    ...base,
    meanLagMinutes,
    sampleCount: { l1: predicted.length, truth: truthPoints.length, matched: matched.length },
    metrics,
    mlAvailable,
    mlTrainedAtUtc: mlArtifact?.trainedAtUtc ?? null,
    mlMetrics,
    mlOverallSkillPct,
    series,
    warnings,
  };
}
