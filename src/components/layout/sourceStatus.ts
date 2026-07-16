import type { CelesTrakResponse } from '@/services/celestrakService';

export const CELESTRAK_SOURCE_ID = 'celestrak-tle';

export type SourceConnectionState = 'connected' | 'partial' | 'cached' | 'checking' | 'offline';

export interface SourceStatus {
  id: string;
  name: string;
  status: SourceConnectionState;
  lastUpdated: string | null;
  detail?: string | null;
}

export interface SourceStatusSummary {
  availableCount: number;
  totalCount: number;
  tone: 'connected' | 'degraded' | 'checking' | 'offline';
}

const AVAILABLE_STATES = new Set<SourceConnectionState>(['connected', 'partial', 'cached']);

export const SOURCE_STATUS_LABEL: Record<SourceConnectionState, string> = {
  connected: 'Connected',
  partial: 'Partial',
  cached: 'Cached',
  checking: 'Checking',
  offline: 'Offline',
};

export function summarizeSourceStatuses(sources: SourceStatus[]): SourceStatusSummary {
  const availableCount = sources.filter(source => AVAILABLE_STATES.has(source.status)).length;
  const statuses = new Set(sources.map(source => source.status));

  const tone = statuses.has('offline')
    ? 'offline'
    : statuses.has('checking')
      ? 'checking'
      : statuses.has('partial') || statuses.has('cached')
        ? 'degraded'
        : 'connected';

  return { availableCount, totalCount: sources.length, tone };
}

export function buildCelestrakSourceStatus(
  data: Pick<CelesTrakResponse, 'isConnected' | 'lastUpdated' | 'errorMessage' | 'tles' | 'stale' | 'error' | 'nextRetryAtUtc'>,
  checking: boolean,
): SourceStatus {
  const hasCatalog = data.tles.length > 0;
  const failureDetail = [
    data.errorMessage ?? data.error?.message ?? null,
    data.error?.code ? `Code: ${data.error.code}.` : null,
    data.nextRetryAtUtc ? `Next retry after ${data.nextRetryAtUtc}.` : null,
  ].filter((value): value is string => Boolean(value)).join(' ');

  if (hasCatalog && data.stale) {
    return {
      id: CELESTRAK_SOURCE_ID,
      name: 'CelesTrak (TLE)',
      status: 'cached',
      lastUpdated: data.lastUpdated,
      detail: failureDetail || 'Serving the last available CelesTrak catalog.',
    };
  }

  if (checking) {
    return {
      id: CELESTRAK_SOURCE_ID,
      name: 'CelesTrak (TLE)',
      status: 'checking',
      lastUpdated: null,
      detail: 'Checking the current CelesTrak catalog.',
    };
  }

  if (hasCatalog && data.isConnected) {
    return {
      id: CELESTRAK_SOURCE_ID,
      name: 'CelesTrak (TLE)',
      status: 'connected',
      lastUpdated: data.lastUpdated,
      detail: null,
    };
  }

  if (hasCatalog) {
    return {
      id: CELESTRAK_SOURCE_ID,
      name: 'CelesTrak (TLE)',
      status: 'cached',
      lastUpdated: data.lastUpdated,
      detail: failureDetail || 'Serving an available catalog without a live upstream connection.',
    };
  }

  return {
    id: CELESTRAK_SOURCE_ID,
    name: 'CelesTrak (TLE)',
    status: 'offline',
    lastUpdated: null,
    detail: failureDetail || 'CelesTrak unavailable.',
  };
}

export function classifyL1SourceStatus(input: {
  sampleTimeUtc: string | null;
  freshness: 'fresh' | 'degraded' | 'stale';
  magneticAvailable: boolean;
  plasmaAvailable: boolean;
}): SourceConnectionState {
  if (!input.sampleTimeUtc || input.freshness === 'stale') return 'offline';
  if (!input.magneticAvailable && !input.plasmaAvailable) return 'offline';
  if (input.freshness === 'degraded' || !input.magneticAvailable || !input.plasmaAvailable) return 'partial';
  return 'connected';
}
