/**
 * OpenAPI 3.1 description of the HELIOSAT Public API (v1) — the single source of
 * truth that external companies import (Postman/Insomnia, client codegen). Served
 * verbatim at GET /api/v1/openapi.json and rendered at GET /api/v1/docs.
 *
 * Keep this in sync with the v1 routes and src/lib/api/forecastContract.ts. The
 * contract is additive-only within v1 (breaking changes ship as /api/v2/...).
 */

import { FORECAST_SCHEMA_VERSION, FORECAST_MODEL_VERSION } from './forecastContract';

const PROD_SERVER = 'https://heliosat-live.vercel.app';

const rateLimitHeaders = {
  'X-RateLimit-Limit': { schema: { type: 'integer' }, description: 'Requests allowed per minute for this key.' },
  'X-RateLimit-Remaining': { schema: { type: 'integer' }, description: 'Requests remaining in the current minute window.' },
} as const;

const nullableNumber = { type: ['number', 'null'] };
const nullableString = { type: ['string', 'null'] };

const physicalDrivers = {
  type: 'object',
  description: 'Propagated physical solar-wind drivers at the bow-shock nose, plus 60-min rolling extremes and per-minute gradients.',
  properties: {
    speed_km_s: nullableNumber,
    density_cm3: nullableNumber,
    bz_gsm_nt: nullableNumber,
    bt_nt: nullableNumber,
    dynamic_pressure_npa: nullableNumber,
    coupling_electric_field_mv_m: nullableNumber,
    rolling_min_bz_gsm_nt_60m: nullableNumber,
    rolling_max_dynamic_pressure_npa_60m: nullableNumber,
    rolling_max_coupling_electric_field_mv_m_60m: nullableNumber,
    gradients_per_minute: {
      type: 'object',
      properties: {
        speed_km_s: nullableNumber,
        density_cm3: nullableNumber,
        bt_nt: nullableNumber,
        dynamic_pressure_npa: nullableNumber,
      },
    },
  },
} as const;

