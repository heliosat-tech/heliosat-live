import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { buildTransitCorridorSeries, TRANSIT_CORRIDOR_TARGET } from '@/services/transitCorridorService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const windowKey = new URL(request.url).searchParams.get('window') ?? '7d';
  const res = await buildTransitCorridorSeries({ windowKey, maxPoints: TRANSIT_CORRIDOR_TARGET });

  return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
}
