import type { NormalizedSpaceWeatherRow } from './pipeline/normalizedSchema';
import { validateNormalizedRows } from './pipeline/normalizedSchema';

export interface GoesMagnetometerFetchResult {
  rows: NormalizedSpaceWeatherRow[];
  fetchedAtUtc: string;
  sourceUrl: string;
  errorMessage: string | null;
}

interface GoesMagnetometerPoint {
  time_tag?: string;
  satellite?: number | string;
  He?: number | string | null;
  Hp?: number | string | null;
  Hn?: number | string | null;
  total?: number | string | null;
  arcjet_flag?: boolean | string | number | null;
}

export const GOES_PRIMARY_MAG_ENDPOINT = 'https://services.swpc.noaa.gov/json/goes/primary/magnetometers-1-day.json';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 350;

const GOES_MAG_VARIABLES: Array<{
  key: keyof Pick<GoesMagnetometerPoint, 'He' | 'Hp' | 'Hn' | 'total'>;
  variable: string;
}> = [
  { key: 'He', variable: 'goes_mag_he' },
  { key: 'Hp', variable: 'goes_mag_hp' },
  { key: 'Hn', variable: 'goes_mag_hn' },
  { key: 'total', variable: 'goes_mag_total' },
];

function sleep(delayMs: number) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function parseTimestampUtc(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) < 1e30 ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && Math.abs(parsed) < 1e30 ? parsed : null;
  }

  return null;
}

function parseQualityFlag(value: GoesMagnetometerPoint['arcjet_flag']) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (typeof value === 'number') {
    return value ? 1 : 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' ? 1 : 0;
  }

  return 0;
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`NOAA GOES MAG request failed with ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('NOAA GOES MAG request failed');

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('NOAA GOES MAG request failed');
}

export async function fetchGoesMagnetometerRows(): Promise<GoesMagnetometerFetchResult> {
  const fetchedAtUtc = new Date().toISOString();

  try {
    const data = await fetchJsonWithRetry(GOES_PRIMARY_MAG_ENDPOINT);

    if (!Array.isArray(data)) {
      return {
        rows: [],
        fetchedAtUtc,
        sourceUrl: GOES_PRIMARY_MAG_ENDPOINT,
        errorMessage: 'Unexpected GOES MAG response shape',
      };
    }

    const rows: NormalizedSpaceWeatherRow[] = [];

    data.forEach((point: unknown) => {
      const magPoint = point as GoesMagnetometerPoint;
      const timestampUtc = parseTimestampUtc(magPoint.time_tag);

      if (!timestampUtc) {
        return;
      }

      const satellite = magPoint.satellite ? String(magPoint.satellite) : 'primary';
      const qualityFlag = parseQualityFlag(magPoint.arcjet_flag);

      GOES_MAG_VARIABLES.forEach(({ key, variable }) => {
        const value = toFiniteNumber(magPoint[key]);

        if (value === null) {
          return;
        }

        rows.push({
          timestamp_utc: timestampUtc,
          source: 'GOES',
          mission: `GOES-${satellite}`,
          instrument: 'MAG',
          variable,
          value,
          quality_flag: qualityFlag,
          unit: 'nT',
          cadence_s: 60,
        });
      });
    });

    const validation = validateNormalizedRows(rows);

    return {
      rows: validation.ok ? rows : [],
      fetchedAtUtc,
      sourceUrl: GOES_PRIMARY_MAG_ENDPOINT,
      errorMessage: validation.ok ? null : validation.errors.slice(0, 3).join('; '),
    };
  } catch (error) {
    return {
      rows: [],
      fetchedAtUtc,
      sourceUrl: GOES_PRIMARY_MAG_ENDPOINT,
      errorMessage: error instanceof Error ? error.message : 'NOAA GOES MAG request failed',
    };
  }
}