const hazardEvent = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['incoming_shock', 'southward_bz_interval', 'high_dynamic_pressure_interval', 'high_coupling_interval', 'geomagnetic_risk_window'] },
    severity: { $ref: '#/components/schemas/HazardSeverity' },
    confidence: { $ref: '#/components/schemas/Confidence' },
    expected_start_utc: nullableString,
    expected_peak_utc: nullableString,
    expected_end_utc: nullableString,
    lead_time_minutes: nullableNumber,
    main_driver: { type: 'string' },
    physical_drivers: { $ref: '#/components/schemas/HazardPhysicalDrivers' },
    operator_message: { type: 'string' },
  },
} as const;

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'HELIOSAT Public API',
    version: '1.0.0',
    description:
      'Real-time space-weather forecast: the L1 → near-Earth/bow-shock propagation of physical ' +
      'solar-wind and IMF drivers (speed, density, Bz, Bt, dynamic pressure, coupling electric field). ' +
      'Any G/Kp value is an operational proxy derived from those propagated drivers, not an official measured ' +
      'Kp/G. Responses are served precomputed (read the latest published forecast; never computed in-request). ' +
      `Contract schema version "${FORECAST_SCHEMA_VERSION}", model "${FORECAST_MODEL_VERSION}". Within v1, fields ` +
      'are additive only; breaking changes ship under /api/v2/...',
    contact: { name: 'HELIOSAT' },
  },
  servers: [{ url: PROD_SERVER, description: 'Production' }, { url: '{baseUrl}', description: 'Custom deployment', variables: { baseUrl: { default: PROD_SERVER } } }],
  security: [{ apiKey: [] }],
  tags: [
    { name: 'Forecast', description: 'The core real-time physical forecast.' },
    { name: 'Hazard', description: 'Operational hazard assessment derived from the forecast.' },
    { name: 'Status', description: 'Unauthenticated health/uptime endpoint.' },
  ],
  paths: {
    '/api/v1/forecast/realtime': {
      get: {
        tags: ['Forecast'],
        summary: 'Latest real-time forecast',
        description: 'The most recent precomputed L1→Earth physical-driver forecast.',
        security: [{ apiKey: [] }],
        responses: {
          '200': {
            description: 'The latest forecast.',
            headers: rateLimitHeaders,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ForecastRealtime' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/NoForecast' },
        },
      },
    },
    '/api/v1/hazard/latest': {
      get: {
        tags: ['Hazard'],
        summary: 'Latest hazard assessment',
        description: 'Operational hazard severity + discrete hazard events derived from the latest forecast.',
        security: [{ apiKey: [] }],
        responses: {
          '200': { description: 'Hazard assessment.', headers: rateLimitHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/HazardResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/NoForecast' },
        },
      },
    },
    '/api/v1/hazard/window': {
      get: {
        tags: ['Hazard'],
        summary: 'Hazard assessment over a look-ahead window',
        security: [{ apiKey: [] }],
        parameters: [{ $ref: '#/components/parameters/Minutes' }],
        responses: {
          '200': {
            description: 'Hazard assessment for the requested window.',
            headers: rateLimitHeaders,
            content: { 'application/json': { schema: { allOf: [{ type: 'object', properties: { window_minutes: { type: 'integer' } } }, { $ref: '#/components/schemas/HazardResponse' }] } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/NoForecast' },
        },
      },
    },
    '/api/v1/events/latest': {
      get: {
        tags: ['Hazard'],
        summary: 'Latest hazard events',
        security: [{ apiKey: [] }],
        responses: {
          '200': { description: 'Hazard events.', headers: rateLimitHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/HazardEventsResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/NoForecast' },
        },
      },
    },
    '/api/v1/events/window': {
      get: {
        tags: ['Hazard'],
        summary: 'Hazard events over a look-ahead window',
        security: [{ apiKey: [] }],
        parameters: [{ $ref: '#/components/parameters/Minutes' }],
        responses: {
          '200': { description: 'Hazard events for the requested window.', headers: rateLimitHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/HazardEventsResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/NoForecast' },
        },
      },
    },
    '/api/v1/status': {
      get: {
        tags: ['Status'],
        summary: 'Service health',
        description: 'Unauthenticated. 200 when a fresh forecast exists, 503 when stale (>15 min) or missing — suitable for an HTTP uptime monitor.',
        security: [],
        responses: {
          '200': { description: 'Fresh.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Status' } } } },
          '503': { description: 'Stale or no data.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Status' } } } },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', description: 'Per-client API key: `Authorization: Bearer <api_key>`. Keys are issued per company and rate-limited per minute.' },
    },
    parameters: {
      Minutes: { name: 'minutes', in: 'query', required: false, description: 'Look-ahead window in minutes (default 90, clamped 1–360).', schema: { type: 'integer', default: 90, minimum: 1, maximum: 360 } },
    },
    responses: {
      Unauthorized: { description: 'Missing, invalid, inactive, or expired API key.', headers: { 'WWW-Authenticate': { schema: { type: 'string' }, description: 'Bearer' } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      RateLimited: { description: 'Per-minute rate limit exceeded.', headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until the window resets.' }, 'X-RateLimit-Limit': rateLimitHeaders['X-RateLimit-Limit'] }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      NoForecast: { description: 'No forecast published yet (retry shortly).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
      Confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      HazardSeverity: { type: 'string', enum: ['low', 'moderate', 'high', 'severe'] },
      HazardPhysicalDrivers: physicalDrivers,
      HazardEvent: hazardEvent,
      Status: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'stale', 'no_data'] },
          schema_version: nullableString,
          model_version: nullableString,
          issued_at: nullableString,
          confidence: { oneOf: [{ $ref: '#/components/schemas/Confidence' }, { type: 'null' }] },
          forecast_age_seconds: { type: 'integer' },
          stale: { type: 'boolean' },
          detail: { type: 'string' },
        },
      },
      HazardResponse: {
        type: 'object',
        properties: {
          hazard: {
            type: 'object',
            properties: {
              generated_at: { type: 'string' },
              model_version: { type: 'string' },
              forecast_issued_at: nullableString,
              expected_start_utc: nullableString,
              expected_peak_utc: nullableString,
              expected_end_utc: nullableString,
              lead_time_minutes: nullableNumber,
              severity: { $ref: '#/components/schemas/HazardSeverity' },
              confidence: { $ref: '#/components/schemas/Confidence' },
              main_driver: { type: 'string' },
              physical_drivers: { $ref: '#/components/schemas/HazardPhysicalDrivers' },
              estimated_g_level_proxy: { type: 'string' },
              operator_message: { type: 'string' },
              quality_flags: { type: 'array', items: { type: 'string' } },
              limitations: { type: 'array', items: { type: 'string' } },
            },
          },
          events: { type: 'array', items: { $ref: '#/components/schemas/HazardEvent' } },
        },
      },
      HazardEventsResponse: {
        type: 'object',
        properties: {
          generated_at: { type: 'string' },
          model_version: { type: 'string' },
          forecast_issued_at: nullableString,
          window_minutes: nullableNumber,
          events: { type: 'array', items: { $ref: '#/components/schemas/HazardEvent' } },
          quality_flags: { type: 'array', items: { type: 'string' } },
          limitations: { type: 'array', items: { type: 'string' } },
        },
      },
      ForecastRealtime: {
        type: 'object',
        description: 'The stable v1 real-time forecast payload. Units: speed km/s, field nT, density 1/cm³, times ISO-8601 UTC.',
        properties: {
          schema_version: { type: 'string' },
          model_version: { type: 'string' },
          issued_at: { type: 'string' },
          generated_at: { type: 'string' },
          observed_at: nullableString,
          l1_sample_time_utc: nullableString,
          l1_distance_km: { type: 'number' },
          distance_km: { type: 'number' },
          distance_source: { type: 'string', enum: ['measured_ephemeris', 'nominal_l1_distance', 'unknown'] },
          source: {
            type: 'object',
            properties: { id: { type: 'string' }, provider: { type: 'string' }, observatory: { type: 'string' }, products: { type: 'array', items: { type: 'string' } } },
          },
          target: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' } } },
          observed: {
            type: ['object', 'null'],
            properties: { speed_km_s: nullableNumber, bz_nt: nullableNumber, density_p_cm3: nullableNumber, g_level: { type: 'number' } },
          },
          arrival: { type: ['object', 'null'], properties: { estimated_utc: nullableString, transit_lag_minutes: nullableNumber } },
          arrival_time_utc: nullableString,
          lead_time_minutes: nullableNumber,
          arrival_uncertainty_minutes: { type: 'number' },
          propagated_variables: {
            type: ['object', 'null'],
            properties: { speed_km_s: nullableNumber, density_cm3: nullableNumber, bz_gsm_nt: nullableNumber, bt_nt: nullableNumber },
          },
          derived_features: {
            type: ['object', 'null'],
            properties: {
              dynamic_pressure_npa: nullableNumber,
              coupling_electric_field_mv_m: nullableNumber,
              gradients_per_minute: { type: 'object', additionalProperties: nullableNumber },
              rolling_min_bz_gsm_nt: { type: 'object', properties: { minutes_15: nullableNumber, minutes_30: nullableNumber, minutes_60: nullableNumber } },
              rolling_max_dynamic_pressure_npa: { type: 'object', properties: { minutes_15: nullableNumber, minutes_30: nullableNumber, minutes_60: nullableNumber } },
              rolling_max_coupling_electric_field_mv_m: { type: 'object', properties: { minutes_15: nullableNumber, minutes_30: nullableNumber, minutes_60: nullableNumber } },
            },
          },
          quality_flags: { type: 'array', items: { type: 'string' } },
          confidence: { $ref: '#/components/schemas/Confidence' },
          limitations: { type: 'array', items: { type: 'string' } },
          estimated_g_level_proxy: {
            type: ['object', 'null'],
            properties: { level: { type: 'number' }, code: { type: 'string' }, kp_estimate: nullableNumber, method: { type: 'string' }, note: { type: 'string' } },
          },
          inbound_peak: {
            type: ['object', 'null'],
            description: 'Worst geomagnetic parcel still inbound, or null when nothing notable is in transit.',
            properties: { g_level: { type: 'number' }, speed_km_s: { type: 'number' }, min_bz_nt: { type: 'number' }, eta_utc: { type: 'string' }, lead_minutes: { type: 'number' } },
          },
        },
        required: ['schema_version', 'model_version', 'issued_at', 'generated_at'],
      },
    },
  },
} as const;
