import type { NormalizedSpaceWeatherRow } from './pipeline/normalizedSchema';
import type {
  ContextIndexKind,
  ContextIndexPoint,
  ContextIndexSnapshot,
} from './spaceWeatherContextIndexService';

export type EdaStratum = 'all' | 'solar_min' | 'solar_max' | 'quiet' | 'storm';

export interface HistogramBin {
  min: number;
  max: number;
  count: number;
  density: number;
}

export interface KdePoint {
  x: number;
  density: number;
}

export interface DistributionStats {
  count: number;
  mean: number | null;
  median: number | null;
  std: number | null;
  skew: number | null;
  kurtosis: number | null;
  p01: number | null;
  p05: number | null;
  p95: number | null;
  p99: number | null;
  jarqueBeraStatistic: number | null;
  jarqueBeraPValueApprox: number | null;
}

export interface RollingPoint {
  timestampUtc: string;
  mean30d: number | null;
  std30d: number | null;
  mean1y: number | null;
  std1y: number | null;
}

export interface StationaritySummary {
  adfStatisticApprox: number | null;
  kpssStatisticApprox: number | null;
  regimeChanges: string[];
  rolling: RollingPoint[];
}

export interface CorrelationPoint {
  lagHours: number;
  value: number;
}

export interface AutocorrelationSummary {
  acf: CorrelationPoint[];
  pacf: CorrelationPoint[];
  decorrelationTimeHours: number | null;
}

export interface TimeSeriesPoint {
  timestampUtc: string;
  value: number;
  kp: number | null;
  dst: number | null;
}

export interface VariableStatsRow {
  source: string;
  variable: string;
  stratum: EdaStratum;
  unit: string;
  count: number;
  mean: number | null;
  median: number | null;
  std: number | null;
  skew: number | null;
  kurtosis: number | null;
  p01: number | null;
  p05: number | null;
  p95: number | null;
  p99: number | null;
  jarqueBeraStatistic: number | null;
  adfStatisticApprox: number | null;
  kpssStatisticApprox: number | null;
  decorrelationTimeHours: number | null;
}

export interface VariableEdaCard {
  seriesId: string;
  source: string;
  variable: string;
  unit: string;
  stratum: EdaStratum;
  distribution: {
    histogram: HistogramBin[];
    kde: KdePoint[];
    stats: DistributionStats;
  };
  timeSeries: TimeSeriesPoint[];
  stationarity: StationaritySummary;
  autocorrelation: AutocorrelationSummary;
}

export interface UnivariateEdaSnapshot {
  generatedAtUtc: string;
  source: 'parquet-store-clean-mask' | 'playground-clean-mask';
  availableStrata: EdaStratum[];
  context: {
    generatedAtUtc: string;
    points: ContextIndexPoint[];
    errors: ContextIndexSnapshot['errors'];
  };
  variableStats: VariableStatsRow[];
  cards: VariableEdaCard[];
  figures: Array<{
    seriesId: string;
    stratum: EdaStratum;
    jsonPath: string;
    pngPath: string;
  }>;
}

interface SeriesGroup {
  seriesId: string;
  source: string;
  variable: string;
  unit: string;
  rows: NormalizedSpaceWeatherRow[];
}

const STRATA: EdaStratum[] = ['all', 'solar_min', 'solar_max', 'quiet', 'storm'];
const MAX_TIME_SERIES_POINTS = 260;
const MAX_ROLLING_POINTS = 180;
const MAX_CORRELATION_LAGS = 96;
const HISTOGRAM_BINS = 32;
const KDE_POINTS = 48;
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const timestampMs = new Date(normalized).getTime();

  return Number.isNaN(timestampMs) ? null : timestampMs;
}

function toIsoUtc(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

function finiteValues(values: number[]) {
  return values.filter(Number.isFinite);
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

  const sortedValues = [...values].sort((a, b) => a - b);
  const middleIndex = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[middleIndex];
  }

  return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}

function percentile(values: number[], rank: number) {
  if (values.length === 0) {
    return null;
  }

  const sortedValues = [...values].sort((a, b) => a - b);
  const position = (sortedValues.length - 1) * rank;
  const baseIndex = Math.floor(position);
  const remainder = position - baseIndex;
  const nextValue = sortedValues[baseIndex + 1];

  if (nextValue === undefined) {
    return sortedValues[baseIndex];
  }

  return sortedValues[baseIndex] + remainder * (nextValue - sortedValues[baseIndex]);
}

