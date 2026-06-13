import { classifyGFromKp, kpFromCoupling } from './stormScaleService';

export type PhysicalDriverSourceId =
  | 'swpc_rtsw'
  | 'swpc_legacy'
  | 'imap_ialirt'
  | 'dscovr'
  | 'ace'
  | 'ace_archive'
  | 'omni_reference'
  | 'cached_live';

export type PhysicalDriverVariable = 'speed' | 'bz' | 'bt' | 'density';

export interface PhysicalDriverCandidate {
  /** Timestamp on the axis being resolved: L1 detection time for live streams, arrival time for replay. */
  timeMs: number;
  /** Physical source timestamp, usually L1 detection time. Reference archives may omit it. */
  observedMs?: number | null;
  sourceId: PhysicalDriverSourceId;
  sourceLabel: string;
  priority: number;
  speedKmS?: number | null;
  bzGsmNt?: number | null;
  btNt?: number | null;
  densityCm3?: number | null;
}

export interface ResolvedPhysicalDriverSample {
  timeUtc: string;
  targetTimeMs: number;
  sourceTimeUtc: string | null;
  arrivalTimeUtc: string | null;
  leadTimeMinutes: number | null;
  speedKmS: number | null;
  bzGsmNt: number | null;
  btNt: number | null;
  densityCm3: number | null;
  sourceByVariable: Record<PhysicalDriverVariable, PhysicalDriverSourceId | null>;
  sourceLabelByVariable: Record<PhysicalDriverVariable, string | null>;
  sourceTimeByVariable: Record<PhysicalDriverVariable, string | null>;
  missingVariables: PhysicalDriverVariable[];
  qualityFlags: string[];
  riskAvailable: boolean;
  derived: {
    pdynNpa: number | null;
    emMvM: number | null;
    estimatedGLevel: number | null;
  };
}

export interface ResolvePhysicalDriverOptions {
  toleranceMs: number;
  distanceKm?: number | null;
  computeArrivalFromSpeed?: boolean;
}

interface VariablePick {
  value: number;
  sourceId: PhysicalDriverSourceId;
  sourceLabel: string;
  sourceTimeMs: number;
  offsetMs: number;
}

const VAR_KEYS = ['speed', 'bz', 'bt', 'density'] as const satisfies readonly PhysicalDriverVariable[];

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function valueFor(candidate: PhysicalDriverCandidate, variable: PhysicalDriverVariable): number | null {
  if (variable === 'speed') return finite(candidate.speedKmS);
  if (variable === 'bz') return finite(candidate.bzGsmNt);
  if (variable === 'bt') return finite(candidate.btNt);
  return finite(candidate.densityCm3);
}

export function computeDynamicPressureNpa(speedKmS: number | null, densityCm3: number | null): number | null {
  const speed = finite(speedKmS);
  const density = finite(densityCm3);
  if (speed === null || density === null || speed <= 0 || density < 0) return null;
  return 1.6726219e-6 * density * speed * speed;
}

