/**
 * MRU (Movimiento Rectilíneo Uniforme / Uniform Rectilinear Motion) forecast core.
 *
 * The simplest physically-motivated baseline for L1 -> Earth propagation:
 * the solar wind measured at L1 is assumed to travel radially Sunward->Earth at
 * the speed measured at L1, carrying its properties (speed, density, magnetic
 * field) essentially unchanged. The only thing that changes is *when* it
 * arrives:
 *
 *     lag = L1_distance / solar_wind_speed
 *     value_at_Earth(t + lag) = value_at_L1(t)
 *
 * This module is pure (no I/O, no framework) so it can run identically on the
 * server (historical validation) and on the client (live forecast).
 */

/** Nominal Sun-Earth L1 distance, used when a measured spacecraft distance is unavailable. */
export const NOMINAL_L1_DISTANCE_KM = 1_500_000;

// ---- Raw MRU baseline: ONE consistent computation everywhere ----
// The validated benchmark (and the basis the ML residual was trained against) propagates
// the spacecraft X-position to the bow-shock NOSE, not Earth's centre:
//     mru_delay = (sc_x - bsn_x) * Re / V
// These constants match ml/arrival_residual/dataset.py (Re) and the live BSN estimate.
export const RE_KM = 6371.2;
export const BSN_X_RE = 13.5;
/** Nominal L1 → bow-shock-nose distance (the Earth-centre nominal minus the standoff). */
export const NOMINAL_BOW_SHOCK_DISTANCE_KM = NOMINAL_L1_DISTANCE_KM - BSN_X_RE * RE_KM;

/**
 * The MRU propagation distance: spacecraft X to the bow-shock nose, (sc_x - bsn_x)·Re.
 * Pass the spacecraft GSE X in km. Falls back to the nominal L1→bow-shock distance when
 * the position is unavailable — NEVER the Earth-centre magnitude, so the raw MRU baseline
 * never silently jumps ~3 min between formulas across states.
 */
export function bowShockDistanceKm(scXKm: number | null | undefined): number {
  if (scXKm === null || scXKm === undefined || !Number.isFinite(scXKm)) return NOMINAL_BOW_SHOCK_DISTANCE_KM;
  return scXKm - BSN_X_RE * RE_KM;
}

/** A single solar-wind sample as measured at L1. */
export interface L1Sample {
  timeUtc: string;
  speedKmS: number | null;
  densityPerCm3: number | null;
  /** North-south interplanetary magnetic field component (GSM). Negative = southward = geoeffective. */
  bzNt: number | null;
  /** Magnetic field magnitude |B|. */
  btNt: number | null;
  temperatureK: number | null;
}

/** An L1 sample propagated to Earth under the MRU assumption. */
export interface PropagatedSample {
  l1TimeUtc: string;
  /** Estimated time the parcel reaches Earth = l1Time + lag. */
  arrivalTimeUtc: string;
  lagMinutes: number;
  speedKmS: number | null;
  densityPerCm3: number | null;
  bzNt: number | null;
  btNt: number | null;
  temperatureK: number | null;
}

export type GeoeffectiveLevel = 'quiet' | 'unsettled' | 'storm' | 'unknown';

export interface MruConditionStatus {
  level: GeoeffectiveLevel;
  label: string;
  /** Plain-language one-liner suitable for a non-expert. */
  headline: string;
  bzNt: number | null;
  speedKmS: number | null;
}

/**
 * Heuristic geoeffectiveness thresholds. These are deliberately simple and are
 * NOT a calibrated geomagnetic index — they only flag the two classic drivers
 * of geomagnetic activity: a southward IMF (negative Bz) and high solar-wind
 * speed.
 */
const STORM_BZ_NT = -10;
const STORM_SPEED_KM_S = 600;
const UNSETTLED_BZ_NT = -5;
const UNSETTLED_SPEED_KM_S = 500;

function toFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  // Tolerate both ISO ("...Z") and NOAA-style ("2025-05-30 20:48:00") stamps.
  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const ms = new Date(normalized).getTime();

  return Number.isNaN(ms) ? null : ms;
}