function standardDeviation(values: number[]) {
  if (values.length < 2) {
    return null;
  }

  const currentMean = mean(values);

  if (currentMean === null) {
    return null;
  }

  const variance = values.reduce((sum, value) => sum + (value - currentMean) ** 2, 0) / (values.length - 1);

  return Math.sqrt(variance);
}

function skewness(values: number[]) {
  if (values.length < 3) {
    return null;
  }

  const currentMean = mean(values);
  const currentStd = standardDeviation(values);

  if (currentMean === null || currentStd === null || currentStd === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + ((value - currentMean) / currentStd) ** 3, 0) / values.length;
}

function excessKurtosis(values: number[]) {
  if (values.length < 4) {
    return null;
  }

  const currentMean = mean(values);
  const currentStd = standardDeviation(values);

  if (currentMean === null || currentStd === null || currentStd === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + ((value - currentMean) / currentStd) ** 4, 0) / values.length - 3;
}

function buildDistributionStats(valuesInput: number[]): DistributionStats {
  const values = finiteValues(valuesInput);
  const currentSkew = skewness(values);
  const currentKurtosis = excessKurtosis(values);
  const jarqueBeraStatistic = currentSkew === null || currentKurtosis === null
    ? null
    : (values.length / 6) * (currentSkew ** 2 + (currentKurtosis ** 2) / 4);

  return {
    count: values.length,
    mean: mean(values),
    median: median(values),
    std: standardDeviation(values),
    skew: currentSkew,
    kurtosis: currentKurtosis,
    p01: percentile(values, 0.01),
    p05: percentile(values, 0.05),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    jarqueBeraStatistic,
    jarqueBeraPValueApprox: jarqueBeraStatistic === null ? null : Math.exp(-jarqueBeraStatistic / 2),
  };
}

