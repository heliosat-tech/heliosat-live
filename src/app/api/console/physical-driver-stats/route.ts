import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { computePhysicalDriverEventStats } from '@/services/physicalDriverEventStatsService';
import { buildTransitCorridorSeries } from '@/services/transitCorridorService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const windowKey = new URL(request.url).searchParams.get('window') ?? '90d';
  const series = await buildTransitCorridorSeries({ windowKey, maxPoints: null });
  const stats = computePhysicalDriverEventStats(series.gForecast, {
    window: series.window,
    startMs: series.startMs,
    endMs: series.endMs,
  });

  return NextResponse.json(stats, { headers: { 'Cache-Control': 'no-store' } });
}
