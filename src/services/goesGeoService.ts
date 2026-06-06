/**
 * GEO satellite data for the Internal Console: the GOES magnetometer (the
 * magnetospheric magnetic field at geostationary orbit, ~6.6 Re / 35,786 km). This is
 * a genuine GEO measurement — distinct from the L1 solar wind. Source: NOAA SWPC's
 * primary-GOES JSON (last 1/3/7 days). Multi-year GEO history would need NCEI's netCDF
 * archive, which isn't parsed here yet.
 *
 * Hp = the field component parallel to Earth's spin axis (the classic GEO storm/substorm
 * indicator); `total` = field magnitude. Both in nT. Rows flagged `arcjet_flag` (thruster
 * firing contaminates the reading) are dropped.
 */

const BASE = 'https://services.swpc.noaa.gov/json/goes/primary';
const REQUEST_TIMEOUT_MS = 12000;

export interface GeoPoint { ms: number; hp: number | null; total: number | null }
export interface GeoResult { samples: GeoPoint[]; satellite: number | null; errorMessage: string | null }

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GOES magnetometer (GEO) for roughly the last `days` days (SWPC products cap at 7). */
export async function fetchGoesGeo(days: number): Promise<GeoResult> {
  const product = days <= 1 ? 'magnetometers-1-day.json' : days <= 3 ? 'magnetometers-3-day.json' : 'magnetometers-7-day.json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${product}`, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`SWPC GOES magnetometer request failed with ${res.status}`);
    const data = (await res.json()) as Array<Record<string, unknown>>;

    const byMs = new Map<number, GeoPoint>();
    let satellite: number | null = null;
    for (const row of Array.isArray(data) ? data : []) {
      const ms = new Date(String(row.time_tag)).getTime();
      if (Number.isNaN(ms)) continue;
      satellite = numOrNull(row.satellite) ?? satellite;
      const contaminated = row.arcjet_flag === true;
      byMs.set(ms, {
        ms,
        hp: contaminated ? null : numOrNull(row.Hp),
        total: contaminated ? null : numOrNull(row.total),
      });
    }
    return { samples: [...byMs.values()].sort((a, b) => a.ms - b.ms), satellite, errorMessage: null };
  } catch (error) {
    return { samples: [], satellite: null, errorMessage: error instanceof Error ? error.message : 'SWPC GOES magnetometer request failed' };
  } finally {
    clearTimeout(timer);
  }
}
