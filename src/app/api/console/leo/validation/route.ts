import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { buildLeoValidationResponse } from '@/services/leo/leoValidationService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noStore = { headers: { 'Cache-Control': 'no-store' } } as const;

/** Latest versioned held-out LEO study summary, with reference and end-to-end modes kept separate. */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, ...noStore });
  }
  return NextResponse.json(await buildLeoValidationResponse(), noStore);
}
