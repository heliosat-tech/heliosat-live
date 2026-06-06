import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { buildTrainingInventory } from '@/services/trainingDataInventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * Inventory of the local historical data (L1 archives + GOES NCEI backfill), classified
 * by orbit and mission with date coverage. Metadata-only; safe to poll.
 */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(await buildTrainingInventory(), { headers: { 'Cache-Control': 'no-store' } });
}
