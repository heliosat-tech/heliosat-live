import { NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api/apiKeyAuth';
import { readLatestForecast } from '@/services/realtimeForecastService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * PUBLIC API — Real-Time Forecast (v1). Authenticated by API key (not the admin
 * cookie gate). Reads the last PRECOMPUTED forecast from Supabase; it never computes
 * in-request, so it responds in ~tens of ms. See docs/api-v1.md for the contract.
 *
 *   curl -H "Authorization: Bearer <api_key>" https://<host>/api/v1/forecast/realtime
 */
export async function GET(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth.ok) {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (auth.status === 401) headers['WWW-Authenticate'] = 'Bearer';
    if (auth.retryAfter != null) headers['Retry-After'] = String(auth.retryAfter);
    if (auth.rateLimit != null) headers['X-RateLimit-Limit'] = String(auth.rateLimit);
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }

  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-RateLimit-Limit': String(auth.rateLimit),
    'X-RateLimit-Remaining': String(auth.remaining),
  };

  const latest = await readLatestForecast();
  if (!latest) {
    return NextResponse.json(
      { error: 'No forecast available yet. Please retry shortly.' },
      { status: 503, headers },
    );
  }

  return NextResponse.json(latest, { status: 200, headers });
}
