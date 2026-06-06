import type {
  FeaturePreviewRow,
  FeatureStats,
  FeatureWorkbenchSnapshot,
} from './featureEngineeringService';

export type ModelFamily = 'naive' | 'linear' | 'var' | 'boosting' | 'sequence';
export type ModelRunStatus = 'trained' | 'registered' | 'failed';
export type DatasetSplit = 'train' | 'val' | 'test';

export interface RegressionMetrics {
  rmse: number | null;
  mae: number | null;
  r2: number | null;
  bias: number | null;
  medianAbsoluteError: number | null;
  p95AbsoluteError: number | null;
  skillVsPersistence: number | null;
  peakError: number | null;
  leadTimeMinutes: number | null;
  pinballLoss: number | null;
  crps: number | null;
}

export interface ModelPredictionRow {
  runId: string;
  timestampUtc: string;
  issuedAtUtc: string;
  split: DatasetSplit;
  actual: number;
  predicted: number;
  residual: number;
}

export interface FeatureImportanceRow {
  runId: string;
  featureId: string;
  importance: number;
  rank: number;
}

export interface ModelRunRecord {
  runId: string;
  model: string;
  family: ModelFamily;
  status: ModelRunStatus;
  target: string;
  horizonMinutes: number;
  seed: number;
  trainedAtUtc: string | null;
  trainRows: number;
  valRows: number;
  testRows: number;
  metrics: RegressionMetrics;
  notes: string[];
}

export interface BaselinesLabSnapshot {
  generatedAtUtc: string;
  target: string;
  horizonsMinutes: number[];
  runsDbPath: string;
  predictionsPath: string;
  featureImportancePath: string;
  split: {
    train: { startUtc: string | null; stopUtc: string | null; rows: number };
    val: { startUtc: string | null; stopUtc: string | null; rows: number };
    test: { startUtc: string | null; stopUtc: string | null; rows: number };
  };
  runs: ModelRunRecord[];
  predictions: ModelPredictionRow[];
  featureImportance: FeatureImportanceRow[];
  selectedStormWindow: {
    startUtc: string | null;
    stopUtc: string | null;
  };
  warnings: string[];
}

interface SupervisedRow {
  issuedAtMs: number;
  targetMs: number;
  split: DatasetSplit;
  actual: number;
  persistence: number;
  features: Record<string, number | null>;
}

interface LinearDataset {
  featureIds: string[];
  trainMeans: number[];
  trainStds: number[];
  trainX: number[][];
  trainY: number[];
  testX: number[][];
  testRows: SupervisedRow[];
}

const DEFAULT_HORIZONS_MINUTES = [30, 60, 90];
const MODEL_SEED = 42;
const MAX_LINEAR_FEATURES = 18;

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

function mean(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], rank: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index];
}

function rmse(errors: number[]) {
  if (errors.length === 0) {
    return null;
  }

  return Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
}

function mae(errors: number[]) {
  if (errors.length === 0) {
    return null;
  }

  return errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
}

function r2(actual: number[], predicted: number[]) {
  if (actual.length < 2 || actual.length !== predicted.length) {
    return null;
  }

  const actualMean = mean(actual);

  if (actualMean === null) {
    return null;
  }

  const ssRes = actual.reduce((sum, value, index) => sum + (value - predicted[index]) ** 2, 0);
  const ssTot = actual.reduce((sum, value) => sum + (value - actualMean) ** 2, 0);

  return ssTot === 0 ? null : 1 - ssRes / ssTot;
}

function buildMetrics(predictions: ModelPredictionRow[], persistenceRmse: number | null): RegressionMetrics {
  const testPredictions = predictions.filter(row => row.split === 'test');
  const errors = testPredictions.map(row => row.predicted - row.actual);
  const actual = testPredictions.map(row => row.actual);
  const predicted = testPredictions.map(row => row.predicted);
  const currentRmse = rmse(errors);
  const absErrors = errors.map(error => Math.abs(error));

  return {
    rmse: round(currentRmse),
    mae: round(mae(errors)),
    r2: round(r2(actual, predicted)),
    bias: round(mean(errors)),
    medianAbsoluteError: round(median(absErrors)),
    p95AbsoluteError: round(percentile(absErrors, 0.95)),
    skillVsPersistence: currentRmse === null || persistenceRmse === null || persistenceRmse === 0
      ? null
      : round(1 - currentRmse / persistenceRmse),
    peakError: round(absErrors.length > 0 ? Math.max(...absErrors) : null),
    leadTimeMinutes: null,
    pinballLoss: null,
    crps: null,
  };
}

