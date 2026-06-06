import type { NormalizedSpaceWeatherRow } from './pipeline/normalizedSchema';

export type CouplingOrbitGroup = 'GEO' | 'MEO' | 'LEO' | 'HEO' | 'NEAR_EARTH';

export interface CouplingPairConfig {
  id: string;
  l1Source: string;
  l1Variable: string;
  earthSource: string;
  earthVariable: string;
  earthOrbit: CouplingOrbitGroup;
  label: string;
}

export interface CouplingRange {
  startUtc: string;
  stopUtc: string;
}

export interface CcfMatrixRow {
  pairId: string;
  l1_var: string;
  earth_var: string;
  lag: number;
  window: string;
  corrPearson: number | null;
  corrSpearman: number | null;
  mi: number | null;
  sampleCount: number;
  confidenceLow: number | null;
  confidenceHigh: number | null;
}

export interface CouplingHeatmapCell {
  pairId: string;
  l1Source: string;
  l1Variable: string;
  earthSource: string;
  earthVariable: string;
  earthOrbit: CouplingOrbitGroup;
  absCorrelation: number | null;
  optimalLagMinutes: number | null;
  corrPearson: number | null;
  corrSpearman: number | null;
  mutualInformation: number | null;
  sampleCount: number;
}

export interface OptimalLagRow {
  pairId: string;
  l1_var: string;
  earth_var: string;
  window: string;
  startUtc: string;
  stopUtc: string;
  lagMinutes: number | null;
  corrPearson: number | null;
  corrSpearman: number | null;
  mutualInformation: number | null;
  absCorrelation: number | null;
  sampleCount: number;
}

export interface LagVariabilityPoint {
  timestampUtc: string;
  startUtc: string;
  stopUtc: string;
  lagMinutes: number | null;
  corrPearson: number | null;
  windSpeedKmS: number | null;
  sampleCount: number;
}

export interface CoherencePoint {
  frequencyHz: number;
  frequencyMilliHz: number;
  periodMinutes: number | null;
  coherenceMagnitude: number;
  phaseRadians: number;
  band: string;
}

export interface CoherenceSummaryRow {
  pairId: string;
  l1_var: string;
  earth_var: string;
  band: string;
  meanCoherence: number | null;
  medianPhaseRadians: number | null;
  points: number;
}

export interface L1EarthCouplingPairDetail {
  pair: CouplingPairConfig;
  l1Unit: string | null;
  earthUnit: string | null;
  ccf: CcfMatrixRow[];
  lagVariability: LagVariabilityPoint[];
  coherence: CoherencePoint[];
}

export interface L1EarthCouplingSnapshot {
  generatedAtUtc: string;
  source: 'parquet-store-aligned-grid' | 'playground-live-l1-plus-goes-mag';
  range: CouplingRange;
  config: {
    gridCadenceSeconds: number;
    lagMinutes: {
      min: number;
      max: number;
      step: number;
    };
    rollingWindowHours: number;
    pairCount: number;
  };
  pairs: CouplingPairConfig[];
  heatmap: CouplingHeatmapCell[];
  pairDetails: L1EarthCouplingPairDetail[];
  ccfMatrix: CcfMatrixRow[];
  optimalLags: OptimalLagRow[];
  coherenceSummary: CoherenceSummaryRow[];
  topPairs: OptimalLagRow[];
  warnings: string[];
}

interface SeriesData {
  source: string;
  variable: string;
  unit: string | null;
  values: Map<number, number>;
}

interface PairedValues {
  timestampsMs: number[];
  x: number[];
  y: number[];
}

const GRID_CADENCE_SECONDS = 60;
const GRID_CADENCE_MS = GRID_CADENCE_SECONDS * 1000;
const LAG_MINUTES = {
  min: -30,
  max: 180,
  step: 1,
};
const ROLLING_WINDOW_HOURS = 24;
const ROLLING_WINDOW_MS = ROLLING_WINDOW_HOURS * 60 * 60 * 1000;
const ROLLING_STEP_MS = 6 * 60 * 60 * 1000;
const MIN_CCF_SAMPLES = 8;
const MIN_MI_SAMPLES = 16;
const MAX_TOPOLOGY_POINTS = 180;

