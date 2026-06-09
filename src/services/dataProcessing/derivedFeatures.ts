/**
 * Derived physical features from normalized L1 samples (no OMNI).
 *
 * Everything here is a pure function of the L1 solar-wind / IMF measurements, so the
 * features are fully traceable to the in-situ data. Magnetic field is GSM (geoeffective).
 */

import type { L1Sample } from '../dataSources/types';

const MINUTE_MS = 60_000;

/**
 * Solar-wind dynamic pressure in nPa from proton density (cm^-3) and bulk speed (km/s):
 *   Pdyn = m_p * n * V^2  ->  Pdyn[nPa] = 1.6726e-6 * n[cm^-3] * V[km/s]^2
 * (proton-only; the ~4% alpha contribution is intentionally omitted for transparency.)
 */
export const PDYN_COEFFICIENT = 1.6726e-6;

export function dynamicPressureNpa(densityCm3: number | null, speedKmS: number | null): number | null {
  if (densityCm3 === null || speedKmS === null) return null;
  if (!Number.isFinite(densityCm3) || !Number.isFinite(speedKmS)) return null;
  return PDYN_COEFFICIENT * densityCm3 * speedKmS * speedKmS;
}

/**
 * Merging (dawn-dusk) electric field in mV/m from speed (km/s) and southward Bz (nT):
 *   Em = V * Bs * 1e-3,  with Bs = max(0, -Bz)
 * Em is 0 for northward IMF (not geoeffective for reconnection-driven coupling).
 */
export function mergingElectricFieldMvM(speedKmS: number | null, bzGsmNt: number | null): number | null {
  if (speedKmS === null || bzGsmNt === null) return null;
  if (!Number.isFinite(speedKmS) || !Number.isFinite(bzGsmNt)) return null;
  const southward = Math.max(0, -bzGsmNt);
  return speedKmS * southward * 1e-3;
}

export interface RollingFeatures {
  minBz15: number | null;
  minBz30: number | null;
  minBz60: number | null;
  maxPdyn15: number | null;
  maxPdyn30: number | null;
  maxPdyn60: number | null;
  maxEm15: number | null;
  maxEm30: number | null;
  maxEm60: number | null;
}

export interface GradientFeatures {
  /** Rate of change per minute, backward difference to the previous finite sample. */
  dSpeedDtPerMin: number | null;
  dBzDtPerMin: number | null;
  dDensityDtPerMin: number | null;
  dPdynDtPerMin: number | null;
}

export interface FeaturedL1Sample extends L1Sample {
  timeMs: number;
  pdynNpa: number | null;
  emMvM: number | null;
  rolling: RollingFeatures;
  gradients: GradientFeatures;
}

/** Median spacing between consecutive samples in ms (cadence), or null if undeterminable. */
export function detectCadenceMs(timeMsSorted: number[]): number | null {
  const diffs: number[] = [];
  for (let i = 1; i < timeMsSorted.length; i += 1) {
    const d = timeMsSorted[i] - timeMsSorted[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return null;
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2 === 0 ? (diffs[mid - 1] + diffs[mid]) / 2 : diffs[mid];
}

/**
 * Backward-looking extreme of `value` over the time window [t_i - windowMs, t_i].
 * `dir` selects min or max. Samples whose value is null are skipped.
 */
function rollingExtreme(
  index: number,
  windowMs: number,
  timeMs: number[],
  values: Array<number | null>,
  dir: 'min' | 'max',
): number | null {
  const t = timeMs[index];
  let acc: number | null = null;
  for (let j = index; j >= 0 && t - timeMs[j] <= windowMs; j -= 1) {
    const v = values[j];
    if (v === null || !Number.isFinite(v)) continue;
    if (acc === null) acc = v;
    else acc = dir === 'min' ? Math.min(acc, v) : Math.max(acc, v);
  }
  return acc;
}

/**
 * Enrich a list of L1 samples with derived features. Input is sorted by time and the
 * sample objects are preserved (source attribution and quality flags carry through).
 */
export function buildFeaturedSamples(samples: L1Sample[]): FeaturedL1Sample[] {
  const sorted = [...samples].sort((a, b) => new Date(a.timeUtc).getTime() - new Date(b.timeUtc).getTime());
  const timeMs = sorted.map(s => new Date(s.timeUtc).getTime());
  const pdyn = sorted.map(s => dynamicPressureNpa(s.densityCm3, s.speedKmS));
  const em = sorted.map(s => mergingElectricFieldMvM(s.speedKmS, s.bzGsmNt));
  const bz = sorted.map(s => s.bzGsmNt);

  // Previous finite sample per field, for backward-difference gradients.
  const lastFinite: Record<'speed' | 'bz' | 'density' | 'pdyn', { idx: number; value: number } | null> = {
    speed: null,
    bz: null,
    density: null,
    pdyn: null,
  };

  return sorted.map((sample, i) => {
    const gradient = (field: 'speed' | 'bz' | 'density' | 'pdyn', current: number | null): number | null => {
      let rate: number | null = null;
      const prev = lastFinite[field];
      if (current !== null && Number.isFinite(current) && prev) {
        const dtMin = (timeMs[i] - timeMs[prev.idx]) / MINUTE_MS;
        if (dtMin > 0) rate = (current - prev.value) / dtMin;
      }
      if (current !== null && Number.isFinite(current)) lastFinite[field] = { idx: i, value: current };
      return rate;
    };

    const dSpeedDtPerMin = gradient('speed', sample.speedKmS);
    const dBzDtPerMin = gradient('bz', sample.bzGsmNt);
    const dDensityDtPerMin = gradient('density', sample.densityCm3);
    const dPdynDtPerMin = gradient('pdyn', pdyn[i]);

    return {
      ...sample,
      timeMs: timeMs[i],
      pdynNpa: pdyn[i],
      emMvM: em[i],
      rolling: {
        minBz15: rollingExtreme(i, 15 * MINUTE_MS, timeMs, bz, 'min'),
        minBz30: rollingExtreme(i, 30 * MINUTE_MS, timeMs, bz, 'min'),
        minBz60: rollingExtreme(i, 60 * MINUTE_MS, timeMs, bz, 'min'),
        maxPdyn15: rollingExtreme(i, 15 * MINUTE_MS, timeMs, pdyn, 'max'),
        maxPdyn30: rollingExtreme(i, 30 * MINUTE_MS, timeMs, pdyn, 'max'),
        maxPdyn60: rollingExtreme(i, 60 * MINUTE_MS, timeMs, pdyn, 'max'),
        maxEm15: rollingExtreme(i, 15 * MINUTE_MS, timeMs, em, 'max'),
        maxEm30: rollingExtreme(i, 30 * MINUTE_MS, timeMs, em, 'max'),
        maxEm60: rollingExtreme(i, 60 * MINUTE_MS, timeMs, em, 'max'),
      },
      gradients: { dSpeedDtPerMin, dBzDtPerMin, dDensityDtPerMin, dPdynDtPerMin },
    };
  });
}