export function computeCouplingElectricFieldMvM(speedKmS: number | null, bzGsmNt: number | null): number | null {
  const speed = finite(speedKmS);
  const bz = finite(bzGsmNt);
  if (speed === null || bz === null || speed <= 0) return null;
  return speed * Math.max(0, -bz) * 1e-3;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pickVariable(
  targetMs: number,
  candidates: PhysicalDriverCandidate[],
  variable: PhysicalDriverVariable,
  toleranceMs: number,
): VariablePick | null {
  let best: VariablePick & { priority: number } | null = null;
  for (const candidate of candidates) {
    const value = valueFor(candidate, variable);
    if (value === null) continue;
    const offsetMs = Math.abs(candidate.timeMs - targetMs);
    if (offsetMs > toleranceMs) continue;
    const sourceTimeMs = candidate.observedMs ?? candidate.timeMs;
    const next = {
      value,
      sourceId: candidate.sourceId,
      sourceLabel: candidate.sourceLabel,
      sourceTimeMs,
      offsetMs,
      priority: candidate.priority,
    };
    if (
      best === null
      || next.priority < best.priority
      || (next.priority === best.priority && next.offsetMs < best.offsetMs)
    ) {
      best = next;
    }
  }
  if (!best) return null;
  return {
    value: best.value,
    sourceId: best.sourceId,
    sourceLabel: best.sourceLabel,
    sourceTimeMs: best.sourceTimeMs,
    offsetMs: best.offsetMs,
  };
}

export function resolvePhysicalDriverSample(
  targetMs: number,
  candidateSources: PhysicalDriverCandidate[],
  options: ResolvePhysicalDriverOptions,
): ResolvedPhysicalDriverSample {
  const picks: Record<PhysicalDriverVariable, VariablePick | null> = {
    speed: pickVariable(targetMs, candidateSources, 'speed', options.toleranceMs),
    bz: pickVariable(targetMs, candidateSources, 'bz', options.toleranceMs),
    bt: pickVariable(targetMs, candidateSources, 'bt', options.toleranceMs),
    density: pickVariable(targetMs, candidateSources, 'density', options.toleranceMs),
  };

  const speedKmS = picks.speed?.value ?? null;
  const bzGsmNt = picks.bz?.value ?? null;
  const btNt = picks.bt?.value ?? null;
  const densityCm3 = picks.density?.value ?? null;
  const missingVariables = VAR_KEYS.filter(key => picks[key] === null);
  const sourceIds = new Set(VAR_KEYS.map(key => picks[key]?.sourceId).filter((value): value is PhysicalDriverSourceId => !!value));
  const sourceTimes = VAR_KEYS.map(key => picks[key]?.sourceTimeMs).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const flags = new Set<string>();

  if (sourceIds.size > 1) flags.add('mixed_sources');
  if (VAR_KEYS.some(key => (picks[key]?.offsetMs ?? 0) > 0)) flags.add('time_aligned_fallback');
  for (const variable of missingVariables) flags.add(`missing_${variable}`);

  const riskAvailable = speedKmS !== null && bzGsmNt !== null;
  if (!riskAvailable) flags.add('g_risk_unavailable');

  let arrivalTimeUtc: string | null = null;
  let leadTimeMinutes: number | null = null;
  if (options.computeArrivalFromSpeed && speedKmS !== null && options.distanceKm && options.distanceKm > 0 && picks.speed) {
    const lagMs = (options.distanceKm / speedKmS) * 1000;
    const arrivalMs = picks.speed.sourceTimeMs + lagMs;
    arrivalTimeUtc = new Date(arrivalMs).toISOString();
    leadTimeMinutes = Math.round(lagMs / 60000);
  } else if (options.computeArrivalFromSpeed && speedKmS === null) {
    flags.add('no_physical_arrival_time');
  }

  const pdynNpa = computeDynamicPressureNpa(speedKmS, densityCm3);
  const emMvM = computeCouplingElectricFieldMvM(speedKmS, bzGsmNt);
  const estimatedGLevel = riskAvailable
    ? classifyGFromKp(kpFromCoupling(emMvM ?? 0, speedKmS)).level
    : null;

  return {
    timeUtc: new Date(targetMs).toISOString(),
    targetTimeMs: targetMs,
    sourceTimeUtc: sourceTimes.length ? new Date(Math.min(...sourceTimes)).toISOString() : null,
    arrivalTimeUtc,
    leadTimeMinutes,
    speedKmS,
    bzGsmNt,
    btNt,
    densityCm3,
    sourceByVariable: {
      speed: picks.speed?.sourceId ?? null,
      bz: picks.bz?.sourceId ?? null,
      bt: picks.bt?.sourceId ?? null,
      density: picks.density?.sourceId ?? null,
    },
    sourceLabelByVariable: {
      speed: picks.speed?.sourceLabel ?? null,
      bz: picks.bz?.sourceLabel ?? null,
      bt: picks.bt?.sourceLabel ?? null,
      density: picks.density?.sourceLabel ?? null,
    },
    sourceTimeByVariable: {
      speed: picks.speed ? new Date(picks.speed.sourceTimeMs).toISOString() : null,
      bz: picks.bz ? new Date(picks.bz.sourceTimeMs).toISOString() : null,
      bt: picks.bt ? new Date(picks.bt.sourceTimeMs).toISOString() : null,
      density: picks.density ? new Date(picks.density.sourceTimeMs).toISOString() : null,
    },
    missingVariables,
    qualityFlags: [...flags].sort(),
    riskAvailable,
    derived: {
      pdynNpa: pdynNpa === null ? null : round(pdynNpa, 2),
      emMvM: emMvM === null ? null : round(emMvM, 2),
      estimatedGLevel,
    },
  };
}
