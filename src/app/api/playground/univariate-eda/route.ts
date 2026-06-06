import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import {
  buildDataQualitySnapshot,
  buildNormalizedRowsFromTelemetry,
} from '@/services/dataQualityService';
import { fetchPlaygroundTelemetry } from '@/services/playgroundTelemetryService';
import { fetchContextIndexSnapshot } from '@/services/spaceWeatherContextIndexService';
import {
  buildUnivariateEdaSnapshot,
  type UnivariateEdaSnapshot,
} from '@/services/univariateEdaService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CACHE_TTL_MS = 30 * 60 * 1000;

let cachedResponse: {
  cacheKey: string;
  expiresAt: number;
  snapshot: UnivariateEdaSnapshot;
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

  const telemetry = await fetchPlaygroundTelemetry();
  const qualitySnapshot = buildDataQualitySnapshot(telemetry, {
    startUtc,
    stopUtc,
  });
  const cleanTimestampBySeries = new Map(
    qualitySnapshot.cleanTimestampExport.perSeries.map(series => [
      series.seriesId,
      new Set(series.timestamps),
    ]),
  );
  const cleanRows = buildNormalizedRowsFromTelemetry(telemetry).filter(row => {
    const cleanTimestampSet = cleanTimestampBySeries.get(`${row.source}:${row.variable}`);

    return cleanTimestampSet?.has(row.timestamp_utc) ?? false;
  });
  const contextSnapshot = await fetchContextIndexSnapshot();
  const univariateEda = buildUnivariateEdaSnapshot(cleanRows, contextSnapshot);

  cachedResponse = {
    cacheKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
    snapshot: univariateEda,
  };

  return NextResponse.json(univariateEda, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
