/**
 * Live ML arrival-residual correction (Node side).
 *
 * The model is the offline-validated Python scikit-learn HistGradientBoostingRegressor
 * (held-out MAE 10.39 vs MRU 12.13). It cannot load in Node, so we shell out to a small
 * Python predict entrypoint that builds the 20 features with the EXACT training code and
 * returns the residual `OMNI - MRU` (minutes) per sample.
 *
 * This is a best-effort enhancement, never a dependency: the subprocess is bounded by a
 * hard timeout and any failure (spawn error, timeout, bad output, Python missing) resolves
 * to an empty result so the caller falls back to raw MRU. The forecast is never blocked.
 */

import { spawn } from 'node:child_process';
import { BSN_X_RE } from './mruForecastService';

/** One trailing-history sample, in the SAME units/frames as training. */
export interface MlInputSample {
  time: string; // ISO 8601 UTC
  speed_km_s: number | null;
  density_p_cc: number | null;
  bmag_nt: number | null;
  bz_gsm_nt: number | null;
  by_gsm_nt: number | null;
  sc_x_re: number | null;
  sc_y_re: number | null;
  sc_z_re: number | null;
}

export interface MlPrediction {
  time: string;
  mruDelayMin: number | null;
  residualMin: number | null;
  correctedDelayMin: number | null;
  /** True only when all 20 features were finite (instantaneous present AND >=3 h rolling). */
  complete: boolean;
}

/** Nominal bow-shock-nose standoff in Earth radii — single-sourced with the MRU baseline. */
export const BSN_X_RE_NOMINAL = BSN_X_RE;
/** Held-out MAE bands (minutes) for the ETA uncertainty. */
export const ETA_BAND_ML_MIN = 10.39;
export const ETA_BAND_MRU_MIN = 12.13;

const PYTHON = process.env.HELIOS_PYTHON || 'python3';
const PREDICT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 4_000_000;

/**
 * Predict the arrival-time residual for each input sample. Returns the predictions keyed
 * by their `time`. On any failure returns an empty map (caller falls back to raw MRU).
 */
export async function predictArrivalResiduals(
  samples: MlInputSample[],
  bsnXRe: number = BSN_X_RE_NOMINAL,
): Promise<Map<string, MlPrediction>> {
  const empty = new Map<string, MlPrediction>();
  if (samples.length === 0) return empty;

  const predictions = await new Promise<MlPrediction[]>(resolve => {
    let settled = false;
    const finish = (result: MlPrediction[]) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(PYTHON, ['-m', 'ml.arrival_residual.predict'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      finish([]);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish([]);
    }, PREDICT_TIMEOUT_MS);

    let out = '';
    let overflow = false;
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.length > MAX_OUTPUT_BYTES) { overflow = true; try { child.kill('SIGKILL'); } catch { /* noop */ } }
    });
    child.on('error', () => { clearTimeout(timer); finish([]); });
    child.on('close', () => {
      clearTimeout(timer);
      if (overflow) { finish([]); return; }
      try {
        const parsed = JSON.parse(out) as { predictions?: MlPrediction[] };
        finish(Array.isArray(parsed.predictions) ? parsed.predictions : []);
      } catch {
        finish([]);
      }
    });

    try {
      child.stdin.on('error', () => { /* EPIPE if the child died — handled by close/error */ });
      child.stdin.write(JSON.stringify({ samples, bsn_x_re: bsnXRe }));
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      finish([]);
    }
  });

  const byTime = new Map<string, MlPrediction>();
  for (const prediction of predictions) byTime.set(prediction.time, prediction);
  return byTime;
}
