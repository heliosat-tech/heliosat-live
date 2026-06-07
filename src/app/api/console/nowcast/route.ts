import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { computeRealtimeForecast } from '@/services/realtimeForecastService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Real-time nowcast for the demo hero panel: the last ~2.5 h of L1 detection plus the
 * MRU forecast projected to its Earth-arrival time (so the line runs PAST "now" — the
 * inbound solar wind still in transit). The computation is shared with the public
 * precompute path (`realtimeForecastService`); this route just gates it behind admin.
 */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const forecast = await computeRealtimeForecast();
  return NextResponse.json(forecast, { headers: { 'Cache-Control': 'no-store' } });
}
