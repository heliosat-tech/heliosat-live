import fs from 'node:fs';
import path from 'node:path';
import { ParquetReader } from 'parquetjs-lite';
import {
  createEmptyNormalizedDataFrame,
  NORMALIZED_SPACE_WEATHER_COLUMNS,
  type NormalizedDataFrame,
  type NormalizedSpaceWeatherRow,
  type SpaceWeatherConnector,
  validateNormalizedRows,
} from './normalizedSchema';

export const NCEI_GOES_SOURCE_ID = 'ncei-goes-r-mag-seiss';
export const NCEI_GOES_STORE_SOURCE = 'goes_nccei';
export const NCEI_GOES_BASE_URL =
  'https://data.ngdc.noaa.gov/platforms/solar-space-observing-satellites/goes';

export const NCEI_GOES_SPACECRAFT = ['GOES-16', 'GOES-17', 'GOES-18', 'GOES-19'] as const;
export const NCEI_GOES_PRODUCTS = {
  mag: 'magn-l2-avg1m',
  mpsh: 'mpsh-l2-avg1m',
  sgps: 'sgps-l2-avg1m',
  xrs: 'xrsf-l2-avg1m',
} as const;

interface NceiGoesArchiveDailyCoverage {
  date_utc: string;
  spacecraft_id: string;
  product: string;
  observed_samples: number;
  expected_samples: number;
}

interface NceiGoesArchivePartitionStats {
  row_count?: number;
  last_timestamp_utc?: string | null;
}

interface NceiGoesArchiveCheckpoint {
  source_id?: string;
  store_source?: string;
  updated_at_utc?: string;
  last_timestamp_ingested?: string | null;
  processed_files?: Record<string, unknown>;
  failed_files?: Record<string, { failed_at_utc?: string; error?: string }>;
  partitions?: Record<string, NceiGoesArchivePartitionStats>;
  daily_coverage?: Record<string, NceiGoesArchiveDailyCoverage>;
  last_pull?: {
    rows_written?: number;
    rows_per_minute?: number | null;
    files_processed?: number;
    files_failed?: number;
    finished_at_utc?: string;
    last_error?: string | null;
  };
}

export interface NceiGoesArchiveHealthObservation {
  status: 'historic' | 'off' | 'error';
  lastSampleTimestampUtc: string | null;
  sampleTimestampsMs: number[];
  rowTimestampsMs: number[];
  rowsInCurrentSnapshot: number | null;
  cadenceSeconds: number | null;
  lastErrorMessage: string | null;
  coverage: Array<{
    window: '24h' | '7d' | '30d';
    percent: number | null;
    observedSamples: number;
    expectedSamples: number | null;
  }>;
  throughputRowsPerMinute: number | null;
  errorRate24hPercent: number | null;
}

const HEALTH_WINDOW_DAYS = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
} as const;

function resolveWorkspacePath(relativePath: string) {
  return path.join(process.cwd(), relativePath);
}

export function getNceiGoesStoreRoot() {
  return process.env.HELIOSAT_PARQUET_ROOT ?? resolveWorkspacePath('data/parquet');
}

