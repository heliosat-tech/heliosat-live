/**
 * Local OMNI hourly archive for the Internal Console. CDAWeb's on-demand HAPI is far
 * too slow for bulk history (a single 1-year request routinely times out at 120s), so
 * the archive is built from SPDF's PRE-GENERATED yearly files
 * (`omni2_YYYY.dat`, ~3-4s each) instead — static downloads, no server-side query.
 * We pull the near-Earth OMNI record ONCE into a compact on-disk file and serve every
 * historical window (30d/1y/5y) by slicing it locally. Instant, and immune to CDAWeb
 * being down.
 *
 * The build is incremental/resumable: each year is persisted as it lands and past
 * years already archived are skipped, so an interrupted run isn't lost and re-running
 * just completes it. Single-instance/persistent-filesystem store (same pattern as
 * `timing.json`); for serverless this would move to Supabase/blob.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { writeJsonFileBestEffort } from '@/lib/fsCache';
import type { L1EventSample, KpPoint } from './liveEventService';

const STORE_DIR = path.join(process.cwd(), 'data', 'console');
const STORE_PATH = path.join(STORE_DIR, 'omni-archive.json');

const DEFAULT_YEARS = 6; // covers the 5y window with margin
const COVERED_THRESHOLD = 4000; // hourly rows in a past year to consider it archived (~½ year)
const SPDF_BASE = 'https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni';
const FETCH_TIMEOUT_MS = 60_000;

// OMNI2 hourly fixed columns (0-based word index) — see the omni2 format doc.
const COL = { bt: 8, bzGsm: 16, density: 23, speed: 24, kp: 38, dst: 40 } as const;

// Compact columnar row: [t, v(km/s), n(/cc), bt(nT), bz(nT), kp(0..9), dst(nT)]. null = missing.
type Row = [number, number | null, number | null, number | null, number | null, number | null, number | null];

interface ArchiveFile {
  updatedAtMs: number;
  rows: Row[]; // sorted ascending by t (hour)
}

export interface ArchiveStatus {
  exists: boolean;
  rows: number;
  startMs: number | null;
  endMs: number | null;
  updatedAtMs: number | null;
}

export interface ArchiveSlice {
  samples: L1EventSample[];
  kpSeries: KpPoint[];
  dst: Array<{ ms: number; dst: number }>;
  startMs: number;
  endMs: number;
}

async function readFile(): Promise<ArchiveFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_PATH, 'utf8')) as ArchiveFile;
    return Array.isArray(parsed?.rows) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeFile(file: ArchiveFile): Promise<void> {
  await writeJsonFileBestEffort(STORE_PATH, file);
}

export async function getArchiveStatus(): Promise<ArchiveStatus> {
  const file = await readFile();
  if (!file || file.rows.length === 0) return { exists: false, rows: 0, startMs: null, endMs: null, updatedAtMs: null };
  return {
    exists: true,
    rows: file.rows.length,
    startMs: file.rows[0][0],
    endMs: file.rows[file.rows.length - 1][0],
    updatedAtMs: file.updatedAtMs,
  };
}

/** Slice the archive to [startMs, endMs] into the OmniHistory-shaped result the series route expects. */
export async function sliceArchive(startMs: number, endMs: number): Promise<ArchiveSlice | null> {
  const file = await readFile();
  if (!file || file.rows.length === 0) return null;
  const samples: L1EventSample[] = [];
  const kpSeries: KpPoint[] = [];
  const dst: Array<{ ms: number; dst: number }> = [];
  for (const [t, v, n, bt, bz, kp, d] of file.rows) {
    if (t < startMs || t > endMs) continue;
    samples.push({ ms: t, speedKmS: v, densityPerCm3: n, bzNt: bz, btNt: bt });
    if (kp !== null) kpSeries.push({ ms: t, kp });
    if (d !== null) dst.push({ ms: t, dst: d });
  }
  return { samples, kpSeries, dst, startMs, endMs };
}

/** Newest hour the archive holds (≈ the latest OMNI coverage); null if empty. */
export async function archiveCoverageEndMs(): Promise<number | null> {
  const file = await readFile();
  return file && file.rows.length ? file.rows[file.rows.length - 1][0] : null;
}

/** Parse one numeric OMNI cell, mapping the fill sentinel to null. */
function field(token: string | undefined, fillAtOrAbove: number): number | null {
  const v = Number(token);
  if (!Number.isFinite(v)) return null;
  return Math.abs(v) >= fillAtOrAbove ? null : v;
}