export const DEFAULT_COUPLING_PAIRS: CouplingPairConfig[] = [
  {
    id: 'dscovr-bz-gsm_goes-mag-hn',
    l1Source: 'DSCOVR',
    l1Variable: 'bz_gsm',
    earthSource: 'GOES',
    earthVariable: 'goes_mag_hn',
    earthOrbit: 'GEO',
    label: 'DSCOVR.Bz_GSM -> GOES-R.MAG.Hn',
  },
  {
    id: 'dscovr-by-gsm_goes-mag-he',
    l1Source: 'DSCOVR',
    l1Variable: 'by_gsm',
    earthSource: 'GOES',
    earthVariable: 'goes_mag_he',
    earthOrbit: 'GEO',
    label: 'DSCOVR.By_GSM -> GOES-R.MAG.He',
  },
  {
    id: 'dscovr-b-total_goes-mag-total',
    l1Source: 'DSCOVR',
    l1Variable: 'b_total',
    earthSource: 'GOES',
    earthVariable: 'goes_mag_total',
    earthOrbit: 'GEO',
    label: 'DSCOVR.|B| -> GOES-R.MAG.total',
  },
  {
    id: 'dscovr-speed_goes-mag-hn',
    l1Source: 'DSCOVR',
    l1Variable: 'solar_wind_speed',
    earthSource: 'GOES',
    earthVariable: 'goes_mag_hn',
    earthOrbit: 'GEO',
    label: 'DSCOVR.V -> GOES-R.MAG.Hn',
  },
  {
    id: 'dscovr-density_goes-mag-total',
    l1Source: 'DSCOVR',
    l1Variable: 'proton_density',
    earthSource: 'GOES',
    earthVariable: 'goes_mag_total',
    earthOrbit: 'GEO',
    label: 'DSCOVR.Np -> GOES-R.MAG.total',
  },
  {
    id: 'ace-bz-gse_goes-mag-hn',
    l1Source: 'ACE',
    l1Variable: 'bz_gse',
    earthSource: 'GOES',
    earthVariable: 'goes_mag_hn',
    earthOrbit: 'GEO',
    label: 'ACE.Bz_GSE -> GOES-R.MAG.Hn',
  },
  {
    id: 'wind-bz-gsm_goes-mag-hn',
    l1Source: 'WIND',
    l1Variable: 'bz_gsm',
    earthSource: 'GOES',
    earthVariable: 'goes_mag_hn',
    earthOrbit: 'GEO',
    label: 'WIND.Bz_GSM -> GOES-R.MAG.Hn',
  },
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

function round(value: number | null, digits = 4) {
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

  const sortedValues = [...values].sort((a, b) => a - b);
  const middleIndex = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[middleIndex];
  }

  return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}

function normalizeRange(
  rows: NormalizedSpaceWeatherRow[],
  range?: Partial<CouplingRange>,
): CouplingRange {
  const timestampsMs = rows
    .map(row => parseTimestampMs(row.timestamp_utc))
    .filter((timestampMs): timestampMs is number => timestampMs !== null);
  const latestMs = timestampsMs.length > 0 ? Math.max(...timestampsMs) : Date.now();
  const earliestMs = timestampsMs.length > 0 ? Math.min(...timestampsMs) : latestMs - 24 * 60 * 60 * 1000;
  const defaultStartMs = Math.max(earliestMs, latestMs - 24 * 60 * 60 * 1000);
  const startMs = parseTimestampMs(range?.startUtc) ?? defaultStartMs;
  const stopMs = parseTimestampMs(range?.stopUtc) ?? latestMs;

  if (stopMs <= startMs) {
    return {
      startUtc: toIsoUtc(defaultStartMs),
      stopUtc: toIsoUtc(latestMs),
    };
  }

  return {
    startUtc: toIsoUtc(startMs),
    stopUtc: toIsoUtc(stopMs),
  };
}

function getMinuteBucket(timestampMs: number) {
  return Math.round(timestampMs / GRID_CADENCE_MS) * GRID_CADENCE_MS;
}

