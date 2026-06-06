/**
 * Inventory of the LOCAL historical data available for training/analysis, classified
 * by orbit class (L1 / GEO / LEO / MEO) and mission, with date coverage. Reads metadata
 * only — the GOES backfill checkpoint (`data/checkpoints/goes_ncei_archive.json`, which
 * records per-day per-product coverage) and the console hourly archives — so it never
 * has to open the 9 GB of raw NetCDF or the Parquet store.
 */

import { promises as fs } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CHECKPOINT = path.join(ROOT, 'data', 'checkpoints', 'goes_ncei_archive.json');
const PARQUET_DIR = path.join(ROOT, 'data', 'parquet');
const CONSOLE_DIR = path.join(ROOT, 'data', 'console');
const DAY = 86_400_000;

export type Orbit = 'L1' | 'GEO' | 'LEO' | 'MEO';

export interface DatasetInfo {
  id: string;
  orbit: Orbit;
  mission: string;
  label: string;
  category: string;
  variables: string[];
  startMs: number | null;
  endMs: number | null;
  samples: number;
  days: number | null;
  cadence: string;
  coveragePct: number | null;
  format: string;
  store: string;
}

export interface TrainingInventory {
  generatedAtUtc: string;
  spanStartMs: number | null;
  spanEndMs: number;
  parquetBytes: number;
  datasets: DatasetInfo[];
  warnings: string[];
}

// GOES SEISS/EXIS product → human meaning.
const GOES_PRODUCT: Record<string, { category: string; variables: string[] }> = {
  mag: { category: 'Magnetometer', variables: ['Hp', 'He', 'Hn', '|H|'] },
  mpsh: { category: 'Electrons · MPS-HI', variables: ['e⁻ differential flux (energy bands)'] },
  sgps: { category: 'Protons · SGPS', variables: ['p⁺ differential flux (≥1 MeV bands)'] },
  xrs: { category: 'X-ray · EXIS XRS', variables: ['0.05–0.4 nm', '0.1–0.8 nm'] },
};

const dayStartMs = (iso: string) => { const ms = Date.parse(`${iso}T00:00:00Z`); return Number.isNaN(ms) ? null : ms; };

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return null; }
}

/** Sum the size of every *.parquet under the store (cheap — tens of files). */
async function parquetBytes(): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(PARQUET_DIR, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.parquet')) {
        try { total += (await fs.stat(path.join(e.parentPath ?? e.path ?? PARQUET_DIR, e.name))).size; } catch { /* skip */ }
      }
    }
  } catch { /* no store */ }
  return total;
}

/** One hourly console archive (rows = [t, ...]) → a dataset entry. */
async function archiveDataset(file: string, base: Omit<DatasetInfo, 'startMs' | 'endMs' | 'samples' | 'days'>): Promise<DatasetInfo | null> {
  const data = await readJson<{ rows: Array<[number, ...unknown[]]> }>(path.join(CONSOLE_DIR, file));
  if (!data || !Array.isArray(data.rows) || data.rows.length === 0) return null;
  const rows = data.rows;
  const startMs = rows[0][0];
  const endMs = rows[rows.length - 1][0];
  return { ...base, startMs, endMs, samples: rows.length, days: Math.round((endMs - startMs) / DAY) };
}

export async function buildTrainingInventory(): Promise<TrainingInventory> {
  const nowMs = Date.now();
  const warnings: string[] = [];
  const datasets: DatasetInfo[] = [];

  // ---- L1 (Lagrange point — the incoming solar wind) ----
  const ace = await archiveDataset('ace-archive.json', {
    id: 'l1-ace', orbit: 'L1', mission: 'ACE', label: 'ACE · solar wind at L1',
    category: 'Solar wind (in situ)', variables: ['speed', 'density', '|B|', 'Bz (GSM)'],
    cadence: '1 hour', coveragePct: null, format: 'JSON archive', store: 'data/console/ace-archive.json',
  });
  if (ace) datasets.push(ace);
  const omni = await archiveDataset('omni-archive.json', {
    id: 'l1-omni', orbit: 'L1', mission: 'OMNI (NASA)', label: 'OMNI · L1 wind shifted to Earth',
    category: 'Solar wind (propagated)', variables: ['speed', 'density', '|B|', 'Bz', 'Kp', 'Dst'],
    cadence: '1 hour', coveragePct: null, format: 'JSON archive', store: 'data/console/omni-archive.json',
  });
  if (omni) datasets.push(omni);

  // ---- GEO · GOES hourly archive (drives the live charts) ----
  const geoHourly = await archiveDataset('geo-archive.json', {
    id: 'geo-mag-hourly', orbit: 'GEO', mission: 'GOES-16/18/19', label: 'GOES magnetometer (hourly archive)',
    category: 'Magnetometer (hourly)', variables: ['Hp', '|H|'],
    cadence: '1 hour', coveragePct: null, format: 'JSON archive', store: 'data/console/geo-archive.json',
  });
  if (geoHourly) datasets.push(geoHourly);

  // ---- GEO · GOES full-res Parquet (from the NCEI backfill checkpoint) ----
  const checkpoint = await readJson<{ daily_coverage?: Record<string, { date_utc: string; product: string; spacecraft_id: string; observed_samples?: number; expected_samples?: number }> }>(CHECKPOINT);
  if (checkpoint?.daily_coverage) {
    const agg = new Map<string, { sc: string; pr: string; min: string; max: string; days: number; obs: number; exp: number }>();
    for (const v of Object.values(checkpoint.daily_coverage)) {
      const key = `${v.spacecraft_id}|${v.product}`;
      const a = agg.get(key) ?? { sc: v.spacecraft_id, pr: v.product, min: '9999', max: '0000', days: 0, obs: 0, exp: 0 };
      a.days += 1; a.obs += v.observed_samples ?? 0; a.exp += v.expected_samples ?? 0;
      if (v.date_utc < a.min) a.min = v.date_utc;
      if (v.date_utc > a.max) a.max = v.date_utc;
      agg.set(key, a);
    }
    for (const a of [...agg.values()].sort((x, y) => (x.sc + x.pr).localeCompare(y.sc + y.pr))) {
      const meta = GOES_PRODUCT[a.pr] ?? { category: a.pr.toUpperCase(), variables: [a.pr] };
      datasets.push({
        id: `geo-${a.sc}-${a.pr}`.toLowerCase(),
        orbit: 'GEO', mission: a.sc, label: `${a.sc} · ${meta.category}`, category: meta.category,
        variables: meta.variables,
        startMs: dayStartMs(a.min), endMs: (dayStartMs(a.max) ?? 0) + DAY,
        samples: a.obs, days: a.days,
        cadence: '1 min', coveragePct: a.exp > 0 ? Math.round((a.obs / a.exp) * 100) : null,
        format: 'Parquet', store: `data/parquet/source=goes_nccei/spacecraft=${a.sc}`,
      });
    }
  } else {
    warnings.push('GOES backfill checkpoint not found — Parquet inventory unavailable.');
  }

  const starts = datasets.map(d => d.startMs).filter((v): v is number => v !== null);
  return {
    generatedAtUtc: new Date(nowMs).toISOString(),
    spanStartMs: starts.length ? Math.min(...starts) : null,
    spanEndMs: nowMs,
    parquetBytes: await parquetBytes(),
    datasets,
    warnings,
  };
}
