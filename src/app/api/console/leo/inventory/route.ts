import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { buildLeoInventory } from '@/services/leo/leoInventoryService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noStore = { headers: { 'Cache-Control': 'no-store' } } as const;

/** Observed Swarm/GRACE-FO local archive inventory; metadata only, never synthetic rows. */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, ...noStore });
  }
  return NextResponse.json(await buildLeoInventory(), noStore);
}