function getSplitForIndex(index: number, totalRows: number): DatasetSplit {
  const trainStop = Math.floor(totalRows * 0.6);
  const valStop = Math.floor(totalRows * 0.8);

  if (index < trainStop) {
    return 'train';
  }

  if (index < valStop) {
    return 'val';
  }

  return 'test';
}

function buildSupervisedRows(matrixRows: FeaturePreviewRow[], horizonMinutes: number): SupervisedRow[] {
  const rows = matrixRows
    .map(row => {
      const timestampMs = parseTimestampMs(row.timestampUtc);
      return timestampMs === null || row.target === null ? null : { timestampMs, row };
    })
    .filter((row): row is { timestampMs: number; row: FeaturePreviewRow } => row !== null)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const targetByTimestamp = new Map(rows.map(row => [row.timestampMs, row.row.target] as const));
  const horizonMs = horizonMinutes * 60 * 1000;
  const supervisedRows = rows
    .map((row): Omit<SupervisedRow, 'split'> | null => {
      const actual = targetByTimestamp.get(row.timestampMs + horizonMs);

      if (actual === undefined || actual === null || row.row.target === null) {
        return null;
      }

      return {
        issuedAtMs: row.timestampMs,
        targetMs: row.timestampMs + horizonMs,
        actual,
        persistence: row.row.target,
        features: row.row.values,
      };
    })
    .filter((row): row is Omit<SupervisedRow, 'split'> => row !== null);

  return supervisedRows.map((row, index) => ({
    ...row,
    split: getSplitForIndex(index, supervisedRows.length),
  }));
}

function makePredictionRows(runId: string, rows: SupervisedRow[], predictions: number[]): ModelPredictionRow[] {
  return rows.map((row, index) => ({
    runId,
    timestampUtc: toIsoUtc(row.targetMs),
    issuedAtUtc: toIsoUtc(row.issuedAtMs),
    split: row.split,
    actual: row.actual,
    predicted: predictions[index],
    residual: predictions[index] - row.actual,
  }));
}

function getTemporalSplit(rows: SupervisedRow[]) {
  const bySplit = (split: DatasetSplit) => rows.filter(row => row.split === split);
  const summarize = (splitRows: SupervisedRow[]) => ({
    startUtc: splitRows.length > 0 ? toIsoUtc(splitRows[0].targetMs) : null,
    stopUtc: splitRows.length > 0 ? toIsoUtc(splitRows[splitRows.length - 1].targetMs) : null,
    rows: splitRows.length,
  });

  return {
    train: summarize(bySplit('train')),
    val: summarize(bySplit('val')),
    test: summarize(bySplit('test')),
  };
}

function hourSeasonKey(timestampMs: number) {
  const date = new Date(timestampMs);
  const month = date.getUTCMonth();
  const season = Math.floor(month / 3);

  return `${date.getUTCHours()}:${season}`;
}

function buildClimatologyPredictions(rows: SupervisedRow[]) {
  const trainRows = rows.filter(row => row.split === 'train');
  const globalMean = mean(trainRows.map(row => row.actual)) ?? 0;
  const grouped = new Map<string, number[]>();

  trainRows.forEach(row => {
    const key = hourSeasonKey(row.targetMs);
    grouped.set(key, [...(grouped.get(key) ?? []), row.actual]);
  });

  const meanByKey = new Map(Array.from(grouped.entries()).map(([key, values]) => [key, mean(values) ?? globalMean]));

  return rows.map(row => meanByKey.get(hourSeasonKey(row.targetMs)) ?? globalMean);
}

function chooseFeatureIds(stats: FeatureStats[]) {
  return stats
    .filter(stat => stat.count > 0 && stat.nanPercent < 80)
    .sort((a, b) => (b.tentativeImportance ?? 0) - (a.tentativeImportance ?? 0))
    .slice(0, MAX_LINEAR_FEATURES)
    .map(stat => stat.featureId);
}

