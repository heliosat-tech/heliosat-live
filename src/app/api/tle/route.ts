import { NextResponse } from 'next/server';
import { fetchTleGroup } from '@/services/celestrakService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// The TLE catalogs the globe lets you switch between. Validated server-side so the route
// can only ever proxy these known CelesTrak groups (no arbitrary upstream URLs).
const ALLOWED_GROUPS = new Set(['stations', 'weather', 'starlink', 'active']);

/**
 * Same-origin proxy for CelesTrak TLE data. The browser hits this instead of celestrak.org
 * directly, which (a) removes the client's dependence on CelesTrak's CORS/latency and (b) lets
 * fetchTleGroup() apply its retry + last-good-cache resilience on the server. Catalogs change
 * only a few times a day, so we let the browser/CDN reuse the response for a few minutes and
 * keep serving it while revalidating — a flaky CelesTrak never blanks the globe.
 */
export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get('group') ?? 'stations';
  const group = ALLOWED_GROUPS.has(requested) ? requested : 'stations';

  const data = await fetchTleGroup(group);

  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' },
  });
}
