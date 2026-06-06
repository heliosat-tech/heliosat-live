import { createHash } from 'crypto';
import type { NormalizedSpaceWeatherRow } from './pipeline/normalizedSchema';
import type { L1EarthCouplingSnapshot, OptimalLagRow } from './l1EarthCouplingService';
import type { ContextIndexPoint, ContextIndexSnapshot } from './spaceWeatherContextIndexService';

export type FeatureFamily = 'lag' | 'rolling' | 'derivative' | 'candidate' | 'spectral' | 'context';
export type FeatureMatrixSource = 'parquet-clean-store' | 'playground-clean-l1-plus-goes-mag';

export interface FeatureTargetConfig {
  source: string;
  variable: string;
  label: string;
  predictionHorizonMinutes: number;
}

export interface FeatureDefinition {
  id: string;
  family: FeatureFamily;
  label: string;
  source: string;
  variable: string;
  operation: string;
  unit: string | null;
  enabled: boolean;
  parameters: Record<string, string | number | boolean | null>;
  minSourceOffsetMinutes: number;
  maxSourceOffsetMinutes: number;
}

export interface FeatureFamilySummary {
  family: FeatureFamily;
  totalFeatures: number;
  enabledFeatures: number;
  meanNanPercent: number | null;
}

export interface FeatureHistogramBin {
  min: number;
  max: number;
  count: number;
}

export interface FeatureStats {
  featureId: string;
  family: FeatureFamily;
  label: string;
  count: number;
  nanPercent: number;
  mean: number | null;
  std: number | null;
  min: number | null;
  max: number | null;
  targetCorrelation: number | null;
  tentativeImportance: number | null;
  histogram: FeatureHistogramBin[];
}

export interface FeaturePreviewRow {
  timestampUtc: string;
  target: number | null;
  sampleWeight: number;
  values: Record<string, number | null>;
  missingFlags: Record<string, 0 | 1>;
}

export interface NoLeakageReport {
  passed: boolean;
  featuresChecked: number;
  violations: Array<{
    featureId: string;
    maxSourceOffsetMinutes: number;
    reason: string;
  }>;
}

export interface FeatureStoreManifest {
  versionTag: string;
  configHash: string;
  outputPath: string;
  configPath: string;
  rowsTotal: number;
  columnsTotal: number;
  targetColumn: string;
}

export interface FeatureWorkbenchSnapshot {
  generatedAtUtc: string;
  source: FeatureMatrixSource;
  range: {
    startUtc: string;
    stopUtc: string;
  };
  target: FeatureTargetConfig;
  featureStore: FeatureStoreManifest;
  config: FeatureBuildConfig;
  featureDefinitions: FeatureDefinition[];
  familySummaries: FeatureFamilySummary[];
  featureStats: FeatureStats[];
  preview: {
    columns: string[];
    head: FeaturePreviewRow[];
    tail: FeaturePreviewRow[];
    sample: FeaturePreviewRow[];
  };
  matrixRows: FeaturePreviewRow[];
  sampleWeights: {
    baseWeight: number;
    eventWeight: number;
    eventRule: string;
    eventRows: number;
  };
  noLeakageReport: NoLeakageReport;
  warnings: string[];
}

interface SeriesData {
  source: string;
  variable: string;
  unit: string | null;
  values: Map<number, number>;
}

export interface FeatureBuildConfig {
  version: string;
  gridCadenceSeconds: number;
  target: FeatureTargetConfig;
  lagMinutes: number[];
  rollingWindowsMinutes: number[];
  rollingStats: string[];
  derivativeDiffMinutes: number[];
  spectralWindowMinutes: number;
  spectralBands: Array<{
    id: string;
    minMilliHz: number;
    maxMilliHz: number;
  }>;
  sampleWeights: {
    baseWeight: number;
    eventWeight: number;
    eventKpThreshold: number;
  };
}

type FeatureEvaluator = (timestampMs: number) => number | null;

