import type { PlaygroundTelemetryData } from './playgroundTelemetryService';
import {
  PUBLIC_SPACE_WEATHER_SOURCES,
  type PublicSpaceWeatherSource,
} from './spaceWeatherSourceCatalog';
import type {
  SpacecraftConnectionStatus,
  SpacecraftId,
  SpacecraftTelemetry,
} from './spacecraftTelemetryService';
import { getSourceConnectorRegistration } from './pipeline/connectorRegistry';
import {
  getNceiGoesArchiveHealthObservation,
  NCEI_GOES_SOURCE_ID,
} from './pipeline/nceiGoesArchiveConnector';

export type PipelineSourceGroup = 'l1-live' | 'l1-historic' | 'near-earth';
export type PipelineSourceStatus = 'live' | 'historic' | 'stale' | 'off' | 'error' | 'not-wired';
export type PipelineLogLevel = 'info' | 'warning' | 'error';

export interface PipelineSparkPoint {
  timestampUtc: string;
  value: number | null;
}

export interface PipelineCoverageMetric {
  window: '24h' | '7d' | '30d';
  percent: number | null;
  observedSamples: number;
  expectedSamples: number | null;
}

export interface PipelinePullLog {
  timestampUtc: string;
  sourceId: string;
  level: PipelineLogLevel;
  status: PipelineSourceStatus;
  rows: number | null;
  message: string;
  latencyMs: number | null;
}

export interface PipelineSourceHealth {
  sourceId: string;
  name: string;
  provider: string;
  endpoint: string;
  group: PipelineSourceGroup;
  status: PipelineSourceStatus;
  readiness: PublicSpaceWeatherSource['readiness'];
  refreshMode: PublicSpaceWeatherSource['cadence'];
  protocol: string;
  implementationStatus: 'wired' | 'registered';
  lastSampleTimestampUtc: string | null;
  lastSampleDeltaSeconds: number | null;
  coverage: PipelineCoverageMetric[];
  errorRate24hPercent: number | null;
  errorRateSparkline: PipelineSparkPoint[];
  throughputRowsPerMinute: number | null;
  throughputSparkline: PipelineSparkPoint[];
  cadenceSeconds: number | null;
  rowsInCurrentSnapshot: number | null;
  variables: string[];
  spacecraft: string[];
  lastErrorMessage: string | null;
  logs: PipelinePullLog[];
}

export interface PipelineHealthSnapshot {
  generatedAtUtc: string;
  refreshPolicy: {
    liveIntervalSeconds: number;
    historicMode: 'daily_incremental_cursor';
  };
  sources: PipelineSourceHealth[];
}

interface RuntimeObservation {
  status: PipelineSourceStatus;
  lastSampleTimestampUtc: string | null;
  sampleTimestampsMs: number[];
  rowTimestampsMs: number[];
  rowsInCurrentSnapshot: number | null;
  cadenceSeconds: number | null;
  lastErrorMessage: string | null;
  coverage?: PipelineCoverageMetric[];
  throughputRowsPerMinute?: number | null;
  errorRate24hPercent?: number | null;
}

const HEALTH_WINDOWS: PipelineCoverageMetric['window'][] = ['24h', '7d', '30d'];
const WINDOW_SECONDS: Record<PipelineCoverageMetric['window'], number> = {
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};
const MAX_LOGS_PER_SOURCE = 20;
const MAX_BUFFERED_PULL_LOGS = 3000;
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const THROUGHPUT_WINDOW_MS = 2 * 60 * 60 * 1000;
const THROUGHPUT_BUCKET_MS = 10 * 60 * 1000;
const ERROR_BUCKET_MS = 60 * 60 * 1000;

let pullLogBuffer: PipelinePullLog[] = [];

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
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

function toFiniteNumber(value: string | number | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function uniqueSorted(values: number[]) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function median(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sortedValues = [...values].sort((a, b) => a - b);
  const middleIndex = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[middleIndex];
  }

  return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}

