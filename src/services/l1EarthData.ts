/**
 * Shared fetch + parse of the L1 (ACE) and Earth (OMNI) solar-wind samples used
 * by the historical features (exploration, validation, ML training). Keeps the
 * CDAWeb HAPI plumbing in one place.
 */
import { fetchHapiSeriesChunked, toFiniteNumber } from './historicPlotService';

export type SolarWindVariableId = 'speed' | 'density' | 'bt' | 'bz';

export interface L1EarthSample {
  ms: number;
  speed: number | null;
  density: number | null;
  bt: number | null;
  bz: number | null;
}

export interface L1EarthSamples {
  l1: L1EarthSample[];
  earth: L1EarthSample[];
  warnings: string[];
}

const GRID_STEP_MS = 60_000;
const PHYSICAL_RANGE: Record<SolarWindVariableId, { min: number; max: number }> = {
  speed: { min: 100, max: 3000 },
  density: { min: 0.01, max: 200 },
  bt: { min: 0, max: 200 },
  bz: { min: -200, max: 200 },
};

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function sanitize(value: number | null, variableId: SolarWindVariableId): number | null {
  if (value === null) {
    return null;
  }
  const { min, max } = PHYSICAL_RANGE[variableId];
  return value >= min && value <= max ? value : null;
}

function readVectorComponent(cell: unknown, index: number): number | null {
  return Array.isArray(cell) ? toFiniteNumber(cell[index]) : null;
}

/**
 * ACE L1 source presets. `k0` is the quick-look product (only served from ~2017,
 * Bz in GSE). `science` is the Level-2 mission archive (plasma 1998–2024, field
 * 1997–present) with Bz in GSM (matches OMNI) — used for deep historical windows.
 */
export type AceSource = 'k0' | 'science';
const ACE_SOURCE_CONFIG: Record<AceSource, { plasmaDataset: string; plasmaParams: string[]; magDataset: string; magParams: string[] }> = {
  k0: { plasmaDataset: 'AC_K0_SWE', plasmaParams: ['Np', 'Vp', 'Tpr'], magDataset: 'AC_K0_MFI', magParams: ['Magnitude', 'BGSEc'] },
  // AC_H0_MFI is 16-sec (minute-resolution, needed for the lag features). AC_H1_MFI
  // is 4-min averaged, which can't fill the 35–85 min lags, so |B|/Bz won't train.
  science: { plasmaDataset: 'AC_H0_SWE', plasmaParams: ['Np', 'Vp'], magDataset: 'AC_H0_MFI', magParams: ['Magnitude', 'BGSM'] },
};

/** Fetch ACE (L1) plasma+mag and OMNI (Earth) for a window, parsed to clean samples. */
export async function fetchAceOmniSamples(
  range: { startUtc: string; stopUtc: string },
  options?: { source?: AceSource },
): Promise<L1EarthSamples> {
  const warnings: string[] = [];
  const config = ACE_SOURCE_CONFIG[options?.source ?? 'k0'];

  const [plasmaResult, magResult, omniResult] = await Promise.all([
    fetchHapiSeriesChunked(config.plasmaDataset, config.plasmaParams, range),
    fetchHapiSeriesChunked(config.magDataset, config.magParams, range),
    fetchHapiSeriesChunked('OMNI_HRO_1MIN', ['F', 'BZ_GSM', 'flow_speed', 'proton_density'], range),
  ]);
  warnings.push(...plasmaResult.warnings, ...magResult.warnings, ...omniResult.warnings);

  // ACE: merge plasma (Np, Vp) and magnetometer (|B|, Bz GSE) by minute.
  const minuteKey = (ms: number) => Math.round(ms / GRID_STEP_MS) * GRID_STEP_MS;
  const l1ByMinute = new Map<number, L1EarthSample>();

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
  const l1 = [...l1ByMinute.values()].sort((a, b) => a.ms - b.ms);

  const earth: L1EarthSample[] = omniResult.rows
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
    .filter((entry): entry is L1EarthSample => entry !== null)
    .sort((a, b) => a.ms - b.ms);

  return { l1, earth, warnings };
}
