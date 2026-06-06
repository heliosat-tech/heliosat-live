import type { PlaygroundTelemetryData } from './playgroundTelemetryService';
import type { SpacecraftTelemetry } from './spacecraftTelemetryService';
import type { NormalizedSpaceWeatherRow } from './pipeline/normalizedSchema';

export type DataQualityWindow = '1h' | '24h' | '7d' | '30d' | '1y' | 'all';
export type CoverageStatus = 'good' | 'partial' | 'poor' | 'na';
export type OutlierMethod = 'robust_z_score' | 'iqr';

export interface DataQualityRange {
  startUtc: string;
  stopUtc: string;
}

export interface QualitySummaryRow {
  source: string;
  variable: string;
  window: DataQualityWindow | 'selected';
  startUtc: string;
  stopUtc: string;
  expectedTimestamps: number | null;
  observedTimestamps: number;
  coveragePercent: number | null;
  nominalCadenceSeconds: number | null;
  effectiveCadenceSeconds: number | null;
  jitterSeconds: number | null;
  upstreamQualityFlags: Array<{
    flag: number;
    count: number;
    percent: number;
  }>;
  gapsCount: number;
  medianGapSeconds: number | null;
  p95GapSeconds: number | null;
  outliersRobustZScoreCount: number;
  outliersIqrCount: number;
}

export interface GapCatalogRow {
  source: string;
  variable: string;
  startUtc: string;
  stopUtc: string;
  durationSeconds: number;
  missingExpectedTimestamps: number | null;
}

export interface OutlierCatalogRow {
  source: string;
  variable: string;
  timestampUtc: string;
  value: number;
  method: OutlierMethod;
  score: number | null;
  lowerFence: number | null;
  upperFence: number | null;
}

export interface CoverageHeatmapCell {
  seriesId: string;
  source: string;
  variable: string;
  dayUtc: string;
  coveragePercent: number | null;
  expectedTimestamps: number | null;
  observedTimestamps: number;
  status: CoverageStatus;
  gaps: GapCatalogRow[];
}

export interface GapDurationHistogramBin {
  minSeconds: number;
  maxSeconds: number;
  count: number;
}

export interface SourceGapCard {
  source: string;
  totalGaps: number;
  medianDurationSeconds: number | null;
  p95DurationSeconds: number | null;
  histogram: GapDurationHistogramBin[];
  topGaps: GapCatalogRow[];
}

export interface SeriesPoint {
  timestampUtc: string;
  value: number;
  isOutlier: boolean;
}

export interface VariableCadenceOutlierCard {
  seriesId: string;
  source: string;
  variable: string;
  unit: string;
  nominalCadenceSeconds: number | null;
  effectiveCadenceSeconds: number | null;
  jitterSeconds: number | null;
  outliersRobustZScoreCount: number;
  outliersIqrCount: number;
  points: SeriesPoint[];
}

export interface CleanTimestampExport {
  generatedAtUtc: string;
  startUtc: string;
  stopUtc: string;
  sharedCleanTimestamps: string[];
  perSeries: Array<{
    seriesId: string;
    source: string;
    variable: string;
    timestamps: string[];
  }>;
}

export interface DataQualitySnapshot {
  generatedAtUtc: string;
  range: DataQualityRange;
  source: 'parquet-store' | 'playground-telemetry-snapshot';
  qualitySummary: QualitySummaryRow[];
  gapsCatalog: GapCatalogRow[];
  outliersCatalog: OutlierCatalogRow[];
  heatmapDays: string[];
  heatmapCells: CoverageHeatmapCell[];
  gapCards: SourceGapCard[];
  variableCards: VariableCadenceOutlierCard[];
  cleanTimestampExport: CleanTimestampExport;
}

interface SeriesGroup {
  seriesId: string;
  source: string;
  variable: string;
  unit: string;
  rows: NormalizedSpaceWeatherRow[];
}

const GAP_FACTOR = 1.5;
const OUTLIER_WINDOW_POINTS = 31;
const ROBUST_Z_SCORE_THRESHOLD = 3.5;
const IQR_FENCE_MULTIPLIER = 1.5;
const MAX_SPARKLINE_POINTS = 160;