function prepareLinearDataset(rows: SupervisedRow[], featureIds: string[]): LinearDataset {
  const trainRows = rows.filter(row => row.split === 'train');
  const testRows = rows;
  const trainMeans = featureIds.map(featureId => {
    const values = trainRows
      .map(row => row.features[featureId])
      .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
    return mean(values) ?? 0;
  });
  const trainStds = featureIds.map((featureId, featureIndex) => {
    const values = trainRows
      .map(row => row.features[featureId] ?? trainMeans[featureIndex])
      .filter(Number.isFinite);
    const std = Math.sqrt(values.reduce((sum, value) => sum + (value - trainMeans[featureIndex]) ** 2, 0) / Math.max(1, values.length - 1));
    return std > 0 ? std : 1;
  });
  const buildX = (inputRows: SupervisedRow[]) => inputRows.map(row => [
    1,
    ...featureIds.map((featureId, index) => {
      const value = row.features[featureId];
      return ((value ?? trainMeans[index]) - trainMeans[index]) / trainStds[index];
    }),
  ]);

  return {
    featureIds,
    trainMeans,
    trainStds,
    trainX: buildX(trainRows),
    trainY: trainRows.map(row => row.actual),
    testX: buildX(testRows),
    testRows,
  };
}

function solveLinearSystem(matrix: number[][], vector: number[]) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let pivotIndex = 0; pivotIndex < n; pivotIndex += 1) {
    let maxRow = pivotIndex;

    for (let row = pivotIndex + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][pivotIndex]) > Math.abs(augmented[maxRow][pivotIndex])) {
        maxRow = row;
      }
    }

    [augmented[pivotIndex], augmented[maxRow]] = [augmented[maxRow], augmented[pivotIndex]];

    const pivot = augmented[pivotIndex][pivotIndex];

    if (Math.abs(pivot) < 1e-10) {
      return null;
    }

    for (let column = pivotIndex; column <= n; column += 1) {
      augmented[pivotIndex][column] /= pivot;
    }

    for (let row = 0; row < n; row += 1) {
      if (row === pivotIndex) {
        continue;
      }

      const factor = augmented[row][pivotIndex];

      for (let column = pivotIndex; column <= n; column += 1) {
        augmented[row][column] -= factor * augmented[pivotIndex][column];
      }
    }
  }

  return augmented.map(row => row[n]);
}

function trainRidge(dataset: LinearDataset, lambda: number) {
  const p = dataset.trainX[0]?.length ?? 0;
  const xtx = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xty = new Array<number>(p).fill(0);

  dataset.trainX.forEach((row, rowIndex) => {
    for (let i = 0; i < p; i += 1) {
      xty[i] += row[i] * dataset.trainY[rowIndex];

      for (let j = 0; j < p; j += 1) {
        xtx[i][j] += row[i] * row[j];
      }
    }
  });

  for (let i = 1; i < p; i += 1) {
    xtx[i][i] += lambda;
  }

  return solveLinearSystem(xtx, xty) ?? new Array<number>(p).fill(0);
}

function softThreshold(value: number, penalty: number) {
  if (value > penalty) {
    return value - penalty;
  }

  if (value < -penalty) {
    return value + penalty;
  }

  return 0;
}

function trainElasticNet(dataset: LinearDataset, alpha = 0.02, l1Ratio = 0.35) {
  const trainX = dataset.trainX.map(row => row.slice(1));
  const p = trainX[0]?.length ?? 0;
  const yMean = mean(dataset.trainY) ?? 0;
  const centeredY = dataset.trainY.map(value => value - yMean);
  const weights = new Array<number>(p).fill(0);

  for (let iteration = 0; iteration < 120; iteration += 1) {
    for (let featureIndex = 0; featureIndex < p; featureIndex += 1) {
      let rho = 0;
      let z = 0;

      trainX.forEach((row, rowIndex) => {
        const predictedWithoutFeature = row.reduce((sum, value, index) => (
          index === featureIndex ? sum : sum + value * weights[index]
        ), 0);
        const residual = centeredY[rowIndex] - predictedWithoutFeature;
        rho += row[featureIndex] * residual;
        z += row[featureIndex] ** 2;
      });

      rho /= Math.max(1, trainX.length);
      z /= Math.max(1, trainX.length);
      weights[featureIndex] = softThreshold(rho, alpha * l1Ratio) / (z + alpha * (1 - l1Ratio));
    }
  }

  return [yMean, ...weights];
}