function inferCadenceSeconds(sampleTimestampsMs: number[]) {
  const timestamps = uniqueSorted(sampleTimestampsMs);

  if (timestamps.length < 2) {
    return null;
  }

  const diffsSeconds = timestamps
    .slice(1)
    .map((timestampMs, index) => (timestampMs - timestamps[index]) / 1000)
    .filter(diffSeconds => diffSeconds > 0);
  const medianDiff = median(diffsSeconds);

  return medianDiff === null ? null : Math.round(medianDiff * 10) / 10;
}

function pipelineStatusFromSpacecraft(
  status: SpacecraftConnectionStatus,
  hasRows: boolean,
  errorMessage: string | null,
): PipelineSourceStatus {
  if (errorMessage && !hasRows) {
    return 'error';
  }

  if (status === 'live') {
    return 'live';
  }

  if (status === 'stale') {
    return 'stale';
  }

  return 'off';
}

function collectMissionObservation(mission: SpacecraftTelemetry): RuntimeObservation {
  const rowTimestampsMs: number[] = [];
  const sampleTimestampsMs: number[] = [];

  mission.charts.forEach(chart => {
    chart.data.forEach(point => {
      const timestampMs = parseTimestampMs(point.time_tag);

      if (timestampMs === null || toFiniteNumber(point.value) === null) {
        return;
      }

      rowTimestampsMs.push(timestampMs);
      sampleTimestampsMs.push(timestampMs);
    });
  });

  const uniqueSamples = uniqueSorted(sampleTimestampsMs);
  const latestTimestampMs = uniqueSamples.at(-1) ?? null;
  const rowsInCurrentSnapshot = rowTimestampsMs.length;

  return {
    status: pipelineStatusFromSpacecraft(mission.status, rowsInCurrentSnapshot > 0, mission.errorMessage),
    lastSampleTimestampUtc: latestTimestampMs === null ? null : toIsoUtc(latestTimestampMs),
    sampleTimestampsMs: uniqueSamples,
    rowTimestampsMs,
    rowsInCurrentSnapshot,
    cadenceSeconds: inferCadenceSeconds(uniqueSamples),
    lastErrorMessage: mission.errorMessage,
  };
}

function mergeMissionObservations(observations: RuntimeObservation[]): RuntimeObservation | null {
  if (observations.length === 0) {
    return null;
  }

  const sampleTimestampsMs = uniqueSorted(observations.flatMap(observation => observation.sampleTimestampsMs));
  const rowTimestampsMs = observations.flatMap(observation => observation.rowTimestampsMs);
  const latestTimestampMs = sampleTimestampsMs.at(-1) ?? null;
  const statuses = observations.map(observation => observation.status);
  const lastErrorMessage = observations.find(observation => observation.lastErrorMessage)?.lastErrorMessage ?? null;
  const cadenceSeconds = inferCadenceSeconds(sampleTimestampsMs);
  const rowsInCurrentSnapshot = observations.reduce(
    (totalRows, observation) => totalRows + (observation.rowsInCurrentSnapshot ?? 0),
    0,
  );

  let status: PipelineSourceStatus = 'off';

  if (statuses.includes('live')) {
    status = 'live';
  } else if (statuses.includes('stale')) {
    status = 'stale';
  } else if (statuses.includes('error')) {
    status = 'error';
  }

  return {
    status,
    lastSampleTimestampUtc: latestTimestampMs === null ? null : toIsoUtc(latestTimestampMs),
    sampleTimestampsMs,
    rowTimestampsMs,
    rowsInCurrentSnapshot,
    cadenceSeconds,
    lastErrorMessage,
  };
}

