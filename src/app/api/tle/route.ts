import {
  CELESTRAK_FAILURE_COOLDOWN_SECONDS,
  CELESTRAK_TLE_GROUPS,
  fetchTleGroup,
} from '@/services/celestrakService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ALLOWED_GROUPS = new Set<string>(CELESTRAK_TLE_GROUPS);

function secondsUntil(value: string | null | undefined): number {
  const atMs = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(atMs)
    ? Math.max(1, Math.ceil((atMs - Date.now()) / 1_000))
    : CELESTRAK_FAILURE_COOLDOWN_SECONDS;
}

/**
 * Same-origin CelesTrak proxy. Upstream polling is held to the official two-hour interval by
 * fetchTleGroup; this response cache is only a short browser/CDN convenience layer.
 */
export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get('group')?.toLowerCase() ?? 'stations';
  const group = ALLOWED_GROUPS.has(requested) ? requested : 'stations';
  const data = await fetchTleGroup(group);

  if (data.tles.length === 0) {
    return Response.json(data, {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(secondsUntil(data.nextRetryAtUtc)),
        'X-Heliosat-Tle-Status': 'unavailable',
      },
    });
  }

  return Response.json(data, {
    status: 200,
    headers: {
      'Cache-Control': data.stale
        ? 'public, max-age=60, stale-while-revalidate=300'
        : 'public, max-age=300, stale-while-revalidate=3600',
      'X-Heliosat-Tle-Status': data.stale ? 'stale' : 'fresh',
    },
  });
}
