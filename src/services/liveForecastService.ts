import type { FeatureWorkbenchSnapshot } from './featureEngineeringService';
import type { BaselinesLabSnapshot, ModelPredictionRow } from './modelBenchmarkService';
import type { PipelineHealthSnapshot } from './pipelineHealthService';

export interface LiveForecastPoint {
  timestampUtc: string;
  observed: number | null;
  predicted: number | null;
  lower: number | null;
  upper: number | null;
  horizonMinutes: number | null;
}

export interface LiveForecastSnapshot {
  generatedAtUtc: string;
  model: {
    runId: string | null;
    model: string;
    target: string;
    weightsUpdatedAtUtc: string | null;
    status: 'baseline' | 'model' | 'unavailable';
  };
  currentAlert: 'green' | 'yellow' | 'red' | 'gray';
  forecast: LiveForecastPoint[];
  trackRecord: Array<{
    timestampUtc: string;
    horizonMinutes: number;
    actual: number;
    predicted: number;
    residual: number;
  }>;
  rollingRmse: Array<{
    timestampUtc: string;
    horizonMinutes: number;
    rmse24h: number | null;
  }>;
  systemHealth: {
    driftScore: number | null;
    driftSparkline: number[];
    inferenceLatencyMsP50: number | null;
    inferenceLatencyMsP95: number | null;
    upstreamFreshness: PipelineHealthSnapshot['sources'];
  };
  operationalHistory: Array<{
    dayUtc: string;
    meanAbsoluteError: number | null;
  }>;
  warnings: string[];
}

const LIVE_HORIZONS_MINUTES = [15, 30, 45, 60, 90];

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const timestampMs = new Date(value).getTime();
  return Number.isNaN(timestampMs) ? null : timestampMs;
}

