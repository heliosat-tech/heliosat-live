import { withAuthenticatedLatestForecast } from '@/lib/api/publicForecastEndpoint';
import { buildHazardEventsResponse } from '@/services/hazardForecastService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function parseMinutes(request: Request): number {
  const url = new URL(request.url);
  const parsed = Number(url.searchParams.get('minutes') ?? 90);
  if (!Number.isFinite(parsed)) return 90;
  return Math.max(1, Math.min(360, Math.round(parsed)));
}

export async function GET(request: Request) {
  const minutes = parseMinutes(request);
  return withAuthenticatedLatestForecast(request, forecast => buildHazardEventsResponse(forecast, minutes));
}
