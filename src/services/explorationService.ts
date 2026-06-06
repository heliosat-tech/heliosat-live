/**
 * Exploration: historical, automatic exploratory analysis of the L1 -> Earth
 * solar wind, using the same real data path as Validation.
 *
 *   L1 input   : ACE key parameters (CDAWeb HAPI)
 *   Earth truth: OMNI HRO 1-min (CDAWeb HAPI)
 *
 * Two views are served from a single fetch:
 *   - Univariate: distribution + summary stats of each variable, at L1 and at Earth.
 *   - Coupling  : cross-correlation between L1 and Earth across candidate lags.
 *                 The lag of peak correlation is the *empirical* L1->Earth travel
 *                 time, which we compare against the MRU ballistic estimate
 *                 (nominal L1 distance / mean speed).
 */
import { resolveCoverageAnchoredRange } from './dataCoverageService';
import { fetchHapiSeries, toFiniteNumber } from './historicPlotService';
import { NOMINAL_L1_DISTANCE_KM } from './mruForecastService';

export type ExplorationVariableId = 'speed' | 'density' | 'bt' | 'bz';
export type ExplorationLocation = 'L1' | 'Earth';

export interface ExplorationHistogramBin {
  binStart: number;
  binEnd: number;
  count: number;
}

export interface ExplorationDistribution {
  variableId: ExplorationVariableId;
  label: string;
  unit: string;
  location: ExplorationLocation;
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  std: number | null;
  p05: number | null;
  p95: number | null;
  histogram: ExplorationHistogramBin[];
}

export interface ExplorationCcfPoint {
  lagMinutes: number;
  correlation: number;
}

export interface ExplorationCoupling {
  variableId: ExplorationVariableId;
  label: string;
  unit: string;
  count: number;
  ccf: ExplorationCcfPoint[];
  optimalLagMinutes: number | null;
  peakCorrelation: number | null;
  mruExpectedLagMinutes: number | null;
  note?: string;
}

export interface ExplorationSnapshot {
  generatedAtUtc: string;
  range: { startUtc: string; stopUtc: string };
  autoSelected: boolean;
  l1Source: string;
  earthSource: string;
  meanSpeedKmS: number | null;
  sampleCount: { l1: number; earth: number; gridMinutes: number };
  distributions: ExplorationDistribution[];
  coupling: ExplorationCoupling[];
  warnings: string[];
}

const GRID_STEP_MS = 60_000;
const CCF_MIN_LAG_MIN = -30;
const CCF_MAX_LAG_MIN = 180;
const CCF_LAG_STEP_MIN = 2;
const HISTOGRAM_BINS = 24;
const MIN_PAIRS_FOR_CORRELATION = 30;

const VARIABLES: { id: ExplorationVariableId; label: string; unit: string; min: number; max: number }[] = [
  { id: 'speed', label: 'Solar-wind speed', unit: 'km/s', min: 100, max: 3000 },
  { id: 'density', label: 'Proton density', unit: 'n/cc', min: 0.01, max: 200 },
  { id: 'bt', label: 'Field magnitude |B|', unit: 'nT', min: 0, max: 200 },
  { id: 'bz', label: 'Bz (north-south field)', unit: 'nT', min: -200, max: 200 },
];

const BZ_FRAME_NOTE =
  'Lag is robust, but ACE reports Bz in GSE and OMNI in GSM, so the absolute correlation is approximate.';

