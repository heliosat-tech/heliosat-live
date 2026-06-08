import { NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api/apiKeyAuth';
import type { ForecastRealtimeV1 } from '@/lib/api/forecastContract';
import { readLatestForecast } from '@/services/realtimeForecastService';

export async function withAuthenticatedLatestForecast(
  request: Request,
  buildPayload: (forecast: ForecastRealtimeV1) => unknown,
): Promise<NextResponse> {
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

  return NextResponse.json(buildPayload(latest), { status: 200, headers });
}
