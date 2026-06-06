import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { getArchiveStatus, buildOmniArchive } from '@/services/omniArchiveStore';
import { getAceArchiveStatus, buildAceArchive } from '@/services/aceArchiveStore';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

const noStore = { headers: { 'Cache-Control': 'no-store' } } as const;

/**
 * Local archive control for the two historical datasets: OMNI (near-Earth) and ACE (L1).
 * `GET` reports coverage of both; `GET ?build=1` downloads/refreshes both (incremental,
 * resumable; `&force=1` rebuilds from scratch, `&years=N` sets span, `&only=omni|ace`
 * limits to one). Once built, the historical chart windows slice them locally instead of
 * hitting CDAWeb on every view.
 */
export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, ...noStore });
  }

  const url = new URL(request.url);
  if (url.searchParams.get('build') === '1') {
    const force = url.searchParams.get('force') === '1';
    const only = url.searchParams.get('only');
    const yearsRaw = Number(url.searchParams.get('years'));
    const years = Number.isFinite(yearsRaw) && yearsRaw > 0 ? Math.min(20, Math.round(yearsRaw)) : undefined;
    const omni = only === 'ace' ? await getOmniReport() : await buildOmniArchive({ years, force });
    const ace = only === 'omni' ? await getAceReport() : await buildAceArchive({ years, force });
    return NextResponse.json({ omni, ace }, noStore);
  }

  return NextResponse.json({ status: await getArchiveStatus(), ace: await getAceArchiveStatus() }, noStore);
}

// Wrap a no-op build (when `only=` skips one) as a report-shaped status echo.
async function getOmniReport() {
  return { status: await getArchiveStatus(), yearsFetched: 0, yearsSkipped: 0, yearsFailed: 0, failedYears: [] };
}
async function getAceReport() {
  return { status: await getAceArchiveStatus(), yearsFetched: 0, yearsSkipped: 0, yearsFailed: 0, failedYears: [] };
}
