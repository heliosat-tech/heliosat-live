/**
 * NOAA Space Weather Scales (G / S / R) — classification + a transparent
 * solar-wind -> Kp estimator for the geomagnetic (G) scale.
 *
 * The three scales describe three PHYSICALLY DISTINCT phenomena that reach Earth
 * by different paths, which is why HELIOSAT can forecast one of them and only
 * observe the other two:
 *
 *   G  Geomagnetic storms   <- driven by the solar WIND (southward Bz x speed),
 *                              measured by the planetary Kp index. This is what
 *                              HELIOSAT propagates from L1 -> Earth, so it can be
 *                              FORECAST with the L1->Earth transit as lead time.
 *   R  Radio blackouts       <- driven by solar X-ray FLARES. X-rays travel at the
 *                              speed of light (~8 min Sun->Earth) and are measured
 *                              by GOES at Earth. They cannot be predicted from the
 *                              L1 solar wind; HELIOSAT can only OBSERVE them.
 *   S  Solar radiation storms<- driven by solar energetic PROTONS, measured by GOES
 *                              at Earth. Also not derivable from the L1 bulk solar
 *                              wind feed; OBSERVED only.
 *
 * This module is pure (no I/O, no framework) so it runs identically on server and
 * client. Live "observed" G/S/R come from NOAA (see noaaStormScalesService).
 */

export type StormScaleKind = 'G' | 'S' | 'R';

/** A classified scale value: level 0 (none) .. 5 (extreme). */
export interface StormScaleValue {
  kind: StormScaleKind;
  /** 0 = none/below threshold, 1..5 = NOAA scale level. */
  level: number;
  /** "G0" .. "G5" etc. Level 0 renders as "—" in the UI but kept here for logic. */
  code: string;
  /** Short human label, e.g. "Minor", "Severe". */
  label: string;
  /** One-line plain description of the impact at this level. */
  description: string;
}

export interface ScaleMeta {
  kind: StormScaleKind;
  title: string;
  /** What physically drives it. */
  driver: string;
  /** What instrument/quantity defines the official level. */
  measuredBy: string;
  /** Whether HELIOSAT forecasts it from the L1 solar wind, or only observes it. */
  forecastable: boolean;
  /** Plain explanation of the forecastable/observed distinction. */
  note: string;
}

export const SCALE_META: Record<StormScaleKind, ScaleMeta> = {
  G: {
    kind: 'G',
    title: 'Geomagnetic storm',
    driver: 'Southward IMF (Bz) coupling with fast solar wind',
    measuredBy: 'Planetary Kp index (ground magnetometers)',
    forecastable: true,
    note: 'Driven by the solar wind HELIOSAT propagates from L1, so it is forecast with the L1→Earth transit as lead time, then compared with the real Kp.',
  },
  S: {
    kind: 'S',
    title: 'Solar radiation storm',
    driver: 'Solar energetic protons (≥10 MeV)',
    measuredBy: 'GOES proton sensors at Earth',
    forecastable: false,
    note: 'Energetic protons are not carried by the bulk L1 solar wind feed, so HELIOSAT observes this from GOES rather than forecasting it.',
  },
  R: {
    kind: 'R',
    title: 'Radio blackout',
    driver: 'Solar X-ray flares',
    measuredBy: 'GOES X-ray sensors at Earth',
    forecastable: false,
    note: 'X-rays travel at the speed of light (~8 min Sun→Earth), arriving with the flare itself, so they cannot be predicted from the L1 solar wind — only observed.',
  },
};

