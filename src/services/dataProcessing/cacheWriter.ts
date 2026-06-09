import { promises as fs } from 'fs';
import path from 'path';

export type IngestionCacheStage = 'raw' | 'processed';
export type IngestionCacheFormat = 'jsonl';

export interface IngestionCacheWriteOptions {
  stage: IngestionCacheStage;
  sourceId: string;
  rows: unknown[];
  fetchedAtUtc?: string;
  fileLabel?: string;
}

export interface IngestionCacheWriteResult {
  ok: boolean;
  path: string;
  rows: number;
  format: IngestionCacheFormat;
  errorMessage: string | null;
}

function dataRoot() {
  return process.env.HELIOSAT_DATA_ROOT ?? path.join(process.cwd(), 'data');
}

function sanitizePathSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function timestampFileLabel(timestampUtc: string) {
  return timestampUtc
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '')
    .replace(/[^0-9TZ-]/g, '');
}

function serializeJsonl(rows: unknown[]) {
  return `${rows.map(row => JSON.stringify(row)).join('\n')}${rows.length > 0 ? '\n' : ''}`;
}

export function getIngestionCachePath(options: IngestionCacheWriteOptions) {
  const fetchedAtUtc = options.fetchedAtUtc ?? new Date().toISOString();
  const sourceSegment = sanitizePathSegment(options.sourceId);
  const fileSegment = sanitizePathSegment(options.fileLabel ?? options.sourceId);
  const daySegment = fetchedAtUtc.slice(0, 10);

  return path.join(
    dataRoot(),
    options.stage,
    sourceSegment,
    daySegment,
    `${fileSegment}-${timestampFileLabel(fetchedAtUtc)}.jsonl`,
  );
}

export async function writeIngestionJsonlCacheBestEffort(
  options: IngestionCacheWriteOptions,
): Promise<IngestionCacheWriteResult> {
  const filePath = getIngestionCachePath(options);

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, serializeJsonl(options.rows), 'utf8');

    return {
      ok: true,
      path: filePath,
      rows: options.rows.length,
      format: 'jsonl',
      errorMessage: null,
    };
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[ingestion-cache] could not persist ${filePath}:`, (error as Error)?.message ?? error);
    }

    return {
      ok: false,
      path: filePath,
      rows: options.rows.length,
      format: 'jsonl',
      errorMessage: error instanceof Error ? error.message : 'Local ingestion cache write failed',
    };
  }
}

export function writeRawSourceCache(
  sourceId: string,
  rows: unknown[],
  options: Omit<IngestionCacheWriteOptions, 'stage' | 'sourceId' | 'rows'> = {},
) {
  return writeIngestionJsonlCacheBestEffort({
    ...options,
    stage: 'raw',
    sourceId,
    rows,
  });
}

export function writeProcessedSourceCache(
  sourceId: string,
  rows: unknown[],
  options: Omit<IngestionCacheWriteOptions, 'stage' | 'sourceId' | 'rows'> = {},
) {
  return writeIngestionJsonlCacheBestEffort({
    ...options,
    stage: 'processed',
    sourceId,
    rows,
  });
}
