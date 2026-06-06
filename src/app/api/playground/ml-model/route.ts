import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { loadMlModel, runDefinitiveTraining } from '@/services/mlModelService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Definitive training samples windows across the full ACE science archive; give it room.
export const maxDuration = 300;

async function requireAdmin() {
  const adminState = await getCurrentAdminState();
  return adminState.isAdmin;
}

/** Status of the saved model (for the Models screen). */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const artifact = await loadMlModel();
  return NextResponse.json({ trained: artifact !== null, artifact }, { headers: { 'Cache-Control': 'no-store' } });
}

/** Train (or retrain) the model and persist the artifact. */
export async function POST() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const result = await runDefinitiveTraining();
  const status = result.error ? 422 : 200;
  return NextResponse.json(
    { trained: result.artifact !== null, artifact: result.artifact, warnings: result.warnings, error: result.error },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
