import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { buildNormalizedRowsFromTelemetry } from '@/services/dataQualityService';
import { fetchGoesMagnetometerRows } from '@/services/noaaGoesMagnetometerService';
import { fetchPlaygroundTelemetry } from '@/services/playgroundTelemetryService';
import { fetchContextIndexSnapshot } from '@/services/spaceWeatherContextIndexService';
import {
  buildStormBrowserSnapshot,
  type StormBrowserSnapshot,
} from '@/services/stormEventService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CACHE_TTL_MS = 15 * 60 * 1000;

let cachedResponse: {
  expiresAt: number;
  snapshot: StormBrowserSnapshot;
} | null = null;

export async function GET() {
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

  if (cachedResponse && Date.now() < cachedResponse.expiresAt) {
    return NextResponse.json(cachedResponse.snapshot, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }

  const [telemetry, goesMag, context] = await Promise.all([
    fetchPlaygroundTelemetry(),
    fetchGoesMagnetometerRows(),
    fetchContextIndexSnapshot(),
  ]);
  const snapshot = buildStormBrowserSnapshot(context, [
    ...buildNormalizedRowsFromTelemetry(telemetry),
    ...goesMag.rows,
  ]);

  if (goesMag.errorMessage) {
    snapshot.warnings.push(`GOES MAG fetch: ${goesMag.errorMessage}`);
  }

  cachedResponse = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    snapshot,
  };

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
