import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { fetchNoaaStormScales } from '@/services/noaaStormScalesService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Real, near-Earth observed NOAA storm scales (G/S/R) + the latest planetary Kp.
 * This is the ground truth the Live Forecast compares its forecast G against, and
 * the source for the observed-only S and R levels (measured by GOES at Earth).
 */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const result = await fetchNoaaStormScales();
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
