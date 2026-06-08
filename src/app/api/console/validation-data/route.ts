import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { getAceArchiveStatus } from '@/services/aceArchiveStore';
import { getArchiveStatus as getOmniArchiveStatus } from '@/services/omniArchiveStore';
import { getGeoArchiveStatus } from '@/services/geoArchiveStore';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CONSOLE_DATA_DIR = path.join(process.cwd(), 'data', 'console');

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function readJson<T>(fileName: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(CONSOLE_DATA_DIR, fileName), 'utf8')) as T;
  } catch {
    return null;
  }
}

interface ArrivalCache {
  source?: string;
  interval?: { startUtc: string; stopUtc: string; label: string };
  statsSpan?: { startUtc: string; stopUtc: string; multiYear: boolean };
  samples?: number;
  computedAtUtc?: string;
}

interface TimingCache {
  samples?: number;
  coverage?: { startUtc: string; stopUtc: string };
  computedAtUtc?: string;
}

export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const [ace, omni, geo, arrival, timing] = await Promise.all([
    getAceArchiveStatus(),
    getOmniArchiveStatus(),
    getGeoArchiveStatus(),
    readJson<ArrivalCache>('arrival.json'),
    readJson<TimingCache>('timing.json'),
  ]);

  return NextResponse.json(
    {
      generatedAtUtc: new Date().toISOString(),
      archives: {
        ace: {
          rows: ace.rows,
          startUtc: iso(ace.startMs),
          endUtc: iso(ace.endMs),
          updatedAtUtc: iso(ace.updatedAtMs),
          resolution: '1 hour',
          role: 'Historical upstream L1 input for MRU hindcast.',
          variables: ['speed', 'density', '|B|', 'Bz GSM'],
          source: 'ACE AC_H2_MFI + AC_H2_SWE via CDAWeb HAPI',
        },
        omni: {
          rows: omni.rows,
          startUtc: iso(omni.startMs),
          endUtc: iso(omni.endMs),
          updatedAtUtc: iso(omni.updatedAtMs),
          resolution: '1 hour',
          role: 'Near-Earth/time-shifted truth for variable alignment, plus Kp/Dst response labels.',
          variables: ['speed', 'density', '|B|', 'Bz GSM', 'Kp', 'Dst'],
          source: 'OMNI2 hourly archive from SPDF yearly files',
        },
        geo: {
          rows: geo.rows,
          startUtc: iso(geo.startMs),
          endUtc: iso(geo.endMs),
          updatedAtUtc: iso(geo.updatedAtMs),
          resolution: '1 hour',
          role: 'GEO magnetosphere response context, not L1 solar-wind truth.',
          variables: ['Hp', '|H|'],
          source: 'GOES magnetometer archive built from NCEI daily files',
        },
      },
      studies: {
        arrivalTiming: {
          source: arrival?.source ?? 'OMNI HRO Timeshift',
          interval: arrival?.interval ?? null,
          statsSpan: arrival?.statsSpan ?? null,
          samples: arrival?.samples ?? null,
          computedAtUtc: arrival?.computedAtUtc ?? null,
          role: 'Compares MRU ballistic delay against OMNI propagation Timeshift.',
          metrics: ['bias', 'MAE', 'RMSE', 'median absolute error', 'p90 absolute error', 'within 10/20/30 min'],
        },
        timingDistribution: {
          coverage: timing?.coverage ?? null,
          samples: timing?.samples ?? null,
          computedAtUtc: timing?.computedAtUtc ?? null,
          role: 'Long-span timing distribution for MRU delay vs OMNI Timeshift.',
          metrics: ['bias', 'MAE', 'RMSE', 'p90 absolute error', 'within tolerance'],
        },
        variableAlignment: {
          role: 'Propagates ACE upstream L1 samples and compares speed, density, |B| and Bz against OMNI near-Earth truth at arrival time.',
          metrics: ['MAE', 'RMSE', 'bias', 'correlation'],
        },
        gProxy: {
          role: 'Compares the rules-based estimated G/Kp response proxy against observed Kp/G bins.',
          metrics: ['exact match', 'within ±1 G level', 'bias'],
          caveat: 'Kp is a ground geomagnetic response index, not an in-situ solar-wind variable.',
        },
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
