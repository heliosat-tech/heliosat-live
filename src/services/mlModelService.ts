/**
 * A small, self-contained ML model that learns a correction over the MRU
 * baseline for L1 -> Earth propagation. Pure TypeScript (no Python, no native
 * deps), trained once offline and saved as a JSON artifact, then served
 * automatically.
 *
 * For each target variable at Earth (speed, density, |B|, Bz) we fit a
 * standardized ridge regression whose features are the L1 value of that
 * variable at several candidate lags. This lets the model learn the best
 * effective travel time and a scale/offset correction that pure ballistic
 * propagation cannot. The MRU baseline is always the yardstick it is scored
 * against (skill score).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { writeJsonFileBestEffort } from '@/lib/fsCache';
import { resolveCoverageAnchoredRange } from './dataCoverageService';
import { fetchAceOmniSamples, type L1EarthSample, type SolarWindVariableId } from './l1EarthData';
import { NOMINAL_L1_DISTANCE_KM } from './mruForecastService';

const MODEL_DIR = path.join(process.cwd(), 'data', 'ml-model');
const MODEL_PATH = path.join(MODEL_DIR, 'model.json');

const GRID_STEP_MS = 60_000;
const LAGS_MIN = [35, 45, 55, 65, 75, 85];
const RIDGE_LAMBDA = 1.0;
const TEST_FRACTION = 0.2;
const MIN_TRAIN_SAMPLES = 120;

export const ML_VARIABLE_IDS: SolarWindVariableId[] = ['speed', 'density', 'bt', 'bz'];
export const ML_VARIABLE_META: Record<SolarWindVariableId, { label: string; unit: string }> = {
  speed: { label: 'Solar-wind speed', unit: 'km/s' },
  density: { label: 'Proton density', unit: 'n/cc' },
  bt: { label: 'Field magnitude |B|', unit: 'nT' },
  bz: { label: 'Bz (north-south field)', unit: 'nT' },
};

export interface MlVariableModel {
  variableId: SolarWindVariableId;
  featureMeans: number[];
  featureStds: number[];
  weights: number[];
  yMean: number;
}

export interface MlVariableScore {
  variableId: SolarWindVariableId;
  label: string;
  unit: string;
  count: number;
  mlR2: number | null;
  mlRmse: number | null;
  mlMae: number | null;
  mruR2: number | null;
  mruRmse: number | null;
  skillPct: number | null;
}

export interface MlModelArtifact {
  version: string;
  trainedAtUtc: string;
  trainWindow: { startUtc: string; stopUtc: string };
  lagsMin: number[];
  lambda: number;
  distanceKm: number;
  meanLagMinutes: number | null;
  sampleCount: { train: number; test: number };
  models: Partial<Record<SolarWindVariableId, MlVariableModel>>;
  scores: MlVariableScore[];
  overallR2: number | null;
  overallSkillPct: number | null;
  /** Provenance (set by the definitive multi-year training). */
  source?: string;
  trainingMode?: 'recent' | 'definitive';
  windowsRequested?: number;
  windowsUsed?: number;
}

// ---------------------------------------------------------------- linear algebra

/** Solve A x = b for a small symmetric positive-definite system (Gaussian elimination, partial pivot). */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      return null;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) {
        m[row][k] -= factor * m[col][k];
      }
    }
  }

  return m.map((row, i) => row[n] / row[i]);
}