/** Download + parse SPDF's static omni2_YYYY.dat (whitespace-delimited hourly rows). */
async function fetchOmniYear(year: number): Promise<Row[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SPDF_BASE}/omni2_${year}.dat`, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) return [];
    const text = await res.text();
    const rows: Row[] = [];
    for (const line of text.split('\n')) {
      const c = line.trim().split(/\s+/);
      if (c.length < 41) continue;
      const yr = Number(c[0]);
      const doy = Number(c[1]);
      const hr = Number(c[2]);
      if (!Number.isFinite(yr) || !Number.isFinite(doy) || !Number.isFinite(hr)) continue;
      const t = Date.UTC(yr, 0, 1) + (doy - 1) * 86400000 + hr * 3600000;

      const kpRaw = Number(c[COL.kp]); // Kp ×10 (e.g. 23 -> 2.3); 99 = fill
      const dstRaw = Number(c[COL.dst]);
      const v = field(c[COL.speed], 9990);
      const n = field(c[COL.density], 999);
      const bt = field(c[COL.bt], 999);
      const bz = field(c[COL.bzGsm], 999);
      const kp = Number.isFinite(kpRaw) && kpRaw >= 0 && kpRaw <= 90 ? kpRaw / 10 : null;
      const dst = Number.isFinite(dstRaw) && Math.abs(dstRaw) < 99990 ? dstRaw : null;
      // Skip all-fill hours (the current-year file pads unprocessed hours to year-end);
      // dropping them keeps the coverage end at the last REAL measurement.
      if (v === null && n === null && bt === null && bz === null && kp === null && dst === null) continue;
      rows.push([t, v, n, bt, bz, kp, dst]);
    }
    return rows;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOmniYearWithRetry(year: number, retries = 2): Promise<Row[]> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const rows = await fetchOmniYear(year);
    if (rows.length > 0) return rows;
    if (attempt < retries) await new Promise(res => setTimeout(res, 1500));
  }
  return [];
}

export interface BuildReport {
  status: ArchiveStatus;
  yearsFetched: number;
  yearsSkipped: number;
  yearsFailed: number;
  failedYears: number[];
}

/**
 * Build/refresh the local OMNI archive from SPDF yearly files. Incremental: skips past
 * years already well covered (unless `force`), always refetches the current year (its
 * file grows). Persists after each year, so a partial run is never lost.
 */
export async function buildOmniArchive(options?: { years?: number; force?: boolean }): Promise<BuildReport> {
  const years = options?.years ?? DEFAULT_YEARS;
  const force = options?.force ?? false;
  const currentYear = new Date().getUTCFullYear();
  const firstYear = currentYear - years + 1;

  const existing = force ? null : await readFile();
  const byHour = new Map<number, Row>();
  if (existing) for (const row of existing.rows) byHour.set(row[0], row);

  const countInYear = (y: number) => {
    const start = Date.UTC(y, 0, 1);
    const end = Date.UTC(y + 1, 0, 1);
    let n = 0;
    for (const t of byHour.keys()) if (t >= start && t < end) n += 1;
    return n;
  };

  let yearsFetched = 0;
  let yearsSkipped = 0;
  let yearsFailed = 0;
  const failedYears: number[] = [];

  for (let y = firstYear; y <= currentYear; y += 1) {
    const isCurrent = y === currentYear;
    if (!force && !isCurrent && countInYear(y) >= COVERED_THRESHOLD) {
      yearsSkipped += 1;
      continue;
    }
    const rows = await fetchOmniYearWithRetry(y);
    if (rows.length === 0) {
      yearsFailed += 1;
      failedYears.push(y);
      continue;
    }
    for (const row of rows) byHour.set(row[0], row);
    yearsFetched += 1;
    // Persist progress immediately so an interrupted/timed-out build isn't lost.
    await writeFile({ updatedAtMs: Date.now(), rows: [...byHour.values()].sort((a, b) => a[0] - b[0]) });
  }

  const merged = [...byHour.values()].sort((a, b) => a[0] - b[0]);

  // Never clobber a good archive with an empty one: if every fetch failed (SPDF down)
  // leave whatever is already on disk untouched and report the failure.
  if (merged.length === 0) {
    return { status: await getArchiveStatus(), yearsFetched, yearsSkipped, yearsFailed, failedYears };
  }

  await writeFile({ updatedAtMs: Date.now(), rows: merged });

  return {
    status: {
      exists: merged.length > 0,
      rows: merged.length,
      startMs: merged.length ? merged[0][0] : null,
      endMs: merged.length ? merged[merged.length - 1][0] : null,
      updatedAtMs: Date.now(),
    },
    yearsFetched,
    yearsSkipped,
    yearsFailed,
    failedYears,
  };
}
