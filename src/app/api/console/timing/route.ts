import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { writeJsonFileBestEffort } from '@/lib/fsCache';
import { computeMruTimingStats, type MruTimingStats } from '@/services/mruTimingService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const STORE_DIR = path.join(process.cwd(), 'data', 'console');
const STORE_PATH = path.join(STORE_DIR, 'timing.json');

async function loadCached(): Promise<MruTimingStats | null> {
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, 'utf8')) as MruTimingStats;
  } catch {
    return null;
  }
}

/**
 * MRU arrival-time accuracy vs OMNI's measured propagation delay. Cached on disk
 * (it's stationary); first call computes (~20-40s sampling years of OMNI), later
 * calls are instant. `?refresh=1` recomputes.
 */
export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  if (!refresh) {
    const cached = await loadCached();
    if (cached) return NextResponse.json({ stats: cached, cached: true }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const stats = await computeMruTimingStats();
  if (!stats) {
    return NextResponse.json({ stats: null, error: 'Could not compute timing stats (OMNI fetch failed).' }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
  }
  await writeJsonFileBestEffort(STORE_PATH, stats, { pretty: true });
  return NextResponse.json({ stats, cached: false }, { headers: { 'Cache-Control': 'no-store' } });
}
