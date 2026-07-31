export interface NoaaMagnetometerData {
  time_tag: string;
  bx_gsm: string | null;
  by_gsm: string | null;
  bz_gsm: string | null;
  lon_gsm: string | null;
  lat_gsm: string | null;
  bt: string | null;
}

export interface NoaaPlasmaData {
  time_tag: string;
  density: string | null;
  speed: string | null;
  temperature: string | null;
}

export interface NoaaEphemerisData {
  time_tag: string;
  x_gse: string | null;
  y_gse: string | null;
  z_gse: string | null;
  vx_gse: string | null;
  vy_gse: string | null;
  vz_gse: string | null;
  x_gsm: string | null;
  y_gsm: string | null;
  z_gsm: string | null;
  vx_gsm: string | null;
  vy_gsm: string | null;
  vz_gsm: string | null;
}

export interface NoaaRtswSpacecraftStatus {
  name: string;
  active: boolean;
  lastUpdated: string;
}

export interface NoaaServiceResponse<T> {
  isConnected: boolean;
  lastUpdated: string | null;
  errorMessage: string | null;
  latestData: T | null;
  timeSeries: T[];
  /** Spacecraft currently present in this live RTSW product. */
  spacecraft: NoaaRtswSpacecraftStatus[];
}

const NOAA_RTSW_BASE_URL = 'https://services.swpc.noaa.gov/json/rtsw';
const NOAA_MAG_ENDPOINT = `${NOAA_RTSW_BASE_URL}/rtsw_mag_1m.json`;
const NOAA_PLASMA_ENDPOINT = `${NOAA_RTSW_BASE_URL}/rtsw_wind_1m.json`;
const NOAA_EPHEMERIS_ENDPOINT = `${NOAA_RTSW_BASE_URL}/rtsw_ephemerides_1h.json`;
const NOAA_FETCH_TIMEOUT_MS = 8_000;
const NOAA_LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
const NOAA_FUTURE_SAMPLE_TOLERANCE_MS = 5 * 60 * 1000;

interface SelectedRtswRecord {
  record: Record<string, unknown>;
  timestampMs: number;
  timeUtc: string;
  active: boolean;
  source: string;
}

interface RtswMinuteGroup {
  minuteMs: number;
  records: SelectedRtswRecord[];
}