const GRID_CADENCE_SECONDS = 60;
const GRID_CADENCE_MS = GRID_CADENCE_SECONDS * 1000;
const DEFAULT_LAG_MINUTES = [0, 5, 10, 15, 20, 30, 45, 60, 75, 90, 120];
const ROLLING_WINDOWS_MINUTES = [5, 15, 30, 60, 120];
const ROLLING_STATS = ['mean', 'std', 'min', 'max', 'p10', 'p90', 'integral'];
const DERIVATIVE_DIFF_MINUTES = [15, 60];
const SPECTRAL_WINDOW_MINUTES = 60;
const PREVIEW_ROWS = 6;
const HISTOGRAM_BINS = 18;
const FEATURE_STORE_VERSION = 'features-v1';
const DEFAULT_TARGET: FeatureTargetConfig = {
  source: 'GOES',
  variable: 'goes_mag_hn',
  label: 'GOES-R MAG Hn',
  predictionHorizonMinutes: 0,
};

const SPECTRAL_BANDS = [
  { id: 'lt_1_mhz', minMilliHz: 0, maxMilliHz: 1 },
  { id: 'pc5_1_7_mhz', minMilliHz: 1, maxMilliHz: 7 },
  { id: 'ultra_7_20_mhz', minMilliHz: 7, maxMilliHz: 20 },
];

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

function minuteBucket(timestampMs: number) {
  return Math.round(timestampMs / GRID_CADENCE_MS) * GRID_CADENCE_MS;
}

