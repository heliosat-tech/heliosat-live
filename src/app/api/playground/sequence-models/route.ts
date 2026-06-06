import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import {
  buildDataQualitySnapshot,
  buildNormalizedRowsFromTelemetry,
} from '@/services/dataQualityService';
import { buildFeatureWorkbenchSnapshot } from '@/services/featureEngineeringService';
import { buildL1EarthCouplingSnapshot } from '@/services/l1EarthCouplingService';
import { buildBaselinesLabSnapshot } from '@/services/modelBenchmarkService';
import {
  buildSequenceModelsSnapshot,
  type SequenceModelsSnapshot,
} from '@/services/sequenceModelService';
import { fetchGoesMagnetometerRows } from '@/services/noaaGoesMagnetometerService';
import { fetchPlaygroundTelemetry } from '@/services/playgroundTelemetryService';
import { fetchContextIndexSnapshot } from '@/services/spaceWeatherContextIndexService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CACHE_TTL_MS = 15 * 60 * 1000;

let cachedResponse: {
  cacheKey: string;
  expiresAt: number;
  snapshot: SequenceModelsSnapshot;
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

  const [telemetry, goesMag, context] = await Promise.all([
    fetchPlaygroundTelemetry(),
    fetchGoesMagnetometerRows(),
    fetchContextIndexSnapshot(),
  ]);
  const telemetryRows = buildNormalizedRowsFromTelemetry(telemetry);
  const qualitySnapshot = buildDataQualitySnapshot(telemetry, { startUtc, stopUtc });
  const cleanTimestampBySeries = new Map(
    qualitySnapshot.cleanTimestampExport.perSeries.map(series => [series.seriesId, new Set(series.timestamps)]),
  );
  const cleanTelemetryRows = telemetryRows.filter(row => cleanTimestampBySeries.get(`${row.source}:${row.variable}`)?.has(row.timestamp_utc) ?? false);
  const rows = [...cleanTelemetryRows, ...goesMag.rows];
  const couplingSnapshot = buildL1EarthCouplingSnapshot(rows, { startUtc, stopUtc });
  const featureSnapshot = buildFeatureWorkbenchSnapshot(rows, couplingSnapshot, context, { startUtc, stopUtc });
  const baselinesSnapshot = buildBaselinesLabSnapshot(featureSnapshot);
  const snapshot = buildSequenceModelsSnapshot(baselinesSnapshot);

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