function predictLinear(x: number[][], coefficients: number[]) {
  return x.map(row => row.reduce((sum, value, index) => sum + value * (coefficients[index] ?? 0), 0));
}

function featureImportance(runId: string, featureIds: string[], coefficients: number[]) {
  return featureIds
    .map((featureId, index) => ({
      runId,
      featureId,
      importance: Math.abs(coefficients[index + 1] ?? 0),
      rank: 0,
    }))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 20)
    .map((row, index) => ({
      ...row,
      importance: round(row.importance) ?? 0,
      rank: index + 1,
    }));
}

function buildRun(
  model: string,
  family: ModelFamily,
  horizonMinutes: number,
  target: string,
  rows: SupervisedRow[],
  predictions: ModelPredictionRow[],
  persistenceRmse: number | null,
  notes: string[] = [],
): ModelRunRecord {
  return {
    runId: `${model.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${target.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${horizonMinutes}m_seed${MODEL_SEED}`,
    model,
    family,
    status: 'trained',
    target,
    horizonMinutes,
    seed: MODEL_SEED,
    trainedAtUtc: new Date().toISOString(),
    trainRows: rows.filter(row => row.split === 'train').length,
    valRows: rows.filter(row => row.split === 'val').length,
    testRows: rows.filter(row => row.split === 'test').length,
    metrics: buildMetrics(predictions, persistenceRmse),
    notes,
  };
}

function emptyMetrics(): RegressionMetrics {
  return {
    rmse: null,
    mae: null,
    r2: null,
    bias: null,
    medianAbsoluteError: null,
    p95AbsoluteError: null,
    skillVsPersistence: null,
    peakError: null,
    leadTimeMinutes: null,
    pinballLoss: null,
    crps: null,
  };
}

function registeredRun(model: string, family: ModelFamily, target: string, horizonMinutes: number, notes: string[]): ModelRunRecord {
  return {
    runId: `${model.toLowerCase()}_${target.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${horizonMinutes}m_registered`,
    model,
    family,
    status: 'registered',
    target,
    horizonMinutes,
    seed: MODEL_SEED,
    trainedAtUtc: null,
    trainRows: 0,
    valRows: 0,
    testRows: 0,
    metrics: emptyMetrics(),
    notes,
  };
}

