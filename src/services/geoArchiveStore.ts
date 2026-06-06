/**
 * Read-side of the local GEO (GOES magnetometer) archive. The archive itself is built
 * out-of-band by `scripts/build-geo-archive.mjs` (NCEI daily HDF5 → hourly Hp/|H|),
 * because HDF5 parsing (h5wasm) is awkward inside the app's Turbopack runtime. The app
 * only reads/slices the resulting JSON — so historical windows show real GEO data.
 */

import { promises as fs } from 'fs';
import path from 'path';

const STORE_PATH = path.join(process.cwd(), 'data', 'console', 'geo-archive.json');

type Row = [number, number | null, number | null]; // [t, hp(nT), total|H|(nT)]
interface ArchiveFile { updatedAtMs: number; rows: Row[] }

export interface GeoArchiveStatus { exists: boolean; rows: number; startMs: number | null; endMs: number | null; updatedAtMs: number | null }
export interface GeoHourPoint { ms: number; hp: number | null; total: number | null }

async function readArchive(): Promise<ArchiveFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_PATH, 'utf8')) as ArchiveFile;
    return Array.isArray(parsed?.rows) ? parsed : null;
  } catch {
    return null;
  }
}

export async function getGeoArchiveStatus(): Promise<GeoArchiveStatus> {
  const f = await readArchive();
  if (!f || f.rows.length === 0) return { exists: false, rows: 0, startMs: null, endMs: null, updatedAtMs: null };
  return { exists: true, rows: f.rows.length, startMs: f.rows[0][0], endMs: f.rows[f.rows.length - 1][0], updatedAtMs: f.updatedAtMs };
}

export async function sliceGeoArchive(startMs: number, endMs: number): Promise<GeoHourPoint[]> {
  const f = await readArchive();
  if (!f) return [];
  const out: GeoHourPoint[] = [];
  for (const [t, hp, total] of f.rows) {
    if (t < startMs || t > endMs) continue;
    out.push({ ms: t, hp, total });
  }
  return out;
}