// NOAA scale labels (shared 1..5 wording per scale kind).
const G_LABELS = ['None', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'];
const S_LABELS = ['None', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'];
const R_LABELS = ['None', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'];

const G_DESCRIPTIONS = [
  'Quiet to unsettled geomagnetic field.',
  'Weak power-grid fluctuations; aurora visible at high latitudes.',
  'High-latitude power systems may see voltage alarms; aurora to ~55°.',
  'Voltage corrections needed; surface charging on spacecraft; aurora to ~50°.',
  'Possible widespread voltage control problems; aurora to ~45°.',
  'Grid systems can collapse; aurora seen near the equator.',
];
const S_DESCRIPTIONS = [
  'No elevated proton flux.',
  'Minor impacts on HF radio in polar regions.',
  'Small effects on satellite operations possible; polar HF degraded.',
  'Single-event upsets on satellites; degraded polar HF and navigation.',
  'Elevated radiation risk to astronauts; satellite memory/imaging issues.',
  'Unavoidable radiation hazard to astronauts; satellites may be disabled.',
];
const R_DESCRIPTIONS = [
  'No significant X-ray flare activity.',
  'Weak HF radio degradation on the sunlit side for minutes.',
  'Limited HF radio blackout on the sunlit side; low-freq navigation degraded.',
  'Wide-area HF blackout for ~1 hour on the sunlit side.',
  'HF blackout on most of the sunlit side for 1–2 hours.',
  'Complete HF blackout on the entire sunlit side for hours.',
];

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(5, Math.round(level)));
}

function makeValue(kind: StormScaleKind, level: number): StormScaleValue {
  const lv = clampLevel(level);
  const labels = kind === 'G' ? G_LABELS : kind === 'S' ? S_LABELS : R_LABELS;
  const descriptions = kind === 'G' ? G_DESCRIPTIONS : kind === 'S' ? S_DESCRIPTIONS : R_DESCRIPTIONS;
  return {
    kind,
    level: lv,
    code: `${kind}${lv}`,
    label: labels[lv],
    description: descriptions[lv],
  };
}

/** Build a scale value directly from an official NOAA level string ("0".."5"). */
export function scaleFromNoaaLevel(kind: StormScaleKind, level: string | number | null | undefined): StormScaleValue {
  const parsed = typeof level === 'number' ? level : level == null ? 0 : Number(level);
  return makeValue(kind, Number.isFinite(parsed) ? parsed : 0);
}

/**
 * NOAA G scale from the planetary Kp index.
 * G1 Kp=5, G2 Kp=6, G3 Kp=7, G4 Kp=8, G5 Kp=9.
 */
export function classifyGFromKp(kp: number | null): StormScaleValue {
  if (kp === null || !Number.isFinite(kp)) return makeValue('G', 0);
  if (kp >= 9) return makeValue('G', 5);
  if (kp >= 8) return makeValue('G', 4);
  if (kp >= 7) return makeValue('G', 3);
  if (kp >= 6) return makeValue('G', 2);
  if (kp >= 5) return makeValue('G', 1);
  return makeValue('G', 0);
}

/**
 * NOAA S scale from the >=10 MeV integral proton flux in pfu
 * (particle flux units = protons cm^-2 s^-1 sr^-1).
 * S1 10, S2 1e2, S3 1e3, S4 1e4, S5 1e5.
 */
export function classifySFromPfu(pfu: number | null): StormScaleValue {
  if (pfu === null || !Number.isFinite(pfu)) return makeValue('S', 0);
  if (pfu >= 1e5) return makeValue('S', 5);
  if (pfu >= 1e4) return makeValue('S', 4);
  if (pfu >= 1e3) return makeValue('S', 3);
  if (pfu >= 1e2) return makeValue('S', 2);
  if (pfu >= 10) return makeValue('S', 1);
  return makeValue('S', 0);
}

/**
 * NOAA R scale from the GOES long-band (0.1-0.8 nm) X-ray flux in W/m^2.
 * R1 M1 (1e-5), R2 M5 (5e-5), R3 X1 (1e-4), R4 X10 (1e-3), R5 X20 (2e-3).
 */
export function classifyRFromXrayFlux(fluxWm2: number | null): StormScaleValue {
  if (fluxWm2 === null || !Number.isFinite(fluxWm2)) return makeValue('R', 0);
  if (fluxWm2 >= 2e-3) return makeValue('R', 5);
  if (fluxWm2 >= 1e-3) return makeValue('R', 4);
  if (fluxWm2 >= 1e-4) return makeValue('R', 3);
  if (fluxWm2 >= 5e-5) return makeValue('R', 2);
  if (fluxWm2 >= 1e-5) return makeValue('R', 1);
  return makeValue('R', 0);
}

/**
 * Transparent operational estimate of the planetary Kp from the arriving solar
 * wind. This is deliberately simple and clearly a heuristic (in the spirit of the
 * MRU baseline) — it is NOT the official Kp, which is measured from ground
 * magnetometers after the fact.
 *
 * Two well-established drivers are combined and the stronger one wins:
 *
 *  1. Dawn-dusk merging electric field from a SOUTHWARD field:
 *       Bs = max(0, -Bz)                       [nT]
 *       Em = V * Bs * 1e-3                      [mV/m]
 *     Em is the classic geoeffective coupling term (negative Bz reconnects with
 *     Earth's field). Mapped to Kp through a monotonic, documented calibration.
 *
 *  2. A fast-stream floor: fast wind alone (e.g. CIRs) raises activity even with a
 *     weakly southward field, so speed sets a Kp floor.
 *
 * Both calibrations are piecewise-linear with the anchor points below and are
 * tunable; they are intended for decision-support, not as a calibrated index.
 */
export interface KpEstimate {
  kp: number;
  /** Merging electric field Em (mV/m) used for the estimate. */
  mergingFieldMvM: number;
  southwardBzNt: number;
}

// Em (mV/m) -> Kp anchors.
const EM_KP_ANCHORS: Array<[number, number]> = [
  [0, 1],
  [0.5, 3],
  [1.5, 4],
  [2.5, 5], // G1 onset
  [4, 6], // G2
  [6, 7], // G3
  [9, 8], // G4
  [13, 9], // G5
];

// Speed (km/s) -> Kp floor anchors (fast-stream driven activity).
const SPEED_KP_ANCHORS: Array<[number, number]> = [
  [350, 0],
  [450, 2],
  [550, 3],
  [650, 4],
  [800, 5],
];

function interpolateAnchors(anchors: Array<[number, number]>, x: number): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x >= x0 && x <= x1) {
      const fraction = (x - x0) / (x1 - x0);
      return y0 + fraction * (y1 - y0);
    }
  }
  return last[1];
}

