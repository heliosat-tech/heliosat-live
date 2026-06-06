/**
 * GEO orbit-impact model (the wired reference of the per-orbit framework, see
 * orbitModels.ts). Predicts the magnetic field |B| measured AT a geostationary
 * satellite (GOES), where the satellite's POSITION is a first-class driver: at
 * GEO the field is compressed/strong on the day side and stretched/weak at night,
 * so it follows a strong diurnal cycle as the satellite sweeps through local time.
 *
 * We quantify the value of the position variable with an ablation: train the same
 * ridge model on ~1 year of data WITHOUT the satellite local-time features and
 * WITH them, and compare. Inputs:
 *   - L1 solar wind (ACE) at several propagation lags (speed, density, Bz)
 *   - satellite local time (sin/cos), from UT + the GOES longitude
 *   - target: GOES |B| from the NCEI archive (pre-extracted to JSON)
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fetchAceOmniSamples } from './l1EarthData';
import { r2, ridgeFit, rmse } from './mlModelService';

const GRID_STEP_MS = 60_000;
const FEATURE_LAGS_MIN = [45, 55, 65];
const RIDGE_LAMBDA = 1.0;
const TEST_FRACTION = 0.2;
const GOES_DIR = path.join(process.cwd(), 'data', 'ml-model', 'goes');
const RESULT_PATH = path.join(process.cwd(), 'data', 'ml-model', 'goes-geo-result.json');

/** Operating longitude (deg) of each GOES-R satellite, for the local-time calc. */
const GOES_LONGITUDE_DEG: Record<string, number> = {
  'GOES-16': -75.2,
  'GOES-18': -137.2,
  'GOES-19': -75.2,
};

export interface GoesImpactModelScore {
  r2: number | null;
  rmse: number | null;
}

export interface GoesImpactResult {
  spacecraft: string;
  window: { startUtc: string; stopUtc: string };
  dataMonths: number;
  longitudeDeg: number;
  featureLagsMin: number[];
  unit: string;
  sampleCount: { goes: number; matched: number; train: number; test: number };
  withoutPosition: GoesImpactModelScore;
  withPosition: GoesImpactModelScore;
  positionGainR2: number | null;
  positionSkillPct: number | null;
  generatedAtUtc: string;
  warnings: string[];
}

/** Read and merge every extracted GOES |B| month for a spacecraft. */
async function loadAllGoesMonths(spacecraft: string): Promise<{ byMinute: Map<number, number>; months: number; startMs: number; stopMs: number }> {
  const byMinute = new Map<number, number>();
  let months = 0;
  let startMs = Number.POSITIVE_INFINITY;
  let stopMs = Number.NEGATIVE_INFINITY;

  let files: string[] = [];
  try {
    files = (await fs.readdir(GOES_DIR)).filter(name => name.startsWith(`${spacecraft}-`) && name.endsWith('.json'));
  } catch {
    return { byMinute, months: 0, startMs: 0, stopMs: 0 };
  }

  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(GOES_DIR, file), 'utf8');
      const points = JSON.parse(raw) as [number, number][];
      let used = false;
      for (const [ms, value] of points) {
        if (Number.isFinite(ms) && Number.isFinite(value) && value > 0 && value < 1000) {
          byMinute.set(Math.round(ms / GRID_STEP_MS), value);
          if (ms < startMs) startMs = ms;
          if (ms > stopMs) stopMs = ms;
          used = true;
        }
      }
      if (used) months += 1;
    } catch {
      /* skip unreadable month */
    }
  }

  return { byMinute, months, startMs: Number.isFinite(startMs) ? startMs : 0, stopMs: Number.isFinite(stopMs) ? stopMs : 0 };
}

/** Local solar time (hours, 0-24) of a satellite at a given UT and longitude. */
function localTimeHours(ms: number, longitudeDeg: number): number {
  const utHours = (ms / 3_600_000) % 24;
  return (((utHours + longitudeDeg / 15) % 24) + 24) % 24;
}

function evaluate(rows: { features: number[]; target: number }[]): GoesImpactModelScore & { count: number } {
  const splitIndex = Math.floor(rows.length * (1 - TEST_FRACTION));
  const trainRows = rows.slice(0, splitIndex);
  const testRows = rows.slice(splitIndex);

  if (trainRows.length < 200 || testRows.length < 50) {
    return { r2: null, rmse: null, count: testRows.length };
  }

  const fit = ridgeFit(trainRows.map(row => row.features), trainRows.map(row => row.target), RIDGE_LAMBDA);
  if (!fit) {
    return { r2: null, rmse: null, count: testRows.length };
  }

  const predicted = testRows.map(row => {
    let value = fit.yMean;
    for (let j = 0; j < fit.weights.length; j += 1) {
      value += fit.weights[j] * ((row.features[j] - fit.featureMeans[j]) / fit.featureStds[j]);
    }
    return value;
  });
  const truth = testRows.map(row => row.target);

  return { r2: r2(predicted, truth), rmse: rmse(predicted, truth), count: testRows.length };
}