const WINDOW_MS: Record<Exclude<DataQualityWindow, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
};

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

function toFiniteNumber(value: string | number | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function uniqueSorted(values: number[]) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
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

function percentile(values: number[], percentileRank: number) {
  if (values.length === 0) {
    return null;
  }

  const sortedValues = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sortedValues.length) - 1),
  );

  return sortedValues[index];
}

function standardDeviation(values: number[]) {
  if (values.length < 2) {
    return null;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);

  return Math.sqrt(variance);
}

function inferCadenceSeconds(timestampsMs: number[]) {
  const sortedTimestamps = uniqueSorted(timestampsMs);

  if (sortedTimestamps.length < 2) {
    return null;
  }

  const deltasSeconds = sortedTimestamps
    .slice(1)
    .map((timestampMs, index) => (timestampMs - sortedTimestamps[index]) / 1000)
    .filter(deltaSeconds => deltaSeconds > 0);
  const cadence = median(deltasSeconds);

  return cadence === null ? null : Math.round(cadence * 10) / 10;
}

function calculateJitterSeconds(timestampsMs: number[]) {
  const sortedTimestamps = uniqueSorted(timestampsMs);

  if (sortedTimestamps.length < 3) {
    return null;
  }

  const deltasSeconds = sortedTimestamps
    .slice(1)
    .map((timestampMs, index) => (timestampMs - sortedTimestamps[index]) / 1000)
    .filter(deltaSeconds => deltaSeconds > 0);

  return standardDeviation(deltasSeconds);
}

function normalizeVariableName(title: string, chartId: string) {
  const normalizedTitle = title.trim().toLowerCase();
  const normalizedChartId = chartId.toLowerCase();

  if (normalizedTitle.includes('bx')) {
    return normalizedTitle.includes('gsm') || normalizedChartId.includes('gsm') ? 'bx_gsm' : 'bx_gse';
  }

  if (normalizedTitle.includes('by')) {
    return normalizedTitle.includes('gsm') || normalizedChartId.includes('gsm') ? 'by_gsm' : 'by_gse';
  }

  if (normalizedTitle.includes('bz')) {
    return normalizedTitle.includes('gsm') || normalizedChartId.includes('gsm') ? 'bz_gsm' : 'bz_gse';
  }

  if (normalizedTitle === 'bt' || normalizedTitle.includes('|b|')) {
    return 'b_total';
  }

  if (normalizedTitle.includes('speed') && !normalizedTitle.includes('thermal')) {
    return 'solar_wind_speed';
  }

  if (normalizedTitle.includes('density')) {
    return 'proton_density';
  }

  if (normalizedTitle.includes('temperature')) {
    return 'proton_temperature';
  }

  if (normalizedTitle.includes('thermal speed')) {
    return 'thermal_speed';
  }

  if (normalizedTitle.includes('x gse')) {
    return 'x_gse';
  }

  if (normalizedTitle.includes('y gse')) {
    return 'y_gse';
  }

  if (normalizedTitle.includes('z gse')) {
    return 'z_gse';
  }

  return normalizedTitle.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function estimateRowCadenceSeconds(points: Array<{ time_tag: string }>) {
  const timestampsMs = points
    .map(point => parseTimestampMs(point.time_tag))
    .filter((timestampMs): timestampMs is number => timestampMs !== null);

  return inferCadenceSeconds(timestampsMs) ?? 60;
}

export function buildNormalizedRowsFromTelemetry(telemetryData: PlaygroundTelemetryData): NormalizedSpaceWeatherRow[] {
  const rows: NormalizedSpaceWeatherRow[] = [];

  telemetryData.spacecraftTelemetry.forEach((mission: SpacecraftTelemetry) => {
    mission.charts.forEach(chart => {
      const variable = normalizeVariableName(chart.title, chart.id);
      const cadenceSeconds = estimateRowCadenceSeconds(chart.data);

      chart.data.forEach(point => {
        const timestampMs = parseTimestampMs(point.time_tag);
        const value = toFiniteNumber(point.value);

        if (timestampMs === null || value === null) {
          return;
        }

        rows.push({
          timestamp_utc: toIsoUtc(timestampMs),
          source: mission.id,
          mission: mission.displayName,
          instrument: chart.title,
          variable,
          value,
          quality_flag: 0,
          unit: chart.unit,
          cadence_s: cadenceSeconds,
        });
      });
    });
  });

  return rows;
}

function getDefaultRange(rows: NormalizedSpaceWeatherRow[]): DataQualityRange {
  const latestTimestampMs = Math.max(
    ...rows
      .map(row => parseTimestampMs(row.timestamp_utc))
      .filter((timestampMs): timestampMs is number => timestampMs !== null),
    Date.now(),
  );

  return {
    startUtc: toIsoUtc(latestTimestampMs - WINDOW_MS['7d']),
    stopUtc: toIsoUtc(latestTimestampMs),
  };
}

function normalizeRange(
  rows: NormalizedSpaceWeatherRow[],
  range?: Partial<DataQualityRange>,
): DataQualityRange {
  const defaultRange = getDefaultRange(rows);
  const startMs = parseTimestampMs(range?.startUtc) ?? parseTimestampMs(defaultRange.startUtc) ?? Date.now() - WINDOW_MS['7d'];
  const stopMs = parseTimestampMs(range?.stopUtc) ?? parseTimestampMs(defaultRange.stopUtc) ?? Date.now();

  if (stopMs <= startMs) {
    return defaultRange;
  }

  return {
    startUtc: toIsoUtc(startMs),
    stopUtc: toIsoUtc(stopMs),
  };
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
    rows: [...group.rows].sort((a, b) => {
      const aMs = parseTimestampMs(a.timestamp_utc) ?? 0;
      const bMs = parseTimestampMs(b.timestamp_utc) ?? 0;
      return aMs - bMs;
    }),
  }));
}

