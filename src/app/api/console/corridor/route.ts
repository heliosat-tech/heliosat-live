import { NextResponse } from 'next/server';
import { buildTransitCorridorSeries, TRANSIT_CORRIDOR_TARGET } from '@/services/transitCorridorService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

// Public, read-only historical arrival-corridor data (no PII) — the dashboard heatmaps must work
// for anonymous visitors. Historical windows change slowly, so allow a short shared cache to keep
// the heavy archive computation from re-running on every request.
export async function GET(request: Request) {
  const windowKey = new URL(request.url).searchParams.get('window') ?? '7d';
  const res = await buildTransitCorridorSeries({ windowKey, maxPoints: TRANSIT_CORRIDOR_TARGET });

  return NextResponse.json(res, {
    headers: { 'Cache-Control': 'public, max-age=120, s-maxage=600, stale-while-revalidate=3600' },
  });
}
