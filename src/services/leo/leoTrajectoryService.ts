import * as satellite from 'satellite.js';
import type { LeoSatelliteOption, LeoTleFreshness, LeoTrajectory, LeoVector3 } from '../../lib/leo/contracts';
import { getSubsolarPoint } from '../solarPositionService';
import { fetchTleGroup, type SatelliteTLE } from '../celestrakService';

export type LeoTleGroup = 'stations' | 'weather';

const EARTH_ANGULAR_VELOCITY_RAD_S = 7.292115e-5;
const FRESH_TLE_HOURS = 24;
const DEGRADED_TLE_HOURS = 72;

export function noradIdFromTle(tle: SatelliteTLE): string | null {
  const value = tle.line1.slice(2, 7).trim();
  return /^\d+$/.test(value) ? value : null;
}

export function tleEpochUtc(tle: SatelliteTLE): string | null {
  try {
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    if (!Number.isFinite(satrec.jdsatepoch)) return null;
    const date = new Date((satrec.jdsatepoch - 2_440_587.5) * 86_400_000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

export function classifyTleFreshness(epochUtc: string | null, nowMs = Date.now()): { ageHours: number | null; freshness: LeoTleFreshness } {
  if (!epochUtc) return { ageHours: null, freshness: 'unknown' };
  const epochMs = Date.parse(epochUtc);
  if (!Number.isFinite(epochMs) || !Number.isFinite(nowMs)) return { ageHours: null, freshness: 'unknown' };
  if (epochMs - nowMs > 5 * 60_000) return { ageHours: null, freshness: 'unknown' };
  const ageHours = Math.max(0, (nowMs - epochMs) / 3_600_000);
  if (ageHours <= FRESH_TLE_HOURS) return { ageHours, freshness: 'fresh' };
  if (ageHours <= DEGRADED_TLE_HOURS) return { ageHours, freshness: 'degraded' };
  return { ageHours, freshness: 'stale' };
}

export function atmosphereCorotationVelocity(positionKm: LeoVector3): LeoVector3 {
  return {
    x: -EARTH_ANGULAR_VELOCITY_RAD_S * positionKm.y,
    y: EARTH_ANGULAR_VELOCITY_RAD_S * positionKm.x,
    z: 0,
  };
}

export function subtractVectors(left: LeoVector3, right: LeoVector3): LeoVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

export function vectorMagnitude(vector: LeoVector3): number {
  return Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
}

function localSolarTimeHours(date: Date, longitudeDeg: number): number {
  const subsolarLongitude = getSubsolarPoint(date).longitudeDeg;
  return ((12 + (longitudeDeg - subsolarLongitude) / 15) % 24 + 24) % 24;
}

function satelliteOption(tle: SatelliteTLE, nowMs: number): LeoSatelliteOption | null {
  const noradId = noradIdFromTle(tle);
  if (!noradId) return null;
  const epoch = tleEpochUtc(tle);
  const freshness = classifyTleFreshness(epoch, nowMs);
  return {
    norad_id: noradId,
    name: tle.name,
    source: tle.source,
    tle_epoch_utc: epoch,
    tle_age_hours: freshness.ageHours,
    tle_freshness: freshness.freshness,
  };
}

export function unavailableTrajectory(generatedAtUtc: string, warnings: string[], horizonMinutes = 180, cadenceMinutes = 5): LeoTrajectory {
  return {
    status: 'unavailable',
    satellite: null,
    frame: 'TEME',
    propagator: 'SGP4 via satellite.js',
    generated_at_utc: generatedAtUtc,
    horizon_minutes: horizonMinutes,
    cadence_minutes: cadenceMinutes,
    points: [],
    warnings,
  };
}

export function propagateLeoTrajectory(
  tle: SatelliteTLE,
  options: { startMs?: number; horizonMinutes?: number; cadenceMinutes?: number } = {},
): LeoTrajectory {
  const startMs = options.startMs ?? Date.now();
  const generatedAtUtc = new Date(startMs).toISOString();
  const horizonMinutes = Math.max(5, Math.min(1_440, Math.round(options.horizonMinutes ?? 180)));
  const cadenceMinutes = Math.max(1, Math.min(30, Math.round(options.cadenceMinutes ?? 5)));
  const selected = satelliteOption(tle, startMs);
  if (!selected) return unavailableTrajectory(generatedAtUtc, ['The selected TLE has no valid NORAD catalog identifier.'], horizonMinutes, cadenceMinutes);

  let satrec: ReturnType<typeof satellite.twoline2satrec>;
  try {
    satrec = satellite.twoline2satrec(tle.line1, tle.line2);
  } catch {
    return { ...unavailableTrajectory(generatedAtUtc, ['The selected TLE could not be parsed.'], horizonMinutes, cadenceMinutes), satellite: selected };
  }

  const points: LeoTrajectory['points'] = [];
  let failures = 0;
  for (let minute = 0; minute <= horizonMinutes; minute += cadenceMinutes) {
    const date = new Date(startMs + minute * 60_000);
    try {
      const propagated = satellite.propagate(satrec, date);
      if (!propagated) {
        failures += 1;
        continue;
      }
      const positionKm = { ...propagated.position };
      const velocityKmS = { ...propagated.velocity };
      const gmst = satellite.gstime(date);
      const geodetic = satellite.eciToGeodetic(propagated.position, gmst);
      const latitudeDeg = satellite.degreesLat(geodetic.latitude);
      const longitudeDeg = satellite.degreesLong(geodetic.longitude);
      const corotation = atmosphereCorotationVelocity(positionKm);
      const relative = subtractVectors(velocityKmS, corotation);
      const values = [
        positionKm.x, positionKm.y, positionKm.z,
        velocityKmS.x, velocityKmS.y, velocityKmS.z,
        latitudeDeg, longitudeDeg, geodetic.height,
      ];
      if (!values.every(Number.isFinite)) {
        failures += 1;
        continue;
      }
      points.push({
        timestamp_utc: date.toISOString(),
        frame: 'TEME',
        position_km: positionKm,
        velocity_km_s: velocityKmS,
        atmosphere_corotation_velocity_km_s: corotation,
        air_relative_velocity_km_s: relative,
        air_relative_speed_km_s: vectorMagnitude(relative),
        latitude_deg: latitudeDeg,
        longitude_deg: longitudeDeg,
        altitude_km: geodetic.height,
        local_solar_time_h: localSolarTimeHours(date, longitudeDeg),
      });
    } catch {
      failures += 1;
    }
  }

  const warnings: string[] = [];
  if (selected.tle_freshness === 'stale') warnings.push('The CelesTrak TLE epoch is more than 72 hours old; trajectory context is stale.');
  else if (selected.tle_freshness === 'degraded') warnings.push('The CelesTrak TLE epoch is more than 24 hours old; trajectory context is degraded.');
  else if (selected.tle_freshness === 'unknown') warnings.push('The TLE epoch could not be determined.');
  if (failures) warnings.push(`${failures} requested trajectory point${failures === 1 ? '' : 's'} could not be propagated.`);

  return {
    status: points.length === 0
      ? 'unavailable'
      : failures || selected.tle_freshness !== 'fresh'
        ? 'partial'
        : 'available',
    satellite: selected,
    frame: 'TEME',
    propagator: 'SGP4 via satellite.js',
    generated_at_utc: generatedAtUtc,
    horizon_minutes: horizonMinutes,
    cadence_minutes: cadenceMinutes,
    points,
    warnings,
  };
}

export interface LeoTrajectorySelection {
  group: LeoTleGroup;
  selectedNoradId: string | null;
  options: LeoSatelliteOption[];
  trajectory: LeoTrajectory;
  sourceConnected: boolean;
  sourceStale: boolean;
  warnings: string[];
}

export async function selectLeoTrajectory(options: {
  group?: LeoTleGroup;
  noradId?: string | null;
  horizonMinutes?: number;
  cadenceMinutes?: number;
  nowMs?: number;
} = {}): Promise<LeoTrajectorySelection> {
  const group = options.group === 'weather' ? 'weather' : 'stations';
  const nowMs = options.nowMs ?? Date.now();
  const response = await fetchTleGroup(group);
  const catalog = response.tles.map(tle => ({ tle, option: satelliteOption(tle, nowMs) })).filter((entry): entry is { tle: SatelliteTLE; option: LeoSatelliteOption } => entry.option !== null);
  const requested = options.noradId?.trim() || null;
  const selected = (requested ? catalog.find(entry => entry.option.norad_id === requested) : null) ?? catalog[0] ?? null;
  const warnings: string[] = [];
  if (!response.isConnected) warnings.push(response.errorMessage ?? 'CelesTrak is unavailable and no cached TLE catalog exists.');
  if (response.stale) warnings.push('CelesTrak is unavailable; the last in-memory TLE catalog is being used.');
  if (requested && !catalog.some(entry => entry.option.norad_id === requested)) warnings.push(`NORAD ${requested} is not present in the selected CelesTrak group.`);

  const trajectory = selected
    ? propagateLeoTrajectory(selected.tle, {
        startMs: nowMs,
        horizonMinutes: options.horizonMinutes,
        cadenceMinutes: options.cadenceMinutes,
      })
    : unavailableTrajectory(
        new Date(nowMs).toISOString(),
        ['No real TLE is available for trajectory propagation.'],
        options.horizonMinutes,
        options.cadenceMinutes,
      );
  trajectory.warnings = [...warnings, ...trajectory.warnings];

  return {
    group,
    selectedNoradId: selected?.option.norad_id ?? null,
    options: catalog.map(entry => entry.option),
    trajectory,
    sourceConnected: response.isConnected,
    sourceStale: Boolean(response.stale),
    warnings,
  };
}