function getRuntimeObservationForSource(
  source: PublicSpaceWeatherSource,
  spacecraftTelemetry: SpacecraftTelemetry[],
) {
  if (source.id === NCEI_GOES_SOURCE_ID) {
    const archiveObservation = getNceiGoesArchiveHealthObservation();

    if (!archiveObservation) {
      return null;
    }

    return {
      status: archiveObservation.status,
      lastSampleTimestampUtc: archiveObservation.lastSampleTimestampUtc,
      sampleTimestampsMs: archiveObservation.sampleTimestampsMs,
      rowTimestampsMs: archiveObservation.rowTimestampsMs,
      rowsInCurrentSnapshot: archiveObservation.rowsInCurrentSnapshot,
      cadenceSeconds: archiveObservation.cadenceSeconds,
      lastErrorMessage: archiveObservation.lastErrorMessage,
      coverage: archiveObservation.coverage,
      throughputRowsPerMinute: archiveObservation.throughputRowsPerMinute,
      errorRate24hPercent: archiveObservation.errorRate24hPercent,
    } satisfies RuntimeObservation;
  }

  const missionById = new Map<SpacecraftId, SpacecraftTelemetry>(
    spacecraftTelemetry.map(mission => [mission.id, mission]),
  );
  const sourceMissionIds: Partial<Record<string, SpacecraftId[]>> = {
    'swpc-rtsw-l1': ['DSCOVR'],
    'cdaweb-ace-wind-imap': ['ACE', 'WIND', 'IMAP'],
  };
  const missionIds = sourceMissionIds[source.id] ?? [];
  const observations = missionIds
    .map(missionId => missionById.get(missionId))
    .filter((mission): mission is SpacecraftTelemetry => Boolean(mission))
    .map(collectMissionObservation);

  return mergeMissionObservations(observations);
}

function getSourceGroup(source: PublicSpaceWeatherSource): PipelineSourceGroup {
  if (source.domain === 'near-earth') {
    return 'near-earth';
  }

  return source.cadence === 'historic' ? 'l1-historic' : 'l1-live';
}

function buildCoverage(
  sampleTimestampsMs: number[],
  cadenceSeconds: number | null,
  nowMs: number,
): PipelineCoverageMetric[] {
  return HEALTH_WINDOWS.map(window => {
    if (cadenceSeconds === null) {
      return {
        window,
        percent: null,
        observedSamples: 0,
        expectedSamples: null,
      };
    }

    const windowSeconds = WINDOW_SECONDS[window];
    const windowStartMs = nowMs - windowSeconds * 1000;
    const observedSamples = sampleTimestampsMs.filter(timestampMs => timestampMs >= windowStartMs).length;
    const expectedSamples = Math.ceil(windowSeconds / cadenceSeconds);

    return {
      window,
      percent: expectedSamples > 0 ? Math.min(100, (observedSamples / expectedSamples) * 100) : null,
      observedSamples,
      expectedSamples,
    };
  });
}

function buildThroughputSparkline(rowTimestampsMs: number[], nowMs: number): PipelineSparkPoint[] {
  if (rowTimestampsMs.length === 0) {
    return [];
  }

  const startMs = nowMs - THROUGHPUT_WINDOW_MS;
  const bucketCount = Math.ceil(THROUGHPUT_WINDOW_MS / THROUGHPUT_BUCKET_MS);

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketStartMs = startMs + index * THROUGHPUT_BUCKET_MS;
    const bucketStopMs = bucketStartMs + THROUGHPUT_BUCKET_MS;
    const rowsInBucket = rowTimestampsMs.filter(
      timestampMs => timestampMs >= bucketStartMs && timestampMs < bucketStopMs,
    ).length;

    return {
      timestampUtc: toIsoUtc(bucketStartMs),
      value: rowsInBucket / (THROUGHPUT_BUCKET_MS / 60000),
    };
  });
}

