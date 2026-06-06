import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { buildNormalizedRowsFromTelemetry } from '@/services/dataQualityService';
import {
  buildL1EarthCouplingSnapshot,
  type L1EarthCouplingSnapshot,
} from '@/services/l1EarthCouplingService';
import { fetchGoesMagnetometerRows } from '@/services/noaaGoesMagnetometerService';
import { fetchPlaygroundTelemetry } from '@/services/playgroundTelemetryService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CACHE_TTL_MS = 15 * 60 * 1000;

let cachedResponse: {
  cacheKey: string;
  expiresAt: number;
  snapshot: L1EarthCouplingSnapshot;
} | null = null;

export async function GET(request: NextRequest) {
  const adminState = await getCurrentAdminState();

  if (!adminState.isAdmin) {
    return NextResponse.json(
      { error: 'Admin required' },
      {
        status: 403,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  const startUtc = request.nextUrl.searchParams.get('startUtc') ?? undefined;
  const stopUtc = request.nextUrl.searchParams.get('stopUtc') ?? undefined;
  const cacheKey = `${startUtc ?? 'default'}:${stopUtc ?? 'default'}`;

  if (cachedResponse && cachedResponse.cacheKey === cacheKey && Date.now() < cachedResponse.expiresAt) {
    return NextResponse.json(cachedResponse.snapshot, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }

  const [telemetry, goesMag] = await Promise.all([
    fetchPlaygroundTelemetry(),
    fetchGoesMagnetometerRows(),
  ]);
  const rows = [
    ...buildNormalizedRowsFromTelemetry(telemetry),
    ...goesMag.rows,
  ];
  const snapshot = buildL1EarthCouplingSnapshot(rows, {
    startUtc,
    stopUtc,
  });

  if (goesMag.errorMessage) {
    snapshot.warnings.push(`GOES MAG fetch: ${goesMag.errorMessage}`);
  }

  cachedResponse = {
    cacheKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
    snapshot,
  };

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