function getTimestampsMs(rows: NormalizedSpaceWeatherRow[]) {
  return uniqueSorted(
    rows
      .map(row => parseTimestampMs(row.timestamp_utc))
      .filter((timestampMs): timestampMs is number => timestampMs !== null),
  );
}

function countExpectedTimestamps(startMs: number, stopMs: number, cadenceSeconds: number | null) {
  if (cadenceSeconds === null || stopMs <= startMs) {
    return null;
  }

  return Math.max(0, Math.floor((stopMs - startMs) / (cadenceSeconds * 1000)) + 1);
}

function buildGaps(
  group: SeriesGroup,
  timestampsMs: number[],
  nominalCadenceSeconds: number | null,
  range: DataQualityRange,
) {
  const startMs = parseTimestampMs(range.startUtc) ?? 0;
  const stopMs = parseTimestampMs(range.stopUtc) ?? startMs;

  if (nominalCadenceSeconds === null) {
    return [];
  }

  const nominalMs = nominalCadenceSeconds * 1000;
  const gapThresholdMs = nominalMs * GAP_FACTOR;
  const gaps: GapCatalogRow[] = [];

  if (timestampsMs.length === 0) {
    return [{
      source: group.source,
      variable: group.variable,
      startUtc: range.startUtc,
      stopUtc: range.stopUtc,
      durationSeconds: Math.max(0, (stopMs - startMs) / 1000),
      missingExpectedTimestamps: countExpectedTimestamps(startMs, stopMs, nominalCadenceSeconds),
    }];
  }

  const firstTimestampMs = timestampsMs[0];
  const lastTimestampMs = timestampsMs[timestampsMs.length - 1];

  if (firstTimestampMs - startMs > gapThresholdMs) {
    const gapStopMs = Math.max(startMs, firstTimestampMs - nominalMs);
    gaps.push({
      source: group.source,
      variable: group.variable,
      startUtc: toIsoUtc(startMs),
      stopUtc: toIsoUtc(gapStopMs),
      durationSeconds: Math.max(0, (gapStopMs - startMs) / 1000),
      missingExpectedTimestamps: countExpectedTimestamps(startMs, gapStopMs, nominalCadenceSeconds),
    });
  }

  timestampsMs.slice(1).forEach((timestampMs, index) => {
    const previousTimestampMs = timestampsMs[index];
    const deltaMs = timestampMs - previousTimestampMs;

    if (deltaMs <= gapThresholdMs) {
      return;
    }

    const gapStartMs = previousTimestampMs + nominalMs;
    const gapStopMs = Math.max(gapStartMs, timestampMs - nominalMs);

    gaps.push({
      source: group.source,
      variable: group.variable,
      startUtc: toIsoUtc(gapStartMs),
      stopUtc: toIsoUtc(gapStopMs),
      durationSeconds: Math.max(0, (gapStopMs - gapStartMs) / 1000),
      missingExpectedTimestamps: countExpectedTimestamps(gapStartMs, gapStopMs, nominalCadenceSeconds),
    });
  });

  if (stopMs - lastTimestampMs > gapThresholdMs) {
    const gapStartMs = lastTimestampMs + nominalMs;
    gaps.push({
      source: group.source,
      variable: group.variable,
      startUtc: toIsoUtc(gapStartMs),
      stopUtc: toIsoUtc(stopMs),
      durationSeconds: Math.max(0, (stopMs - gapStartMs) / 1000),
      missingExpectedTimestamps: countExpectedTimestamps(gapStartMs, stopMs, nominalCadenceSeconds),
    });
  }

  return gaps.filter(gap => gap.durationSeconds > 0).sort((a, b) => {
    const aMs = parseTimestampMs(a.startUtc) ?? 0;
    const bMs = parseTimestampMs(b.startUtc) ?? 0;
    return aMs - bMs;
  });
}