interface VariableSamples {
  ms: number;
  speed: number | null;
  density: number | null;
  bt: number | null;
  bz: number | null;
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function sanitize(value: number | null, variableId: ExplorationVariableId): number | null {
  if (value === null) {
    return null;
  }
  const config = VARIABLES.find(variable => variable.id === variableId)!;
  return value >= config.min && value <= config.max ? value : null;
}

function readVectorComponent(cell: unknown, index: number): number | null {
  return Array.isArray(cell) ? toFiniteNumber(cell[index]) : null;
}

const AUTO_WINDOW_DAYS = 3;

/** Clock-based fallback window, used only if dataset coverage cannot be probed. */
export function getAutoExplorationRange(now: Date = new Date()): { startUtc: string; stopUtc: string } {
  const stop = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start = new Date(stop.getTime() - AUTO_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { startUtc: start.toISOString(), stopUtc: stop.toISOString() };
}

/** Window anchored to the actual ACE + OMNI coverage, falling back to a clock window. */
async function resolveAutoExplorationRange(): Promise<{ startUtc: string; stopUtc: string }> {
  return (await resolveCoverageAnchoredRange(AUTO_WINDOW_DAYS)) ?? getAutoExplorationRange();
}

function selectValues(samples: VariableSamples[], variableId: ExplorationVariableId): number[] {
  return samples
    .map(sample => sample[variableId])
    .filter((value): value is number => value !== null);
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

function buildDistribution(
  variable: (typeof VARIABLES)[number],
  location: ExplorationLocation,
  values: number[],
): ExplorationDistribution {
  const count = values.length;
  if (count === 0) {
    return {
      variableId: variable.id,
      label: variable.label,
      unit: variable.unit,
      location,
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      std: null,
      p05: null,
      p95: null,
      histogram: [],
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  const histogram: ExplorationHistogramBin[] = [];
  const span = max - min;
  if (span > 0) {
    const binWidth = span / HISTOGRAM_BINS;
    const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
    for (const value of values) {
      const index = Math.min(HISTOGRAM_BINS - 1, Math.floor((value - min) / binWidth));
      counts[index] += 1;
    }
    for (let index = 0; index < HISTOGRAM_BINS; index += 1) {
      histogram.push({ binStart: min + index * binWidth, binEnd: min + (index + 1) * binWidth, count: counts[index] });
    }
  } else {
    histogram.push({ binStart: min, binEnd: max, count });
  }

  return {
    variableId: variable.id,
    label: variable.label,
    unit: variable.unit,
    location,
    count,
    min,
    max,
    mean,
    median: quantile(sorted, 0.5),
    std: Math.sqrt(variance),
    p05: quantile(sorted, 0.05),
    p95: quantile(sorted, 0.95),
    histogram,
  };
}

/** Resample a sparse sample series onto a uniform grid by nearest value within one step. */
function toGrid(samples: VariableSamples[], variableId: ExplorationVariableId, startMs: number, gridLength: number): Array<number | null> {
  const grid = new Array<number | null>(gridLength).fill(null);
  for (const sample of samples) {
    const value = sample[variableId];
    if (value === null) {
      continue;
    }
    const index = Math.round((sample.ms - startMs) / GRID_STEP_MS);
    if (index >= 0 && index < gridLength) {
      grid[index] = value; // last write wins; samples are ~grid cadence
    }
  }
  return grid;
}

function correlationAtLag(l1Grid: Array<number | null>, earthGrid: Array<number | null>, lagSteps: number): { correlation: number; count: number } {
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let count = 0;

  for (let i = 0; i < l1Grid.length; i += 1) {
    const j = i + lagSteps;
    if (j < 0 || j >= earthGrid.length) {
      continue;
    }
    const x = l1Grid[i];
    const y = earthGrid[j];
    if (x === null || y === null) {
      continue;
    }
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
    count += 1;
  }

  if (count < MIN_PAIRS_FOR_CORRELATION) {
    return { correlation: 0, count };
  }

  const covariance = sumXY / count - (sumX / count) * (sumY / count);
  const varX = sumXX / count - (sumX / count) ** 2;
  const varY = sumYY / count - (sumY / count) ** 2;
  const denominator = Math.sqrt(varX * varY);

  return { correlation: denominator > 0 ? covariance / denominator : 0, count };
}

function buildCoupling(
  variable: (typeof VARIABLES)[number],
  l1Grid: Array<number | null>,
  earthGrid: Array<number | null>,
  mruExpectedLagMinutes: number | null,
): ExplorationCoupling {
  const ccf: ExplorationCcfPoint[] = [];
  let optimalLagMinutes: number | null = null;
  let peakCorrelation: number | null = null;
  let maxCount = 0;

  for (let lag = CCF_MIN_LAG_MIN; lag <= CCF_MAX_LAG_MIN; lag += CCF_LAG_STEP_MIN) {
    const { correlation, count } = correlationAtLag(l1Grid, earthGrid, lag);
    maxCount = Math.max(maxCount, count);
    ccf.push({ lagMinutes: lag, correlation });
    if (peakCorrelation === null || correlation > peakCorrelation) {
      peakCorrelation = correlation;
      optimalLagMinutes = lag;
    }
  }

  return {
    variableId: variable.id,
    label: variable.label,
    unit: variable.unit,
    count: maxCount,
    ccf,
    optimalLagMinutes: maxCount >= MIN_PAIRS_FOR_CORRELATION ? optimalLagMinutes : null,
    peakCorrelation: maxCount >= MIN_PAIRS_FOR_CORRELATION ? peakCorrelation : null,
    mruExpectedLagMinutes,
    note: variable.id === 'bz' ? BZ_FRAME_NOTE : undefined,
  };
}

export async function buildExplorationSnapshot(range?: {
  startUtc?: string;
  stopUtc?: string;
}): Promise<ExplorationSnapshot> {
  const generatedAtUtc = new Date().toISOString();
  const warnings: string[] = [];
  const autoSelected = !range?.startUtc && !range?.stopUtc;
  const autoRange = autoSelected ? await resolveAutoExplorationRange() : getAutoExplorationRange();
  const resolvedRange = {
    startUtc: range?.startUtc || autoRange.startUtc,
    stopUtc: range?.stopUtc || autoRange.stopUtc,
  };

  const base: ExplorationSnapshot = {
    generatedAtUtc,
    range: resolvedRange,
    autoSelected,
    l1Source: 'ACE key parameters (CDAWeb HAPI)',
    earthSource: 'OMNI HRO 1-min (CDAWeb HAPI)',
    meanSpeedKmS: null,
    sampleCount: { l1: 0, earth: 0, gridMinutes: 0 },
    distributions: [],
    coupling: [],
    warnings,
  };

  const startMs = parseTimeMs(resolvedRange.startUtc);
  const stopMs = parseTimeMs(resolvedRange.stopUtc);
  if (startMs === null || stopMs === null || stopMs <= startMs) {
    warnings.push('Invalid time range.');
    return base;
  }

  const [plasmaResult, magResult, omniResult] = await Promise.all([
    fetchHapiSeries('AC_K0_SWE', ['Np', 'Vp', 'Tpr'], resolvedRange),
    fetchHapiSeries('AC_K0_MFI', ['Magnitude', 'BGSEc'], resolvedRange),
    fetchHapiSeries('OMNI_HRO_1MIN', ['F', 'BZ_GSM', 'flow_speed', 'proton_density'], resolvedRange),
  ]);
  warnings.push(...plasmaResult.warnings, ...magResult.warnings, ...omniResult.warnings);

  // L1 (ACE): merge plasma + magnetometer by minute.
  const l1ByMinute = new Map<number, VariableSamples>();
  const minuteKey = (ms: number) => Math.round(ms / GRID_STEP_MS) * GRID_STEP_MS;

  for (const row of plasmaResult.rows) {
    const ms = parseTimeMs(row[0]);
    if (ms === null) continue;
    const key = minuteKey(ms);
    const entry = l1ByMinute.get(key) ?? { ms: key, speed: null, density: null, bt: null, bz: null };
    entry.density = sanitize(toFiniteNumber(row[1]), 'density');
    entry.speed = sanitize(toFiniteNumber(row[2]), 'speed');
    l1ByMinute.set(key, entry);
  }
  for (const row of magResult.rows) {
    const ms = parseTimeMs(row[0]);
    if (ms === null) continue;
    const key = minuteKey(ms);
    const entry = l1ByMinute.get(key) ?? { ms: key, speed: null, density: null, bt: null, bz: null };
    entry.bt = sanitize(toFiniteNumber(row[1]), 'bt');
    entry.bz = sanitize(readVectorComponent(row[2], 2), 'bz');
    l1ByMinute.set(key, entry);
  }
  const l1Samples = [...l1ByMinute.values()].sort((a, b) => a.ms - b.ms);

  const earthSamples: VariableSamples[] = omniResult.rows
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
    .filter((entry): entry is VariableSamples => entry !== null)
    .sort((a, b) => a.ms - b.ms);

  if (l1Samples.length === 0 && earthSamples.length === 0) {
    warnings.push('No ACE or OMNI samples returned for this window.');
    return base;
  }

  const meanSpeed = (() => {
    const speeds = selectValues(l1Samples, 'speed');
    return speeds.length > 0 ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : null;
  })();
  const mruExpectedLagMinutes = meanSpeed && meanSpeed > 0 ? NOMINAL_L1_DISTANCE_KM / meanSpeed / 60 : null;

  // Distributions: L1 (ACE) and Earth (OMNI) per variable.
  const distributions: ExplorationDistribution[] = [];
  for (const variable of VARIABLES) {
    distributions.push(buildDistribution(variable, 'L1', selectValues(l1Samples, variable.id)));
    distributions.push(buildDistribution(variable, 'Earth', selectValues(earthSamples, variable.id)));
  }

  // Coupling: cross-correlation on a shared 1-minute grid.
  const gridLength = Math.min(20_000, Math.floor((stopMs - startMs) / GRID_STEP_MS) + 1);
  const coupling: ExplorationCoupling[] = VARIABLES.map(variable => {
    const l1Grid = toGrid(l1Samples, variable.id, startMs, gridLength);
    const earthGrid = toGrid(earthSamples, variable.id, startMs, gridLength);
    return buildCoupling(variable, l1Grid, earthGrid, mruExpectedLagMinutes);
  });

  return {
    ...base,
    meanSpeedKmS: meanSpeed,
    sampleCount: { l1: l1Samples.length, earth: earthSamples.length, gridMinutes: gridLength },
    distributions,
    coupling,
    warnings,
  };
}