function buildSeries(
  rows: NormalizedSpaceWeatherRow[],
  source: string,
  variable: string,
  range: CouplingRange,
): SeriesData {
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

    const bucketMs = getMinuteBucket(timestampMs);
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

function filterSeriesByWindow(series: SeriesData, startMs: number, stopMs: number): SeriesData {
  return {
    ...series,
    values: new Map(
      Array.from(series.values.entries()).filter(([timestampMs]) => timestampMs >= startMs && timestampMs <= stopMs),
    ),
  };
}

function getPairedValues(l1Series: SeriesData, earthSeries: SeriesData, lagMinutes: number): PairedValues {
  const lagMs = lagMinutes * GRID_CADENCE_MS;
  const timestampsMs: number[] = [];
  const x: number[] = [];
  const y: number[] = [];

  Array.from(l1Series.values.entries())
    .sort(([a], [b]) => a - b)
    .forEach(([timestampMs, l1Value]) => {
      const earthValue = earthSeries.values.get(timestampMs + lagMs);

      if (earthValue === undefined) {
        return;
      }

      timestampsMs.push(timestampMs);
      x.push(l1Value);
      y.push(earthValue);
    });

  return { timestampsMs, x, y };
}

function pearson(x: number[], y: number[]) {
  if (x.length !== y.length || x.length < MIN_CCF_SAMPLES) {
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

  if (denominator === 0) {
    return null;
  }

  return covariance / denominator;
}

function rank(values: number[]) {
  const indexedValues = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let index = 0;

  while (index < indexedValues.length) {
    let tieEnd = index;

    while (
      tieEnd + 1 < indexedValues.length &&
      indexedValues[tieEnd + 1].value === indexedValues[index].value
    ) {
      tieEnd += 1;
    }

    const averageRank = (index + tieEnd + 2) / 2;

    for (let tieIndex = index; tieIndex <= tieEnd; tieIndex += 1) {
      ranks[indexedValues[tieIndex].index] = averageRank;
    }

    index = tieEnd + 1;
  }

  return ranks;
}

function spearman(x: number[], y: number[]) {
  if (x.length !== y.length || x.length < MIN_CCF_SAMPLES) {
    return null;
  }

  return pearson(rank(x), rank(y));
}

function correlationConfidenceInterval(corr: number | null, sampleCount: number) {
  if (corr === null || sampleCount < 4) {
    return { low: null, high: null };
  }

  const boundedCorr = Math.max(-0.999999, Math.min(0.999999, corr));
  const z = Math.atanh(boundedCorr);
  const standardError = 1 / Math.sqrt(sampleCount - 3);

  return {
    low: round(Math.tanh(z - 1.96 * standardError)),
    high: round(Math.tanh(z + 1.96 * standardError)),
  };
}

function mutualInformation(x: number[], y: number[]) {
  if (x.length !== y.length || x.length < MIN_MI_SAMPLES) {
    return null;
  }

  const binCount = Math.max(2, Math.min(8, Math.floor(Math.sqrt(x.length))));
  const minX = Math.min(...x);
  const maxX = Math.max(...x);
  const minY = Math.min(...y);
  const maxY = Math.max(...y);
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;

  if (rangeX === 0 || rangeY === 0) {
    return null;
  }

  const xCounts = new Array<number>(binCount).fill(0);
  const yCounts = new Array<number>(binCount).fill(0);
  const jointCounts = Array.from({ length: binCount }, () => new Array<number>(binCount).fill(0));

  for (let index = 0; index < x.length; index += 1) {
    const xBin = Math.min(binCount - 1, Math.max(0, Math.floor(((x[index] - minX) / rangeX) * binCount)));
    const yBin = Math.min(binCount - 1, Math.max(0, Math.floor(((y[index] - minY) / rangeY) * binCount)));
    xCounts[xBin] += 1;
    yCounts[yBin] += 1;
    jointCounts[xBin][yBin] += 1;
  }

  let mi = 0;

  for (let xBin = 0; xBin < binCount; xBin += 1) {
    for (let yBin = 0; yBin < binCount; yBin += 1) {
      const jointProbability = jointCounts[xBin][yBin] / x.length;

      if (jointProbability === 0) {
        continue;
      }

      const xProbability = xCounts[xBin] / x.length;
      const yProbability = yCounts[yBin] / x.length;
      mi += jointProbability * Math.log2(jointProbability / (xProbability * yProbability));
    }
  }

  return mi;
}

function buildCcfRows(
  pair: CouplingPairConfig,
  l1Series: SeriesData,
  earthSeries: SeriesData,
  windowLabel: string,
) {
  const rows: CcfMatrixRow[] = [];

  for (let lag = LAG_MINUTES.min; lag <= LAG_MINUTES.max; lag += LAG_MINUTES.step) {
    const paired = getPairedValues(l1Series, earthSeries, lag);
    const corrPearson = round(pearson(paired.x, paired.y));
    const corrSpearman = round(spearman(paired.x, paired.y));
    const mi = round(mutualInformation(paired.x, paired.y));
    const confidence = correlationConfidenceInterval(corrPearson, paired.x.length);

    rows.push({
      pairId: pair.id,
      l1_var: `${pair.l1Source}.${pair.l1Variable}`,
      earth_var: `${pair.earthSource}.${pair.earthVariable}`,
      lag,
      window: windowLabel,
      corrPearson,
      corrSpearman,
      mi,
      sampleCount: paired.x.length,
      confidenceLow: confidence.low,
      confidenceHigh: confidence.high,
    });
  }

  return rows;
}

function buildOptimalLagRow(
  pair: CouplingPairConfig,
  ccfRows: CcfMatrixRow[],
  range: CouplingRange,
  windowLabel: string,
): OptimalLagRow {
  const bestRow = ccfRows.reduce<CcfMatrixRow | null>((currentBest, row) => {
    if (row.corrPearson === null) {
      return currentBest;
    }

    if (!currentBest || currentBest.corrPearson === null) {
      return row;
    }

    return Math.abs(row.corrPearson) > Math.abs(currentBest.corrPearson) ? row : currentBest;
  }, null);

  return {
    pairId: pair.id,
    l1_var: `${pair.l1Source}.${pair.l1Variable}`,
    earth_var: `${pair.earthSource}.${pair.earthVariable}`,
    window: windowLabel,
    startUtc: range.startUtc,
    stopUtc: range.stopUtc,
    lagMinutes: bestRow?.lag ?? null,
    corrPearson: bestRow?.corrPearson ?? null,
    corrSpearman: bestRow?.corrSpearman ?? null,
    mutualInformation: bestRow?.mi ?? null,
    absCorrelation: bestRow?.corrPearson === null || bestRow?.corrPearson === undefined
      ? null
      : round(Math.abs(bestRow.corrPearson)),
    sampleCount: bestRow?.sampleCount ?? 0,
  };
}

function downsample<T>(rows: T[], maxPoints = MAX_TOPOLOGY_POINTS) {
  if (rows.length <= maxPoints) {
    return rows;
  }

  const step = Math.ceil(rows.length / maxPoints);
  return rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
}

function buildLagVariability(
  pair: CouplingPairConfig,
  l1Series: SeriesData,
  earthSeries: SeriesData,
  windSpeedSeries: SeriesData,
) {
  const timestamps = [
    ...Array.from(l1Series.values.keys()),
    ...Array.from(earthSeries.values.keys()),
  ];

  if (timestamps.length < MIN_CCF_SAMPLES) {
    return [];
  }

  const startMs = Math.min(...timestamps);
  const stopMs = Math.max(...timestamps);
  const totalSpanMs = stopMs - startMs;

  if (totalSpanMs <= 0) {
    return [];
  }

  const windows: Array<{ startMs: number; stopMs: number }> = [];

  if (totalSpanMs <= ROLLING_WINDOW_MS) {
    windows.push({ startMs, stopMs });
  } else {
    for (let windowStartMs = startMs; windowStartMs + ROLLING_WINDOW_MS <= stopMs; windowStartMs += ROLLING_STEP_MS) {
      windows.push({
        startMs: windowStartMs,
        stopMs: windowStartMs + ROLLING_WINDOW_MS,
      });
    }
  }

  return downsample(windows.map(windowRange => {
    const windowRangeIso = {
      startUtc: toIsoUtc(windowRange.startMs),
      stopUtc: toIsoUtc(windowRange.stopMs),
    };
    const l1Window = filterSeriesByWindow(l1Series, windowRange.startMs, windowRange.stopMs);
    const earthWindow = filterSeriesByWindow(earthSeries, windowRange.startMs, windowRange.stopMs);
    const ccfRows = buildCcfRows(pair, l1Window, earthWindow, 'rolling_24h');
    const optimal = buildOptimalLagRow(pair, ccfRows, windowRangeIso, 'rolling_24h');
    const windValues = Array.from(windSpeedSeries.values.entries())
      .filter(([timestampMs]) => timestampMs >= windowRange.startMs && timestampMs <= windowRange.stopMs)
      .map(([, value]) => value);

    return {
      timestampUtc: toIsoUtc(windowRange.stopMs),
      startUtc: windowRangeIso.startUtc,
      stopUtc: windowRangeIso.stopUtc,
      lagMinutes: optimal.lagMinutes,
      corrPearson: optimal.corrPearson,
      windSpeedKmS: round(mean(windValues), 2),
      sampleCount: optimal.sampleCount,
    };
  }).filter(point => point.sampleCount >= MIN_CCF_SAMPLES));
}

function subtractMean(values: number[]) {
  const currentMean = mean(values) ?? 0;
  return values.map(value => value - currentMean);
}

function dftAt(values: number[], k: number) {
  let re = 0;
  let im = 0;
  const n = values.length;

  for (let index = 0; index < n; index += 1) {
    const hann = n > 1 ? 0.5 * (1 - Math.cos((2 * Math.PI * index) / (n - 1))) : 1;
    const angle = (-2 * Math.PI * k * index) / n;
    const windowedValue = values[index] * hann;
    re += windowedValue * Math.cos(angle);
    im += windowedValue * Math.sin(angle);
  }

  return { re, im };
}

function getFrequencyBand(frequencyHz: number) {
  const frequencyMilliHz = frequencyHz * 1000;

  if (frequencyMilliHz < 1) {
    return '<1 mHz';
  }

  if (frequencyMilliHz <= 10) {
    return '1-10 mHz';
  }

  return '>10 mHz';
}

function buildCoherencePoints(l1Series: SeriesData, earthSeries: SeriesData, optimalLagMinutes: number | null) {
  if (optimalLagMinutes === null) {
    return [];
  }

  const paired = getPairedValues(l1Series, earthSeries, optimalLagMinutes);
  const sampleCount = paired.x.length;

  if (sampleCount < 16) {
    return [];
  }

  const segmentLength = Math.min(96, sampleCount < 64 ? sampleCount : 64);
  const step = Math.max(8, Math.floor(segmentLength / 2));
  const maxK = Math.min(48, Math.floor(segmentLength / 2));
  const accumulators = Array.from({ length: maxK + 1 }, () => ({
    sxx: 0,
    syy: 0,
    sxyRe: 0,
    sxyIm: 0,
    segments: 0,
  }));

  for (let startIndex = 0; startIndex + segmentLength <= sampleCount; startIndex += step) {
    const xSegment = subtractMean(paired.x.slice(startIndex, startIndex + segmentLength));
    const ySegment = subtractMean(paired.y.slice(startIndex, startIndex + segmentLength));

    for (let k = 1; k <= maxK; k += 1) {
      const xDft = dftAt(xSegment, k);
      const yDft = dftAt(ySegment, k);
      const accumulator = accumulators[k];

      accumulator.sxx += xDft.re ** 2 + xDft.im ** 2;
      accumulator.syy += yDft.re ** 2 + yDft.im ** 2;
      accumulator.sxyRe += xDft.re * yDft.re + xDft.im * yDft.im;
      accumulator.sxyIm += xDft.im * yDft.re - xDft.re * yDft.im;
      accumulator.segments += 1;
    }
  }

  return accumulators
    .map((accumulator, index): CoherencePoint | null => {
      if (index === 0 || accumulator.segments === 0 || accumulator.sxx <= 0 || accumulator.syy <= 0) {
        return null;
      }

      const frequencyHz = index / (segmentLength * GRID_CADENCE_SECONDS);
      const coherenceMagnitude = Math.min(
        1,
        Math.max(
          0,
          (accumulator.sxyRe ** 2 + accumulator.sxyIm ** 2) / (accumulator.sxx * accumulator.syy),
        ),
      );

      return {
        frequencyHz,
        frequencyMilliHz: frequencyHz * 1000,
        periodMinutes: frequencyHz > 0 ? 1 / frequencyHz / 60 : null,
        coherenceMagnitude: round(coherenceMagnitude, 4) ?? 0,
        phaseRadians: round(Math.atan2(accumulator.sxyIm, accumulator.sxyRe), 4) ?? 0,
        band: getFrequencyBand(frequencyHz),
      };
    })
    .filter((point): point is CoherencePoint => point !== null);
}

function buildCoherenceSummary(
  pair: CouplingPairConfig,
  points: CoherencePoint[],
) {
  const bands = ['<1 mHz', '1-10 mHz', '>10 mHz'];

  return bands.map((band): CoherenceSummaryRow => {
    const bandPoints = points.filter(point => point.band === band);

    return {
      pairId: pair.id,
      l1_var: `${pair.l1Source}.${pair.l1Variable}`,
      earth_var: `${pair.earthSource}.${pair.earthVariable}`,
      band,
      meanCoherence: round(mean(bandPoints.map(point => point.coherenceMagnitude))),
      medianPhaseRadians: round(median(bandPoints.map(point => point.phaseRadians))),
      points: bandPoints.length,
    };
  });
}

function buildHeatmapCell(pair: CouplingPairConfig, optimal: OptimalLagRow): CouplingHeatmapCell {
  return {
    pairId: pair.id,
    l1Source: pair.l1Source,
    l1Variable: pair.l1Variable,
    earthSource: pair.earthSource,
    earthVariable: pair.earthVariable,
    earthOrbit: pair.earthOrbit,
    absCorrelation: optimal.absCorrelation,
    optimalLagMinutes: optimal.lagMinutes,
    corrPearson: optimal.corrPearson,
    corrSpearman: optimal.corrSpearman,
    mutualInformation: optimal.mutualInformation,
    sampleCount: optimal.sampleCount,
  };
}

export function buildL1EarthCouplingSnapshot(
  rows: NormalizedSpaceWeatherRow[],
  rangeInput?: Partial<CouplingRange>,
  pairConfig: CouplingPairConfig[] = DEFAULT_COUPLING_PAIRS,
): L1EarthCouplingSnapshot {
  const range = normalizeRange(rows, rangeInput);
  const warnings: string[] = [];
  const heatmap: CouplingHeatmapCell[] = [];
  const pairDetails: L1EarthCouplingPairDetail[] = [];
  const ccfMatrix: CcfMatrixRow[] = [];
  const optimalLags: OptimalLagRow[] = [];
  const coherenceSummary: CoherenceSummaryRow[] = [];
  const windSpeedSeries = buildSeries(rows, 'DSCOVR', 'solar_wind_speed', range);

  if (!rows.some(row => row.source === 'GOES')) {
    warnings.push('GOES MAG rows are not available for near-Earth coupling.');
  }

  pairConfig.forEach(pair => {
    const l1Series = buildSeries(rows, pair.l1Source, pair.l1Variable, range);
    const earthSeries = buildSeries(rows, pair.earthSource, pair.earthVariable, range);
    const ccfRows = buildCcfRows(pair, l1Series, earthSeries, 'full');
    const optimal = buildOptimalLagRow(pair, ccfRows, range, 'full');
    const lagVariability = buildLagVariability(pair, l1Series, earthSeries, windSpeedSeries);
    const coherence = buildCoherencePoints(l1Series, earthSeries, optimal.lagMinutes);

    if (l1Series.values.size === 0) {
      warnings.push(`${pair.l1Source}.${pair.l1Variable} has no aligned rows in the selected range.`);
    }

    if (earthSeries.values.size === 0) {
      warnings.push(`${pair.earthSource}.${pair.earthVariable} has no aligned rows in the selected range.`);
    }

    ccfMatrix.push(...ccfRows);
    optimalLags.push(optimal);
    heatmap.push(buildHeatmapCell(pair, optimal));
    coherenceSummary.push(...buildCoherenceSummary(pair, coherence));
    pairDetails.push({
      pair,
      l1Unit: l1Series.unit,
      earthUnit: earthSeries.unit,
      ccf: ccfRows,
      lagVariability,
      coherence,
    });
  });

  const topPairs = optimalLags
    .filter(row => row.absCorrelation !== null)
    .sort((a, b) => (b.absCorrelation ?? 0) - (a.absCorrelation ?? 0))
    .slice(0, 25);

  return {
    generatedAtUtc: new Date().toISOString(),
    source: 'playground-live-l1-plus-goes-mag',
    range,
    config: {
      gridCadenceSeconds: GRID_CADENCE_SECONDS,
      lagMinutes: LAG_MINUTES,
      rollingWindowHours: ROLLING_WINDOW_HOURS,
      pairCount: pairConfig.length,
    },
    pairs: pairConfig,
    heatmap,
    pairDetails,
    ccfMatrix,
    optimalLags,
    coherenceSummary,
    topPairs,
    warnings: Array.from(new Set(warnings)),
  };
}
