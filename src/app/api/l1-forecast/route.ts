import { NextResponse } from 'next/server';
import { buildL1ForecastPanelData } from '@/services/l1ForecastPanelService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Live refresh feed for the L1 -> Earth propagation panels. The home page server-renders the
 * initial payload; the client polls this route every minute so the arrival heatmaps and charts
 * keep sliding as the solar wind advances toward Earth.
 */
export async function GET() {
  const data = await buildL1ForecastPanelData();
  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
