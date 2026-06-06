export type ContextIndexKind = 'kp' | 'dst' | 'f107';

export interface ContextIndexPoint {
  timestampUtc: string;
  kind: ContextIndexKind;
  value: number;
  source: string;
}

export interface ContextIndexSnapshot {
  generatedAtUtc: string;
  points: ContextIndexPoint[];
  errors: Array<{
    kind: ContextIndexKind;
    message: string;
  }>;
}

const REQUEST_TIMEOUT_MS = 7000;
const KP_ENDPOINT = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const DST_ENDPOINT = 'https://services.swpc.noaa.gov/products/kyoto-dst.json';
const F107_ENDPOINT = 'https://services.swpc.noaa.gov/json/f107_cm_flux.json';

function parseTimestampMs(value: unknown) {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const timestampMs = new Date(normalized).getTime();

  return Number.isNaN(timestampMs) ? null : timestampMs;
}

function toIsoUtc(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

function parseTableRows(
  data: unknown,
  kind: ContextIndexKind,
  source: string,
  candidateTimeColumns: string[],
  candidateValueColumns: string[],
) {
  if (!Array.isArray(data) || data.length <= 1 || !Array.isArray(data[0])) {
    return [];
  }

  const header = data[0].map(value => String(value));
  const timeIndex = candidateTimeColumns
    .map(column => header.indexOf(column))
    .find(index => index >= 0) ?? -1;
  const valueIndex = candidateValueColumns
    .map(column => header.indexOf(column))
    .find(index => index >= 0) ?? -1;

  if (timeIndex < 0 || valueIndex < 0) {
    return [];
  }

  return data.slice(1)
    .filter((row): row is unknown[] => Array.isArray(row))
    .map(row => {
      const timestampMs = parseTimestampMs(row[timeIndex]);
      const value = toFiniteNumber(row[valueIndex]);

      if (timestampMs === null || value === null) {
        return null;
      }

      return {
        timestampUtc: toIsoUtc(timestampMs),
        kind,
        value,
        source,
      };
    })
    .filter((point): point is ContextIndexPoint => point !== null);
}

function parseObjectRows(
  data: unknown,
  kind: ContextIndexKind,
  source: string,
  candidateTimeKeys: string[],
  candidateValueKeys: string[],
) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .map(row => {
      const timestampValue = candidateTimeKeys.map(key => row[key]).find(Boolean);
      const value = candidateValueKeys.map(key => toFiniteNumber(row[key])).find(candidateValue => candidateValue !== null) ?? null;
      const timestampMs = parseTimestampMs(timestampValue);

      if (timestampMs === null || value === null) {
        return null;
      }

      return {
        timestampUtc: toIsoUtc(timestampMs),
        kind,
        value,
        source,
      };
    })
    .filter((point): point is ContextIndexPoint => point !== null);
}

async function fetchKpPoints() {
  const data = await fetchJson<unknown>(KP_ENDPOINT);
  const tablePoints = parseTableRows(
    data,
    'kp',
    'NOAA SWPC planetary K index',
    ['time_tag', 'time_tag ', 'time'],
    ['Kp', 'kp', 'estimated_kp'],
  );

  if (tablePoints.length > 0) {
    return tablePoints;
  }

  return parseObjectRows(
    data,
    'kp',
    'NOAA SWPC planetary K index',
    ['time_tag', 'time'],
    ['Kp', 'kp', 'estimated_kp'],
  );
}

async function fetchDstPoints() {
  const data = await fetchJson<unknown>(DST_ENDPOINT);
  const tablePoints = parseTableRows(
    data,
    'dst',
    'NOAA SWPC Kyoto Dst',
    ['time_tag', 'time'],
    ['dst', 'Dst', 'DST'],
  );

  if (tablePoints.length > 0) {
    return tablePoints;
  }

  return parseObjectRows(
    data,
    'dst',
    'NOAA SWPC Kyoto Dst',
    ['time_tag', 'time'],
    ['dst', 'Dst', 'DST'],
  );
}

async function fetchF107Points() {
  const data = await fetchJson<unknown>(F107_ENDPOINT);
  const objectPoints = parseObjectRows(
    data,
    'f107',
    'NOAA SWPC F10.7 cm flux',
    ['time_tag', 'time', 'date'],
    ['observed_flux', 'flux', 'f107', 'value'],
  );

  if (objectPoints.length > 0) {
    return objectPoints;
  }

  return parseTableRows(
    data,
    'f107',
    'NOAA SWPC F10.7 cm flux',
    ['time_tag', 'time', 'date'],
    ['observed_flux', 'flux', 'f107', 'value'],
  );
}

export async function fetchContextIndexSnapshot(): Promise<ContextIndexSnapshot> {
  const fetchers: Array<{
    kind: ContextIndexKind;
    fetch: () => Promise<ContextIndexPoint[]>;
  }> = [
    { kind: 'kp', fetch: fetchKpPoints },
    { kind: 'dst', fetch: fetchDstPoints },
    { kind: 'f107', fetch: fetchF107Points },
  ];
  const settledResults = await Promise.allSettled(fetchers.map(fetcher => fetcher.fetch()));
  const points: ContextIndexPoint[] = [];
  const errors: ContextIndexSnapshot['errors'] = [];

  settledResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      points.push(...result.value);
      return;
    }

    errors.push({
      kind: fetchers[index].kind,
      message: result.reason instanceof Error ? result.reason.message : 'Context index fetch failed',
    });
  });

  return {
    generatedAtUtc: toIsoUtc(Date.now()),
    points: points.sort((a, b) => {
      const aMs = parseTimestampMs(a.timestampUtc) ?? 0;
      const bMs = parseTimestampMs(b.timestampUtc) ?? 0;
      return aMs - bMs;
    }),
    errors,
  };
}