export function ridgeFit(features: number[][], targets: number[], lambda: number) {
  const n = features.length;
  const k = features[0].length;

  const means = new Array<number>(k).fill(0);
  for (const row of features) {
    for (let j = 0; j < k; j += 1) means[j] += row[j];
  }
  for (let j = 0; j < k; j += 1) means[j] /= n;

  const stds = new Array<number>(k).fill(0);
  for (const row of features) {
    for (let j = 0; j < k; j += 1) stds[j] += (row[j] - means[j]) ** 2;
  }
  for (let j = 0; j < k; j += 1) stds[j] = Math.sqrt(stds[j] / n) || 1;

  const yMean = targets.reduce((sum, value) => sum + value, 0) / n;

  // Standardized design matrix and centered target.
  const z = features.map(row => row.map((value, j) => (value - means[j]) / stds[j]));
  const yc = targets.map(value => value - yMean);

  const ata = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const aty = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let a = 0; a < k; a += 1) {
      aty[a] += z[i][a] * yc[i];
      for (let b = a; b < k; b += 1) {
        ata[a][b] += z[i][a] * z[i][b];
      }
    }
  }
  for (let a = 0; a < k; a += 1) {
    ata[a][a] += lambda;
    for (let b = a + 1; b < k; b += 1) ata[b][a] = ata[a][b];
  }

  const weights = solveLinearSystem(ata, aty);
  if (!weights) {
    return null;
  }
  return { featureMeans: means, featureStds: stds, weights, yMean };
}

function predictStandardized(model: MlVariableModel, rawFeatures: number[]): number {
  let value = model.yMean;
  for (let j = 0; j < model.weights.length; j += 1) {
    value += model.weights[j] * ((rawFeatures[j] - model.featureMeans[j]) / model.featureStds[j]);
  }
  return value;
}

// ---------------------------------------------------------------- gridding & scoring

function buildMinuteMaps(samples: L1EarthSample[]): Record<SolarWindVariableId, Map<number, number>> {
  const maps = {
    speed: new Map<number, number>(),
    density: new Map<number, number>(),
    bt: new Map<number, number>(),
    bz: new Map<number, number>(),
  };
  for (const sample of samples) {
    const minute = Math.round(sample.ms / GRID_STEP_MS);
    for (const variableId of ML_VARIABLE_IDS) {
      const value = sample[variableId];
      if (value !== null) {
        maps[variableId].set(minute, value);
      }
    }
  }
  return maps;
}