export function getNceiGoesCheckpointPath() {
  return process.env.HELIOSAT_GOES_NCEI_CHECKPOINT
    ?? resolveWorkspacePath('data/checkpoints/goes_ncei_archive.json');
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function toTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function toIsoUtc(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  return null;
}

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toInt(value: unknown) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function getMonthKeysBetween(start: Date, stop: Date) {
  const keys: Array<{ year: number; month: string }> = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const stopMonth = new Date(Date.UTC(stop.getUTCFullYear(), stop.getUTCMonth(), 1));

  while (cursor <= stopMonth) {
    keys.push({
      year: cursor.getUTCFullYear(),
      month: String(cursor.getUTCMonth() + 1).padStart(2, '0'),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return keys;
}

function listParquetFilesForRange(
  storeRoot: string,
  spacecraft: readonly string[],
  start: Date,
  stop: Date,
) {
  const sourceRoot = path.join(storeRoot, `source=${NCEI_GOES_STORE_SOURCE}`);
  const monthKeys = getMonthKeysBetween(start, stop);

  return spacecraft.flatMap(spacecraftId =>
    monthKeys.flatMap(({ year, month }) => {
      const partitionDir = path.join(sourceRoot, `spacecraft=${spacecraftId}`, `year=${year}`, `month=${month}`);

      if (!fs.existsSync(partitionDir)) {
        return [];
      }

      return fs
        .readdirSync(partitionDir)
        .filter(fileName => fileName.endsWith('.parquet'))
        .map(fileName => path.join(partitionDir, fileName));
    }),
  );
}

async function readNormalizedRowsFromParquet(
  filePath: string,
  variables: Set<string>,
  startMs: number,
  stopMs: number,
) {
  const reader = await ParquetReader.openFile(filePath);

  try {
    const cursor = reader.getCursor([
      'timestamp_utc',
      'source',
      'spacecraft_id',
      'mission',
      'instrument',
      'variable',
      'value',
      'quality_flag',
      'unit',
      'cadence_s',
    ]);
    const rows: NormalizedSpaceWeatherRow[] = [];
    let record = await cursor.next();

    while (record) {
      const timestampUtc = toIsoUtc(record.timestamp_utc);
      const timestampMs = timestampUtc ? toTimestampMs(timestampUtc) : null;
      const variable = typeof record.variable === 'string' ? record.variable : null;
      const value = toFiniteNumber(record.value);
      const qualityFlag = toInt(record.quality_flag);
      const cadenceSeconds = toFiniteNumber(record.cadence_s);

      if (
        timestampUtc
        && timestampMs !== null
        && timestampMs >= startMs
        && timestampMs <= stopMs
        && variable
        && (variables.size === 0 || variables.has(variable))
        && value !== null
        && qualityFlag !== null
        && cadenceSeconds !== null
      ) {
        const spacecraftId = typeof record.spacecraft_id === 'string' ? record.spacecraft_id : 'GOES-R';

        rows.push({
          timestamp_utc: timestampUtc,
          source: typeof record.source === 'string' ? record.source : NCEI_GOES_STORE_SOURCE,
          mission: typeof record.mission === 'string' ? record.mission : spacecraftId,
          instrument: typeof record.instrument === 'string' ? record.instrument : 'GOES-R',
          variable,
          value,
          quality_flag: qualityFlag,
          unit: typeof record.unit === 'string' ? record.unit : 'unknown',
          cadence_s: cadenceSeconds,
        });
      }

      record = await cursor.next();
    }

    return rows;
  } finally {
    await reader.close();
  }
}

function getRowsInStore(checkpoint: NceiGoesArchiveCheckpoint) {
  const partitionStats = Object.values(checkpoint.partitions ?? {});
  const totalRows = partitionStats.reduce(
    (total, partition) => total + (Number.isFinite(partition.row_count) ? partition.row_count ?? 0 : 0),
    0,
  );

  return totalRows > 0 ? totalRows : null;
}

function getLatestSample(checkpoint: NceiGoesArchiveCheckpoint) {
  const candidates = [
    checkpoint.last_timestamp_ingested,
    ...Object.values(checkpoint.partitions ?? {}).map(partition => partition.last_timestamp_utc ?? null),
  ]
    .map(value => (value ? new Date(value).getTime() : null))
    .filter((value): value is number => value !== null && !Number.isNaN(value));

  if (candidates.length === 0) {
    return null;
  }

  return new Date(Math.max(...candidates)).toISOString();
}

function dateKeyFromTimestamp(timestampMs: number) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function addUtcDays(dateKey: string, days: number) {
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function buildCoverageFromCheckpoint(
  checkpoint: NceiGoesArchiveCheckpoint,
  lastSampleTimestampUtc: string | null,
): NceiGoesArchiveHealthObservation['coverage'] {
  const dailyCoverage = Object.values(checkpoint.daily_coverage ?? {});
  const lastSampleMs = toTimestampMs(lastSampleTimestampUtc);

  if (lastSampleMs === null || dailyCoverage.length === 0) {
    return Object.keys(HEALTH_WINDOW_DAYS).map(window => ({
      window: window as keyof typeof HEALTH_WINDOW_DAYS,
      percent: null,
      observedSamples: 0,
      expectedSamples: null,
    }));
  }

  const latestDateKey = dateKeyFromTimestamp(lastSampleMs);
  const pairKeys = Array.from(
    new Set(dailyCoverage.map(entry => `${entry.spacecraft_id}|${entry.product}`)),
  );
  const coverageByDateAndPair = new Map(
    dailyCoverage.map(entry => [
      `${entry.date_utc}|${entry.spacecraft_id}|${entry.product}`,
      entry,
    ]),
  );

  return Object.entries(HEALTH_WINDOW_DAYS).map(([window, days]) => {
    let observedSamples = 0;
    let expectedSamples = 0;

    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const dateKey = addUtcDays(latestDateKey, -offset);

      pairKeys.forEach(pairKey => {
        const entry = coverageByDateAndPair.get(`${dateKey}|${pairKey}`);
        expectedSamples += entry?.expected_samples ?? 1440;
        observedSamples += entry?.observed_samples ?? 0;
      });
    }

    return {
      window: window as keyof typeof HEALTH_WINDOW_DAYS,
      percent: expectedSamples > 0 ? Math.min(100, (observedSamples / expectedSamples) * 100) : null,
      observedSamples,
      expectedSamples,
    };
  });
}

function getFailedFileCount24h(checkpoint: NceiGoesArchiveCheckpoint, nowMs: number) {
  const cutoffMs = nowMs - 24 * 60 * 60 * 1000;

  return Object.values(checkpoint.failed_files ?? {}).filter(entry => {
    const failedAtMs = toTimestampMs(entry.failed_at_utc);
    return failedAtMs !== null && failedAtMs >= cutoffMs;
  }).length;
}

export function getNceiGoesArchiveHealthObservation(): NceiGoesArchiveHealthObservation | null {
  const checkpoint = readJsonFile<NceiGoesArchiveCheckpoint>(getNceiGoesCheckpointPath());

  if (!checkpoint) {
    return null;
  }

  const rowsInStore = getRowsInStore(checkpoint);
  const lastSampleTimestampUtc = getLatestSample(checkpoint);
  const processedFileCount = Object.keys(checkpoint.processed_files ?? {}).length;
  const failedFileCount24h = getFailedFileCount24h(checkpoint, Date.now());
  const lastPullProcessedCount = checkpoint.last_pull?.files_processed ?? 0;
  const status = processedFileCount > 0 && lastSampleTimestampUtc
    ? 'historic'
    : failedFileCount24h > 0
      ? 'error'
      : 'off';
  const rowsPerMinute = checkpoint.last_pull?.rows_per_minute ?? null;

  return {
    status,
    lastSampleTimestampUtc,
    sampleTimestampsMs: [],
    rowTimestampsMs: [],
    rowsInCurrentSnapshot: rowsInStore,
    cadenceSeconds: 60,
    lastErrorMessage: checkpoint.last_pull?.last_error ?? null,
    coverage: buildCoverageFromCheckpoint(checkpoint, lastSampleTimestampUtc),
    throughputRowsPerMinute: typeof rowsPerMinute === 'number' && Number.isFinite(rowsPerMinute)
      ? rowsPerMinute
      : null,
    errorRate24hPercent: lastPullProcessedCount + failedFileCount24h > 0
      ? (failedFileCount24h / (lastPullProcessedCount + failedFileCount24h)) * 100
      : null,
  };
}

export class NceiGoesArchiveConnector implements SpaceWeatherConnector {
  constructor(private readonly storeRoot = getNceiGoesStoreRoot()) {}

  async fetch(
    sourceId: string,
    variables: string[],
    tStart: Date | string,
    tStop: Date | string,
  ): Promise<NormalizedDataFrame> {
    if (sourceId !== NCEI_GOES_SOURCE_ID && sourceId !== NCEI_GOES_STORE_SOURCE) {
      return createEmptyNormalizedDataFrame();
    }

    const start = new Date(tStart);
    const stop = new Date(tStop);

    if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime()) || stop < start) {
      throw new Error('Invalid GOES NCEI fetch range');
    }

    const parquetFiles = listParquetFilesForRange(this.storeRoot, NCEI_GOES_SPACECRAFT, start, stop);
    const variableSet = new Set(variables);
    const rowsByFile = await Promise.all(
      parquetFiles.map(filePath =>
        readNormalizedRowsFromParquet(filePath, variableSet, start.getTime(), stop.getTime()),
      ),
    );
    const rows = rowsByFile.flat().sort((a, b) => {
      const timestampDiff = new Date(a.timestamp_utc).getTime() - new Date(b.timestamp_utc).getTime();
      return timestampDiff || a.variable.localeCompare(b.variable) || a.mission.localeCompare(b.mission);
    });
    const validation = validateNormalizedRows(rows);

    if (!validation.ok) {
      throw new Error(`GOES NCEI normalized Parquet rows failed validation: ${validation.errors.slice(0, 3).join('; ')}`);
    }

    return {
      columns: NORMALIZED_SPACE_WEATHER_COLUMNS,
      rows,
    };
  }

  status() {
    return getNceiGoesArchiveHealthObservation();
  }

  persist() {
    throw new Error('Use scripts/backfill_goes_ncei.py to persist GOES-R NCEI NetCDF files into Parquet.');
  }
}

export const nceiGoesArchiveConnector = new NceiGoesArchiveConnector();