function round(value: number | null, digits = 5) {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function toSafeId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mean(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

function pearson(x: number[], y: number[]) {
  if (x.length !== y.length || x.length < 3) {
    return null;
  }

  const meanX = mean(x);
  const meanY = mean(y);

  if (meanX === null || meanY === null) {
    return null;
  }

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    covariance += dx * dy;
    varianceX += dx ** 2;
    varianceY += dy ** 2;
  }

  const denominator = Math.sqrt(varianceX * varianceY);

  return denominator === 0 ? null : covariance / denominator;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue).sort().map(key => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(',')}}`;
}

function hashConfig(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function normalizeRange(
  rows: NormalizedSpaceWeatherRow[],
  rangeInput?: Partial<{ startUtc: string; stopUtc: string }>,
) {
  const timestampsMs = rows
    .map(row => parseTimestampMs(row.timestamp_utc))
    .filter((timestampMs): timestampMs is number => timestampMs !== null);
  const latestMs = timestampsMs.length > 0 ? Math.max(...timestampsMs) : Date.now();
  const earliestMs = timestampsMs.length > 0 ? Math.min(...timestampsMs) : latestMs - 24 * 60 * 60 * 1000;
  const startMs = parseTimestampMs(rangeInput?.startUtc) ?? Math.max(earliestMs, latestMs - 24 * 60 * 60 * 1000);
  const stopMs = parseTimestampMs(rangeInput?.stopUtc) ?? latestMs;

  if (stopMs <= startMs) {
    return {
      startUtc: toIsoUtc(earliestMs),
      stopUtc: toIsoUtc(latestMs),
    };
  }

  return {
    startUtc: toIsoUtc(startMs),
    stopUtc: toIsoUtc(stopMs),
  };
}

function buildSeries(rows: NormalizedSpaceWeatherRow[], source: string, variable: string, range: { startUtc: string; stopUtc: string }): SeriesData {
  const startMs = parseTimestampMs(range.startUtc) ?? Number.NEGATIVE_INFINITY;
  const stopMs = parseTimestampMs(range.stopUtc) ?? Number.POSITIVE_INFINITY;
  const buckets = new Map<number, { sum: number; count: number }>();
  let unit: string | null = null;

  rows.forEach(row => {
    if (row.source !== source || row.variable !== variable) {
      return;
    }

    const timestampMs = parseTimestampMs(row.timestamp_utc);

    if (timestampMs === null || timestampMs < startMs || timestampMs > stopMs) {
      return;
    }

    const bucketMs = minuteBucket(timestampMs);
    const bucket = buckets.get(bucketMs) ?? { sum: 0, count: 0 };
    bucket.sum += row.value;
    bucket.count += 1;
    buckets.set(bucketMs, bucket);
    unit = unit ?? row.unit;
  });

  return {
    source,
    variable,
    unit,
    values: new Map(
      Array.from(buckets.entries())
        .map(([timestampMs, bucket]) => [timestampMs, bucket.sum / bucket.count] as const)
        .sort(([a], [b]) => a - b),
    ),
  };
}

function getWindowValues(series: SeriesData, timestampMs: number, windowMinutes: number) {
  const startMs = timestampMs - windowMinutes * GRID_CADENCE_MS + GRID_CADENCE_MS;
  const values: number[] = [];

  for (let currentMs = startMs; currentMs <= timestampMs; currentMs += GRID_CADENCE_MS) {
    const value = series.values.get(currentMs);

    if (value !== undefined) {
      values.push(value);
    }
  }

  return values;
}

function rollingValue(values: number[], stat: string, cadenceSeconds: number) {
  if (values.length === 0) {
    return null;
  }

  if (stat === 'mean') {
    return mean(values);
  }

  if (stat === 'std') {
    return standardDeviation(values);
  }

  if (stat === 'min') {
    return Math.min(...values);
  }

  if (stat === 'max') {
    return Math.max(...values);
  }

  if (stat === 'p10') {
    return percentile(values, 0.1);
  }

  if (stat === 'p90') {
    return percentile(values, 0.9);
  }

  if (stat === 'integral') {
    return values.reduce((sum, value) => sum + value * cadenceSeconds, 0);
  }

  return null;
}

function getPrioritizedL1Rows(couplingSnapshot: L1EarthCouplingSnapshot | null) {
  if (!couplingSnapshot || couplingSnapshot.topPairs.length === 0) {
    return [];
  }

  return couplingSnapshot.topPairs
    .filter(row => row.lagMinutes === null || row.lagMinutes >= 0)
    .slice(0, 8);
}

function parseL1Var(value: string) {
  const separatorIndex = value.indexOf('.');

  if (separatorIndex < 0) {
    return null;
  }

  return {
    source: value.slice(0, separatorIndex),
    variable: value.slice(separatorIndex + 1),
  };
}

function getLagMinutesForPair(row: OptimalLagRow | null) {
  const lags = new Set(DEFAULT_LAG_MINUTES);

  if (row?.lagMinutes !== null && row?.lagMinutes !== undefined && row.lagMinutes >= 0) {
    [row.lagMinutes - 15, row.lagMinutes, row.lagMinutes + 15].forEach(lag => {
      if (lag >= 0) {
        lags.add(Math.round(lag));
      }
    });
  }

  return Array.from(lags).sort((a, b) => a - b);
}

function dftPower(values: number[], k: number) {
  let re = 0;
  let im = 0;
  const n = values.length;
  const currentMean = mean(values) ?? 0;

  for (let index = 0; index < n; index += 1) {
    const hann = n > 1 ? 0.5 * (1 - Math.cos((2 * Math.PI * index) / (n - 1))) : 1;
    const angle = (-2 * Math.PI * k * index) / n;
    const value = (values[index] - currentMean) * hann;
    re += value * Math.cos(angle);
    im += value * Math.sin(angle);
  }

  return (re ** 2 + im ** 2) / n;
}

function spectralBandPower(values: number[], band: { minMilliHz: number; maxMilliHz: number }) {
  if (values.length < 16) {
    return null;
  }

  let totalPower = 0;
  let bins = 0;
  const maxK = Math.floor(values.length / 2);

  for (let k = 1; k <= maxK; k += 1) {
    const frequencyMilliHz = (k / (values.length * GRID_CADENCE_SECONDS)) * 1000;

    if (frequencyMilliHz < band.minMilliHz || frequencyMilliHz > band.maxMilliHz) {
      continue;
    }

    totalPower += dftPower(values, k);
    bins += 1;
  }

  return bins === 0 ? null : totalPower;
}

function latestContextValueAt(
  points: ContextIndexPoint[],
  kind: ContextIndexPoint['kind'],
  timestampMs: number,
): ContextIndexPoint | null {
  let latestPoint: ContextIndexPoint | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  points.forEach(point => {
    if (point.kind !== kind) {
      return;
    }

    const pointMs = parseTimestampMs(point.timestampUtc);

    if (pointMs !== null && pointMs <= timestampMs && pointMs > latestMs) {
      latestPoint = point;
      latestMs = pointMs;
    }
  });

  return latestPoint;
}

function daysSinceLastKpEvent(points: ContextIndexPoint[], timestampMs: number, threshold: number) {
  let latestEventMs: number | null = null;

  points.forEach(point => {
    if (point.kind !== 'kp' || point.value <= threshold) {
      return;
    }

    const pointMs = parseTimestampMs(point.timestampUtc);

    if (pointMs !== null && pointMs <= timestampMs && (latestEventMs === null || pointMs > latestEventMs)) {
      latestEventMs = pointMs;
    }
  });

  return latestEventMs === null ? null : (timestampMs - latestEventMs) / (24 * 60 * 60 * 1000);
}

function localTimeProxyHour(timestampMs: number) {
  return new Date(timestampMs).getUTCHours() + new Date(timestampMs).getUTCMinutes() / 60;
}

function dayOfYear(timestampMs: number) {
  const date = new Date(timestampMs);
  const startOfYearMs = Date.UTC(date.getUTCFullYear(), 0, 1);

  return Math.floor((timestampMs - startOfYearMs) / (24 * 60 * 60 * 1000)) + 1;
}

function buildCandidateSeriesEvaluator(
  operation: string,
  getSeries: (source: string, variable: string) => SeriesData,
  source: string,
): FeatureEvaluator {
  const get = (variable: string, timestampMs: number) => getSeries(source, variable).values.get(timestampMs) ?? null;

  return (timestampMs: number) => {
    const bx = get('bx_gsm', timestampMs) ?? get('bx_gse', timestampMs);
    const by = get('by_gsm', timestampMs) ?? get('by_gse', timestampMs);
    const bz = get('bz_gsm', timestampMs) ?? get('bz_gse', timestampMs);
    const speed = get('solar_wind_speed', timestampMs);
    const density = get('proton_density', timestampMs);
    const bMagnitude = bx === null || by === null || bz === null ? null : Math.sqrt(bx ** 2 + by ** 2 + bz ** 2);

    if (operation === 'b_magnitude_candidate') {
      return bMagnitude;
    }

    if (operation === 'clock_angle') {
      return by === null || bz === null ? null : Math.atan2(by, bz);
    }

    if (operation === 'cone_angle') {
      if (bx === null || bMagnitude === null || bMagnitude === 0) {
        return null;
      }

      return Math.acos(Math.max(-1, Math.min(1, bx / bMagnitude)));
    }

    if (operation === 'dynamic_pressure_proxy') {
      return density === null || speed === null ? null : density * speed ** 2;
    }

    if (operation === 'motional_electric_field_proxy') {
      return speed === null || bz === null ? null : -speed * bz;
    }

    if (operation === 'akasofu_epsilon_proxy') {
      if (speed === null || bMagnitude === null || by === null || bz === null) {
        return null;
      }

      const clockAngle = Math.atan2(by, bz);
      return speed * bMagnitude ** 2 * Math.sin(clockAngle / 2) ** 4;
    }

    return null;
  };
}

function buildFeatureEvaluators(
  rows: NormalizedSpaceWeatherRow[],
  couplingSnapshot: L1EarthCouplingSnapshot | null,
  contextSnapshot: ContextIndexSnapshot | null,
  range: { startUtc: string; stopUtc: string },
  config: FeatureBuildConfig,
) {
  const seriesCache = new Map<string, SeriesData>();
  const definitions: FeatureDefinition[] = [];
  const evaluators = new Map<string, FeatureEvaluator>();
  const prioritizedRows = getPrioritizedL1Rows(couplingSnapshot);
  const fallbackSources = [
    { source: 'DSCOVR', variable: 'bz_gsm', lagRow: null },
    { source: 'DSCOVR', variable: 'by_gsm', lagRow: null },
    { source: 'DSCOVR', variable: 'solar_wind_speed', lagRow: null },
    { source: 'DSCOVR', variable: 'proton_density', lagRow: null },
  ];
  const prioritizedSeries = prioritizedRows.length > 0
    ? prioritizedRows
      .map(row => {
        const parsed = parseL1Var(row.l1_var);
        return parsed ? { ...parsed, lagRow: row } : null;
      })
      .filter((value): value is { source: string; variable: string; lagRow: OptimalLagRow } => value !== null)
    : fallbackSources;
  const uniqueSeries = Array.from(
    new Map(prioritizedSeries.map(series => [`${series.source}.${series.variable}`, series])).values(),
  );

  const getSeries = (source: string, variable: string) => {
    const key = `${source}.${variable}`;
    const existing = seriesCache.get(key);

    if (existing) {
      return existing;
    }

    const nextSeries = buildSeries(rows, source, variable, range);
    seriesCache.set(key, nextSeries);
    return nextSeries;
  };

  const addFeature = (
    definition: FeatureDefinition,
    evaluator: FeatureEvaluator,
  ) => {
    definitions.push(definition);
    evaluators.set(definition.id, evaluator);
  };

  uniqueSeries.forEach(seriesInfo => {
    const series = getSeries(seriesInfo.source, seriesInfo.variable);
    const sourceVariableId = toSafeId(`${seriesInfo.source}_${seriesInfo.variable}`);
    const lagMinutes = getLagMinutesForPair(seriesInfo.lagRow);

    lagMinutes.forEach(lagMinute => {
      const id = `${sourceVariableId}_lag_${lagMinute}m`;
      addFeature({
        id,
        family: 'lag',
        label: `${seriesInfo.source}.${seriesInfo.variable} lag ${lagMinute}m`,
        source: seriesInfo.source,
        variable: seriesInfo.variable,
        operation: 'lag',
        unit: series.unit,
        enabled: true,
        parameters: { lagMinutes: lagMinute },
        minSourceOffsetMinutes: -lagMinute,
        maxSourceOffsetMinutes: -lagMinute,
      }, timestampMs => series.values.get(timestampMs - lagMinute * GRID_CADENCE_MS) ?? null);
    });

    config.rollingWindowsMinutes.forEach(windowMinutes => {
      config.rollingStats.forEach(stat => {
        const id = `${sourceVariableId}_roll_${windowMinutes}m_${stat}`;
        addFeature({
          id,
          family: 'rolling',
          label: `${seriesInfo.source}.${seriesInfo.variable} ${windowMinutes}m ${stat}`,
          source: seriesInfo.source,
          variable: seriesInfo.variable,
          operation: `rolling_${stat}`,
          unit: stat === 'integral' && series.unit ? `${series.unit}*s` : series.unit,
          enabled: true,
          parameters: { windowMinutes, stat },
          minSourceOffsetMinutes: -(windowMinutes - 1),
          maxSourceOffsetMinutes: 0,
        }, timestampMs => rollingValue(getWindowValues(series, timestampMs, windowMinutes), stat, config.gridCadenceSeconds));
      });
    });

    const firstDerivativeId = `${sourceVariableId}_gradient_1m`;
    addFeature({
      id: firstDerivativeId,
      family: 'derivative',
      label: `${seriesInfo.source}.${seriesInfo.variable} gradient 1m`,
      source: seriesInfo.source,
      variable: seriesInfo.variable,
      operation: 'first_derivative',
      unit: series.unit ? `${series.unit}/s` : null,
      enabled: true,
      parameters: { deltaMinutes: 1 },
      minSourceOffsetMinutes: -1,
      maxSourceOffsetMinutes: 0,
    }, timestampMs => {
      const currentValue = series.values.get(timestampMs);
      const previousValue = series.values.get(timestampMs - GRID_CADENCE_MS);
      return currentValue === undefined || previousValue === undefined ? null : (currentValue - previousValue) / GRID_CADENCE_SECONDS;
    });

    const secondDerivativeId = `${sourceVariableId}_acceleration_1m`;
    addFeature({
      id: secondDerivativeId,
      family: 'derivative',
      label: `${seriesInfo.source}.${seriesInfo.variable} acceleration 1m`,
      source: seriesInfo.source,
      variable: seriesInfo.variable,
      operation: 'second_derivative',
      unit: series.unit ? `${series.unit}/s2` : null,
      enabled: true,
      parameters: { deltaMinutes: 1 },
      minSourceOffsetMinutes: -2,
      maxSourceOffsetMinutes: 0,
    }, timestampMs => {
      const currentValue = series.values.get(timestampMs);
      const previousValue = series.values.get(timestampMs - GRID_CADENCE_MS);
      const priorValue = series.values.get(timestampMs - 2 * GRID_CADENCE_MS);

      if (currentValue === undefined || previousValue === undefined || priorValue === undefined) {
        return null;
      }

      return (currentValue - 2 * previousValue + priorValue) / GRID_CADENCE_SECONDS ** 2;
    });

    config.derivativeDiffMinutes.forEach(diffMinutes => {
      const id = `${sourceVariableId}_diff_${diffMinutes}m`;
      addFeature({
        id,
        family: 'derivative',
        label: `${seriesInfo.source}.${seriesInfo.variable} diff ${diffMinutes}m`,
        source: seriesInfo.source,
        variable: seriesInfo.variable,
        operation: 'difference',
        unit: series.unit,
        enabled: true,
        parameters: { diffMinutes },
        minSourceOffsetMinutes: -diffMinutes,
        maxSourceOffsetMinutes: 0,
      }, timestampMs => {
        const currentValue = series.values.get(timestampMs);
        const previousValue = series.values.get(timestampMs - diffMinutes * GRID_CADENCE_MS);
        return currentValue === undefined || previousValue === undefined ? null : currentValue - previousValue;
      });
    });

    config.spectralBands.forEach(band => {
      const id = `${sourceVariableId}_fft_${band.id}_${config.spectralWindowMinutes}m`;
      addFeature({
        id,
        family: 'spectral',
        label: `${seriesInfo.source}.${seriesInfo.variable} FFT ${band.id}`,
        source: seriesInfo.source,
        variable: seriesInfo.variable,
        operation: 'spectral_power',
        unit: series.unit ? `${series.unit}^2` : null,
        enabled: true,
        parameters: {
          windowMinutes: config.spectralWindowMinutes,
          minMilliHz: band.minMilliHz,
          maxMilliHz: band.maxMilliHz,
        },
        minSourceOffsetMinutes: -(config.spectralWindowMinutes - 1),
        maxSourceOffsetMinutes: 0,
      }, timestampMs => spectralBandPower(getWindowValues(series, timestampMs, config.spectralWindowMinutes), band));
    });
  });

  Array.from(new Set(uniqueSeries.map(series => series.source))).forEach(source => {
    [
      'b_magnitude_candidate',
      'clock_angle',
      'cone_angle',
      'dynamic_pressure_proxy',
      'motional_electric_field_proxy',
      'akasofu_epsilon_proxy',
    ].forEach(operation => {
      const id = `${toSafeId(source)}_${operation}`;
      addFeature({
        id,
        family: 'candidate',
        label: `${source} ${operation}`,
        source,
        variable: 'derived',
        operation,
        unit: null,
        enabled: true,
        parameters: { proxy: true },
        minSourceOffsetMinutes: 0,
        maxSourceOffsetMinutes: 0,
      }, buildCandidateSeriesEvaluator(operation, getSeries, source));
    });
  });

  const contextPoints = contextSnapshot?.points ?? [];
  const addContextFeature = (id: string, label: string, operation: string, evaluator: FeatureEvaluator) => {
    addFeature({
      id,
      family: 'context',
      label,
      source: 'CONTEXT',
      variable: operation,
      operation,
      unit: null,
      enabled: true,
      parameters: { causalLookup: 'latest_timestamp_leq_prediction_time' },
      minSourceOffsetMinutes: Number.NEGATIVE_INFINITY,
      maxSourceOffsetMinutes: 0,
    }, evaluator);
  };

  addContextFeature('context_days_since_kp_gt_5', 'Days since last Kp > 5', 'days_since_kp_event', timestampMs =>
    daysSinceLastKpEvent(contextPoints, timestampMs, config.sampleWeights.eventKpThreshold));
  addContextFeature('context_target_local_time_proxy_hour', 'Target local time proxy hour', 'local_time_proxy', localTimeProxyHour);
  addContextFeature('context_day_of_year_sin', 'Day of year sin', 'day_of_year_sin', timestampMs =>
    Math.sin((2 * Math.PI * dayOfYear(timestampMs)) / 366));
  addContextFeature('context_day_of_year_cos', 'Day of year cos', 'day_of_year_cos', timestampMs =>
    Math.cos((2 * Math.PI * dayOfYear(timestampMs)) / 366));
  addContextFeature('context_f107_latest', 'Latest F10.7', 'f107_latest', timestampMs =>
    latestContextValueAt(contextPoints, 'f107', timestampMs)?.value ?? null);

  return { definitions, evaluators };
}

function validateFeatureCausality(definitions: FeatureDefinition[]): NoLeakageReport {
  const violations = definitions
    .filter(definition => definition.maxSourceOffsetMinutes > 0)
    .map(definition => ({
      featureId: definition.id,
      maxSourceOffsetMinutes: definition.maxSourceOffsetMinutes,
      reason: 'Feature depends on source data after the prediction timestamp.',
    }));

  return {
    passed: violations.length === 0,
    featuresChecked: definitions.length,
    violations,
  };
}

function buildHistogram(values: number[]): FeatureHistogramBin[] {
  if (values.length === 0) {
    return [];
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue;

  if (range === 0) {
    return [{
      min: minValue,
      max: maxValue,
      count: values.length,
    }];
  }

  const bins = Array.from({ length: HISTOGRAM_BINS }, (_, index) => ({
    min: minValue + (range * index) / HISTOGRAM_BINS,
    max: minValue + (range * (index + 1)) / HISTOGRAM_BINS,
    count: 0,
  }));

  values.forEach(value => {
    const binIndex = Math.min(HISTOGRAM_BINS - 1, Math.max(0, Math.floor(((value - minValue) / range) * HISTOGRAM_BINS)));
    bins[binIndex].count += 1;
  });

  return bins;
}

function buildFeatureStats(definitions: FeatureDefinition[], previewRows: FeaturePreviewRow[], targetValues: Map<number, number | null>) {
  return definitions.map(definition => {
    const featureValues: number[] = [];
    const pairedFeatureValues: number[] = [];
    const pairedTargetValues: number[] = [];
    let missingCount = 0;

    previewRows.forEach(row => {
      const value = row.values[definition.id];
      const rowTimestampMs = parseTimestampMs(row.timestampUtc);
      const targetValue = rowTimestampMs === null ? null : targetValues.get(rowTimestampMs) ?? null;

      if (value === null || value === undefined) {
        missingCount += 1;
        return;
      }

      featureValues.push(value);

      if (targetValue !== null) {
        pairedFeatureValues.push(value);
        pairedTargetValues.push(targetValue);
      }
    });

    const corr = round(pearson(pairedFeatureValues, pairedTargetValues), 5);

    return {
      featureId: definition.id,
      family: definition.family,
      label: definition.label,
      count: featureValues.length,
      nanPercent: previewRows.length > 0 ? round((missingCount / previewRows.length) * 100, 2) ?? 0 : 0,
      mean: round(mean(featureValues)),
      std: round(standardDeviation(featureValues)),
      min: featureValues.length > 0 ? round(Math.min(...featureValues)) : null,
      max: featureValues.length > 0 ? round(Math.max(...featureValues)) : null,
      targetCorrelation: corr,
      tentativeImportance: corr === null ? null : round(Math.abs(corr), 5),
      histogram: buildHistogram(featureValues),
    };
  });
}

function buildFamilySummaries(definitions: FeatureDefinition[], stats: FeatureStats[]) {
  const families: FeatureFamily[] = ['lag', 'rolling', 'derivative', 'candidate', 'spectral', 'context'];

  return families.map(family => {
    const familyDefinitions = definitions.filter(definition => definition.family === family);
    const familyStats = stats.filter(stat => stat.family === family);

    return {
      family,
      totalFeatures: familyDefinitions.length,
      enabledFeatures: familyDefinitions.filter(definition => definition.enabled).length,
      meanNanPercent: round(mean(familyStats.map(stat => stat.nanPercent)), 2),
    };
  });
}

function deterministicSample(rows: FeaturePreviewRow[], configHash: string) {
  if (rows.length <= PREVIEW_ROWS) {
    return rows;
  }

  const seed = parseInt(configHash.slice(0, 8), 16);
  const stride = Math.max(1, Math.floor(rows.length / PREVIEW_ROWS));

  return Array.from({ length: PREVIEW_ROWS }, (_, index) => rows[(seed + index * stride) % rows.length])
    .sort((a, b) => (parseTimestampMs(a.timestampUtc) ?? 0) - (parseTimestampMs(b.timestampUtc) ?? 0));
}

function eventWeightForTimestamp(contextPoints: ContextIndexPoint[], timestampMs: number, config: FeatureBuildConfig) {
  const kp = latestContextValueAt(contextPoints, 'kp', timestampMs);

  return kp && kp.value > config.sampleWeights.eventKpThreshold
    ? config.sampleWeights.eventWeight
    : config.sampleWeights.baseWeight;
}

export function buildFeatureWorkbenchSnapshot(
  rows: NormalizedSpaceWeatherRow[],
  couplingSnapshot: L1EarthCouplingSnapshot | null,
  contextSnapshot: ContextIndexSnapshot | null,
  rangeInput?: Partial<{ startUtc: string; stopUtc: string }>,
  target: FeatureTargetConfig = DEFAULT_TARGET,
): FeatureWorkbenchSnapshot {
  const range = normalizeRange(rows, rangeInput);
  const targetSeries = buildSeries(rows, target.source, target.variable, range);
  const config: FeatureBuildConfig = {
    version: FEATURE_STORE_VERSION,
    gridCadenceSeconds: GRID_CADENCE_SECONDS,
    target,
    lagMinutes: DEFAULT_LAG_MINUTES,
    rollingWindowsMinutes: ROLLING_WINDOWS_MINUTES,
    rollingStats: ROLLING_STATS,
    derivativeDiffMinutes: DERIVATIVE_DIFF_MINUTES,
    spectralWindowMinutes: SPECTRAL_WINDOW_MINUTES,
    spectralBands: SPECTRAL_BANDS,
    sampleWeights: {
      baseWeight: 1,
      eventWeight: 3,
      eventKpThreshold: 5,
    },
  };
  const prioritizedSignature = couplingSnapshot?.topPairs.map(row => ({
    l1_var: row.l1_var,
    earth_var: row.earth_var,
    lagMinutes: row.lagMinutes,
    corrPearson: row.corrPearson,
  })) ?? [];
  const configHash = hashConfig({
    config,
    prioritizedSignature,
  });
  const { definitions, evaluators } = buildFeatureEvaluators(rows, couplingSnapshot, contextSnapshot, range, config);
  const noLeakageReport = validateFeatureCausality(definitions);
  const contextPoints = contextSnapshot?.points ?? [];
  const timestampsMs = Array.from(targetSeries.values.keys()).sort((a, b) => a - b);
  const matrixRows = timestampsMs.map((timestampMs): FeaturePreviewRow => {
    const values: Record<string, number | null> = {};
    const missingFlags: Record<string, 0 | 1> = {};

    definitions.forEach(definition => {
      const value = round(evaluators.get(definition.id)?.(timestampMs) ?? null);
      values[definition.id] = value;
      missingFlags[`${definition.id}__missing`] = value === null ? 1 : 0;
    });

    return {
      timestampUtc: toIsoUtc(timestampMs),
      target: round(targetSeries.values.get(timestampMs) ?? null),
      sampleWeight: eventWeightForTimestamp(contextPoints, timestampMs, config),
      values,
      missingFlags,
    };
  });
  const targetValues = new Map(matrixRows.map(row => [parseTimestampMs(row.timestampUtc) ?? 0, row.target] as const));
  const stats = buildFeatureStats(definitions, matrixRows, targetValues);
  const familySummaries = buildFamilySummaries(definitions, stats);
  const eventRows = matrixRows.filter(row => row.sampleWeight > config.sampleWeights.baseWeight).length;
  const warnings: string[] = [];

  if (targetSeries.values.size === 0) {
    warnings.push(`${target.source}.${target.variable} target has no rows in the selected range.`);
  }

  if (!couplingSnapshot || couplingSnapshot.topPairs.length === 0) {
    warnings.push('No prioritized L1-Earth pairs were available; Feature Workbench used DSCOVR defaults.');
  }

  if ((contextSnapshot?.errors.length ?? 0) > 0) {
    contextSnapshot?.errors.forEach(error => warnings.push(`Context ${error.kind}: ${error.message}`));
  }

  return {
    generatedAtUtc: new Date().toISOString(),
    source: 'playground-clean-l1-plus-goes-mag',
    range,
    target,
    featureStore: {
      versionTag: `${FEATURE_STORE_VERSION}-${configHash}`,
      configHash,
      outputPath: `local://data/features/${FEATURE_STORE_VERSION}-${configHash}/features.parquet`,
      configPath: 'data/feature_config.yaml',
      rowsTotal: matrixRows.length,
      columnsTotal: definitions.length + 3,
      targetColumn: 'target',
    },
    config,
    featureDefinitions: definitions,
    familySummaries,
    featureStats: stats,
    preview: {
      columns: ['timestampUtc', 'target', 'sampleWeight', ...definitions.map(definition => definition.id)],
      head: matrixRows.slice(0, PREVIEW_ROWS),
      tail: matrixRows.slice(-PREVIEW_ROWS),
      sample: deterministicSample(matrixRows, configHash),
    },
    matrixRows,
    sampleWeights: {
      baseWeight: config.sampleWeights.baseWeight,
      eventWeight: config.sampleWeights.eventWeight,
      eventRule: `latest Kp > ${config.sampleWeights.eventKpThreshold}`,
      eventRows,
    },
    noLeakageReport,
    warnings: Array.from(new Set(warnings)),
  };
}
