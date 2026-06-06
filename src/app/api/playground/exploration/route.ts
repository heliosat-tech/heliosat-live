import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import {
  buildExplorationSnapshot,
  type ExplorationSnapshot,
} from '@/services/explorationService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedResponse: {
  cacheKey: string;
  expiresAt: number;
  snapshot: ExplorationSnapshot;
} | null = null;

export async function GET(request: NextRequest) {
  const adminState = await getCurrentAdminState();

  if (!adminState.isAdmin) {
    return NextResponse.json(
      { error: 'Admin required' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const startUtc = request.nextUrl.searchParams.get('startUtc') ?? '';
  const stopUtc = request.nextUrl.searchParams.get('stopUtc') ?? '';
  const cacheKey = JSON.stringify({ startUtc, stopUtc });

  if (cachedResponse && cachedResponse.cacheKey === cacheKey && Date.now() < cachedResponse.expiresAt) {
    return NextResponse.json(cachedResponse.snapshot, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const snapshot = await buildExplorationSnapshot({
    startUtc: startUtc || undefined,
    stopUtc: stopUtc || undefined,
  });

  cachedResponse = {
    cacheKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
    snapshot,
  };

  return NextResponse.json(snapshot, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