function parseObservationTime(value: unknown): { timestampMs: number; timeUtc: string } | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(' ', 'T')}Z`;
  const timestampMs = new Date(normalized).getTime();

  return Number.isFinite(timestampMs)
    ? { timestampMs, timeUtc: new Date(timestampMs).toISOString() }
    : null;
}

function minuteBucket(timestampMs: number) {
  return Math.floor(timestampMs / 60_000) * 60_000;
}

function isActiveRecord(value: unknown) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function recordSource(record: Record<string, unknown>) {
  return typeof record.source === 'string' ? record.source.trim() : '';
}

function comparePreferredRecord(a: SelectedRtswRecord, b: SelectedRtswRecord) {
  if (a.active !== b.active) {
    return a.active ? -1 : 1;
  }

  if (a.timestampMs !== b.timestampMs) {
    return b.timestampMs - a.timestampMs;
  }

  return a.source.localeCompare(b.source);
}

/**
 * SWPC publishes one object per spacecraft. Collapse that multi-spacecraft stream
 * into minute groups, ordered with the record SWPC marks as active first. Keeping
 * the remaining records permits a field-level fallback when the active record has
 * a null measurement.
 */
function groupRecordsByMinute(data: unknown): RtswMinuteGroup[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const grouped = new Map<number, SelectedRtswRecord[]>();

  for (const value of data) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }

    const record = value as Record<string, unknown>;
    const observation = parseObservationTime(record.time_tag);
    if (!observation) {
      continue;
    }

    const candidate: SelectedRtswRecord = {
      record,
      ...observation,
      active: isActiveRecord(record.active),
      source: recordSource(record),
    };
    const key = minuteBucket(candidate.timestampMs);
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  return [...grouped.entries()]
    .map(([minuteMs, records]) => ({
      minuteMs,
      records: records.sort(comparePreferredRecord),
    }))
    .sort((a, b) => a.minuteMs - b.minuteMs);
}

function numericString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) < 1e30 ? String(value) : null;
}

function valueFromGroup(group: RtswMinuteGroup, field: string): string | null {
  for (const { record } of group.records) {
    const value = numericString(record[field]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function observationTime(group: RtswMinuteGroup) {
  return group.records[0]?.timeUtc ?? null;
}

function isLiveGroup(group: RtswMinuteGroup, nowMs: number) {
  const timestampMs = group.records[0]?.timestampMs;
  if (timestampMs === undefined) {
    return false;
  }

  const ageMs = nowMs - timestampMs;
  return ageMs >= -NOAA_FUTURE_SAMPLE_TOLERANCE_MS && ageMs <= NOAA_LIVE_WINDOW_MS;
}

function emptyResponse<T>(errorMessage: string): NoaaServiceResponse<T> {
  return {
    isConnected: false,
    lastUpdated: null,
    errorMessage,
    latestData: null,
    timeSeries: [],
    spacecraft: [],
  };
}

function spacecraftFromGroups(groups: RtswMinuteGroup[]): NoaaRtswSpacecraftStatus[] {
  const latestByName = new Map<string, SelectedRtswRecord>();

  for (const group of groups) {
    for (const record of group.records) {
      if (!record.source) continue;
      const previous = latestByName.get(record.source);
      if (!previous || record.timestampMs > previous.timestampMs) {
        latestByName.set(record.source, record);
      }
    }
  }

  return [...latestByName.values()]
    .map(record => ({
      name: record.source,
      active: record.active,
      lastUpdated: record.timeUtc,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

async function fetchRtswProduct<T>(
  endpoint: string,
  unavailableMessage: string,
  noDataMessage: string,
  mapRecord: (group: RtswMinuteGroup) => T,
  observationTime: (sample: T) => string,
): Promise<NoaaServiceResponse<T>> {
  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      signal: AbortSignal.timeout(NOAA_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return emptyResponse(unavailableMessage);
    }

    const groups = groupRecordsByMinute(await response.json())
      .filter(group => isLiveGroup(group, Date.now()));
    if (groups.length === 0) {
      return emptyResponse(noDataMessage);
    }

    const timeSeries = groups.map(mapRecord);
    const latestData = timeSeries[timeSeries.length - 1] ?? null;

    return {
      isConnected: latestData !== null,
      lastUpdated: latestData ? observationTime(latestData) : null,
      errorMessage: null,
      latestData,
      timeSeries,
      spacecraft: spacecraftFromGroups(groups),
    };
  } catch {
    return emptyResponse(unavailableMessage);
  }
}

export function fetchNoaaMagnetometerData(): Promise<NoaaServiceResponse<NoaaMagnetometerData>> {
  return fetchRtswProduct(
    NOAA_MAG_ENDPOINT,
    'NOAA magnetometer unavailable',
    'No magnetometer data available',
    group => ({
      time_tag: observationTime(group) as string,
      bx_gsm: valueFromGroup(group, 'bx_gsm'),
      by_gsm: valueFromGroup(group, 'by_gsm'),
      bz_gsm: valueFromGroup(group, 'bz_gsm'),
      // The object feed renamed the legacy angular columns to phi/theta.
      lon_gsm: valueFromGroup(group, 'phi_gsm'),
      lat_gsm: valueFromGroup(group, 'theta_gsm'),
      bt: valueFromGroup(group, 'bt'),
    }),
    sample => sample.time_tag,
  );
}

export function fetchNoaaPlasmaData(): Promise<NoaaServiceResponse<NoaaPlasmaData>> {
  return fetchRtswProduct(
    NOAA_PLASMA_ENDPOINT,
    'NOAA plasma unavailable',
    'No plasma data available',
    group => ({
      time_tag: observationTime(group) as string,
      density: valueFromGroup(group, 'proton_density'),
      speed: valueFromGroup(group, 'proton_speed'),
      temperature: valueFromGroup(group, 'proton_temperature'),
    }),
    sample => sample.time_tag,
  );
}

export function fetchNoaaEphemerisData(): Promise<NoaaServiceResponse<NoaaEphemerisData>> {
  return fetchRtswProduct(
    NOAA_EPHEMERIS_ENDPOINT,
    'NOAA spacecraft ephemeris unavailable',
    'No spacecraft ephemeris available',
    group => ({
      time_tag: observationTime(group) as string,
      x_gse: valueFromGroup(group, 'x_gse'),
      y_gse: valueFromGroup(group, 'y_gse'),
      z_gse: valueFromGroup(group, 'z_gse'),
      vx_gse: valueFromGroup(group, 'vx_gse'),
      vy_gse: valueFromGroup(group, 'vy_gse'),
      vz_gse: valueFromGroup(group, 'vz_gse'),
      x_gsm: valueFromGroup(group, 'x_gsm'),
      y_gsm: valueFromGroup(group, 'y_gsm'),
      z_gsm: valueFromGroup(group, 'z_gsm'),
      vx_gsm: valueFromGroup(group, 'vx_gsm'),
      vy_gsm: valueFromGroup(group, 'vy_gsm'),
      vz_gsm: valueFromGroup(group, 'vz_gsm'),
    }),
    sample => sample.time_tag,
  );
}
