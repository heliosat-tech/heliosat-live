import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { publishRealtimeForecast } from '@/services/realtimeForecastService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Compute the real-time forecast and store it as the public 'realtime' row
 * (precompute → store). Admin-gated for now so it can be triggered manually to seed
 * / refresh the public endpoint; Fase 4 will drive this on a schedule (cron).
 */
export async function POST() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const published = await publishRealtimeForecast();
    return NextResponse.json({ ok: true, published }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error)?.message ?? 'Failed to publish forecast.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