function getWindowValues(values: number[], index: number, windowPoints: number) {
  const radius = Math.floor(windowPoints / 2);
  const startIndex = Math.max(0, index - radius);
  const stopIndex = Math.min(values.length, index + radius + 1);

  return values.slice(startIndex, stopIndex);
}

function quantile(values: number[], rank: number) {
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

function detectOutliers(group: SeriesGroup) {
  const values = group.rows.map(row => row.value);
  const outliers: OutlierCatalogRow[] = [];

  group.rows.forEach((row, index) => {
    const windowValues = getWindowValues(values, index, OUTLIER_WINDOW_POINTS);

    if (windowValues.length < 8) {
      return;
    }

    const windowMedian = median(windowValues);

    if (windowMedian !== null) {
      const deviations = windowValues.map(value => Math.abs(value - windowMedian));
      const mad = median(deviations);

      if (mad !== null && mad > 0) {
        const robustZScore = 0.6745 * (row.value - windowMedian) / mad;

        if (Math.abs(robustZScore) >= ROBUST_Z_SCORE_THRESHOLD) {
          outliers.push({
            source: group.source,
            variable: group.variable,
            timestampUtc: row.timestamp_utc,
            value: row.value,
            method: 'robust_z_score',
            score: robustZScore,
            lowerFence: null,
            upperFence: null,
          });
        }
      }
    }

    const q1 = quantile(windowValues, 0.25);
    const q3 = quantile(windowValues, 0.75);

    if (q1 === null || q3 === null) {
      return;
    }

    const iqr = q3 - q1;

    if (iqr <= 0) {
      return;
    }

    const lowerFence = q1 - IQR_FENCE_MULTIPLIER * iqr;
    const upperFence = q3 + IQR_FENCE_MULTIPLIER * iqr;

    if (row.value < lowerFence || row.value > upperFence) {
      outliers.push({
        source: group.source,
        variable: group.variable,
        timestampUtc: row.timestamp_utc,
        value: row.value,
        method: 'iqr',
        score: null,
        lowerFence,
        upperFence,
      });
    }
  });

  return outliers;
}

function buildQualityFlagSummary(rows: NormalizedSpaceWeatherRow[]) {
  const totalRows = rows.length;
  const counts = new Map<number, number>();

  rows.forEach(row => {
    counts.set(row.quality_flag, (counts.get(row.quality_flag) ?? 0) + 1);
  });

  return Array.from(counts.entries())
    .sort(([a], [b]) => a - b)
    .map(([flag, count]) => ({
      flag,
      count,
      percent: totalRows > 0 ? (count / totalRows) * 100 : 0,
    }));
}

function buildCoverageCells(
  group: SeriesGroup,
  timestampsMs: number[],
  cadenceSeconds: number | null,
  gaps: GapCatalogRow[],
  range: DataQualityRange,
) {
  const rangeStartMs = parseTimestampMs(range.startUtc) ?? 0;
  const rangeStopMs = parseTimestampMs(range.stopUtc) ?? rangeStartMs;
  const startDayMs = Date.UTC(
    new Date(rangeStartMs).getUTCFullYear(),
    new Date(rangeStartMs).getUTCMonth(),
    new Date(rangeStartMs).getUTCDate(),
  );
  const cells: CoverageHeatmapCell[] = [];

  for (let dayMs = startDayMs; dayMs < rangeStopMs; dayMs += 24 * 60 * 60 * 1000) {
    const dayStopMs = Math.min(dayMs + 24 * 60 * 60 * 1000, rangeStopMs);
    const bucketStartMs = Math.max(dayMs, rangeStartMs);
    const expectedTimestamps = countExpectedTimestamps(bucketStartMs, dayStopMs, cadenceSeconds);
    const observedTimestamps = timestampsMs.filter(
      timestampMs => timestampMs >= bucketStartMs && timestampMs < dayStopMs,
    ).length;
    const coveragePercent = expectedTimestamps === null || expectedTimestamps === 0
      ? null
      : Math.min(100, (observedTimestamps / expectedTimestamps) * 100);
    const dayUtc = toIsoUtc(dayMs).slice(0, 10);
    const bucketGaps = gaps.filter(gap => {
      const gapStartMs = parseTimestampMs(gap.startUtc);
      const gapStopMs = parseTimestampMs(gap.stopUtc);
      return gapStartMs !== null && gapStopMs !== null && gapStartMs < dayStopMs && gapStopMs >= bucketStartMs;
    });

    let status: CoverageStatus = 'na';
    if (coveragePercent !== null) {
      status = coveragePercent >= 99.5 ? 'good' : coveragePercent >= 50 ? 'partial' : 'poor';
    }

    cells.push({
      seriesId: group.seriesId,
      source: group.source,
      variable: group.variable,
      dayUtc,
      coveragePercent,
      expectedTimestamps,
      observedTimestamps,
      status,
      gaps: bucketGaps,
    });
  }

  return cells;
}

function buildGapHistogram(gaps: GapCatalogRow[]) {
  if (gaps.length === 0) {
    return [];
  }

  const bins = [
    [0, 60],
    [60, 300],
    [300, 1800],
    [1800, 3600],
    [3600, 21600],
    [21600, 86400],
    [86400, 604800],
    [604800, Number.POSITIVE_INFINITY],
  ] as const;

  return bins
    .map(([minSeconds, maxSeconds]) => ({
      minSeconds,
      maxSeconds: Number.isFinite(maxSeconds) ? maxSeconds : 604800,
      count: gaps.filter(gap => gap.durationSeconds >= minSeconds && gap.durationSeconds < maxSeconds).length,
    }))
    .filter(bin => bin.count > 0);
}

function buildGapCards(gaps: GapCatalogRow[]) {
  const gapsBySource = new Map<string, GapCatalogRow[]>();

  gaps.forEach(gap => {
    const sourceGaps = gapsBySource.get(gap.source) ?? [];
    sourceGaps.push(gap);
    gapsBySource.set(gap.source, sourceGaps);
  });

  return Array.from(gapsBySource.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, sourceGaps]) => {
      const durationsSeconds = sourceGaps.map(gap => gap.durationSeconds);

      return {
        source,
        totalGaps: sourceGaps.length,
        medianDurationSeconds: median(durationsSeconds),
        p95DurationSeconds: percentile(durationsSeconds, 95),
        histogram: buildGapHistogram(sourceGaps),
        topGaps: [...sourceGaps].sort((a, b) => b.durationSeconds - a.durationSeconds).slice(0, 5),
      };
    });
}