export function buildBaselinesLabSnapshot(
  featureSnapshot: FeatureWorkbenchSnapshot,
  horizonsMinutes: number[] = DEFAULT_HORIZONS_MINUTES,
): BaselinesLabSnapshot {
  const target = `${featureSnapshot.target.source}.${featureSnapshot.target.variable}`;
  const warnings: string[] = [];
  const runs: ModelRunRecord[] = [];
  const allPredictions: ModelPredictionRow[] = [];
  const allImportances: FeatureImportanceRow[] = [];
  let split = getTemporalSplit([]);

  horizonsMinutes.forEach(horizonMinutes => {
    const rows = buildSupervisedRows(featureSnapshot.matrixRows, horizonMinutes);
    split = rows.length > 0 ? getTemporalSplit(rows) : split;

    if (rows.length < 12 || rows.filter(row => row.split === 'test').length < 3) {
      warnings.push(`Not enough supervised rows for ${horizonMinutes}m horizon.`);
      ['Persistence', 'Climatology', 'Ridge', 'ElasticNet', 'VAR'].forEach(model => {
        runs.push(registeredRun(model, model === 'Persistence' || model === 'Climatology' ? 'naive' : model === 'VAR' ? 'var' : 'linear', target, horizonMinutes, [
          'Insufficient supervised rows in the selected window.',
        ]));
      });
      return;
    }

    const persistenceRunId = `persistence_${target.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${horizonMinutes}m_seed${MODEL_SEED}`;
    const persistencePredictions = makePredictionRows(persistenceRunId, rows, rows.map(row => row.persistence));
    const persistenceRmse = buildMetrics(persistencePredictions, null).rmse;
    const persistenceRun = buildRun('Persistence', 'naive', horizonMinutes, target, rows, persistencePredictions, persistenceRmse, [
      'Forecast uses the latest observed target at issue time.',
    ]);
    runs.push({
      ...persistenceRun,
      metrics: {
        ...persistenceRun.metrics,
        skillVsPersistence: 0,
      },
    });
    allPredictions.push(...persistencePredictions);

    const climatologyRunId = `climatology_${target.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${horizonMinutes}m_seed${MODEL_SEED}`;
    const climatologyPredictions = makePredictionRows(climatologyRunId, rows, buildClimatologyPredictions(rows));
    runs.push(buildRun('Climatology', 'naive', horizonMinutes, target, rows, climatologyPredictions, persistenceRmse, [
      'Conditioned by UTC hour and quarter-season on train split only.',
    ]));
    allPredictions.push(...climatologyPredictions);

    const featureIds = chooseFeatureIds(featureSnapshot.featureStats);
    const dataset = prepareLinearDataset(rows, featureIds);

    if (featureIds.length === 0 || dataset.trainX.length < 4) {
      warnings.push(`No usable feature columns for linear models at ${horizonMinutes}m horizon.`);
    } else {
      const ridgeRunId = `ridge_${target.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${horizonMinutes}m_seed${MODEL_SEED}`;
      const ridgeCoefficients = trainRidge(dataset, 1);
      const ridgePredictions = makePredictionRows(ridgeRunId, rows, predictLinear(dataset.testX, ridgeCoefficients));
      runs.push(buildRun('Ridge', 'linear', horizonMinutes, target, rows, ridgePredictions, persistenceRmse, [
        'Closed-form ridge over top univariate feature candidates.',
      ]));
      allPredictions.push(...ridgePredictions);
      allImportances.push(...featureImportance(ridgeRunId, featureIds, ridgeCoefficients));

      const elasticRunId = `elasticnet_${target.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${horizonMinutes}m_seed${MODEL_SEED}`;
      const elasticCoefficients = trainElasticNet(dataset);
      const elasticPredictions = makePredictionRows(elasticRunId, rows, predictLinear(dataset.testX, elasticCoefficients));
      runs.push(buildRun('ElasticNet', 'linear', horizonMinutes, target, rows, elasticPredictions, persistenceRmse, [
        'Coordinate-descent ElasticNet with fixed seed/config.',
      ]));
      allPredictions.push(...elasticPredictions);
      allImportances.push(...featureImportance(elasticRunId, featureIds, elasticCoefficients));

      const varFeatureIds = featureIds.filter(featureId => featureId.includes('_lag_')).slice(0, 8);
      const varDataset = prepareLinearDataset(rows, varFeatureIds.length > 0 ? varFeatureIds : featureIds.slice(0, 8));
      const varRunId = `var_${target.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${horizonMinutes}m_seed${MODEL_SEED}`;
      const varCoefficients = trainRidge(varDataset, 0.25);
      const varPredictions = makePredictionRows(varRunId, rows, predictLinear(varDataset.testX, varCoefficients));
      runs.push(buildRun('VAR', 'var', horizonMinutes, target, rows, varPredictions, persistenceRmse, [
        'VAR-style autoregression over lagged multivariate feature columns.',
      ]));
      allPredictions.push(...varPredictions);
      allImportances.push(...featureImportance(varRunId, varDataset.featureIds, varCoefficients));
    }

    ['LightGBM', 'XGBoost', 'CatBoost'].forEach(model => {
      runs.push(registeredRun(model, 'boosting', target, horizonMinutes, [
        'Registered for Optuna tuning; package is not installed in this Next.js workspace.',
      ]));
    });
  });

  const testPredictions = allPredictions.filter(row => row.split === 'test');

  return {
    generatedAtUtc: new Date().toISOString(),
    target,
    horizonsMinutes,
    runsDbPath: 'local://data/model-runs/runs.db',
    predictionsPath: 'local://data/model-runs/predictions.parquet',
    featureImportancePath: 'local://data/model-runs/feature_importance.parquet',
    split,
    runs: runs.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'trained' ? -1 : 1;
      }

      return (a.metrics.rmse ?? Number.POSITIVE_INFINITY) - (b.metrics.rmse ?? Number.POSITIVE_INFINITY);
    }),
    predictions: allPredictions,
    featureImportance: allImportances,
    selectedStormWindow: {
      startUtc: testPredictions[0]?.timestampUtc ?? null,
      stopUtc: testPredictions[Math.min(testPredictions.length - 1, 60)]?.timestampUtc ?? null,
    },
    warnings: Array.from(new Set(warnings)),
  };
}
