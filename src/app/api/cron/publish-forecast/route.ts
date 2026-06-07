import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { publishRealtimeForecast } from '@/services/realtimeForecastService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * Scheduled precompute trigger (ROADMAP Fase 4): recompute the real-time forecast
 * from live NOAA data and store it as the public 'realtime' row, so GET /api/v1/...
 * only ever reads. Machine-callable — authenticated by a shared CRON_SECRET bearer
 * (the admin cookie can't authenticate a scheduler). Works with any scheduler that
 * can send a header: Vercel Cron (injects it automatically), GitHub Actions, or
 * Supabase pg_cron + pg_net. See docs/api-v1.md / ROADMAP D4.1.
 *
 * GET (not POST) because Vercel Cron only issues GET requests.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match ? match[1].trim() : '';
  // Constant-time compare; equal-length buffers required by timingSafeEqual.
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const published = await publishRealtimeForecast();
    return NextResponse.json(
      { ok: true, issued_at: published.issued_at, observed_at: published.observed_at },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error)?.message ?? 'Failed to publish forecast.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