/**
 * Propagate one L1 sample to Earth. Returns null when the speed is missing or
 * non-positive (no physical travel time can be computed).
 */
export function propagateL1Sample(
  sample: L1Sample,
  distanceKm: number = NOMINAL_L1_DISTANCE_KM,
): PropagatedSample | null {
  const speedKmS = toFinite(sample.speedKmS);
  const l1TimeMs = parseTimeMs(sample.timeUtc);

  if (speedKmS === null || speedKmS <= 0 || l1TimeMs === null) {
    return null;
  }

  const lagSeconds = distanceKm / speedKmS;
  const arrivalMs = l1TimeMs + lagSeconds * 1000;

  return {
    l1TimeUtc: new Date(l1TimeMs).toISOString(),
    arrivalTimeUtc: new Date(arrivalMs).toISOString(),
    lagMinutes: lagSeconds / 60,
    speedKmS,
    densityPerCm3: toFinite(sample.densityPerCm3),
    bzNt: toFinite(sample.bzNt),
    btNt: toFinite(sample.btNt),
    temperatureK: toFinite(sample.temperatureK),
  };
}

/** Propagate a series of L1 samples, dropping any that cannot be propagated. */
export function propagateL1Series(
  samples: L1Sample[],
  distanceKm: number = NOMINAL_L1_DISTANCE_KM,
): PropagatedSample[] {
  return samples
    .map(sample => propagateL1Sample(sample, distanceKm))
    .filter((sample): sample is PropagatedSample => sample !== null)
    .sort((a, b) => parseTimeMs(a.arrivalTimeUtc)! - parseTimeMs(b.arrivalTimeUtc)!);
}

/**
 * Classify expected geomagnetic impact from the two dominant drivers
 * (southward Bz and solar-wind speed). Heuristic, decision-support only.
 */
export function classifyConditions(
  speedKmS: number | null,
  bzNt: number | null,
): MruConditionStatus {
  const speed = toFinite(speedKmS);
  const bz = toFinite(bzNt);

  if (speed === null && bz === null) {
    return {
      level: 'unknown',
      label: 'No data',
      headline: 'No recent L1 solar-wind measurement is available.',
      bzNt: null,
      speedKmS: null,
    };
  }

  const isStorm = (bz !== null && bz <= STORM_BZ_NT) || (speed !== null && speed >= STORM_SPEED_KM_S);
  const isUnsettled = (bz !== null && bz <= UNSETTLED_BZ_NT) || (speed !== null && speed >= UNSETTLED_SPEED_KM_S);

  if (isStorm) {
    return {
      level: 'storm',
      label: 'Storm likely',
      headline: 'Strong southward field and/or fast wind — geomagnetic storming is likely.',
      bzNt: bz,
      speedKmS: speed,
    };
  }

  if (isUnsettled) {
    return {
      level: 'unsettled',
      label: 'Unsettled',
      headline: 'Mildly southward field or elevated speed — expect unsettled conditions.',
      bzNt: bz,
      speedKmS: speed,
    };
  }

  return {
    level: 'quiet',
    label: 'Quiet',
    headline: 'Northward/weak field and nominal speed — quiet conditions expected.',
    bzNt: bz,
    speedKmS: speed,
  };
}

/** Single source of truth for the human-readable explanation shown in the UI. */
export const MRU_ASSUMPTIONS = [
  'The solar wind travels in a straight radial line from L1 to Earth (uniform rectilinear motion).',
  'It moves at the bulk speed measured at L1, with no acceleration along the way.',
  'Its properties (density, magnetic field) arrive essentially unchanged — only time-shifted.',
] as const;

export const MRU_LIMITATIONS = [
  'Real solar-wind structures rotate, compress and evolve between L1 and Earth.',
  'The simple ballistic timing ignores the magnetic field orientation of the arriving front.',
  'No magnetospheric response is modelled — this estimates the arriving solar wind, not a calibrated geomagnetic index.',
] as const;
