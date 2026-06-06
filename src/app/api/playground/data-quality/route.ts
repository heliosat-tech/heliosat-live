import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { buildDataQualitySnapshot } from '@/services/dataQualityService';
import { fetchPlaygroundTelemetry } from '@/services/playgroundTelemetryService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  const telemetry = await fetchPlaygroundTelemetry();
  const dataQuality = buildDataQualitySnapshot(telemetry, {
    startUtc,
    stopUtc,
  });

  return NextResponse.json(dataQuality, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