export async function runGoesImpactAnalysis(options?: { spacecraft?: string }): Promise<GoesImpactResult> {
  const spacecraft = options?.spacecraft ?? 'GOES-16';
  const longitudeDeg = GOES_LONGITUDE_DEG[spacecraft] ?? -75.2;
  const generatedAtUtc = new Date().toISOString();
  const warnings: string[] = [];

  const goes = await loadAllGoesMonths(spacecraft);
  const window = {
    startUtc: goes.startMs ? new Date(goes.startMs).toISOString() : '',
    stopUtc: goes.stopMs ? new Date(goes.stopMs).toISOString() : '',
  };

  const empty: GoesImpactResult = {
    spacecraft,
    window,
    dataMonths: goes.months,
    longitudeDeg,
    featureLagsMin: FEATURE_LAGS_MIN,
    unit: 'nT',
    sampleCount: { goes: goes.byMinute.size, matched: 0, train: 0, test: 0 },
    withoutPosition: { r2: null, rmse: null },
    withPosition: { r2: null, rmse: null },
    positionGainR2: null,
    positionSkillPct: null,
    generatedAtUtc,
    warnings,
  };

  if (goes.byMinute.size === 0) {
    warnings.push('No extracted GOES |B| data found.');
    return empty;
  }

  // L1 (ACE) over the full data span.
  const { l1, warnings: l1Warnings } = await fetchAceOmniSamples(window);
  warnings.push(...l1Warnings);
  const speedByMinute = new Map<number, number>();
  const densityByMinute = new Map<number, number>();
  const bzByMinute = new Map<number, number>();
  for (const sample of l1) {
    const minute = Math.round(sample.ms / GRID_STEP_MS);
    if (sample.speed !== null) speedByMinute.set(minute, sample.speed);
    if (sample.density !== null) densityByMinute.set(minute, sample.density);
    if (sample.bz !== null) bzByMinute.set(minute, sample.bz);
  }

  // Build aligned rows: GOES |B|(t) vs L1(t - lag) at several lags + local time(t).
  const baseRows: { minute: number; l1Features: number[]; positionFeatures: number[]; target: number }[] = [];
  for (const [minute, target] of goes.byMinute) {
    const l1Features: number[] = [];
    let complete = true;
    for (const lag of FEATURE_LAGS_MIN) {
      const speed = speedByMinute.get(minute - lag);
      const density = densityByMinute.get(minute - lag);
      const bz = bzByMinute.get(minute - lag);
      if (speed === undefined || density === undefined || bz === undefined) {
        complete = false;
        break;
      }
      l1Features.push(speed, density, bz);
    }
    if (!complete) {
      continue;
    }
    const angle = (2 * Math.PI * localTimeHours(minute * GRID_STEP_MS, longitudeDeg)) / 24;
    baseRows.push({ minute, l1Features, positionFeatures: [Math.sin(angle), Math.cos(angle)], target });
  }
  baseRows.sort((a, b) => a.minute - b.minute);

  if (baseRows.length < 500) {
    warnings.push('Not enough overlapping GOES + ACE samples to train.');
    return { ...empty, sampleCount: { goes: goes.byMinute.size, matched: baseRows.length, train: 0, test: 0 } };
  }

  const withoutPosition = evaluate(baseRows.map(row => ({ features: row.l1Features, target: row.target })));
  const withPosition = evaluate(baseRows.map(row => ({ features: [...row.l1Features, ...row.positionFeatures], target: row.target })));

  const positionGainR2 =
    withPosition.r2 !== null && withoutPosition.r2 !== null ? withPosition.r2 - withoutPosition.r2 : null;
  const positionSkillPct =
    withPosition.rmse !== null && withoutPosition.rmse !== null && withoutPosition.rmse > 0
      ? (1 - withPosition.rmse / withoutPosition.rmse) * 100
      : null;

  const result: GoesImpactResult = {
    spacecraft,
    window,
    dataMonths: goes.months,
    longitudeDeg,
    featureLagsMin: FEATURE_LAGS_MIN,
    unit: 'nT',
    sampleCount: {
      goes: goes.byMinute.size,
      matched: baseRows.length,
      train: Math.floor(baseRows.length * (1 - TEST_FRACTION)),
      test: withPosition.count,
    },
    withoutPosition: { r2: withoutPosition.r2, rmse: withoutPosition.rmse },
    withPosition: { r2: withPosition.r2, rmse: withPosition.rmse },
    positionGainR2,
    positionSkillPct,
    generatedAtUtc,
    warnings,
  };

  await saveGoesImpactResult(result);
  return result;
}

export async function saveGoesImpactResult(result: GoesImpactResult): Promise<void> {
  await fs.mkdir(path.dirname(RESULT_PATH), { recursive: true });
  await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
}

export async function loadGoesImpactResult(): Promise<GoesImpactResult | null> {
  try {
    return JSON.parse(await fs.readFile(RESULT_PATH, 'utf8')) as GoesImpactResult;
  } catch {
    return null;
  }
}
