import { NextResponse } from 'next/server';
import { buildTransitCorridorSeries, TRANSIT_CORRIDOR_TARGET } from '@/services/transitCorridorService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

// Public, read-only historical arrival-corridor data (no PII) — the dashboard heatmaps must work
// for anonymous visitors. Keep the shared cache shorter than the client replay TTL so a
// long-running dashboard cannot retain a stale right edge or an already-repaired data gap.
export async function GET(request: Request) {
  const windowKey = new URL(request.url).searchParams.get('window') ?? '7d';
  const res = await buildTransitCorridorSeries({ windowKey, maxPoints: TRANSIT_CORRIDOR_TARGET });

  return NextResponse.json(res, {
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=300' },
  });
}