function toIsoUtc(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

function round(value: number | null, digits = 5) {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function rmse(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  return Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
}

function chooseBestRun(baselines: BaselinesLabSnapshot) {
  return baselines.runs
    .filter(run => run.status === 'trained' && run.metrics.rmse !== null)
    .slice()
    .sort((a, b) => (a.metrics.rmse ?? Number.POSITIVE_INFINITY) - (b.metrics.rmse ?? Number.POSITIVE_INFINITY))[0] ?? null;
}

function residualP95(predictions: ModelPredictionRow[]) {
  const absErrors = predictions.map(row => Math.abs(row.residual)).sort((a, b) => a - b);

  if (absErrors.length === 0) {
    return null;
  }

  return absErrors[Math.min(absErrors.length - 1, Math.ceil(absErrors.length * 0.95) - 1)];
}

function buildRollingRmse(predictions: ModelPredictionRow[]) {
  return predictions.map(row => {
    const rowMs = parseTimestampMs(row.timestampUtc) ?? 0;
    const windowErrors = predictions
      .filter(candidate => {
        const candidateMs = parseTimestampMs(candidate.timestampUtc);
        return candidateMs !== null && candidateMs <= rowMs && candidateMs >= rowMs - 24 * 60 * 60 * 1000;
      })
      .map(candidate => candidate.residual);

    return {
      timestampUtc: row.timestampUtc,
      horizonMinutes: 30,
      rmse24h: round(rmse(windowErrors)),
    };
  });
}

function driftScore(featureSnapshot: FeatureWorkbenchSnapshot) {
  const latestRow = featureSnapshot.matrixRows.at(-1);

  if (!latestRow) {
    return null;
  }

  const zScores = featureSnapshot.featureStats
    .map(stat => {
      const value = latestRow.values[stat.featureId];
      if (value === null || value === undefined || stat.mean === null || stat.std === null || stat.std === 0) {
        return null;
      }
      return Math.min(10, Math.abs((value - stat.mean) / stat.std));
    })
    .filter((value): value is number => value !== null);

  if (zScores.length === 0) {
    return null;
  }

  return zScores.reduce((sum, value) => sum + value, 0) / zScores.length;
}

function driftSeries(featureSnapshot: FeatureWorkbenchSnapshot) {
  return featureSnapshot.matrixRows.slice(-24).map(row => {
    const zScores = featureSnapshot.featureStats
      .map(stat => {
        const value = row.values[stat.featureId];
        if (value === null || value === undefined || stat.mean === null || stat.std === null || stat.std === 0) {
          return null;
        }
        return Math.min(10, Math.abs((value - stat.mean) / stat.std));
      })
      .filter((value): value is number => value !== null);

    if (zScores.length === 0) {
      return 0;
    }

    return round(zScores.reduce((sum, value) => sum + value, 0) / zScores.length, 4) ?? 0;
  });
}

export function buildLiveForecastSnapshot(
  featureSnapshot: FeatureWorkbenchSnapshot,
  baselines: BaselinesLabSnapshot,
  pipelineHealth: PipelineHealthSnapshot,
): LiveForecastSnapshot {
  const latestRows = featureSnapshot.matrixRows
    .filter(row => row.target !== null)
    .slice(-120);
  const latestRow = latestRows.at(-1);
  const latestMs = latestRow ? parseTimestampMs(latestRow.timestampUtc) : null;
  const bestRun = chooseBestRun(baselines);
  const bestRunPredictions = bestRun ? baselines.predictions.filter(row => row.runId === bestRun.runId && row.split === 'test') : [];
  const uncertainty = residualP95(bestRunPredictions) ?? 0;
  const latestValue = latestRow?.target ?? null;
  const forecast: LiveForecastPoint[] = [
    ...latestRows.map(row => ({
      timestampUtc: row.timestampUtc,
      observed: row.target,
      predicted: null,
      lower: null,
      upper: null,
      horizonMinutes: null,
    })),
    ...LIVE_HORIZONS_MINUTES.map(horizonMinutes => ({
      timestampUtc: latestMs === null ? new Date().toISOString() : toIsoUtc(latestMs + horizonMinutes * 60 * 1000),
      observed: null,
      predicted: latestValue,
      lower: latestValue === null ? null : latestValue - uncertainty,
      upper: latestValue === null ? null : latestValue + uncertainty,
      horizonMinutes,
    })),
  ];
  const trackRecord = bestRunPredictions.slice(-240).map(row => ({
    timestampUtc: row.timestampUtc,
    horizonMinutes: bestRun?.horizonMinutes ?? 30,
    actual: row.actual,
    predicted: row.predicted,
    residual: row.residual,
  }));
  const currentDriftScore = round(driftScore(featureSnapshot), 4);
  const latestRmse = bestRun?.metrics.rmse ?? null;
  const p95Error = bestRun?.metrics.p95AbsoluteError ?? null;
  const currentAbsResidual = trackRecord.at(-1) ? Math.abs(trackRecord.at(-1)?.residual ?? 0) : null;
  const currentAlert = latestValue === null
    ? 'gray'
    : currentAbsResidual !== null && p95Error !== null && currentAbsResidual > p95Error
      ? 'red'
      : currentDriftScore !== null && currentDriftScore > 2
        ? 'yellow'
        : 'green';

  return {
    generatedAtUtc: new Date().toISOString(),
    model: {
      runId: bestRun?.runId ?? null,
      model: bestRun?.model ?? 'Persistence fallback',
      target: featureSnapshot.target.label,
      weightsUpdatedAtUtc: bestRun?.trainedAtUtc ?? null,
      status: bestRun ? 'baseline' : 'unavailable',
    },
    currentAlert,
    forecast,
    trackRecord,
    rollingRmse: buildRollingRmse(bestRunPredictions.slice(-240)),
    systemHealth: {
      driftScore: currentDriftScore,
      driftSparkline: driftSeries(featureSnapshot),
      inferenceLatencyMsP50: null,
      inferenceLatencyMsP95: null,
      upstreamFreshness: pipelineHealth.sources,
    },
    operationalHistory: Object.values(trackRecord.reduce<Record<string, { dayUtc: string; errors: number[] }>>((accumulator, row) => {
      const dayUtc = row.timestampUtc.slice(0, 10);
      const existing = accumulator[dayUtc] ?? { dayUtc, errors: [] };
      existing.errors.push(Math.abs(row.residual));
      accumulator[dayUtc] = existing;
      return accumulator;
    }, {})).map(day => ({
      dayUtc: day.dayUtc,
      meanAbsoluteError: round(day.errors.reduce((sum, value) => sum + value, 0) / Math.max(1, day.errors.length)),
    })),
    warnings: [
      latestRmse === null ? 'No trained baseline run is available for live forecast selection.' : '',
      'Inference latency instrumentation is not wired to persistent run logs yet.',
      'Live logging is represented in-memory in the playground; append-only Parquet writer is not installed yet.',
    ].filter(Boolean),
  };
}