export function r2(predicted: number[], truth: number[]): number | null {
  const n = truth.length;
  if (n < 2) return null;
  const mean = truth.reduce((sum, value) => sum + value, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (truth[i] - predicted[i]) ** 2;
    ssTot += (truth[i] - mean) ** 2;
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : null;
}

export function rmse(predicted: number[], truth: number[]): number | null {
  const n = truth.length;
  if (n === 0) return null;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += (predicted[i] - truth[i]) ** 2;
  return Math.sqrt(sum / n);
}

function mae(predicted: number[], truth: number[]): number | null {
  const n = truth.length;
  if (n === 0) return null;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.abs(predicted[i] - truth[i]);
  return sum / n;
}

// ---------------------------------------------------------------- training

interface VariableSampleRow {
  minute: number;
  features: number[];
  target: number;
  mru: number | null;
}

export function trainMlArtifact(
  samples: { l1: L1EarthSample[]; earth: L1EarthSample[] },
  trainWindow: { startUtc: string; stopUtc: string },
): MlModelArtifact {
  const l1Maps = buildMinuteMaps(samples.l1);
  const earthMaps = buildMinuteMaps(samples.earth);

  const speeds = samples.l1.map(sample => sample.speed).filter((value): value is number => value !== null);
  const meanSpeed = speeds.length > 0 ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : null;
  const meanLagMinutes = meanSpeed && meanSpeed > 0 ? NOMINAL_L1_DISTANCE_KM / meanSpeed / 60 : null;
  const meanLagSteps = meanLagMinutes !== null ? Math.round(meanLagMinutes) : null;

  const models: Partial<Record<SolarWindVariableId, MlVariableModel>> = {};
  const scores: MlVariableScore[] = [];
  let totalTrain = 0;
  let totalTest = 0;

  for (const variableId of ML_VARIABLE_IDS) {
    const meta = ML_VARIABLE_META[variableId];
    const targetMap = earthMaps[variableId];
    const featureMap = l1Maps[variableId];

    const rows: VariableSampleRow[] = [];
    for (const [minute, target] of targetMap) {
      const features = LAGS_MIN.map(lag => featureMap.get(minute - lag));
      if (features.some(value => value === undefined)) {
        continue;
      }
      rows.push({
        minute,
        features: features as number[],
        target,
        mru: meanLagSteps !== null ? featureMap.get(minute - meanLagSteps) ?? null : null,
      });
    }
    rows.sort((a, b) => a.minute - b.minute);

    const splitIndex = Math.floor(rows.length * (1 - TEST_FRACTION));
    const trainRows = rows.slice(0, splitIndex);
    const testRows = rows.slice(splitIndex);

    if (trainRows.length < MIN_TRAIN_SAMPLES || testRows.length < 10) {
      scores.push({ variableId, label: meta.label, unit: meta.unit, count: testRows.length, mlR2: null, mlRmse: null, mlMae: null, mruR2: null, mruRmse: null, skillPct: null });
      continue;
    }

    const fit = ridgeFit(trainRows.map(row => row.features), trainRows.map(row => row.target), RIDGE_LAMBDA);
    if (!fit) {
      scores.push({ variableId, label: meta.label, unit: meta.unit, count: 0, mlR2: null, mlRmse: null, mlMae: null, mruR2: null, mruRmse: null, skillPct: null });
      continue;
    }
    const model: MlVariableModel = { variableId, ...fit };
    models[variableId] = model;
    totalTrain += trainRows.length;
    totalTest += testRows.length;

    // Evaluate on the held-out test split.
    const mlPred: number[] = [];
    const mlTruth: number[] = [];
    const mruPred: number[] = [];
    const mruTruth: number[] = [];
    for (const row of testRows) {
      mlPred.push(predictStandardized(model, row.features));
      mlTruth.push(row.target);
      if (row.mru !== null) {
        mruPred.push(row.mru);
        mruTruth.push(row.target);
      }
    }

    const mlRmse = rmse(mlPred, mlTruth);
    const mruRmse = rmse(mruPred, mruTruth);
    scores.push({
      variableId,
      label: meta.label,
      unit: meta.unit,
      count: testRows.length,
      mlR2: r2(mlPred, mlTruth),
      mlRmse,
      mlMae: mae(mlPred, mlTruth),
      mruR2: r2(mruPred, mruTruth),
      mruRmse,
      skillPct: mlRmse !== null && mruRmse !== null && mruRmse > 0 ? (1 - mlRmse / mruRmse) * 100 : null,
    });
  }

  const scoredR2 = scores.map(score => score.mlR2).filter((value): value is number => value !== null);
  const scoredSkill = scores.map(score => score.skillPct).filter((value): value is number => value !== null);

  return {
    version: 'mru-correction-ridge-v1',
    trainedAtUtc: new Date().toISOString(),
    trainWindow,
    lagsMin: LAGS_MIN,
    lambda: RIDGE_LAMBDA,
    distanceKm: NOMINAL_L1_DISTANCE_KM,
    meanLagMinutes,
    sampleCount: { train: totalTrain, test: totalTest },
    models,
    scores,
    overallR2: scoredR2.length > 0 ? scoredR2.reduce((sum, value) => sum + value, 0) / scoredR2.length : null,
    overallSkillPct: scoredSkill.length > 0 ? scoredSkill.reduce((sum, value) => sum + value, 0) / scoredSkill.length : null,
  };
}

// ---------------------------------------------------------------- inference (serving)

/**
 * Predict the Earth value of `variableId` at each requested time, from L1
 * samples, using a trained artifact. Returns null where features are missing.
 */
export function predictAtTimes(
  artifact: MlModelArtifact,
  l1Samples: L1EarthSample[],
  variableId: SolarWindVariableId,
  targetTimesMs: number[],
  options?: { imputeMissing?: boolean; anchorToInput?: boolean },
): (number | null)[] {
  const model = artifact.models[variableId];
  if (!model) {
    return targetTimesMs.map(() => null);
  }
  const featureMap = buildMinuteMaps(l1Samples)[variableId];

  // For the live forecast we let the model reach the same horizon as the ballistic
  // MRU baseline: its shortest lags need L1 data closer to arrival than the full
  // transit time, which isn't measured yet for the furthest-future points. With
  // imputeMissing we carry the nearest available L1 reading forward (persistence)
  // for those few minutes. OFF by default so training/validation metrics stay honest.
  const sortedMinutes = options?.imputeMissing ? [...featureMap.keys()].sort((a, b) => a - b) : [];
  const nearestValue = (minute: number): number | undefined => {
    if (sortedMinutes.length === 0) return undefined;
    // Largest available minute <= target (carry forward); else the earliest.
    let lo = 0;
    let hi = sortedMinutes.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedMinutes[mid] <= minute) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const key = best >= 0 ? sortedMinutes[best] : sortedMinutes[0];
    return featureMap.get(key);
  };

  return targetTimesMs.map(ms => {
    const minute = Math.round(ms / GRID_STEP_MS);
    const features = artifact.lagsMin.map(lag => {
      const value = featureMap.get(minute - lag);
      if (value !== undefined) return value;
      return options?.imputeMissing ? nearestValue(minute - lag) : undefined;
    });
    if (features.some(value => value === undefined)) {
      return null;
    }
    const resolved = features as number[];
    const raw = predictStandardized(model, resolved);

    // anchorToInput re-bases the prediction from the training TARGET mean (yMean,
    // OMNI scale) onto the training INPUT mean (the L1 scale). The model is trained
    // on ACE L1 -> OMNI; for proton density ACE K0 reads ~2.5 n/cc low vs OMNI, so
    // yMean bakes a constant ACE->OMNI offset into every prediction that is wrong on
    // the DSCOVR live feed. Replacing the yMean intercept with the (constant) input
    // feature mean removes that source-calibration offset while preserving the
    // feature-driven dynamics — it must NOT use the per-sample live features (that
    // would double-count the input level).
    if (options?.anchorToInput) {
      const inputAnchor = model.featureMeans.reduce((sum, value) => sum + value, 0) / model.featureMeans.length;
      return raw - model.yMean + inputAnchor;
    }
    return raw;
  });
}

