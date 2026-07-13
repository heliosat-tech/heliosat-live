import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { buildLeoForecast, LEO_FORECAST_SNAPSHOT_FILE } from '@/services/leo/leoForecastService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

const noStore = { headers: { 'Cache-Control': 'no-store' } } as const;

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

/**
 * Experimental internal LEO forecast. Real TLE/L1 context is returned even when the
 * versioned density snapshot is absent; scientific density/drag fields then stay null.
 */
export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, ...noStore });
  }

  const params = new URL(request.url).searchParams;
  const group = params.get('group') === 'weather' ? 'weather' as const : 'stations' as const;
  const noradId = params.get('norad_id');
  const horizonMinutes = boundedInteger(params.get('horizon_minutes'), 180, 30, 1_440);
  const cadenceMinutes = boundedInteger(params.get('cadence_minutes'), 5, 1, 30);
  const result = await buildLeoForecast({ group, noradId, horizonMinutes, cadenceMinutes });
  if (!result.timeline && !result.warnings.some(warning => warning.includes(LEO_FORECAST_SNAPSHOT_FILE))) {
    result.warnings.push(`No ${LEO_FORECAST_SNAPSHOT_FILE} density output is available.`);
  }
  return NextResponse.json(result, noStore);
}
