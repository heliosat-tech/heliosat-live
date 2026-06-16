import type { SatelliteTLE } from './celestrakService';
import { derivePhysicalFluxState } from './satelliteExposureService';
import type { NoaaMagnetometerData, NoaaPlasmaData, NoaaServiceResponse } from './noaaSolarWindService';
import { getSatelliteKey } from '@/contexts/SatelliteConfigContext';
import type { Comparator, EnvVariable, Threshold, WatchConfig } from '@/contexts/SatelliteWatchContext';

// Environment variables an operator can set instrument thresholds on. These are the live
// space-weather drivers already surfaced elsewhere (derivePhysicalFluxState + L1 Kp estimate).
export interface EnvVarDef {
  label: string;
  unit: string;
  defaultComparator: Comparator;
  defaultValue: number;
}

export const ENV_VARS: Record<EnvVariable, EnvVarDef> = {
  speed: { label: 'Solar-wind speed', unit: 'km/s', defaultComparator: 'gt', defaultValue: 600 },
  bz: { label: 'Bz (GSM)', unit: 'nT', defaultComparator: 'lt', defaultValue: -10 },
  density: { label: 'Proton density', unit: 'cm⁻³', defaultComparator: 'gt', defaultValue: 20 },
  bt: { label: '|B| (Bt)', unit: 'nT', defaultComparator: 'gt', defaultValue: 15 },
  kp: { label: 'Kp index', unit: '', defaultComparator: 'gte', defaultValue: 5 },
  dynamicPressure: { label: 'Dynamic pressure', unit: 'nPa', defaultComparator: 'gt', defaultValue: 5 },
};

export const ENV_VARIABLE_ORDER: EnvVariable[] = ['speed', 'bz', 'density', 'bt', 'kp', 'dynamicPressure'];

export const COMPARATORS: Record<Comparator, string> = {
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
};

export type LiveEnv = Record<EnvVariable, number | null>;

/** Current values of the threshold variables from the live NOAA snapshot (+ L1 Kp estimate). */
export function buildLiveEnv(
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>,
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>,
  kp: number | null,
): LiveEnv {
  const flux = derivePhysicalFluxState(noaaMagData, noaaPlasmaData);
  const valueOf = (id: string): number | null => {
    const value = flux.quantities.find(quantity => quantity.id === id)?.value;
    return typeof value === 'number' ? value : null;
  };
  return {
    speed: valueOf('speed'),
    bz: valueOf('bz_gsm'),
    density: valueOf('density'),
    bt: valueOf('bt'),
    dynamicPressure: valueOf('dynamic_pressure'),
    kp: kp ?? null,
  };
}

export interface ActiveWatchAlert {
  satelliteKey: string;
  satelliteName: string;
  instrumentName: string;
  threshold: Threshold;
  currentValue: number;
}

function crosses(value: number, comparator: Comparator, target: number): boolean {
  switch (comparator) {
    case 'gt': return value > target;
    case 'lt': return value < target;
    case 'gte': return value >= target;
    case 'lte': return value <= target;
    default: return false;
  }
}

/** Evaluate every tracked satellite's instrument thresholds against the live environment. */
export function evaluateWatchAlerts(
  config: WatchConfig,
  trackedTles: SatelliteTLE[],
  live: LiveEnv,
): ActiveWatchAlert[] {
  const alerts: ActiveWatchAlert[] = [];
  for (const tle of trackedTles) {
    const satelliteKey = getSatelliteKey(tle);
    const instruments = config[satelliteKey];
    if (!instruments?.length) continue;
    for (const instrument of instruments) {
      for (const threshold of instrument.thresholds) {
        const value = live[threshold.variable];
        if (value === null || !Number.isFinite(value)) continue;
        if (crosses(value, threshold.comparator, threshold.value)) {
          alerts.push({
            satelliteKey,
            satelliteName: tle.name,
            instrumentName: instrument.name,
            threshold,
            currentValue: value,
          });
        }
      }
    }
  }
  return alerts;
}

/** "Solar-wind speed > 600 km/s" */
export function formatThreshold(threshold: Threshold): string {
  const def = ENV_VARS[threshold.variable];
  return `${def.label} ${COMPARATORS[threshold.comparator]} ${threshold.value}${def.unit ? ` ${def.unit}` : ''}`;
}

/** "612 km/s" */
export function formatEnvValue(variable: EnvVariable, value: number): string {
  const def = ENV_VARS[variable];
  const digits = variable === 'speed' ? 0 : 1;
  return `${value.toFixed(digits)}${def.unit ? ` ${def.unit}` : ''}`;
}
