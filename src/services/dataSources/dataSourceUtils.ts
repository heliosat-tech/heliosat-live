const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 350;

export function parseTimestampUtc(value: unknown): string | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseTimestampMs(value: unknown): number | null {
  const timestampUtc = parseTimestampUtc(value);

  if (!timestampUtc) {
    return null;
  }

  const timestampMs = new Date(timestampUtc).getTime();

  return Number.isNaN(timestampMs) ? null : timestampMs;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) < 1e30 ? value : null;
  }

  if (typeof value === 'string') {
    if (!value.trim()) {
      return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && Math.abs(parsed) < 1e30 ? parsed : null;
  }

  return null;
}

export function columnIndex(table: unknown[]): Record<string, number> {
  const header = table[0];
  const indexes: Record<string, number> = {};

  if (Array.isArray(header)) {
    header.forEach((name, index) => {
      if (typeof name === 'string') {
        indexes[name] = index;
      }
    });
  }

  return indexes;
}

export function minuteKey(timestampMs: number) {
  return Math.round(timestampMs / 60_000) * 60_000;
}

export function hourKey(timestampMs: number) {
  return Math.round(timestampMs / 3_600_000) * 3_600_000;
}

export function vectorComponent(value: unknown, index: number) {
  return Array.isArray(value) ? toFiniteNumber(value[index]) : null;
}

export function compactQualityFlags(flags: Array<string | null | undefined | false>) {
  return [...new Set(flags.filter((flag): flag is string => Boolean(flag)))];
}

export function sanitizePhysicalValue(
  value: number | null,
  range: { min: number; max: number },
) {
  if (value === null) {
    return null;
  }

  return value >= range.min && value <= range.max ? value : null;
}

function sleep(delayMs: number) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

export async function fetchJsonWithRetry(
  url: string,
  options: { timeoutMs?: number; retries?: number; label?: string } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`${options.label ?? 'Request'} failed with ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(`${options.label ?? 'Request'} failed`);

      if (attempt < retries) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error(`${options.label ?? 'Request'} failed`);
}
