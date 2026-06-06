/**
 * On-disk cache for the Internal Console chart series. The historical windows
 * (30d/1y/5y) pull tens of thousands of rows from CDAWeb HAPI on every request,
 * which is slow and flaky. The archive past data barely changes (OMNI only grows at
 * its recent, ~3-week-lagged edge), so we cache each window's computed+downsampled
 * payload on disk and serve it within a per-window TTL — turning repeat loads into an
 * instant disk read. Also lets us serve the last good snapshot when HAPI returns
 * nothing, instead of a blank chart.
 *
 * Single-instance/persistent-filesystem cache (same as `timing.json`). For a
 * serverless deploy this would move to Supabase/blob storage; the call sites are
 * isolated here so that swap is a one-file change.
 */

import { promises as fs } from 'fs';
import path from 'path';

const STORE_DIR = path.join(process.cwd(), 'data', 'console', 'series');

/** Freshness window per chart range — historical data is near-immutable, so cache long. */
export const SERIES_TTL_MS: Record<string, number> = {
  '24h': 45_000,
  '3d': 60_000,
  '7d': 120_000,
  '30d': 3 * 60 * 60_000, // 3 h
  '1y': 12 * 60 * 60_000, // 12 h
  '5y': 24 * 60 * 60_000, // 24 h
};

export interface CachedSeries<T> {
  fetchedAtMs: number;
  payload: T;
}

const safeKey = (window: string) => window.replace(/[^a-z0-9_-]/gi, '_');

export async function readSeriesCache<T>(window: string): Promise<CachedSeries<T> | null> {
  try {
    const raw = await fs.readFile(path.join(STORE_DIR, `${safeKey(window)}.json`), 'utf8');
    const parsed = JSON.parse(raw) as CachedSeries<T>;
    return typeof parsed?.fetchedAtMs === 'number' && parsed.payload ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSeriesCache<T>(window: string, payload: T): Promise<void> {
  try {
    await fs.mkdir(STORE_DIR, { recursive: true });
    await fs.writeFile(path.join(STORE_DIR, `${safeKey(window)}.json`), JSON.stringify({ fetchedAtMs: Date.now(), payload }), 'utf8');
  } catch {
    /* best-effort cache — never block the response on a write failure */
  }
}