// ---------------------------------------------------------------- persistence

export async function saveMlModel(artifact: MlModelArtifact): Promise<void> {
  await writeJsonFileBestEffort(MODEL_PATH, artifact, { pretty: true });
}

export async function loadMlModel(): Promise<MlModelArtifact | null> {
  try {
    const raw = await fs.readFile(MODEL_PATH, 'utf8');
    return JSON.parse(raw) as MlModelArtifact;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- orchestration

const TRAIN_WINDOW_DAYS = 14;

export interface MlTrainingResult {
  artifact: MlModelArtifact | null;
  warnings: string[];
  error: string | null;
}

/**
 * End-to-end training: pick a coverage-anchored window, fetch ACE + OMNI, fit
 * the model, and persist the artifact. This is the single entry point used by
 * both the admin "Train" button and any scheduled job.
 */
export async function runMlTraining(days = TRAIN_WINDOW_DAYS): Promise<MlTrainingResult> {
  const range = await resolveCoverageAnchoredRange(days);
  if (!range) {
    return { artifact: null, warnings: [], error: 'Could not resolve a data window (HAPI coverage probe failed).' };
  }

  const { l1, earth, warnings } = await fetchAceOmniSamples(range);
  if (l1.length === 0 || earth.length === 0) {
    return { artifact: null, warnings, error: 'No ACE/OMNI data available for the training window.' };
  }

  const artifact = trainMlArtifact({ l1, earth }, range);
  await saveMlModel(artifact);
  return { artifact, warnings, error: null };
}

// ---------------------------------------------------------- definitive training

const HAPI_INFO = 'https://cdaweb.gsfc.nasa.gov/hapi/info';
// ACE Level-2 science archive (deep history, GSM Bz, calibrated density) + OMNI.
const SCIENCE_DATASETS = ['AC_H0_SWE', 'AC_H0_MFI', 'OMNI_HRO_1MIN'];
const DEFINITIVE_WINDOW_DAYS = 28;
const DEFINITIVE_TARGET_WINDOWS = 20;
const DEFINITIVE_FETCH_CONCURRENCY = 4;

async function datasetSpanMs(id: string): Promise<{ start: number; stop: number } | null> {
  try {
    const response = await fetch(`${HAPI_INFO}?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const info = (await response.json()) as { startDate?: string; stopDate?: string };
    const start = info.startDate ? new Date(info.startDate).getTime() : Number.NaN;
    const stop = info.stopDate ? new Date(info.stopDate).getTime() : Number.NaN;
    if (Number.isNaN(start) || Number.isNaN(stop)) return null;
    return { start, stop };
  } catch {
    return null;
  }
}

/** Run an async fn over items with bounded concurrency. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await fn(items[current]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Definitive training: the best model we can build, trained ONCE on the maximum
 * available history. It samples ~28-day windows spread across the full ACE
 * science coverage (1998 → ~2024) so the model sees the whole solar cycle (quiet
 * and storm, slow and fast wind), then fits and persists the artifact.
 *
 * Gaps are handled for free: lag-feature rows are only built where all features +
 * the target exist within a window, and the windows are years apart so nothing
 * spuriously joins across them — the usable data simply combines into one set.
 */
export async function runDefinitiveTraining(): Promise<MlTrainingResult> {
  const spans = (await Promise.all(SCIENCE_DATASETS.map(datasetSpanMs))).filter(
    (s): s is { start: number; stop: number } => s !== null,
  );
  if (spans.length < SCIENCE_DATASETS.length) {
    return { artifact: null, warnings: [], error: 'Could not resolve the ACE/OMNI science coverage (HAPI /info probe failed).' };
  }

  const coverageStart = Math.max(...spans.map(s => s.start));
  const coverageStop = Math.min(...spans.map(s => s.stop));
  const windowMs = DEFINITIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const totalMs = coverageStop - coverageStart;
  const count = Math.max(1, Math.min(DEFINITIVE_TARGET_WINDOWS, Math.floor(totalMs / windowMs)));
  const step = count > 1 ? (totalMs - windowMs) / (count - 1) : 0;

  const windows = Array.from({ length: count }, (_, i) => {
    const ws = coverageStart + Math.round(i * step);
    const we = Math.min(ws + windowMs, coverageStop);
    return { startUtc: new Date(ws).toISOString(), stopUtc: new Date(we).toISOString() };
  });

  const warnings: string[] = [];
  const allL1: L1EarthSample[] = [];
  const allEarth: L1EarthSample[] = [];
  let windowsUsed = 0;

  await mapLimit(windows, DEFINITIVE_FETCH_CONCURRENCY, async window => {
    try {
      const { l1, earth, warnings: ww } = await fetchAceOmniSamples(window, { source: 'science' });
      if (l1.length > 0 && earth.length > 0) windowsUsed += 1;
      allL1.push(...l1);
      allEarth.push(...earth);
      if (ww.length > 0) warnings.push(`${window.startUtc.slice(0, 10)}: ${ww[0]}`);
    } catch (error) {
      warnings.push(`${window.startUtc.slice(0, 10)}: fetch failed (${error instanceof Error ? error.message : 'unknown'})`);
    }
  });

  allL1.sort((a, b) => a.ms - b.ms);
  allEarth.sort((a, b) => a.ms - b.ms);

  if (allL1.length < MIN_TRAIN_SAMPLES || allEarth.length < MIN_TRAIN_SAMPLES) {
    return { artifact: null, warnings, error: 'Not enough science data could be fetched to train a definitive model.' };
  }

  const base = trainMlArtifact(
    { l1: allL1, earth: allEarth },
    { startUtc: new Date(coverageStart).toISOString(), stopUtc: new Date(coverageStop).toISOString() },
  );
  const artifact: MlModelArtifact = {
    ...base,
    source: 'ACE science (Level-2) → OMNI · Bz in GSM',
    trainingMode: 'definitive',
    windowsRequested: windows.length,
    windowsUsed,
  };
  await saveMlModel(artifact);
  return { artifact, warnings, error: null };
}