function calculateThroughputRowsPerMinute(rowTimestampsMs: number[]) {
  if (rowTimestampsMs.length === 0) {
    return null;
  }

  const timestamps = uniqueSorted(rowTimestampsMs);
  const firstTimestampMs = timestamps[0];
  const lastTimestampMs = timestamps.at(-1) ?? firstTimestampMs;
  const durationMinutes = Math.max(1, (lastTimestampMs - firstTimestampMs) / 60000);

  return rowTimestampsMs.length / durationMinutes;
}

function getCurrentLogMessage(source: PublicSpaceWeatherSource, observation: RuntimeObservation | null) {
  if (!observation) {
    if (source.readiness === 'gap') {
      return 'Known public-data gap; no robust no-key ingestion source is wired.';
    }

    if (source.readiness === 'candidate' || source.readiness === 'archive') {
      return 'Source is catalogued for future use, but no ingestion health connector is wired yet.';
    }

    return 'Connector registered; no runtime ingestion observations in this process yet.';
  }

  if (observation.status === 'historic') {
    return 'Local archive checkpoint reports ingested GOES-R NetCDF files and Parquet partitions.';
  }

  if (observation.status === 'error') {
    return observation.lastErrorMessage ?? 'Runtime fetch reported an error before producing normalized rows.';
  }

  if (observation.rowsInCurrentSnapshot && observation.rowsInCurrentSnapshot > 0) {
    return 'Runtime telemetry snapshot produced finite value rows for normalization.';
  }

  if (source.readiness === 'gap') {
    return 'Public source gap is tracked explicitly; no connector is enabled.';
  }

  return 'Connector registered; waiting for an enabled ingestion runner.';
}

function getCurrentLogLevel(
  source: PublicSpaceWeatherSource,
  observation: RuntimeObservation | null,
): PipelineLogLevel {
  if (observation?.status === 'error') {
    return 'error';
  }

  if (!observation && source.readiness !== 'connected') {
    return 'warning';
  }

  return 'info';
}

function recordPullLogs(logs: PipelinePullLog[], nowMs: number) {
  const retentionStartMs = nowMs - LOG_RETENTION_MS;

  pullLogBuffer = [...pullLogBuffer, ...logs]
    .filter(log => {
      const timestampMs = parseTimestampMs(log.timestampUtc);
      return timestampMs !== null && timestampMs >= retentionStartMs;
    })
    .slice(-MAX_BUFFERED_PULL_LOGS);
}

function getLogsForSource(sourceId: string) {
  return pullLogBuffer
    .filter(log => log.sourceId === sourceId)
    .sort((a, b) => {
      const aMs = parseTimestampMs(a.timestampUtc) ?? 0;
      const bMs = parseTimestampMs(b.timestampUtc) ?? 0;
      return bMs - aMs;
    });
}

function calculateErrorRate24h(sourceLogs: PipelinePullLog[], nowMs: number) {
  const startMs = nowMs - LOG_RETENTION_MS;
  const logsInWindow = sourceLogs.filter(log => {
    const timestampMs = parseTimestampMs(log.timestampUtc);
    return timestampMs !== null && timestampMs >= startMs;
  });

  if (logsInWindow.length === 0) {
    return null;
  }

  const errorCount = logsInWindow.filter(log => log.level === 'error').length;

  return (errorCount / logsInWindow.length) * 100;
}

function buildErrorSparkline(sourceLogs: PipelinePullLog[], nowMs: number): PipelineSparkPoint[] {
  const startMs = nowMs - LOG_RETENTION_MS;
  const bucketCount = Math.ceil(LOG_RETENTION_MS / ERROR_BUCKET_MS);

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketStartMs = startMs + index * ERROR_BUCKET_MS;
    const bucketStopMs = bucketStartMs + ERROR_BUCKET_MS;
    const logsInBucket = sourceLogs.filter(log => {
      const timestampMs = parseTimestampMs(log.timestampUtc);
      return timestampMs !== null && timestampMs >= bucketStartMs && timestampMs < bucketStopMs;
    });

    return {
      timestampUtc: toIsoUtc(bucketStartMs),
      value: logsInBucket.length === 0
        ? null
        : (logsInBucket.filter(log => log.level === 'error').length / logsInBucket.length) * 100,
    };
  });
}