function downsampleRows(rows: NormalizedSpaceWeatherRow[], maxPoints = MAX_SPARKLINE_POINTS) {
  if (rows.length <= maxPoints) {
    return rows;
  }

  const step = Math.ceil(rows.length / maxPoints);

  return rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
}

function buildVariableCard(
  group: SeriesGroup,
  effectiveCadenceSeconds: number | null,
  nominalCadenceSeconds: number | null,
  jitterSeconds: number | null,
  outliers: OutlierCatalogRow[],
) {
  const outlierTimestampSet = new Set(outliers.map(outlier => outlier.timestampUtc));
  const rows = downsampleRows(group.rows);

  return {
    seriesId: group.seriesId,
    source: group.source,
    variable: group.variable,
    unit: group.unit,
    nominalCadenceSeconds,
    effectiveCadenceSeconds,
    jitterSeconds,
    outliersRobustZScoreCount: outliers.filter(outlier => outlier.method === 'robust_z_score').length,
    outliersIqrCount: outliers.filter(outlier => outlier.method === 'iqr').length,
    points: rows.map(row => ({
      timestampUtc: row.timestamp_utc,
      value: row.value,
      isOutlier: outlierTimestampSet.has(row.timestamp_utc),
    })),
  };
}

function intersectTimestampSets(series: Array<{ timestamps: string[] }>) {
  if (series.length === 0) {
    return [];
  }

  const [firstSeries, ...restSeries] = series;
  const sharedSet = new Set(firstSeries.timestamps);

  restSeries.forEach(currentSeries => {
    const currentSet = new Set(currentSeries.timestamps);

    Array.from(sharedSet).forEach(timestamp => {
      if (!currentSet.has(timestamp)) {
        sharedSet.delete(timestamp);
      }
    });
  });

  return Array.from(sharedSet).sort();
}

