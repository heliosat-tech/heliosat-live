export type QualityFlag = number;

export interface NormalizedSpaceWeatherRow {
  timestamp_utc: string;
  source: string;
  spacecraft_id?: string;
  mission: string;
  instrument: string;
  variable: string;
  value: number;
  quality_flag: QualityFlag;
  unit: string;
  cadence_s: number;
  native_product?: string;
  native_variable?: string;
}

export interface NormalizedDataFrame {
  columns: readonly (keyof NormalizedSpaceWeatherRow)[];
  rows: NormalizedSpaceWeatherRow[];
}

export interface SpaceWeatherConnector {
  fetch(
    sourceId: string,
    variables: string[],
    tStart: Date | string,
    tStop: Date | string,
  ): Promise<NormalizedDataFrame>;
}

export const NORMALIZED_SPACE_WEATHER_COLUMNS: readonly (keyof NormalizedSpaceWeatherRow)[] = [
  'timestamp_utc',
  'source',
  'mission',
  'instrument',
  'variable',
  'value',
  'quality_flag',
  'unit',
  'cadence_s',
];

export const REFRESH_POLICY = {
  liveIntervalSeconds: 60,
  historicIncremental: 'daily_timestamp_cursor',
} as const;

export function createEmptyNormalizedDataFrame(): NormalizedDataFrame {
  return {
    columns: NORMALIZED_SPACE_WEATHER_COLUMNS,
    rows: [],
  };
}

export function getLocalParquetPartitionPath(
  rootPath: string,
  row: Pick<NormalizedSpaceWeatherRow, 'source' | 'timestamp_utc'>,
) {
  const parsedTimestamp = new Date(row.timestamp_utc);

  if (Number.isNaN(parsedTimestamp.getTime())) {
    throw new Error(`Invalid UTC timestamp for partitioning: ${row.timestamp_utc}`);
  }

  const year = parsedTimestamp.getUTCFullYear();
  const month = String(parsedTimestamp.getUTCMonth() + 1).padStart(2, '0');

  return `${rootPath}/source=${row.source}/year=${year}/month=${month}`;
}

export function validateNormalizedRows(rows: NormalizedSpaceWeatherRow[]) {
  const errors: string[] = [];

  rows.forEach((row, index) => {
    const timestamp = new Date(row.timestamp_utc);

    if (Number.isNaN(timestamp.getTime()) || !row.timestamp_utc.endsWith('Z')) {
      errors.push(`row ${index}: timestamp_utc must be a UTC ISO string`);
    }

    if (!row.source) {
      errors.push(`row ${index}: source is required`);
    }

    if (!row.mission) {
      errors.push(`row ${index}: mission is required`);
    }

    if (!row.instrument) {
      errors.push(`row ${index}: instrument is required`);
    }

    if (!row.variable) {
      errors.push(`row ${index}: variable is required`);
    }

    if (!Number.isFinite(row.value)) {
      errors.push(`row ${index}: value must be a finite float64-compatible number`);
    }

    if (!Number.isInteger(row.quality_flag) || row.quality_flag < -128 || row.quality_flag > 127) {
      errors.push(`row ${index}: quality_flag must fit int8`);
    }

    if (!row.unit) {
      errors.push(`row ${index}: unit is required`);
    }

    if (!Number.isFinite(row.cadence_s) || row.cadence_s <= 0) {
      errors.push(`row ${index}: cadence_s must be a positive finite number`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
  };
}
