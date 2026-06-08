/**
 * PUBLIC API contract for the Real-Time Forecast — version 1.
 *
 * This is the stable, client-facing shape served by GET /api/v1/forecast/realtime.
 * Treat it as frozen: once a client integrates against v1, fields are ADDITIVE only
 * (never renamed/removed/retyped). A breaking change ships as a new version (v2)
 * under a new path. Keep this file decoupled from internal service types so the
 * wire format never drifts when internals change.
 *
 * Units: speed km/s, magnetic field nT, density particles/cm³, times ISO-8601 UTC.
 * `g_level` is kept for v1 compatibility. The core product is the propagated
 * physical driver forecast; G/Kp fields are operational proxies derived from it.
 */

export const FORECAST_SCHEMA_VERSION = '1';
export const FORECAST_MODEL_VERSION = 'mru-ballistic-v0.2';

export type ForecastConfidence = 'high' | 'medium' | 'low';
export type ForecastDistanceSource = 'measured_ephemeris' | 'nominal_l1_distance' | 'unknown';

export interface ForecastSourceV1 {
  id: 'noaa_swpc_l1_realtime';
  provider: 'NOAA SWPC';
  observatory: 'L1 upstream monitor';
  products: string[];
}

export interface ForecastTargetV1 {
  id: 'near_earth_bow_shock';
  description: string;
}

export interface PropagatedVariablesV1 {
  speed_km_s: number | null;
  density_cm3: number | null;
  bz_gsm_nt: number | null;
  bt_nt: number | null;
}

export interface ForecastDerivedFeaturesV1 {
  dynamic_pressure_npa: number | null;
  coupling_electric_field_mv_m: number | null;
  gradients_per_minute: {
    speed_km_s: number | null;
    density_cm3: number | null;
    bz_gsm_nt: number | null;
    bt_nt: number | null;
    dynamic_pressure_npa: number | null;
  };
  rolling_min_bz_gsm_nt: {
    minutes_15: number | null;
    minutes_30: number | null;
    minutes_60: number | null;
  };
  rolling_max_dynamic_pressure_npa: {
    minutes_15: number | null;
    minutes_30: number | null;
    minutes_60: number | null;
  };
  rolling_max_coupling_electric_field_mv_m: {
    minutes_15: number | null;
    minutes_30: number | null;
    minutes_60: number | null;
  };
}

export interface EstimatedGLevelProxyV1 {
  level: number;
  code: string;
  kp_estimate: number | null;
  method: 'rules_based_coupling_proxy';
  note: string;
}

export interface ForecastRealtimeV1 {
  /** Contract version of this payload. Currently "1". */
  schema_version: string;
  /** Transparent deterministic model version used to generate this payload. */
  model_version: string;
  /** When this forecast row was published (the precompute/cron run time). */
  issued_at: string;
  /** Alias for issued_at, added for clearer machine integrations. */
  generated_at: string;
  /** Timestamp of the latest L1 measurement the forecast is based on. */
  observed_at: string | null;
  /** Alias for observed_at, naming the physical source sample explicitly. */
  l1_sample_time_utc: string | null;
  /** L1 distance (km) used to propagate the solar wind to Earth. */
  l1_distance_km: number;
  distance_km: number;
  distance_source: ForecastDistanceSource;
  source: ForecastSourceV1;
  target: ForecastTargetV1;

  /** Most recent measured solar-wind conditions at L1. Null if no data. */
  observed: {
    speed_km_s: number | null;
    bz_nt: number | null;
    density_p_cm3: number | null;
    /** Legacy compatibility field: estimated G-level proxy for the latest L1 sample. */
    g_level: number;
  } | null;

  /** Earth-arrival estimate for the latest measured parcel. */
  arrival: {
    /** Estimated Earth-arrival time of the latest parcel. */
    estimated_utc: string | null;
    /** L1 → Earth travel time for that parcel, in minutes. */
    transit_lag_minutes: number | null;
  } | null;
  arrival_time_utc: string | null;
  lead_time_minutes: number | null;
  arrival_uncertainty_minutes: number;
  propagated_variables: PropagatedVariablesV1 | null;
  derived_features: ForecastDerivedFeaturesV1 | null;
  quality_flags: string[];
  confidence: ForecastConfidence;
  limitations: string[];
  estimated_g_level_proxy: EstimatedGLevelProxyV1 | null;

  /**
   * Worst geomagnetic parcel still inbound (Earth-arrival in the future), or null
   * when nothing notable is in transit.
   */
  inbound_peak: {
    g_level: number;
    speed_km_s: number;
    min_bz_nt: number;
    /** Estimated Earth-arrival of the worst inbound parcel. */
    eta_utc: string;
    /** Minutes from issue time until the inbound window arrives. */
    lead_minutes: number;
  } | null;
}