function buildWindowedSummaries(
  group: SeriesGroup,
  range: DataQualityRange,
  selectedSummary: QualitySummaryRow,
) {
  const stopMs = parseTimestampMs(range.stopUtc) ?? Date.now();
  const summaries: QualitySummaryRow[] = [selectedSummary];

  (Object.keys(WINDOW_MS) as Exclude<DataQualityWindow, 'all'>[]).forEach(window => {
    const startMs = Math.max(parseTimestampMs(range.startUtc) ?? 0, stopMs - WINDOW_MS[window]);
    const rows = group.rows.filter(row => {
      const timestampMs = parseTimestampMs(row.timestamp_utc);
      return timestampMs !== null && timestampMs >= startMs && timestampMs <= stopMs;
    });
    const timestampsMs = getTimestampsMs(rows);
    const cadenceSeconds = inferCadenceSeconds(timestampsMs) ?? selectedSummary.nominalCadenceSeconds;
    const expectedTimestamps = countExpectedTimestamps(startMs, stopMs, cadenceSeconds);
    const observedTimestamps = timestampsMs.length;

    summaries.push({
      ...selectedSummary,
      window,
      startUtc: toIsoUtc(startMs),
      expectedTimestamps,
      observedTimestamps,
      coveragePercent: expectedTimestamps === null || expectedTimestamps === 0
        ? null
        : Math.min(100, (observedTimestamps / expectedTimestamps) * 100),
    });
  });

  return summaries;
}

