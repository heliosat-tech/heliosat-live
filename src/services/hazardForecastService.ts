import { FORECAST_MODEL_VERSION, type ForecastConfidence, type ForecastRealtimeV1 } from '@/lib/api/forecastContract';

const MIN = 60_000;

export type HazardSeverity = 'low' | 'moderate' | 'high' | 'severe';
export type HazardEventType =
  | 'incoming_shock'
  | 'southward_bz_interval'
  | 'high_dynamic_pressure_interval'
  | 'high_coupling_interval'
  | 'geomagnetic_risk_window';

export interface HazardPhysicalDrivers {
  speed_km_s: number | null;
  density_cm3: number | null;
  bz_gsm_nt: number | null;
  bt_nt: number | null;
  dynamic_pressure_npa: number | null;
  coupling_electric_field_mv_m: number | null;
  rolling_min_bz_gsm_nt_60m: number | null;
  rolling_max_dynamic_pressure_npa_60m: number | null;
  rolling_max_coupling_electric_field_mv_m_60m: number | null;
  gradients_per_minute: {
    speed_km_s: number | null;
    density_cm3: number | null;
    bt_nt: number | null;
    dynamic_pressure_npa: number | null;
  };
}

export interface HazardEvent {
  type: HazardEventType;
  severity: HazardSeverity;
  confidence: ForecastConfidence;
  expected_start_utc: string | null;
  expected_peak_utc: string | null;
  expected_end_utc: string | null;
  lead_time_minutes: number | null;
  main_driver: string;
  physical_drivers: HazardPhysicalDrivers;
  operator_message: string;
}

export interface HazardAssessment {
  generated_at: string;
  model_version: string;
  forecast_issued_at: string | null;
  expected_start_utc: string | null;
  expected_peak_utc: string | null;
  expected_end_utc: string | null;
  lead_time_minutes: number | null;
  severity: HazardSeverity;
  confidence: ForecastConfidence;
  main_driver: string;
  physical_drivers: HazardPhysicalDrivers;
  estimated_g_level_proxy: string;
  operator_message: string;
  quality_flags: string[];
  limitations: string[];
}

export interface HazardEventsResponse {
  generated_at: string;
  model_version: string;
  forecast_issued_at: string | null;
  window_minutes: number | null;
  events: HazardEvent[];
  quality_flags: string[];
  limitations: string[];
}

