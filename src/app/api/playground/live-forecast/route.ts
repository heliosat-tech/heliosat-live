import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import {
  buildDataQualitySnapshot,
  buildNormalizedRowsFromTelemetry,
} from '@/services/dataQualityService';
import {
  buildFeatureWorkbenchSnapshot,
  type FeatureTargetConfig,
} from '@/services/featureEngineeringService';
import { buildL1EarthCouplingSnapshot } from '@/services/l1EarthCouplingService';
import { buildLiveForecastSnapshot, type LiveForecastSnapshot } from '@/services/liveForecastService';
import { buildBaselinesLabSnapshot } from '@/services/modelBenchmarkService';
import { fetchGoesMagnetometerRows } from '@/services/noaaGoesMagnetometerService';
import { buildPipelineHealthSnapshot } from '@/services/pipelineHealthService';
import { fetchPlaygroundTelemetry } from '@/services/playgroundTelemetryService';
import { fetchContextIndexSnapshot } from '@/services/spaceWeatherContextIndexService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CACHE_TTL_MS = 60 * 1000;

let cachedResponse: {
  cacheKey: string;
  expiresAt: number;
  snapshot: LiveForecastSnapshot;
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
  const experimentId = request.nextUrl.searchParams.get('experimentId') ?? 'none';
  const configHash = request.nextUrl.searchParams.get('configHash') ?? 'none';
  const targetSource = request.nextUrl.searchParams.get('targetSource') ?? 'GOES';
  const targetVariable = request.nextUrl.searchParams.get('targetVariable') ?? 'goes_mag_hn';
  const targetLabel = request.nextUrl.searchParams.get('targetLabel') ?? `${targetSource}.${targetVariable}`;
  const horizonMinutes = Number(request.nextUrl.searchParams.get('horizonMinutes') ?? 0);
  const target: FeatureTargetConfig = {
    source: targetSource,
    variable: targetVariable,
    label: targetLabel,
    predictionHorizonMinutes: Number.isFinite(horizonMinutes) ? horizonMinutes : 0,
  };
  const cacheKey = `${experimentId}:${configHash}:${startUtc ?? 'default'}:${stopUtc ?? 'default'}:${targetSource}:${targetVariable}:${horizonMinutes}`;

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
  const qualitySnapshot = buildDataQualitySnapshot(telemetry, {
    startUtc,
    stopUtc,
  });
  const cleanTimestampBySeries = new Map(
    qualitySnapshot.cleanTimestampExport.perSeries.map(series => [series.seriesId, new Set(series.timestamps)]),
  );
  const rows = [
    ...telemetryRows.filter(row => cleanTimestampBySeries.get(`${row.source}:${row.variable}`)?.has(row.timestamp_utc) ?? false),
    ...goesMag.rows,
  ];
  const couplingSnapshot = buildL1EarthCouplingSnapshot(rows, {
    startUtc,
    stopUtc,
  });
  const featureSnapshot = buildFeatureWorkbenchSnapshot(rows, couplingSnapshot, context, {
    startUtc,
    stopUtc,
  }, target);
  const baselinesSnapshot = buildBaselinesLabSnapshot(featureSnapshot);
  const pipelineHealth = buildPipelineHealthSnapshot(telemetry);
  const snapshot = buildLiveForecastSnapshot(featureSnapshot, baselinesSnapshot, pipelineHealth);

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
