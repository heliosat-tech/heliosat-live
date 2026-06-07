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
 * `g_level` is the NOAA G-scale (0 = none/quiet … 5 = extreme).
 */

export const FORECAST_SCHEMA_VERSION = '1';

export interface ForecastRealtimeV1 {
  /** Contract version of this payload. Currently "1". */
  schema_version: string;
  /** When this forecast row was published (the precompute/cron run time). */
  issued_at: string;
  /** Timestamp of the latest L1 measurement the forecast is based on. */
  observed_at: string | null;
  /** L1 distance (km) used to propagate the solar wind to Earth. */
  l1_distance_km: number;

  /** Most recent measured solar-wind conditions at L1. Null if no data. */
  observed: {
    speed_km_s: number | null;
    bz_nt: number | null;
    density_p_cm3: number | null;
    /** NOAA G-scale right now (0–5). */
    g_level: number;
  } | null;

  /** Earth-arrival estimate for the latest measured parcel. */
  arrival: {
    /** Estimated Earth-arrival time of the latest parcel. */
    estimated_utc: string | null;
    /** L1 → Earth travel time for that parcel, in minutes. */
    transit_lag_minutes: number | null;
  } | null;

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