export function buildDataQualitySnapshot(
  telemetryData: PlaygroundTelemetryData,
  rangeInput?: Partial<DataQualityRange>,
): DataQualitySnapshot {
  const allRows = buildNormalizedRowsFromTelemetry(telemetryData);
  const range = normalizeRange(allRows, rangeInput);
  const rangeStartMs = parseTimestampMs(range.startUtc) ?? 0;
  const rangeStopMs = parseTimestampMs(range.stopUtc) ?? Date.now();
  const rangeRows = allRows.filter(row => {
    const timestampMs = parseTimestampMs(row.timestamp_utc);
    return timestampMs !== null && timestampMs >= rangeStartMs && timestampMs <= rangeStopMs;
  });
  const groups = groupRows(rangeRows);
  const qualitySummary: QualitySummaryRow[] = [];
  const gapsCatalog: GapCatalogRow[] = [];
  const outliersCatalog: OutlierCatalogRow[] = [];
  const heatmapCells: CoverageHeatmapCell[] = [];
  const variableCards: VariableCadenceOutlierCard[] = [];
  const cleanPerSeries: CleanTimestampExport['perSeries'] = [];

  groups.forEach(group => {
    const timestampsMs = getTimestampsMs(group.rows);
    const effectiveCadenceSeconds = inferCadenceSeconds(timestampsMs);
    const nominalCadenceSeconds = median(group.rows.map(row => row.cadence_s).filter(Number.isFinite)) ?? effectiveCadenceSeconds;
    const jitterSeconds = calculateJitterSeconds(timestampsMs);
    const expectedTimestamps = countExpectedTimestamps(rangeStartMs, rangeStopMs, nominalCadenceSeconds);
    const observedTimestamps = timestampsMs.length;
    const gaps = buildGaps(group, timestampsMs, nominalCadenceSeconds, range);
    const outliers = detectOutliers(group);
    const outlierTimestampSet = new Set(outliers.map(outlier => outlier.timestampUtc));
    const selectedSummary: QualitySummaryRow = {
      source: group.source,
      variable: group.variable,
      window: 'selected',
      startUtc: range.startUtc,
      stopUtc: range.stopUtc,
      expectedTimestamps,
      observedTimestamps,
      coveragePercent: expectedTimestamps === null || expectedTimestamps === 0
        ? null
        : Math.min(100, (observedTimestamps / expectedTimestamps) * 100),
      nominalCadenceSeconds,
      effectiveCadenceSeconds,
      jitterSeconds,
      upstreamQualityFlags: buildQualityFlagSummary(group.rows),
      gapsCount: gaps.length,
      medianGapSeconds: median(gaps.map(gap => gap.durationSeconds)),
      p95GapSeconds: percentile(gaps.map(gap => gap.durationSeconds), 95),
      outliersRobustZScoreCount: outliers.filter(outlier => outlier.method === 'robust_z_score').length,
      outliersIqrCount: outliers.filter(outlier => outlier.method === 'iqr').length,
    };

    qualitySummary.push(...buildWindowedSummaries(group, range, selectedSummary));
    gapsCatalog.push(...gaps);
    outliersCatalog.push(...outliers);
    heatmapCells.push(...buildCoverageCells(group, timestampsMs, nominalCadenceSeconds, gaps, range));
    variableCards.push(buildVariableCard(group, effectiveCadenceSeconds, nominalCadenceSeconds, jitterSeconds, outliers));
    cleanPerSeries.push({
      seriesId: group.seriesId,
      source: group.source,
      variable: group.variable,
      timestamps: group.rows
        .filter(row => !outlierTimestampSet.has(row.timestamp_utc))
        .map(row => row.timestamp_utc),
    });
  });

  const generatedAtUtc = toIsoUtc(Date.now());
  const heatmapDays = Array.from(new Set(heatmapCells.map(cell => cell.dayUtc))).sort();

  return {
    generatedAtUtc,
    range,
    source: 'playground-telemetry-snapshot',
    qualitySummary,
    gapsCatalog: gapsCatalog.sort((a, b) => {
      const aMs = parseTimestampMs(a.startUtc) ?? 0;
      const bMs = parseTimestampMs(b.startUtc) ?? 0;
      return aMs - bMs;
    }),
    outliersCatalog: outliersCatalog.sort((a, b) => {
      const aMs = parseTimestampMs(a.timestampUtc) ?? 0;
      const bMs = parseTimestampMs(b.timestampUtc) ?? 0;
      return aMs - bMs;
    }),
    heatmapDays,
    heatmapCells,
    gapCards: buildGapCards(gapsCatalog),
    variableCards,
    cleanTimestampExport: {
      generatedAtUtc,
      startUtc: range.startUtc,
      stopUtc: range.stopUtc,
      sharedCleanTimestamps: intersectTimestampSets(cleanPerSeries),
      perSeries: cleanPerSeries,
    },
  };
}