function buildHistogram(valuesInput: number[]) {
  const values = finiteValues(valuesInput);

  if (values.length === 0) {
    return [];
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const width = (maxValue - minValue || 1) / HISTOGRAM_BINS;
  const bins = Array.from({ length: HISTOGRAM_BINS }, (_, index) => ({
    min: minValue + index * width,
    max: minValue + (index + 1) * width,
    count: 0,
    density: 0,
  }));

  values.forEach(value => {
    const index = Math.min(HISTOGRAM_BINS - 1, Math.floor((value - minValue) / width));
    bins[index].count += 1;
  });

  return bins.map(bin => ({
    ...bin,
    density: bin.count / (values.length * width),
  }));
}

function gaussianKernel(value: number) {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function buildKde(valuesInput: number[]) {
  const values = finiteValues(valuesInput);

  if (values.length < 2) {
    return [];
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const currentStd = standardDeviation(values) ?? 0;
  const bandwidth = Math.max(
    Number.EPSILON,
    1.06 * (currentStd || (maxValue - minValue || 1) / 6) * values.length ** (-1 / 5),
  );

  return Array.from({ length: KDE_POINTS }, (_, index) => {
    const x = minValue + ((maxValue - minValue || 1) * index) / (KDE_POINTS - 1);
    const density = values.reduce(
      (sum, value) => sum + gaussianKernel((x - value) / bandwidth),
      0,
    ) / (values.length * bandwidth);

    return { x, density };
  });
}

function groupRows(rows: NormalizedSpaceWeatherRow[]) {
  const groups = new Map<string, SeriesGroup>();

  rows.forEach(row => {
    const key = `${row.source}:${row.variable}`;
    const existingGroup = groups.get(key);

    if (existingGroup) {
      existingGroup.rows.push(row);
      return;
    }

    groups.set(key, {
      seriesId: key,
      source: row.source,
      variable: row.variable,
      unit: row.unit,
      rows: [row],
    });
  });

  return Array.from(groups.values()).map(group => ({
    ...group,
    rows: group.rows.sort((a, b) => {
      const aMs = parseTimestampMs(a.timestamp_utc) ?? 0;
      const bMs = parseTimestampMs(b.timestamp_utc) ?? 0;
      return aMs - bMs;
    }),
  }));
}

function downsample<T>(rows: T[], maxPoints: number) {
  if (rows.length <= maxPoints) {
    return rows;
  }

  const step = Math.ceil(rows.length / maxPoints);

  return rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
}

function buildContextLookup(contextPoints: ContextIndexPoint[]) {
  const pointsByKind = new Map<string, ContextIndexPoint[]>();

  contextPoints.forEach(point => {
    const points = pointsByKind.get(point.kind) ?? [];
    points.push(point);
    pointsByKind.set(point.kind, points);
  });

  pointsByKind.forEach(points => {
    points.sort((a, b) => {
      const aMs = parseTimestampMs(a.timestampUtc) ?? 0;
      const bMs = parseTimestampMs(b.timestampUtc) ?? 0;
      return aMs - bMs;
    });
  });

  return (timestampUtc: string, kind: ContextIndexKind): ContextIndexPoint | null => {
    const timestampMs = parseTimestampMs(timestampUtc);
    const points = pointsByKind.get(kind);

    if (timestampMs === null || !points || points.length === 0) {
      return null;
    }

    let nearestPoint: ContextIndexPoint | null = null;
    let nearestDeltaMs = Number.POSITIVE_INFINITY;

    points.forEach(point => {
      const pointMs = parseTimestampMs(point.timestampUtc);

      if (pointMs === null) {
        return;
      }

      const deltaMs = Math.abs(pointMs - timestampMs);

      if (deltaMs < nearestDeltaMs) {
        nearestDeltaMs = deltaMs;
        nearestPoint = point;
      }
    });

    return nearestPoint;
  };
}

function getF107Thresholds(contextPoints: ContextIndexPoint[]) {
  const values = contextPoints
    .filter(point => point.kind === 'f107')
    .map(point => point.value)
    .filter(Number.isFinite);

  return {
    low: percentile(values, 0.33),
    high: percentile(values, 0.66),
  };
}

function rowMatchesStratum(
  row: NormalizedSpaceWeatherRow,
  stratum: EdaStratum,
  nearestContext: ReturnType<typeof buildContextLookup>,
  f107Thresholds: { low: number | null; high: number | null },
) {
  if (stratum === 'all') {
    return true;
  }

  if (stratum === 'quiet' || stratum === 'storm') {
    const kp = nearestContext(row.timestamp_utc, 'kp');

    if (!kp) {
      return false;
    }

    return stratum === 'quiet' ? kp.value <= 2 : kp.value >= 5;
  }

  const f107 = nearestContext(row.timestamp_utc, 'f107');

  if (!f107 || f107Thresholds.low === null || f107Thresholds.high === null) {
    return false;
  }

  return stratum === 'solar_min'
    ? f107.value <= f107Thresholds.low
    : f107.value >= f107Thresholds.high;
}

function buildTimeSeries(
  rows: NormalizedSpaceWeatherRow[],
  nearestContext: ReturnType<typeof buildContextLookup>,
) {
  return downsample(rows, MAX_TIME_SERIES_POINTS).map(row => ({
    timestampUtc: row.timestamp_utc,
    value: row.value,
    kp: nearestContext(row.timestamp_utc, 'kp')?.value ?? null,
    dst: nearestContext(row.timestamp_utc, 'dst')?.value ?? null,
  }));
}

function rollingStats(rows: NormalizedSpaceWeatherRow[], windowMs: number, stopTimestampMs: number) {
  const startTimestampMs = stopTimestampMs - windowMs;
  const values = rows
    .filter(row => {
      const timestampMs = parseTimestampMs(row.timestamp_utc);
      return timestampMs !== null && timestampMs >= startTimestampMs && timestampMs <= stopTimestampMs;
    })
    .map(row => row.value);

  return {
    mean: mean(values),
    std: standardDeviation(values),
  };
}

function buildRolling(rows: NormalizedSpaceWeatherRow[]) {
  return downsample(rows, MAX_ROLLING_POINTS).map(row => {
    const timestampMs = parseTimestampMs(row.timestamp_utc) ?? 0;
    const rolling30d = rollingStats(rows, 30 * DAY_MS, timestampMs);
    const rolling1y = rollingStats(rows, YEAR_MS, timestampMs);

    return {
      timestampUtc: row.timestamp_utc,
      mean30d: rolling30d.mean,
      std30d: rolling30d.std,
      mean1y: rolling1y.mean,
      std1y: rolling1y.std,
    };
  });
}

function approximateAdfStatistic(valuesInput: number[]) {
  const values = finiteValues(valuesInput);

  if (values.length < 8) {
    return null;
  }

  const lagged = values.slice(0, -1);
  const diff = values.slice(1).map((value, index) => value - values[index]);
  const laggedMean = mean(lagged);
  const diffMean = mean(diff);

  if (laggedMean === null || diffMean === null) {
    return null;
  }

  const denominator = lagged.reduce((sum, value) => sum + (value - laggedMean) ** 2, 0);

  if (denominator === 0) {
    return null;
  }

  const beta = lagged.reduce((sum, value, index) => (
    sum + (value - laggedMean) * (diff[index] - diffMean)
  ), 0) / denominator;
  const residuals = diff.map((value, index) => value - (diffMean + beta * (lagged[index] - laggedMean)));
  const residualStd = standardDeviation(residuals);
  const betaStdError = residualStd === null ? null : residualStd / Math.sqrt(denominator);

  if (betaStdError === null || betaStdError === 0) {
    return null;
  }

  return beta / betaStdError;
}

function approximateKpssStatistic(valuesInput: number[]) {
  const values = finiteValues(valuesInput);
  const currentMean = mean(values);

  if (values.length < 8 || currentMean === null) {
    return null;
  }

  const residuals = values.map(value => value - currentMean);
  let cumulative = 0;
  const cumulativeSquares = residuals.reduce((sum, residual) => {
    cumulative += residual;
    return sum + cumulative * cumulative;
  }, 0);
  const variance = residuals.reduce((sum, residual) => sum + residual * residual, 0) / values.length;

  if (variance === 0) {
    return null;
  }

  return cumulativeSquares / (values.length * values.length * variance);
}

function detectRegimeChanges(rows: NormalizedSpaceWeatherRow[]) {
  const values = rows.map(row => row.value);
  const currentMean = mean(values);
  const currentStd = standardDeviation(values);

  if (currentMean === null || currentStd === null || currentStd === 0) {
    return [];
  }

  let cumulative = 0;
  const threshold = currentStd * 5;
  const changes: string[] = [];

  rows.forEach(row => {
    cumulative += row.value - currentMean;

    if (Math.abs(cumulative) >= threshold) {
      changes.push(row.timestamp_utc);
      cumulative = 0;
    }
  });

  return changes.slice(0, 60);
}

function autocorrelation(values: number[], lag: number) {
  const currentMean = mean(values);

  if (currentMean === null || values.length <= lag) {
    return null;
  }

  const denominator = values.reduce((sum, value) => sum + (value - currentMean) ** 2, 0);

  if (denominator === 0) {
    return null;
  }

  const numerator = values
    .slice(lag)
    .reduce((sum, value, index) => sum + (value - currentMean) * (values[index] - currentMean), 0);

  return numerator / denominator;
}

function buildPacfFromAcf(acfValues: number[]) {
  const pacfValues: number[] = [1];
  const phi: number[][] = [[1]];
  let predictionVariance = 1;

  for (let lag = 1; lag < acfValues.length; lag += 1) {
    let numerator = acfValues[lag];

    for (let j = 1; j < lag; j += 1) {
      numerator -= phi[lag - 1][j] * acfValues[lag - j];
    }

    const coefficient = predictionVariance === 0 ? 0 : numerator / predictionVariance;
    const currentPhi = Array(lag + 1).fill(0);
    currentPhi[lag] = coefficient;

    for (let j = 1; j < lag; j += 1) {
      currentPhi[j] = phi[lag - 1][j] - coefficient * phi[lag - 1][lag - j];
    }

    phi[lag] = currentPhi;
    predictionVariance *= 1 - coefficient * coefficient;
    pacfValues[lag] = coefficient;
  }

  return pacfValues;
}

function inferCadenceHours(rows: NormalizedSpaceWeatherRow[]) {
  const cadenceSeconds = median(rows.map(row => row.cadence_s).filter(Number.isFinite));

  return cadenceSeconds === null ? null : cadenceSeconds / 3600;
}

function buildAutocorrelation(rows: NormalizedSpaceWeatherRow[]) {
  const values = rows.map(row => row.value);
  const cadenceHours = inferCadenceHours(rows);

  if (values.length < 3 || cadenceHours === null || cadenceHours <= 0) {
    return {
      acf: [],
      pacf: [],
      decorrelationTimeHours: null,
    };
  }

  const maxLag = Math.min(
    values.length - 2,
    MAX_CORRELATION_LAGS,
    Math.max(1, Math.floor(24 / cadenceHours)),
  );
  const acfNumbers = Array.from({ length: maxLag + 1 }, (_, lag) => autocorrelation(values, lag) ?? 0);
  const pacfNumbers = buildPacfFromAcf(acfNumbers);
  const acf = acfNumbers.map((value, lag) => ({
    lagHours: lag * cadenceHours,
    value,
  }));
  const pacf = pacfNumbers.map((value, lag) => ({
    lagHours: lag * cadenceHours,
    value,
  }));
  const decorrelationPoint = acf.find(point => point.lagHours > 0 && point.value <= 1 / Math.E);

  return {
    acf,
    pacf,
    decorrelationTimeHours: decorrelationPoint?.lagHours ?? null,
  };
}

function buildCard(
  group: SeriesGroup,
  stratum: EdaStratum,
  nearestContext: ReturnType<typeof buildContextLookup>,
) {
  const values = group.rows.map(row => row.value);
  const stats = buildDistributionStats(values);
  const stationarity = {
    adfStatisticApprox: approximateAdfStatistic(values),
    kpssStatisticApprox: approximateKpssStatistic(values),
    regimeChanges: detectRegimeChanges(group.rows),
    rolling: buildRolling(group.rows),
  };
  const autocorrelationSummary = buildAutocorrelation(group.rows);

  return {
    card: {
      seriesId: group.seriesId,
      source: group.source,
      variable: group.variable,
      unit: group.unit,
      stratum,
      distribution: {
        histogram: buildHistogram(values),
        kde: buildKde(values),
        stats,
      },
      timeSeries: buildTimeSeries(group.rows, nearestContext),
      stationarity,
      autocorrelation: autocorrelationSummary,
    } satisfies VariableEdaCard,
    stats: {
      source: group.source,
      variable: group.variable,
      stratum,
      unit: group.unit,
      count: stats.count,
      mean: stats.mean,
      median: stats.median,
      std: stats.std,
      skew: stats.skew,
      kurtosis: stats.kurtosis,
      p01: stats.p01,
      p05: stats.p05,
      p95: stats.p95,
      p99: stats.p99,
      jarqueBeraStatistic: stats.jarqueBeraStatistic,
      adfStatisticApprox: stationarity.adfStatisticApprox,
      kpssStatisticApprox: stationarity.kpssStatisticApprox,
      decorrelationTimeHours: autocorrelationSummary.decorrelationTimeHours,
    } satisfies VariableStatsRow,
  };
}

export function buildUnivariateEdaSnapshot(
  cleanRows: NormalizedSpaceWeatherRow[],
  context: ContextIndexSnapshot,
): UnivariateEdaSnapshot {
  const nearestContext = buildContextLookup(context.points);
  const f107Thresholds = getF107Thresholds(context.points);
  const cards: VariableEdaCard[] = [];
  const variableStats: VariableStatsRow[] = [];
  const availableStrata = new Set<EdaStratum>(['all']);

  STRATA.forEach(stratum => {
    const rowsForStratum = cleanRows.filter(row => rowMatchesStratum(row, stratum, nearestContext, f107Thresholds));

    if (rowsForStratum.length === 0) {
      return;
    }

    availableStrata.add(stratum);
    groupRows(rowsForStratum).forEach(group => {
      if (group.rows.length < 2) {
        return;
      }

      const { card, stats } = buildCard(group, stratum, nearestContext);
      cards.push(card);
      variableStats.push(stats);
    });
  });

  return {
    generatedAtUtc: toIsoUtc(Date.now()),
    source: 'playground-clean-mask',
    availableStrata: Array.from(availableStrata),
    context: {
      generatedAtUtc: context.generatedAtUtc,
      points: context.points,
      errors: context.errors,
    },
    variableStats,
    cards,
    figures: cards.map(card => ({
      seriesId: card.seriesId,
      stratum: card.stratum,
      jsonPath: `artifacts/univariate-eda/${card.seriesId}-${card.stratum}.json`,
      pngPath: `artifacts/univariate-eda/${card.seriesId}-${card.stratum}.png`,
    })),
  };
}
