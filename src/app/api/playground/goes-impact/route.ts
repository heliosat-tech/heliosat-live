import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { loadGoesImpactResult, runGoesImpactAnalysis } from '@/services/goesImpactService';
import { ORBIT_CLASSES } from '@/services/orbitModels';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

async function requireAdmin() {
  const adminState = await getCurrentAdminState();
  return adminState.isAdmin;
}

/** The orbit framework + the last persisted GEO result (no recompute). */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const geoResult = await loadGoesImpactResult();
  return NextResponse.json({ orbits: ORBIT_CLASSES, geoResult }, { headers: { 'Cache-Control': 'no-store' } });
}

/** Train/refresh the GEO model (persists the result). */
export async function POST() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const geoResult = await runGoesImpactAnalysis();
  return NextResponse.json({ orbits: ORBIT_CLASSES, geoResult }, { headers: { 'Cache-Control': 'no-store' } });
}
