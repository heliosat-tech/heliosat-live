import { NextResponse } from 'next/server';
import { readLatestForecast } from '@/services/realtimeForecastService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Cron publishes every ~5 min; flag the forecast as stale past 15 min so a dropped
// scheduler (or a failing precompute) is caught quickly.
const STALE_AFTER_S = 15 * 60;

/**
 * Public health/status endpoint (ROADMAP Fase 5 — monitoring). Unauthenticated and
 * cheap: reports whether a FRESH precomputed forecast exists. Returns 200 when fresh
 * and 503 when stale/missing/unconfigured, so a plain HTTP uptime monitor (e.g.
 * UptimeRobot) alarms if the API is down OR the cron stopped publishing.
 */
export async function GET() {
  const headers = { 'Cache-Control': 'no-store' };
  const latest = await readLatestForecast();

  if (!latest) {
    return NextResponse.json(
      { status: 'no_data', detail: 'No forecast published yet (or backend not configured).' },
      { status: 503, headers },
    );
  }

  const issuedAt = latest.issued_at;
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(issuedAt).getTime()) / 1000));
  const stale = ageSeconds > STALE_AFTER_S;

  return NextResponse.json(
    {
      status: stale ? 'stale' : 'ok',
      schema_version: latest.schema_version,
      model_version: latest.model_version ?? null,
      issued_at: issuedAt,
      confidence: latest.confidence ?? null,
      forecast_age_seconds: ageSeconds,
      stale,
    },
    { status: stale ? 503 : 200, headers },
  );
}