export function buildPipelineHealthSnapshot(
  telemetryData: PlaygroundTelemetryData,
): PipelineHealthSnapshot {
  const nowMs = Date.now();
  const generatedAtUtc = toIsoUtc(nowMs);
  const healthWithoutLogs = PUBLIC_SPACE_WEATHER_SOURCES.map(source => {
    const connectorRegistration = getSourceConnectorRegistration(source.id);
    const runtimeObservation = getRuntimeObservationForSource(source, telemetryData.spacecraftTelemetry);
    const lastSampleTimestampMs = parseTimestampMs(runtimeObservation?.lastSampleTimestampUtc);
    const implementationStatus = connectorRegistration?.implementationStatus ?? 'registered';

    return {
      source,
      runtimeObservation,
      health: {
        sourceId: source.id,
        name: source.name,
        provider: source.provider,
        endpoint: source.endpoint,
        group: getSourceGroup(source),
        status: runtimeObservation?.status ?? (implementationStatus === 'registered' ? 'not-wired' : 'off'),
        readiness: source.readiness,
        refreshMode: source.cadence,
        protocol: connectorRegistration?.protocol ?? 'archive-files',
        implementationStatus,
        lastSampleTimestampUtc: runtimeObservation?.lastSampleTimestampUtc ?? null,
        lastSampleDeltaSeconds: lastSampleTimestampMs === null
          ? null
          : Math.max(0, (nowMs - lastSampleTimestampMs) / 1000),
        coverage: runtimeObservation?.coverage ?? buildCoverage(
          runtimeObservation?.sampleTimestampsMs ?? [],
          runtimeObservation?.cadenceSeconds ?? null,
          nowMs,
        ),
        errorRate24hPercent: runtimeObservation?.errorRate24hPercent ?? null,
        errorRateSparkline: [],
        throughputRowsPerMinute: runtimeObservation?.throughputRowsPerMinute
          ?? (runtimeObservation
            ? calculateThroughputRowsPerMinute(runtimeObservation.rowTimestampsMs)
            : null),
        throughputSparkline: buildThroughputSparkline(runtimeObservation?.rowTimestampsMs ?? [], nowMs),
        cadenceSeconds: runtimeObservation?.cadenceSeconds ?? null,
        rowsInCurrentSnapshot: runtimeObservation?.rowsInCurrentSnapshot ?? null,
        variables: source.variables,
        spacecraft: source.spacecraft,
        lastErrorMessage: runtimeObservation?.lastErrorMessage ?? null,
        logs: [],
      } satisfies PipelineSourceHealth,
    };
  });

  recordPullLogs(
    healthWithoutLogs.map(({ source, runtimeObservation, health }) => ({
      timestampUtc: generatedAtUtc,
      sourceId: source.id,
      level: getCurrentLogLevel(source, runtimeObservation),
      status: health.status,
      rows: health.rowsInCurrentSnapshot,
      message: getCurrentLogMessage(source, runtimeObservation),
      latencyMs: null,
    })),
    nowMs,
  );

  return {
    generatedAtUtc,
    refreshPolicy: {
      liveIntervalSeconds: 60,
      historicMode: 'daily_incremental_cursor',
    },
    sources: healthWithoutLogs.map(({ health }) => {
      const sourceLogs = getLogsForSource(health.sourceId);

      return {
        ...health,
        errorRate24hPercent: health.errorRate24hPercent ?? calculateErrorRate24h(sourceLogs, nowMs),
        errorRateSparkline: buildErrorSparkline(sourceLogs, nowMs),
        logs: sourceLogs.slice(0, MAX_LOGS_PER_SOURCE),
      };
    }),
  };
}