export interface HazardResponse {
  hazard: HazardAssessment;
  events: HazardEvent[];
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dynamicPressureNpa(speedKmS: number | null, densityCm3: number | null): number | null {
  const speed = finite(speedKmS);
  const density = finite(densityCm3);
  if (speed === null || density === null || speed <= 0 || density < 0) return null;
  return Math.round(1.6726219e-6 * density * speed * speed * 100) / 100;
}

function couplingElectricFieldMvM(speedKmS: number | null, bzNt: number | null): number | null {
  const speed = finite(speedKmS);
  const bz = finite(bzNt);
  if (speed === null || bz === null || speed <= 0) return null;
  return Math.round(speed * Math.max(0, -bz) * 1e-3 * 100) / 100;
}

function arrivalWindow(forecast: ForecastRealtimeV1): {
  startUtc: string | null;
  peakUtc: string | null;
  endUtc: string | null;
  leadMinutes: number | null;
} {
  const peakUtc = forecast.arrival_time_utc ?? forecast.arrival?.estimated_utc ?? null;
  if (!peakUtc) return { startUtc: null, peakUtc: null, endUtc: null, leadMinutes: null };
  const peakMs = new Date(peakUtc).getTime();
  if (Number.isNaN(peakMs)) return { startUtc: null, peakUtc: null, endUtc: null, leadMinutes: null };
  const uncertainty = finite(forecast.arrival_uncertainty_minutes) ?? 12;
  return {
    startUtc: new Date(peakMs - uncertainty * MIN).toISOString(),
    peakUtc,
    endUtc: new Date(peakMs + uncertainty * MIN).toISOString(),
    leadMinutes: finite(forecast.lead_time_minutes),
  };
}

function physicalDrivers(forecast: ForecastRealtimeV1): HazardPhysicalDrivers {
  const speed = finite(forecast.propagated_variables?.speed_km_s) ?? finite(forecast.observed?.speed_km_s);
  const density = finite(forecast.propagated_variables?.density_cm3) ?? finite(forecast.observed?.density_p_cm3);
  const bz = finite(forecast.propagated_variables?.bz_gsm_nt) ?? finite(forecast.observed?.bz_nt);
  const bt = finite(forecast.propagated_variables?.bt_nt);
  const derived = forecast.derived_features;

  return {
    speed_km_s: speed,
    density_cm3: density,
    bz_gsm_nt: bz,
    bt_nt: bt,
    dynamic_pressure_npa: finite(derived?.dynamic_pressure_npa) ?? dynamicPressureNpa(speed, density),
    coupling_electric_field_mv_m: finite(derived?.coupling_electric_field_mv_m) ?? couplingElectricFieldMvM(speed, bz),
    rolling_min_bz_gsm_nt_60m: finite(derived?.rolling_min_bz_gsm_nt.minutes_60) ?? bz,
    rolling_max_dynamic_pressure_npa_60m: finite(derived?.rolling_max_dynamic_pressure_npa.minutes_60),
    rolling_max_coupling_electric_field_mv_m_60m: finite(derived?.rolling_max_coupling_electric_field_mv_m.minutes_60),
    gradients_per_minute: {
      speed_km_s: finite(derived?.gradients_per_minute.speed_km_s),
      density_cm3: finite(derived?.gradients_per_minute.density_cm3),
      bt_nt: finite(derived?.gradients_per_minute.bt_nt),
      dynamic_pressure_npa: finite(derived?.gradients_per_minute.dynamic_pressure_npa),
    },
  };
}

function severityFromBz(bz: number | null): HazardSeverity | null {
  if (bz === null) return null;
  if (bz <= -20) return 'severe';
  if (bz <= -15) return 'high';
  if (bz <= -10) return 'moderate';
  if (bz <= -5) return 'low';
  return null;
}

function severityFromPdyn(pdyn: number | null): HazardSeverity | null {
  if (pdyn === null) return null;
  if (pdyn >= 10) return 'severe';
  if (pdyn >= 6) return 'high';
  if (pdyn >= 3) return 'moderate';
  return null;
}

function severityFromEm(em: number | null): HazardSeverity | null {
  if (em === null) return null;
  if (em >= 9) return 'severe';
  if (em >= 6) return 'high';
  if (em >= 4) return 'moderate';
  if (em >= 2.5) return 'low';
  return null;
}

function severityFromShockGradient(drivers: HazardPhysicalDrivers): HazardSeverity | null {
  const dP = drivers.gradients_per_minute.dynamic_pressure_npa;
  const dV = drivers.gradients_per_minute.speed_km_s;
  const dN = drivers.gradients_per_minute.density_cm3;
  const dBt = drivers.gradients_per_minute.bt_nt;
  if ((dP !== null && dP >= 0.25) || (dV !== null && dV >= 8) || (dN !== null && dN >= 1) || (dBt !== null && dBt >= 0.5)) {
    return 'high';
  }
  if ((dP !== null && dP >= 0.1) || (dV !== null && dV >= 4) || (dN !== null && dN >= 0.4) || (dBt !== null && dBt >= 0.25)) {
    return 'moderate';
  }
  return null;
}

const severityRank: Record<HazardSeverity, number> = { low: 1, moderate: 2, high: 3, severe: 4 };

function maxSeverity(a: HazardSeverity, b: HazardSeverity): HazardSeverity {
  return severityRank[b] > severityRank[a] ? b : a;
}

function gProxyForSeverity(severity: HazardSeverity): string {
  if (severity === 'severe') return 'G4-G5 possible';
  if (severity === 'high') return 'G2-G3 possible';
  if (severity === 'moderate') return 'G1 possible';
  return 'G0 expected';
}

function eventMessage(type: HazardEventType, severity: HazardSeverity): string {
  if (type === 'incoming_shock') return `${severity} shock-like gradient inbound; watch pressure, field magnitude and speed changes near ETA.`;
  if (type === 'southward_bz_interval') return `${severity} southward Bz driver inbound; geomagnetic coupling risk increases near ETA.`;
  if (type === 'high_dynamic_pressure_interval') return `${severity} dynamic-pressure enhancement inbound; expect magnetopause compression risk near ETA.`;
  if (type === 'high_coupling_interval') return `${severity} solar-wind coupling driver inbound; geomagnetic response proxy may rise near ETA.`;
  return `${severity} combined geomagnetic risk window from propagated physical drivers.`;
}

function makeEvent(
  type: HazardEventType,
  severity: HazardSeverity,
  confidence: ForecastConfidence,
  forecast: ForecastRealtimeV1,
  drivers: HazardPhysicalDrivers,
  mainDriver: string,
): HazardEvent {
  const window = arrivalWindow(forecast);
  return {
    type,
    severity,
    confidence,
    expected_start_utc: window.startUtc,
    expected_peak_utc: window.peakUtc,
    expected_end_utc: window.endUtc,
    lead_time_minutes: window.leadMinutes,
    main_driver: mainDriver,
    physical_drivers: drivers,
    operator_message: eventMessage(type, severity),
  };
}

export function buildHazardEvents(forecast: ForecastRealtimeV1, windowMinutes: number | null = null): HazardEvent[] {
  const drivers = physicalDrivers(forecast);
  const confidence = forecast.confidence ?? 'low';
  const events: HazardEvent[] = [];

  const shockSeverity = severityFromShockGradient(drivers);
  if (shockSeverity) events.push(makeEvent('incoming_shock', shockSeverity, confidence, forecast, drivers, 'rapid solar-wind gradient'));

  const bzSeverity = severityFromBz(drivers.rolling_min_bz_gsm_nt_60m);
  if (bzSeverity) events.push(makeEvent('southward_bz_interval', bzSeverity, confidence, forecast, drivers, 'southward Bz GSM'));

  const pdynSeverity = severityFromPdyn(drivers.rolling_max_dynamic_pressure_npa_60m ?? drivers.dynamic_pressure_npa);
  if (pdynSeverity) events.push(makeEvent('high_dynamic_pressure_interval', pdynSeverity, confidence, forecast, drivers, 'dynamic pressure'));

  const emSeverity = severityFromEm(drivers.rolling_max_coupling_electric_field_mv_m_60m ?? drivers.coupling_electric_field_mv_m);
  if (emSeverity) events.push(makeEvent('high_coupling_interval', emSeverity, confidence, forecast, drivers, 'coupling electric field'));

  const strongest = events.reduce<HazardSeverity>((severity, event) => maxSeverity(severity, event.severity), 'low');
  if (severityRank[strongest] >= severityRank.moderate) {
    events.push(makeEvent('geomagnetic_risk_window', strongest, confidence, forecast, drivers, mainDriverFromEvents(events)));
  }

  if (windowMinutes === null) return events;
  return events.filter(event => event.lead_time_minutes === null || event.lead_time_minutes <= windowMinutes);
}

function mainDriverFromEvents(events: HazardEvent[]): string {
  const ordered = events.slice().sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
  return ordered[0]?.main_driver ?? 'none';
}

function scoreHazard(drivers: HazardPhysicalDrivers, hasShock: boolean): { severity: HazardSeverity; mainDriver: string } {
  const candidates: Array<{ driver: string; score: number }> = [];
  const bz = drivers.rolling_min_bz_gsm_nt_60m;
  const em = drivers.rolling_max_coupling_electric_field_mv_m_60m ?? drivers.coupling_electric_field_mv_m;
  const pdyn = drivers.rolling_max_dynamic_pressure_npa_60m ?? drivers.dynamic_pressure_npa;
  const speed = drivers.speed_km_s;

  candidates.push({ driver: 'southward Bz GSM', score: bz === null ? 0 : bz <= -20 ? 4 : bz <= -15 ? 3 : bz <= -10 ? 2 : bz <= -5 ? 1 : 0 });
  candidates.push({ driver: 'coupling electric field', score: em === null ? 0 : em >= 9 ? 4 : em >= 6 ? 3 : em >= 4 ? 2 : em >= 2.5 ? 1 : 0 });
  candidates.push({ driver: 'dynamic pressure', score: pdyn === null ? 0 : pdyn >= 10 ? 3 : pdyn >= 6 ? 2 : pdyn >= 3 ? 1 : 0 });
  candidates.push({ driver: 'solar-wind speed', score: speed === null ? 0 : speed >= 800 ? 3 : speed >= 650 ? 2 : speed >= 550 ? 1 : 0 });
  candidates.push({ driver: 'rapid solar-wind gradient', score: hasShock ? 2 : 0 });

  const total = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
  const main = candidates.slice().sort((a, b) => b.score - a.score)[0];
  const severity = total >= 8 ? 'severe' : total >= 5 ? 'high' : total >= 3 ? 'moderate' : 'low';
  return { severity, mainDriver: main && main.score > 0 ? main.driver : 'none' };
}

function assessmentMessage(severity: HazardSeverity, mainDriver: string): string {
  if (severity === 'severe') return `Severe geomagnetic response proxy possible; dominant driver is ${mainDriver}. Prepare for elevated operational risk near ETA.`;
  if (severity === 'high') return `High geomagnetic response proxy possible; dominant driver is ${mainDriver}. Review sensitive operations near ETA.`;
  if (severity === 'moderate') return `Moderate geomagnetic response proxy possible; dominant driver is ${mainDriver}. Monitor near ETA.`;
  return 'No elevated geomagnetic driver is currently indicated by the latest propagated L1 parcel.';
}

export function buildHazardAssessment(forecast: ForecastRealtimeV1, windowMinutes: number | null = null): HazardAssessment {
  const generatedAt = new Date().toISOString();
  const events = buildHazardEvents(forecast, windowMinutes);
  const drivers = physicalDrivers(forecast);
  const hasShock = events.some(event => event.type === 'incoming_shock');
  const scored = events.length
    ? { severity: events.reduce<HazardSeverity>((severity, event) => maxSeverity(severity, event.severity), 'low'), mainDriver: mainDriverFromEvents(events) }
    : scoreHazard(drivers, hasShock);
  const window = arrivalWindow(forecast);

  return {
    generated_at: generatedAt,
    model_version: forecast.model_version ?? FORECAST_MODEL_VERSION,
    forecast_issued_at: forecast.issued_at ?? null,
    expected_start_utc: window.startUtc,
    expected_peak_utc: window.peakUtc,
    expected_end_utc: window.endUtc,
    lead_time_minutes: window.leadMinutes,
    severity: scored.severity,
    confidence: forecast.confidence ?? 'low',
    main_driver: scored.mainDriver,
    physical_drivers: drivers,
    estimated_g_level_proxy: gProxyForSeverity(scored.severity),
    operator_message: assessmentMessage(scored.severity, scored.mainDriver),
    quality_flags: forecast.quality_flags ?? [],
    limitations: forecast.limitations ?? [
      'Hazard assessment is rules-based and derived from propagated physical drivers.',
      'Estimated G level is a proxy, not an official measured Kp/G value.',
    ],
  };
}

export function buildHazardResponse(forecast: ForecastRealtimeV1, windowMinutes: number | null = null): HazardResponse {
  return {
    hazard: buildHazardAssessment(forecast, windowMinutes),
    events: buildHazardEvents(forecast, windowMinutes),
  };
}

export function buildHazardEventsResponse(forecast: ForecastRealtimeV1, windowMinutes: number | null = null): HazardEventsResponse {
  return {
    generated_at: new Date().toISOString(),
    model_version: forecast.model_version ?? FORECAST_MODEL_VERSION,
    forecast_issued_at: forecast.issued_at ?? null,
    window_minutes: windowMinutes,
    events: buildHazardEvents(forecast, windowMinutes),
    quality_flags: forecast.quality_flags ?? [],
    limitations: forecast.limitations ?? [
      'Event detection is rules-based and derived from propagated physical drivers.',
      'Estimated G level is a proxy, not an official measured Kp/G value.',
    ],
  };
}