/** Dawn-dusk merging electric field Em = V·max(0,−Bz)·1e-3 [mV/m] from one sample. */
export function mergingFieldMvM(speedKmS: number | null, bzNt: number | null): number {
  const speed = typeof speedKmS === 'number' && Number.isFinite(speedKmS) ? speedKmS : 400;
  const bz = typeof bzNt === 'number' && Number.isFinite(bzNt) ? bzNt : 0;
  return speed * Math.max(0, -bz) * 1e-3;
}

/**
 * Map a (merging-field, speed) pair to an estimated Kp using the documented
 * anchor calibration. Em should be a trailing time-average (~3 h) to match the
 * 3-hour Kp index — instantaneous 1-minute spikes over-predict. This is the single
 * source of truth for the Kp heuristic, shared by the live card and the event log.
 */
export function kpFromCoupling(mergingEmMvM: number, meanSpeedKmS: number | null): number {
  const em = Number.isFinite(mergingEmMvM) ? mergingEmMvM : 0;
  const kpFromField = interpolateAnchors(EM_KP_ANCHORS, em);
  const kpFromSpeed = typeof meanSpeedKmS === 'number' && Number.isFinite(meanSpeedKmS)
    ? interpolateAnchors(SPEED_KP_ANCHORS, meanSpeedKmS)
    : 0;
  return Math.max(0, Math.min(9, Math.max(kpFromField, kpFromSpeed)));
}

export function estimateKpFromSolarWind(
  speedKmS: number | null,
  bzNt: number | null,
): KpEstimate | null {
  const speed = typeof speedKmS === 'number' && Number.isFinite(speedKmS) ? speedKmS : null;
  const bz = typeof bzNt === 'number' && Number.isFinite(bzNt) ? bzNt : null;

  if (speed === null && bz === null) return null;

  const southwardBz = bz === null ? 0 : Math.max(0, -bz);
  const em = mergingFieldMvM(speed, bz);
  const kp = kpFromCoupling(em, speed);

  return {
    kp: Math.round(kp * 10) / 10,
    mergingFieldMvM: Math.round(em * 100) / 100,
    southwardBzNt: Math.round(southwardBz * 10) / 10,
  };
}

/** Convenience: HELIOSAT's forecast G level from the arriving solar wind. */
export function forecastGFromSolarWind(
  speedKmS: number | null,
  bzNt: number | null,
): { scale: StormScaleValue; kp: KpEstimate | null } {
  const kp = estimateKpFromSolarWind(speedKmS, bzNt);
  return { scale: classifyGFromKp(kp ? kp.kp : null), kp };
}
