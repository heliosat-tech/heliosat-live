import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STUDY_PATH = path.join(process.cwd(), 'data', 'console', 'geomagnetic-storm-study.json');

export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const study = JSON.parse(await fs.readFile(STUDY_PATH, 'utf8')) as Record<string, unknown>;
    return NextResponse.json({ study }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { study: null, error: 'Geomagnetic-storm study artifact not found. Run scripts/train_geomagnetic_storm_model.py.' },
      { status: 422, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
