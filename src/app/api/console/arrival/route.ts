import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { writeJsonFileBestEffort } from '@/lib/fsCache';
import { computeArrivalAccuracy, type ArrivalAccuracy } from '@/services/mruArrivalAccuracyService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300; // first build pulls several years of OMNI 5-min in parallel

const STORE_DIR = path.join(process.cwd(), 'data', 'console');
const STORE_PATH = path.join(STORE_DIR, 'arrival.json');

async function loadCached(): Promise<ArrivalAccuracy | null> {
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, 'utf8')) as ArrivalAccuracy;
  } catch {
    return null;
  }
}

/**
 * MRU arrival-time accuracy over the curated demo storm interval (OMNI 1-min). The
 * interval is in the past and immutable, so the result is cached on disk: the first
 * call computes (one ~10–13k-row OMNI fetch), later calls are instant and offline.
 * `?refresh=1` recomputes.
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

  const stats = await computeArrivalAccuracy();
  if (!stats) {
    const cached = await loadCached();
    if (cached) return NextResponse.json({ stats: cached, cached: true, stale: true }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ stats: null, error: 'Could not compute arrival accuracy (OMNI 1-min fetch failed).' }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
  }
  await writeJsonFileBestEffort(STORE_PATH, stats, { pretty: true });
  return NextResponse.json({ stats, cached: false }, { headers: { 'Cache-Control': 'no-store' } });
}
