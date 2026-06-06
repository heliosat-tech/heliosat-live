import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { fetchPlaygroundTelemetry } from '@/services/playgroundTelemetryService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

  const telemetry = await fetchPlaygroundTelemetry();

  return NextResponse.json(telemetry, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
