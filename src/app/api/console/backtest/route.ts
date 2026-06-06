import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { computeMruBacktest } from '@/services/mruBacktestService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const noStore = { headers: { 'Cache-Control': 'no-store' } } as const;

/**
 * Historical MRU backtest: replays the ballistic forecast over the archived L1 record
 * and scores it against the actual arrived wind (OMNI). Needs both local archives built.
 */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, ...noStore });
  }

  const stats = await computeMruBacktest();
  if (!stats) {
    return NextResponse.json({ stats: null, error: 'Backtest needs both local archives (ACE L1 + OMNI). Build them from the chart toolbar.' }, { status: 422, ...noStore });
  }
  return NextResponse.json({ stats }, noStore);
}
