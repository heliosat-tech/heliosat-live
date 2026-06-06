/**
 * Local ACE L1 archive for the Internal Console — the historical counterpart of the
 * OMNI (near-Earth) archive, but for the solar wind measured AT L1 (ACE). Lets the
 * 1y/5y charts show the real "L1 detected" + "MRU forecast" lines instead of near-Earth
 * only. (Terminology: L1 = the Lagrange point, NEVER "near Earth"; near-Earth = OMNI.)
 *
 * Source: CDAWeb HAPI hourly products `AC_H2_MFI` (|B| + Bz GSM) and `AC_H2_SWE`
 * (speed + density). The full-resolution ACE files are HDF4 (impractical in Node) and
 * the ASC merged ASCII lacks Bz/density, so we pull the hourly HAPI CSV per YEAR
 * (~16s/year — fine once) and persist to disk forever; only the current year is
 * refreshed. Incremental/resumable, and never clobbers a good archive with an empty one.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { L1EventSample } from './liveEventService';

const STORE_DIR = path.join(process.cwd(), 'data', 'console');
const STORE_PATH = path.join(STORE_DIR, 'ace-archive.json');

const HAPI_DATA = 'https://cdaweb.gsfc.nasa.gov/hapi/data';
const DEFAULT_YEARS = 6;
const COVERED_THRESHOLD = 4000; // hourly rows in a past year to consider it archived
const FETCH_TIMEOUT_MS = 90_000;
const HOUR = 3_600_000;

// Compact columnar row: [t, v(km/s), n(/cc), bt(nT), bz GSM(nT)]. null = missing.
type Row = [number, number | null, number | null, number | null, number | null];

interface ArchiveFile {
  updatedAtMs: number;
  rows: Row[];
}

export interface AceArchiveStatus {
  exists: boolean;
  rows: number;
  startMs: number | null;
  endMs: number | null;
  updatedAtMs: number | null;
}

export interface AceArchiveSlice {
  samples: L1EventSample[];
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
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(file), 'utf8');
}

export async function getAceArchiveStatus(): Promise<AceArchiveStatus> {
  const file = await readFile();
  if (!file || file.rows.length === 0) return { exists: false, rows: 0, startMs: null, endMs: null, updatedAtMs: null };
  return { exists: true, rows: file.rows.length, startMs: file.rows[0][0], endMs: file.rows[file.rows.length - 1][0], updatedAtMs: file.updatedAtMs };
}

export async function sliceAceArchive(startMs: number, endMs: number): Promise<AceArchiveSlice | null> {
  const file = await readFile();
  if (!file || file.rows.length === 0) return null;
  const samples: L1EventSample[] = [];
  for (const [t, v, n, bt, bz] of file.rows) {
    if (t < startMs || t > endMs) continue;
    samples.push({ ms: t, speedKmS: v, densityPerCm3: n, bzNt: bz, btNt: bt });
  }
  return { samples, startMs, endMs };
}

/** HAPI numeric cell → null on fill (AC_H2 uses ~-1e31) or, for positive-only fields, negatives. */
function cell(token: string | undefined, positiveOnly = false): number | null {
  const v = Number(token);
  if (!Number.isFinite(v) || Math.abs(v) >= 1e20) return null;
  if (positiveOnly && v < 0) return null;
  return v;
}

async function fetchCsv(url: string): Promise<string[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) return [];
    const text = await res.text();
    return text.split('\n').filter(Boolean).map(l => l.split(','));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const hourKey = (iso: string) => Math.round(new Date(iso).getTime() / HOUR) * HOUR;

/** Fetch + merge one calendar year of ACE MAG (|B|,Bz) and SWEPAM (speed,density). */
async function fetchAceYear(year: number): Promise<Row[]> {
  const tmin = `${year}-01-01T00:00:00Z`;
  const tmax = `${year + 1}-01-01T00:00:00Z`;
  const [mfi, swe] = await Promise.all([
    fetchCsv(`${HAPI_DATA}?id=AC_H2_MFI&parameters=Magnitude,BGSM&time.min=${tmin}&time.max=${tmax}&format=csv`),
    fetchCsv(`${HAPI_DATA}?id=AC_H2_SWE&parameters=Np,Vp&time.min=${tmin}&time.max=${tmax}&format=csv`),
  ]);
  if (mfi.length === 0 && swe.length === 0) return [];

  // MAG CSV cols: time, Magnitude, Bx, By, Bz(GSM)
  const byHour = new Map<number, Row>();
  for (const c of mfi) {
    if (c.length < 5 || Number.isNaN(new Date(c[0]).getTime())) continue;
    const t = hourKey(c[0]);
    const row = byHour.get(t) ?? [t, null, null, null, null];
    row[3] = cell(c[1], true); // |B|
    row[4] = cell(c[4]); // Bz GSM (signed)
    byHour.set(t, row);
  }
  // SWEPAM CSV cols: time, Np(density), Vp(speed)
  for (const c of swe) {
    if (c.length < 3 || Number.isNaN(new Date(c[0]).getTime())) continue;
    const t = hourKey(c[0]);
    const row = byHour.get(t) ?? [t, null, null, null, null];
    row[2] = cell(c[1], true); // density
    row[1] = cell(c[2], true); // speed
    byHour.set(t, row);
  }
  // Drop all-fill hours so coverage ends at the last real measurement.
  return [...byHour.values()].filter(r => r[1] !== null || r[2] !== null || r[3] !== null || r[4] !== null).sort((a, b) => a[0] - b[0]);
}

async function fetchAceYearWithRetry(year: number, retries = 1): Promise<Row[]> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const rows = await fetchAceYear(year);
    if (rows.length > 0) return rows;
    if (attempt < retries) await new Promise(res => setTimeout(res, 2000));
  }
  return [];
}

export interface AceBuildReport {
  status: AceArchiveStatus;
  yearsFetched: number;
  yearsSkipped: number;
  yearsFailed: number;
  failedYears: number[];
}

export async function buildAceArchive(options?: { years?: number; force?: boolean }): Promise<AceBuildReport> {
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
    const rows = await fetchAceYearWithRetry(y);
    if (rows.length === 0) {
      yearsFailed += 1;
      failedYears.push(y);
      continue;
    }
    for (const row of rows) byHour.set(row[0], row);
    yearsFetched += 1;
    await writeFile({ updatedAtMs: Date.now(), rows: [...byHour.values()].sort((a, b) => a[0] - b[0]) });
  }

  const merged = [...byHour.values()].sort((a, b) => a[0] - b[0]);
  // Never clobber a good archive with an empty one.
  if (merged.length === 0) {
    return { status: await getAceArchiveStatus(), yearsFetched, yearsSkipped, yearsFailed, failedYears };
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
