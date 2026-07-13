import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LEO_CONTRACT_VERSION,
  LEO_LEGACY_CONTRACT_VERSION,
  type LeoAvailabilityStatus,
  type LeoForecastResponse,
  type LeoForecastSummary,
  type LeoForecastTimelinePoint,
  type LeoForcingPoint,
  type LeoSatelliteOption,
  type LeoSpacecraftScenario,
  type LeoTrajectory,
  type LeoVector3,
} from '../../lib/leo/contracts';
import { computeRealtimeForecast, type RealtimeForecast } from '../realtimeForecastService';
import { buildLeoValidationResponse } from './leoValidationService';
import { selectLeoTrajectory, unavailableTrajectory, type LeoTleGroup, type LeoTrajectorySelection } from './leoTrajectoryService';

export const LEO_FORECAST_SNAPSHOT_FILE = 'forecast-latest.v1.json' as const;
const DEFAULT_SNAPSHOT_MAX_AGE_MINUTES = 30;

export const EMPTY_LEO_FORECAST_SUMMARY: Readonly<LeoForecastSummary> = Object.freeze({
  rho_baseline_kg_m3: null,
  rho_p50_kg_m3: null,
  rho_p10_kg_m3: null,
  rho_p90_kg_m3: null,
  density_enhancement: null,
  drag_acceleration_p50_m_s2: null,
  cumulative_delta_v_m_s: null,
  along_track_estimate_m: null,
  expected_onset_utc: null,
  expected_peak_utc: null,
  expected_recovery_utc: null,
  forecast_confidence: null,
});

