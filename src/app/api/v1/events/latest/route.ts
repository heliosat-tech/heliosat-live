import { withAuthenticatedLatestForecast } from '@/lib/api/publicForecastEndpoint';
import { buildHazardEventsResponse } from '@/services/hazardForecastService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  return withAuthenticatedLatestForecast(request, forecast => buildHazardEventsResponse(forecast));
}
