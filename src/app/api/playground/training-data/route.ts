import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { resolveCoverageAnchoredRange } from '@/services/dataCoverageService';
import { fetchAceOmniSamples, type AceSource } from '@/services/l1EarthData';
import { downsamplePoints, type ForecastHistoryPoint } from '@/services/forecastHistoryService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const HAPI = 'https://cdaweb.gsfc.nasa.gov/hapi';
// `recent` = ACE quick-look (2017+); `deep` = ACE science archive (1998+).
const SOURCE_DATASETS: Record<AceSource, string[]> = {
  k0: ['AC_K0_SWE', 'AC_K0_MFI', 'OMNI_HRO_1MIN'],
  science: ['AC_H0_SWE', 'AC_H0_MFI', 'OMNI_HRO_1MIN'],
};
const TARGET_POINTS = 500;
const MAX_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Probe /info for a dataset's actual [startDate, stopDate]. */
async function datasetSpan(id: string): Promise<{ start: number; stop: number } | null> {
  try {
    const response = await fetch(`${HAPI}/info?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const info = (await response.json()) as { startDate?: string; stopDate?: string };
    const start = info.startDate ? new Date(info.startDate).getTime() : Number.NaN;
    const stop = info.stopDate ? new Date(info.stopDate).getTime() : Number.NaN;
    if (Number.isNaN(start) || Number.isNaN(stop)) return null;
    return { start, stop };
  } catch {
    return null;
  }
}

/**
 * The actual training inputs, for plotting in the Data & pipeline tab:
 *  - the available historical coverage (so the user sees what ranges can be imposed),
 *  - and the L1 (ACE) + near-Earth (OMNI) series over the requested window
 *    (default = the 14-day coverage-anchored training window).
 */
export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const url = new URL(request.url);
  const daysParam = Number(url.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(MAX_DAYS, daysParam) : 14;
  const endParam = url.searchParams.get('end');
  const source: AceSource = url.searchParams.get('source') === 'deep' ? 'science' : 'k0';
  const datasets = SOURCE_DATASETS[source];

  // Available historical coverage = overlap of the chosen source's datasets.
  const spans = (await Promise.all(datasets.map(datasetSpan))).filter((s): s is { start: number; stop: number } => s !== null);
  const available = spans.length
    ? { startUtc: new Date(Math.max(...spans.map(s => s.start))).toISOString(), stopUtc: new Date(Math.min(...spans.map(s => s.stop))).toISOString() }
    : null;

  // Window to fetch: an explicit end anchor + window length (lets the user jump to
  // any historical window), else the coverage-anchored training window.
  let range: { startUtc: string; stopUtc: string } | null = null;
  const endMs = endParam ? new Date(endParam).getTime() : Number.NaN;
  if (!Number.isNaN(endMs)) {
    const clampedEnd = available ? Math.min(endMs, new Date(available.stopUtc).getTime()) : endMs;
    range = { startUtc: new Date(clampedEnd - days * DAY_MS).toISOString(), stopUtc: new Date(clampedEnd).toISOString() };
  } else if (source === 'science' && available) {
    // Deep mode defaults to the latest available science window.
    const stop = new Date(available.stopUtc).getTime();
    range = { startUtc: new Date(stop - days * DAY_MS).toISOString(), stopUtc: new Date(stop).toISOString() };
  } else {
    // One retry — the HAPI /info probe can miss on a cold first request.
    range = (await resolveCoverageAnchoredRange(days)) ?? (await resolveCoverageAnchoredRange(days));
  }
  if (!range) {
    return NextResponse.json({ available, range: null, source, l1: [], earth: [], warnings: ['Could not resolve a data window (HAPI coverage probe failed).'] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const { l1, earth, warnings } = await fetchAceOmniSamples(range, { source });
  const toPoints = (s: { ms: number; speed: number | null; density: number | null; bt: number | null; bz: number | null }): ForecastHistoryPoint => ({ t: s.ms, speed: s.speed, density: s.density, bt: s.bt, bz: s.bz });

  return NextResponse.json(
    {
      available,
      range,
      source,
      counts: { l1: l1.length, earth: earth.length },
      l1: downsamplePoints(l1.map(toPoints), TARGET_POINTS),
      earth: downsamplePoints(earth.map(toPoints), TARGET_POINTS),
      warnings,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