function configuredModelRoot(): string {
  const configured = process.env.HELIOSAT_LEO_MODEL_ROOT?.trim();
  return configured ? path.resolve(process.cwd(), configured) : path.join(process.cwd(), 'data', 'model-runs', 'leo-density');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableNonNegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function validIso(value: unknown): string | null {
  const text = asString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function safeArtifactPath(value: unknown): string | null {
  const text = asString(value);
  if (!text || path.isAbsolute(text)) return null;
  const normalized = text.replaceAll('\\', '/');
  return normalized.split('/').includes('..') || normalized.includes('\0') ? null : normalized;
}

function availability(value: unknown): LeoAvailabilityStatus {
  return value === 'available' || value === 'partial' || value === 'unavailable' || value === 'error'
    ? value
    : 'unavailable';
}

function configuredScenario(): LeoSpacecraftScenario {
  const configured = Number(process.env.HELIOSAT_LEO_BALLISTIC_COEFFICIENT_M2_KG);
  const coefficient = Number.isFinite(configured) && configured > 0 ? configured : 0.01;
  return {
    id: 'nominal',
    label: 'Nominal generic drag-sensitivity scenario',
    evidence_class: 'scenario',
    direct_ballistic_coefficient_m2_kg: coefficient,
    mass_kg: null,
    reference_area_m2: null,
    drag_coefficient: null,
    attitude_mode: 'generic sensitivity scenario',
    parameter_source: process.env.HELIOSAT_LEO_BALLISTIC_COEFFICIENT_M2_KG
      ? 'HELIOSAT_LEO_BALLISTIC_COEFFICIENT_M2_KG configuration; not satellite metadata'
      : 'HelioSat nominal sensitivity scenario (0.01 m²/kg); not a property inferred from the selected satellite',
    is_real_satellite_property: false,
  };
}

function couplingElectricField(speedKmS: number | null, bzNt: number | null): number | null {
  if (speedKmS === null || bzNt === null || speedKmS <= 0) return null;
  return speedKmS * Math.max(0, -bzNt) * 1e-3;
}

function forcingFromRealtime(
  realtime: RealtimeForecast,
  trajectory: LeoTrajectorySelection,
): LeoForecastResponse['forcing'] {
  const nowMs = realtime.now;
  const propagated = realtime.mru
    .filter(point => Number.isFinite(point.t))
    .sort((a, b) => a.t - b.t);
  const confirmed = propagated.filter(point => point.t >= nowMs);
  const timeline: LeoForcingPoint[] = confirmed.map(point => ({
    arrival_time_bow_shock_utc: new Date(point.t).toISOString(),
    forcing_mode: 'confirmed_inbound',
    evidence_class: 'experimental_forecast',
    speed_km_s: point.speed,
    bz_gsm_nt: point.bz,
    dynamic_pressure_npa: null,
    em_mv_m: couplingElectricField(point.speed, point.bz),
    newell_coupling: null,
  }));

  const lastPropagated = confirmed.at(-1) ?? propagated.at(-1) ?? null;
  const lastConfirmedMs = lastPropagated?.t ?? nowMs;
  for (const point of trajectory.trajectory.points) {
    const timestampMs = Date.parse(point.timestamp_utc);
    if (timestampMs <= lastConfirmedMs) continue;
    timeline.push({
      arrival_time_bow_shock_utc: point.timestamp_utc,
      forcing_mode: 'assumption_extension',
      evidence_class: 'experimental_forecast',
      speed_km_s: lastPropagated?.speed ?? null,
      bz_gsm_nt: lastPropagated?.bz ?? null,
      dynamic_pressure_npa: null,
      em_mv_m: couplingElectricField(lastPropagated?.speed ?? null, lastPropagated?.bz ?? null),
      newell_coupling: null,
    });
  }

  const extension = timeline.filter(point => point.forcing_mode === 'assumption_extension');
  const warnings: string[] = [];
  if (realtime.warning) warnings.push(realtime.warning);
  if (realtime.qualityFlags.length) warnings.push(`L1 quality flags: ${realtime.qualityFlags.join(', ')}.`);
  if (timeline.some(point => point.dynamic_pressure_npa === null)) warnings.push('Dynamic pressure is not emitted by the shared live propagation series and is left unavailable; no value is inferred.');
  if (extension.length) warnings.push('Beyond the measured inbound queue, physical forcing is an explicit persistence assumption, not new upstream knowledge.');

  const sourceStatus: LeoAvailabilityStatus = propagated.length === 0
    ? 'unavailable'
    : confirmed.length === 0 || realtime.warning || realtime.qualityFlags.length
      ? 'partial'
      : 'available';
  return {
    source_status: sourceStatus,
    l1_sample_time_utc: realtime.current?.sampleTimeUtc ?? null,
    arrival_model: 'HelioSat MRU ballistic propagation to the Earth bow-shock nose',
    confirmed_inbound: {
      start_utc: confirmed.length ? new Date(confirmed[0].t).toISOString() : null,
      end_utc: confirmed.length ? new Date(confirmed[confirmed.length - 1].t).toISOString() : null,
    },
    assumption_extension: {
      start_utc: extension[0]?.arrival_time_bow_shock_utc ?? null,
      end_utc: extension.at(-1)?.arrival_time_bow_shock_utc ?? null,
      policy: 'Persistence of the last propagated physical driver; no new L1 knowledge beyond the confirmed inbound queue.',
    },
    timeline,
    warnings,
  };
}

interface ForecastSnapshot {
  generatedAtUtc: string;
  group: LeoTleGroup;
  selectedNoradId: string;
  model: LeoForecastResponse['model'];
  baseline: LeoForecastResponse['baseline'];
  validatedDomain: LeoForecastResponse['validated_domain'];
  spacecraftParameters: LeoSpacecraftScenario;
  timeline: LeoForecastTimelinePoint[];
  summary: LeoForecastSummary;
  trajectory: LeoTrajectory;
  forcing: LeoForecastResponse['forcing'];
  domainReasons: string[];
  warnings: string[];
  artifact: string;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function unavailableForecastCalibration(reason: string): LeoForecastResponse['model']['uncertainty'] {
  return {
    status: 'unavailable',
    method: null,
    calibration_start_utc: null,
    calibration_end_utc: null,
    sample_count: null,
    block_count: null,
    nominal_coverage: null,
    empirical_coverage: null,
    p10_coverage: null,
    p50_coverage: null,
    p90_coverage: null,
    reason,
  };
}

function probability(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

function normalizeForecastCalibration(
  value: unknown,
  modelVersion: string,
): LeoForecastResponse['model']['uncertainty'] {
  const record = asObject(value);
  if (!record) return unavailableForecastCalibration('No held-out calibration metadata was published for this snapshot.');
  const period = asObject(record.calibration_period) ?? asObject(record.period);
  const recordedModelVersion = asString(record.model_version);
  const start = validIso(record.calibration_start_utc ?? period?.start_utc);
  const end = validIso(record.calibration_end_utc ?? period?.end_utc ?? period?.stop_utc);
  const method = asString(record.method);
  const sampleCount = nullableNonNegative(record.sample_count);
  const nominalCoverage = probability(record.nominal_coverage);
  const empiricalCoverage = probability(record.empirical_coverage);
  const calibrated = record.status === 'calibrated'
    && recordedModelVersion === modelVersion
    && Boolean(method)
    && Boolean(start && end && Date.parse(start) < Date.parse(end))
    && sampleCount !== null && sampleCount > 0
    && nominalCoverage !== null
    && empiricalCoverage !== null;
  if (!calibrated) {
    return {
      ...unavailableForecastCalibration('Calibration metadata is incomplete or does not match the forecast model version.'),
      status: record.status === 'uncalibrated' ? 'uncalibrated' : 'unavailable',
      method,
      calibration_start_utc: start,
      calibration_end_utc: end,
      sample_count: sampleCount,
      block_count: nullableNonNegative(record.block_count),
      nominal_coverage: nominalCoverage,
      empirical_coverage: empiricalCoverage,
    };
  }
  return {
    status: 'calibrated',
    method,
    calibration_start_utc: start,
    calibration_end_utc: end,
    sample_count: sampleCount,
    block_count: nullableNonNegative(record.block_count),
    nominal_coverage: nominalCoverage,
    empirical_coverage: empiricalCoverage,
    p10_coverage: probability(record.p10_coverage),
    p50_coverage: probability(record.p50_coverage),
    p90_coverage: probability(record.p90_coverage),
    reason: asString(record.reason),
  };
}

function removeUncalibratedQuantiles(point: LeoForecastTimelinePoint): LeoForecastTimelinePoint {
  return {
    ...point,
    rho_p10_kg_m3: null,
    rho_p90_kg_m3: null,
    drag_acceleration_p10_m_s2: null,
    drag_acceleration_p90_m_s2: null,
  };
}

function normalizeVector(value: unknown): LeoVector3 | null {
  const vector = asObject(value);
  if (!vector) return null;
  const x = finite(vector.x);
  const y = finite(vector.y);
  const z = finite(vector.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function normalizeSnapshotSatellite(value: unknown, selectedNoradId: string): LeoSatelliteOption | null {
  const satellite = asObject(value);
  if (!satellite || asString(satellite.norad_id) !== selectedNoradId) return null;
  const freshness = satellite.tle_freshness;
  if (freshness !== 'fresh' && freshness !== 'degraded' && freshness !== 'stale' && freshness !== 'unknown') return null;
  const name = asString(satellite.name);
  const source = asString(satellite.source);
  if (!name || !source) return null;
  return {
    norad_id: selectedNoradId,
    name,
    source,
    tle_epoch_utc: satellite.tle_epoch_utc === null ? null : validIso(satellite.tle_epoch_utc),
    tle_age_hours: satellite.tle_age_hours === null ? null : nullableNonNegative(satellite.tle_age_hours),
    tle_freshness: freshness,
  };
}

function normalizeSnapshotTrajectory(
  value: unknown,
  selectedNoradId: string,
  generatedAtUtc: string,
  densityTimeline: LeoForecastTimelinePoint[],
): LeoTrajectory | null {
  const trajectory = asObject(value);
  if (!trajectory || trajectory.frame !== 'TEME' || trajectory.propagator !== 'SGP4 via satellite.js') return null;
  const generated = validIso(trajectory.generated_at_utc);
  const satellite = normalizeSnapshotSatellite(trajectory.satellite, selectedNoradId);
  const horizon = nullableNonNegative(trajectory.horizon_minutes);
  const cadence = nullableNonNegative(trajectory.cadence_minutes);
  const rawPoints = Array.isArray(trajectory.points) ? trajectory.points : [];
  const contextLagMs = generated ? Date.parse(generatedAtUtc) - Date.parse(generated) : Number.NaN;
  if (!generated || contextLagMs < -5_000 || contextLagMs > 60_000 || !satellite || horizon === null || cadence === null || cadence === 0 || rawPoints.length !== densityTimeline.length) return null;
  const points = rawPoints.map((raw, index) => {
    const point = asObject(raw);
    if (!point || point.frame !== 'TEME') return null;
    const timestamp = validIso(point.timestamp_utc);
    const position = normalizeVector(point.position_km);
    const velocity = normalizeVector(point.velocity_km_s);
    const corotation = normalizeVector(point.atmosphere_corotation_velocity_km_s);
    const relative = normalizeVector(point.air_relative_velocity_km_s);
    const relativeSpeed = nullableNonNegative(point.air_relative_speed_km_s);
    const latitude = finite(point.latitude_deg);
    const longitude = finite(point.longitude_deg);
    const altitude = nullableNonNegative(point.altitude_km);
    const localSolarTime = point.local_solar_time_h === null ? null : nullableNonNegative(point.local_solar_time_h);
    if (!timestamp || Date.parse(timestamp) !== Date.parse(densityTimeline[index].timestamp_utc) || !position || !velocity || !corotation || !relative || relativeSpeed === null || latitude === null || longitude === null || altitude === null || (point.local_solar_time_h !== null && localSolarTime === null)) return null;
    return {
      timestamp_utc: timestamp,
      frame: 'TEME' as const,
      position_km: position,
      velocity_km_s: velocity,
      atmosphere_corotation_velocity_km_s: corotation,
      air_relative_velocity_km_s: relative,
      air_relative_speed_km_s: relativeSpeed,
      latitude_deg: latitude,
      longitude_deg: longitude,
      altitude_km: altitude,
      local_solar_time_h: localSolarTime,
    };
  });
  if (points.some(point => point === null)) return null;
  const status = availability(trajectory.status);
  if (status !== 'available' && status !== 'partial') return null;
  return {
    status,
    satellite,
    frame: 'TEME',
    propagator: 'SGP4 via satellite.js',
    generated_at_utc: generated,
    horizon_minutes: horizon,
    cadence_minutes: cadence,
    points: points as LeoTrajectory['points'],
    warnings: stringList(trajectory.warnings),
  };
}

function normalizeSnapshotForcing(
  value: unknown,
  densityTimeline: LeoForecastTimelinePoint[],
): LeoForecastResponse['forcing'] | null {
  const forcing = asObject(value);
  const confirmed = forcing ? asObject(forcing.confirmed_inbound) : null;
  const extension = forcing ? asObject(forcing.assumption_extension) : null;
  const rawTimeline = forcing && Array.isArray(forcing.timeline) ? forcing.timeline : [];
  const arrivalModel = forcing ? asString(forcing.arrival_model) : null;
  const policy = extension ? asString(extension.policy) : null;
  if (!forcing || !confirmed || !extension || !arrivalModel || !policy || rawTimeline.length !== densityTimeline.length) return null;
  const timeline = rawTimeline.map((raw, index): LeoForcingPoint | null => {
    const point = asObject(raw);
    const timestamp = point ? validIso(point.arrival_time_bow_shock_utc) : null;
    const forcingMode = point?.forcing_mode === 'confirmed_inbound' ? 'confirmed_inbound' : point?.forcing_mode === 'assumption_extension' ? 'assumption_extension' : null;
    if (!point || !timestamp || !forcingMode || Date.parse(timestamp) !== Date.parse(densityTimeline[index].timestamp_utc)) return null;
    return {
      arrival_time_bow_shock_utc: timestamp,
      forcing_mode: forcingMode,
      evidence_class: 'experimental_forecast',
      speed_km_s: point.speed_km_s === null ? null : nullableNonNegative(point.speed_km_s),
      bz_gsm_nt: point.bz_gsm_nt === null ? null : finite(point.bz_gsm_nt),
      dynamic_pressure_npa: point.dynamic_pressure_npa === null ? null : nullableNonNegative(point.dynamic_pressure_npa),
      em_mv_m: point.em_mv_m === null ? null : nullableNonNegative(point.em_mv_m),
      newell_coupling: point.newell_coupling === null ? null : nullableNonNegative(point.newell_coupling),
    };
  });
  if (timeline.some(point => point === null)) return null;
  const sourceStatus = availability(forcing.source_status);
  if (sourceStatus !== 'available' && sourceStatus !== 'partial') return null;
  const optionalIso = (input: unknown) => input === null ? null : validIso(input);
  const l1Sample = optionalIso(forcing.l1_sample_time_utc);
  const confirmedStart = optionalIso(confirmed.start_utc);
  const confirmedEnd = optionalIso(confirmed.end_utc);
  const extensionStart = optionalIso(extension.start_utc);
  const extensionEnd = optionalIso(extension.end_utc);
  if ((forcing.l1_sample_time_utc !== null && !l1Sample)
    || (confirmed.start_utc !== null && !confirmedStart)
    || (confirmed.end_utc !== null && !confirmedEnd)
    || (extension.start_utc !== null && !extensionStart)
    || (extension.end_utc !== null && !extensionEnd)) return null;
  return {
    source_status: sourceStatus,
    l1_sample_time_utc: l1Sample,
    arrival_model: arrivalModel,
    confirmed_inbound: { start_utc: confirmedStart, end_utc: confirmedEnd },
    assumption_extension: { start_utc: extensionStart, end_utc: extensionEnd, policy },
    timeline: timeline as LeoForcingPoint[],
    warnings: stringList(forcing.warnings),
  };
}

function normalizeTimelinePoint(value: unknown): LeoForecastTimelinePoint | null {
  const point = asObject(value);
  const timestamp = point ? validIso(point.timestamp_utc) : null;
  if (!point || !timestamp) return null;
  const forcingMode = point.forcing_mode === 'confirmed_inbound' ? 'confirmed_inbound' : point.forcing_mode === 'assumption_extension' ? 'assumption_extension' : null;
  if (!forcingMode) return null;
  return {
    timestamp_utc: timestamp,
    forcing_mode: forcingMode,
    density_evidence_class: 'experimental_forecast',
    impact_evidence_class: 'scenario',
    rho_baseline_kg_m3: nullableNonNegative(point.rho_baseline_kg_m3),
    rho_p10_kg_m3: nullableNonNegative(point.rho_p10_kg_m3),
    rho_p50_kg_m3: nullableNonNegative(point.rho_p50_kg_m3),
    rho_p90_kg_m3: nullableNonNegative(point.rho_p90_kg_m3),
    drag_acceleration_baseline_m_s2: nullableNonNegative(point.drag_acceleration_baseline_m_s2),
    drag_acceleration_p10_m_s2: nullableNonNegative(point.drag_acceleration_p10_m_s2),
    drag_acceleration_p50_m_s2: nullableNonNegative(point.drag_acceleration_p50_m_s2),
    drag_acceleration_p90_m_s2: nullableNonNegative(point.drag_acceleration_p90_m_s2),
    cumulative_delta_v_baseline_m_s: nullableNonNegative(point.cumulative_delta_v_baseline_m_s),
    cumulative_delta_v_p50_m_s: nullableNonNegative(point.cumulative_delta_v_p50_m_s),
    along_track_baseline_m: finite(point.along_track_baseline_m),
    along_track_p50_m: finite(point.along_track_p50_m),
    altitude_km: nullableNonNegative(point.altitude_km),
    latitude_deg: finite(point.latitude_deg),
    longitude_deg: finite(point.longitude_deg),
    local_solar_time_h: nullableNonNegative(point.local_solar_time_h),
  };
}

function normalizeSummary(value: unknown): LeoForecastSummary {
  const summary = asObject(value) ?? {};
  return {
    rho_baseline_kg_m3: nullableNonNegative(summary.rho_baseline_kg_m3),
    rho_p50_kg_m3: nullableNonNegative(summary.rho_p50_kg_m3),
    rho_p10_kg_m3: nullableNonNegative(summary.rho_p10_kg_m3),
    rho_p90_kg_m3: nullableNonNegative(summary.rho_p90_kg_m3),
    density_enhancement: nullableNonNegative(summary.density_enhancement),
    drag_acceleration_p50_m_s2: nullableNonNegative(summary.drag_acceleration_p50_m_s2),
    cumulative_delta_v_m_s: nullableNonNegative(summary.cumulative_delta_v_m_s),
    along_track_estimate_m: finite(summary.along_track_estimate_m),
    expected_onset_utc: validIso(summary.expected_onset_utc),
    expected_peak_utc: validIso(summary.expected_peak_utc),
    expected_recovery_utc: validIso(summary.expected_recovery_utc),
    forecast_confidence: asString(summary.forecast_confidence),
  };
}

export function normalizeLeoForecastSnapshot(value: unknown, artifact: string): ForecastSnapshot | null {
  const snapshot = asObject(value);
  if (!snapshot
    || (snapshot.schema_version !== LEO_CONTRACT_VERSION && snapshot.schema_version !== LEO_LEGACY_CONTRACT_VERSION)
    || snapshot.forecast_mode !== 'experimental') return null;
  const generatedAtUtc = validIso(snapshot.generated_at_utc);
  const selector = asObject(snapshot.selector);
  const selectedNoradId = selector ? asString(selector.selected_norad_id) : null;
  const group = selector?.group === 'weather' ? 'weather' : selector?.group === 'stations' ? 'stations' : null;
  const model = asObject(snapshot.model);
  const baseline = asObject(snapshot.baseline);
  const spacecraft = asObject(snapshot.spacecraft_parameters);
  const rawTimeline = Array.isArray(snapshot.timeline) ? snapshot.timeline : [];
  const parsedTimeline = rawTimeline.map(normalizeTimelinePoint).filter((point): point is LeoForecastTimelinePoint => point !== null);
  const modelVersion = model ? asString(model.version) : null;
  const calibration = modelVersion
    ? normalizeForecastCalibration(model?.uncertainty ?? snapshot.uncertainty_calibration, modelVersion)
    : unavailableForecastCalibration('The forecast model version is unavailable.');
  const hasPublishedQuantiles = parsedTimeline.some(point => point.rho_p10_kg_m3 !== null
    || point.rho_p90_kg_m3 !== null
    || point.drag_acceleration_p10_m_s2 !== null
    || point.drag_acceleration_p90_m_s2 !== null);
  const timeline = calibration.status === 'calibrated'
    ? parsedTimeline
    : parsedTimeline.map(removeUncalibratedQuantiles);
  const coefficient = spacecraft ? nullableNonNegative(spacecraft.direct_ballistic_coefficient_m2_kg) : null;
  const scenarioId = spacecraft?.id === 'low-drag' || spacecraft?.id === 'nominal' || spacecraft?.id === 'high-drag' ? spacecraft.id : null;
  if (!generatedAtUtc || !selectedNoradId || !group || !model || availability(model.status) !== 'available' || !modelVersion || timeline.length === 0 || timeline.length !== rawTimeline.length || !timeline.some(point => point.rho_p50_kg_m3 !== null) || !spacecraft || !scenarioId || coefficient === null || coefficient === 0 || spacecraft.is_real_satellite_property !== false) return null;
  if (timeline.some(point => {
    const density = [point.rho_p10_kg_m3, point.rho_p50_kg_m3, point.rho_p90_kg_m3];
    const drag = [point.drag_acceleration_p10_m_s2, point.drag_acceleration_p50_m_s2, point.drag_acceleration_p90_m_s2];
    return density.every((item): item is number => item !== null) && !(density[0] <= density[1] && density[1] <= density[2])
      || drag.every((item): item is number => item !== null) && !(drag[0] <= drag[1] && drag[1] <= drag[2]);
  })) return null;

  const trainingRange = asObject(model.training_range);
  const trainingStart = trainingRange ? validIso(trainingRange.start_utc) : null;
  const trainingEnd = trainingRange ? validIso(trainingRange.end_utc) : null;
  const domain = asObject(snapshot.validated_domain);
  const altitudeMin = domain ? nullableNonNegative(domain.altitude_min_km) : null;
  const altitudeMax = domain ? nullableNonNegative(domain.altitude_max_km) : null;
  const missions = domain && Array.isArray(domain.missions) ? domain.missions.filter((item): item is string => typeof item === 'string') : [];
  if (!trainingStart || !trainingEnd || altitudeMin === null || altitudeMax === null || altitudeMin >= altitudeMax) return null;
  const trajectory = normalizeSnapshotTrajectory(snapshot.trajectory, selectedNoradId, generatedAtUtc, timeline);
  const forcing = normalizeSnapshotForcing(snapshot.forcing, timeline);
  if (!trajectory || !forcing) return null;
  const domainReasons: string[] = [];
  if (domain?.mission_category_validated === false) {
    domainReasons.push('The generic TLE mission/spacecraft categories were not represented in M3 training.');
  }
  const featureViolations = stringList(domain?.feature_range_violations);
  if (featureViolations.length) {
    domainReasons.push(`${featureViolations.length} live feature(s) exceed their fitted training range.`);
  }
  const safeSourceArtifact = safeArtifactPath(artifact) ?? LEO_FORECAST_SNAPSHOT_FILE;

  return {
    generatedAtUtc,
    group,
    selectedNoradId,
    model: {
      status: 'available',
      version: modelVersion,
      artifact: safeArtifactPath(model.artifact) ?? safeSourceArtifact,
      training_range: { start_utc: trainingStart, end_utc: trainingEnd },
      uncertainty: calibration,
    },
    baseline: {
      status: baseline ? availability(baseline.status) : 'unavailable',
      model_name: baseline ? asString(baseline.model_name) : null,
      model_version: baseline ? asString(baseline.model_version) : null,
      licensing_status: baseline ? asString(baseline.licensing_status) ?? 'Licensing status was not recorded in the snapshot.' : 'Baseline metadata is unavailable.',
    },
    validatedDomain: { altitude_min_km: altitudeMin, altitude_max_km: altitudeMax, missions },
    spacecraftParameters: {
      id: scenarioId,
      label: asString(spacecraft.label) ?? `${scenarioId} generic scenario`,
      evidence_class: 'scenario',
      direct_ballistic_coefficient_m2_kg: coefficient,
      mass_kg: null,
      reference_area_m2: null,
      drag_coefficient: null,
      attitude_mode: 'generic sensitivity scenario',
      parameter_source: asString(spacecraft.parameter_source) ?? 'Versioned forecast snapshot; not satellite metadata',
      is_real_satellite_property: false,
    },
    timeline,
    summary: (() => {
      const summary = normalizeSummary(snapshot.summary);
      return calibration.status === 'calibrated' ? summary : { ...summary, rho_p10_kg_m3: null, rho_p90_kg_m3: null };
    })(),
    trajectory,
    forcing,
    domainReasons,
    warnings: [
      ...stringList(snapshot.warnings),
      ...(hasPublishedQuantiles && calibration.status !== 'calibrated'
        ? ['Snapshot quantiles were withheld because calibration metadata was unavailable, incomplete or version-mismatched.']
        : []),
    ],
    artifact: safeSourceArtifact,
  };
}

async function findForecastSnapshot(
  selectedNoradId: string | null,
  group: LeoTleGroup,
  horizonMinutes: number,
  cadenceMinutes: number,
  nowMs: number,
): Promise<{ snapshot: ForecastSnapshot | null; warnings: string[] }> {
  if (!selectedNoradId) return { snapshot: null, warnings: [] };
  const root = configuredModelRoot();
  const candidates: Array<{ file: string; modifiedMs: number }> = [];
  const add = async (file: string) => {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) candidates.push({ file, modifiedMs: stat.mtimeMs });
    } catch {
      // Missing snapshots are an expected unavailable state.
    }
  };
  await add(path.join(root, LEO_FORECAST_SNAPSHOT_FILE));
  try {
    const dirs = await fs.readdir(root, { withFileTypes: true });
    await Promise.all(dirs.filter(entry => entry.isDirectory()).map(entry => add(path.join(root, entry.name, LEO_FORECAST_SNAPSHOT_FILE))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { snapshot: null, warnings: ['The LEO forecast artifact directory could not be read.'] };
  }

  const warnings: string[] = [];
  const maxAgeRaw = Number(process.env.HELIOSAT_LEO_FORECAST_MAX_AGE_MINUTES);
  const maxAgeMinutes = Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : DEFAULT_SNAPSHOT_MAX_AGE_MINUTES;
  for (const candidate of candidates.sort((a, b) => b.modifiedMs - a.modifiedMs)) {
    try {
      const relative = path.relative(process.cwd(), candidate.file);
      const displayPath = safeArtifactPath(relative) ?? LEO_FORECAST_SNAPSHOT_FILE;
      const snapshot = normalizeLeoForecastSnapshot(JSON.parse(await fs.readFile(candidate.file, 'utf8')) as unknown, displayPath);
      if (!snapshot) {
        warnings.push(`${displayPath} does not match the versioned forecast snapshot contract.`);
        continue;
      }
      if (snapshot.selectedNoradId !== selectedNoradId || snapshot.group !== group) continue;
      if (snapshot.trajectory.horizon_minutes !== horizonMinutes || snapshot.trajectory.cadence_minutes !== cadenceMinutes) {
        warnings.push(`${displayPath} does not match the requested ${horizonMinutes}-minute/${cadenceMinutes}-minute trajectory grid.`);
        continue;
      }
      const ageMinutes = (nowMs - Date.parse(snapshot.generatedAtUtc)) / 60_000;
      if (ageMinutes < -5 || ageMinutes > maxAgeMinutes) {
        warnings.push(`${displayPath} is outside the ${maxAgeMinutes}-minute freshness window and its density values were not served.`);
        continue;
      }
      warnings.push(`Density and drag values come from ${displayPath}, generated ${Math.max(0, ageMinutes).toFixed(1)} minutes before this request.`);
      return { snapshot, warnings };
    } catch {
      warnings.push(`${safeArtifactPath(path.relative(process.cwd(), candidate.file)) ?? LEO_FORECAST_SNAPSHOT_FILE} could not be parsed.`);
    }
  }
  return { snapshot: null, warnings };
}

export function outOfDistribution(
  domain: LeoForecastResponse['validated_domain'],
  trajectory: LeoTrajectorySelection['trajectory'],
  additionalReasons: string[] = [],
): LeoForecastResponse['out_of_distribution'] {
  if (!domain || domain.altitude_min_km === null || domain.altitude_max_km === null || trajectory.points.length === 0) {
    return additionalReasons.length
      ? { is_out_of_domain: true, reasons: additionalReasons }
      : { is_out_of_domain: null, reasons: [] };
  }
  const min = Math.min(...trajectory.points.map(point => point.altitude_km));
  const max = Math.max(...trajectory.points.map(point => point.altitude_km));
  const reasons: string[] = [...additionalReasons];
  if (min < domain.altitude_min_km) reasons.push(`Trajectory descends below the validated altitude minimum (${domain.altitude_min_km.toFixed(1)} km).`);
  if (max > domain.altitude_max_km) reasons.push(`Trajectory rises above the validated altitude maximum (${domain.altitude_max_km.toFixed(1)} km).`);
  return { is_out_of_domain: reasons.length > 0, reasons };
}

export async function buildLeoForecast(options: {
  group?: LeoTleGroup;
  noradId?: string | null;
  horizonMinutes?: number;
  cadenceMinutes?: number;
} = {}): Promise<LeoForecastResponse> {
  const nowMs = Date.now();
  const generatedAtUtc = new Date(nowMs).toISOString();
  const requestedGroup: LeoTleGroup = options.group === 'weather' ? 'weather' : 'stations';
  const requestedHorizon = Math.max(30, Math.min(1_440, Math.round(options.horizonMinutes ?? 180)));
  const requestedCadence = Math.max(1, Math.min(30, Math.round(options.cadenceMinutes ?? 5)));
  const [trajectoryResult, realtimeResult, validationResult] = await Promise.allSettled([
    selectLeoTrajectory({ ...options, group: requestedGroup, horizonMinutes: requestedHorizon, cadenceMinutes: requestedCadence, nowMs }),
    computeRealtimeForecast(),
    buildLeoValidationResponse(),
  ]);

  const trajectory = trajectoryResult.status === 'fulfilled'
    ? trajectoryResult.value
    : {
        group: requestedGroup,
        selectedNoradId: null,
        options: [],
        trajectory: unavailableTrajectory(generatedAtUtc, ['CelesTrak trajectory retrieval failed.'], requestedHorizon, requestedCadence),
        sourceConnected: false,
        sourceStale: false,
        warnings: ['CelesTrak trajectory retrieval failed.'],
      };
  const snapshotSelection = trajectory.selectedNoradId ?? options.noradId?.trim() ?? null;
  const snapshotResult = await findForecastSnapshot(
    snapshotSelection, requestedGroup, requestedHorizon, requestedCadence, nowMs,
  );
  const snapshot = snapshotResult.snapshot;
  const realtime = realtimeResult.status === 'fulfilled' ? realtimeResult.value : null;
  const currentForcing = realtime
    ? forcingFromRealtime(realtime, trajectory)
    : {
        source_status: 'error' as const,
        l1_sample_time_utc: null,
        arrival_model: 'HelioSat MRU ballistic propagation to the Earth bow-shock nose',
        confirmed_inbound: { start_utc: null, end_utc: null },
        assumption_extension: { start_utc: null, end_utc: null, policy: 'No extension is generated without a real propagated L1 driver.' },
        timeline: [],
        warnings: ['The live L1-to-bow-shock forcing pipeline is unavailable.'],
      };

  const effectiveTrajectory = snapshot?.trajectory ?? trajectory.trajectory;
  const effectiveForcing = snapshot?.forcing ?? currentForcing;
  const warnings = snapshot
    ? [...snapshot.warnings, ...effectiveTrajectory.warnings, ...effectiveForcing.warnings, ...snapshotResult.warnings]
    : [...effectiveTrajectory.warnings, ...effectiveForcing.warnings, ...snapshotResult.warnings];
  if (validationResult.status === 'fulfilled' && validationResult.value.status !== 'available') {
    warnings.push('No fully available held-out LEO validation study is currently published.');
  }
  if (validationResult.status === 'rejected') warnings.push('The held-out LEO validation artifact could not be inspected.');
  if (!snapshot) warnings.push(`No fresh ${LEO_FORECAST_SNAPSHOT_FILE} for the selected NORAD object is available; density and drag values remain null.`);
  const errors: string[] = [];
  if (trajectoryResult.status === 'rejected') errors.push('Future TLE trajectory retrieval failed.');
  if (realtimeResult.status === 'rejected') errors.push('Live L1-to-bow-shock forcing retrieval failed.');

  const model = snapshot?.model ?? {
    status: 'unavailable' as const,
    version: null,
    artifact: null,
    training_range: null,
    uncertainty: unavailableForecastCalibration('No fresh versioned forecast model snapshot is available.'),
  };
  const baseline = snapshot?.baseline ?? {
    status: 'unavailable' as const,
    model_name: null,
    model_version: null,
    licensing_status: 'NRLMSIS research use is gated internally; no live baseline result is available in this response.',
  };
  const domain = snapshot?.validatedDomain ?? null;
  const ood = outOfDistribution(domain, effectiveTrajectory, snapshot?.domainReasons ?? []);
  warnings.push(...ood.reasons);

  const hasPhysicalContext = effectiveTrajectory.points.length > 0 || effectiveForcing.timeline.length > 0;
  const status: LeoAvailabilityStatus = snapshot
    ? errors.length || ood.is_out_of_domain || snapshot.baseline.status !== 'available' || effectiveTrajectory.status !== 'available' || effectiveForcing.source_status !== 'available' ? 'partial' : 'available'
    : hasPhysicalContext
      ? 'partial'
      : errors.length
        ? 'error'
        : 'unavailable';

  return {
    schema_version: LEO_CONTRACT_VERSION,
    generated_at_utc: snapshot?.generatedAtUtc ?? generatedAtUtc,
    forecast_mode: 'experimental',
    research_stage: 'experimental_live',
    evidence_classes: ['experimental_forecast', 'scenario'],
    status,
    research_label: 'Research model, not operational',
    selector: {
      group: snapshot?.group ?? trajectory.group,
      selected_norad_id: snapshot?.selectedNoradId ?? trajectory.selectedNoradId,
      options: trajectory.options,
    },
    model,
    baseline,
    validated_domain: domain,
    out_of_distribution: ood,
    spacecraft_parameters: snapshot?.spacecraftParameters ?? configuredScenario(),
    trajectory: effectiveTrajectory,
    forcing: effectiveForcing,
    timeline: snapshot?.timeline ?? null,
    summary: snapshot?.summary ?? { ...EMPTY_LEO_FORECAST_SUMMARY },
    assumptions: {
      atmosphere_corotation: 'rigid Earth co-rotation',
      neutral_winds: 'not modeled',
      orbit_source: effectiveTrajectory.satellite?.source ?? null,
      orbital_impact: 'first-order estimate, not precise orbit determination',
    },
    data_health: {
      tle_catalog: trajectory.sourceConnected ? (trajectory.sourceStale ? 'stale_cache' : 'connected') : 'unavailable',
      tle_freshness: effectiveTrajectory.satellite?.tle_freshness ?? 'unknown',
      l1_to_bow_shock: effectiveForcing.source_status,
      density_snapshot: snapshot ? 'fresh_versioned_artifact' : 'unavailable',
      density_snapshot_artifact: snapshot?.artifact ?? null,
      physical_context_generated_at_utc: effectiveTrajectory.generated_at_utc,
    },
    warnings: [...new Set(warnings)],
    errors,
  };
}
