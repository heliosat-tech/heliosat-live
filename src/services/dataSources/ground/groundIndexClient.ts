import {
  compactQualityFlags,
  fetchJsonWithRetry,
  parseTimestampMs,
  toFiniteNumber,
} from '../dataSourceUtils';
import type { DataSourceFetchResult, GroundIndexSample, SourceAttribution } from '../types';

export interface GroundIndexClientOptions {
  startUtc?: string;
  stopUtc?: string;
  dstEndpoint?: string;
  includeSymH?: boolean;
}

interface GfzKpResponse {
  Kp?: unknown[];
  datetime?: unknown[];
  status?: unknown[];
  meta?: {
    source?: string;
    license?: string;
  };
}

interface MutableGroundSample {
  timeUtc: string;
  kp: number | null;
  dstNt: number | null;
  symhNt: number | null;
  qualityFlags: string[];
  sourceAttribution: SourceAttribution[];
}

const GFZ_KP_ENDPOINT = 'https://kp.gfz.de/app/json/';
const DEFAULT_DST_ENDPOINT = process.env.HELIOSAT_DST_ENDPOINT
  ?? 'https://services.swpc.noaa.gov/products/kyoto-dst.json';
const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_RANGE_DAYS = 7;

function toIsoUtc(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

function defaultRange() {
  const stopMs = Date.now();
  const startMs = stopMs - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000;

  return {
    startUtc: toIsoUtc(startMs),
    stopUtc: toIsoUtc(stopMs),
  };
}

function buildGfzKpUrl(startUtc: string, stopUtc: string) {
  const url = new URL(GFZ_KP_ENDPOINT);
  url.searchParams.set('start', startUtc);
  url.searchParams.set('end', stopUtc);
  url.searchParams.set('index', 'Kp');

  return url.toString();
}

function buildAttribution(
  sourceId: string,
  provider: string,
  dataset: string,
  url: string,
  retrievedAtUtc: string,
  cadenceSeconds: number,
  notes?: string,
): SourceAttribution {
  return {
    sourceId,
    provider,
    dataset,
    url,
    retrievedAtUtc,
    cadenceSeconds,
    notes,
  };
}

function ensureSample(
  byTime: Map<string, MutableGroundSample>,
  timeUtc: string,
) {
  const existing = byTime.get(timeUtc);
  if (existing) {
    return existing;
  }

  const sample: MutableGroundSample = {
    timeUtc,
    kp: null,
    dstNt: null,
    symhNt: null,
    qualityFlags: [],
    sourceAttribution: [],
  };
  byTime.set(timeUtc, sample);

  return sample;
}

async function fetchGfzKp(
  startUtc: string,
  stopUtc: string,
  attribution: SourceAttribution,
) {
  const url = buildGfzKpUrl(startUtc, stopUtc);
  const payload = await fetchJsonWithRetry(url, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    retries: 1,
    label: 'GFZ Kp',
  }) as GfzKpResponse;
  const samples: Array<{ timeUtc: string; kp: number; status: string | null; attribution: SourceAttribution }> = [];
  const kpValues = Array.isArray(payload.Kp) ? payload.Kp : [];
  const timestamps = Array.isArray(payload.datetime) ? payload.datetime : [];
  const statuses = Array.isArray(payload.status) ? payload.status : [];

  for (let index = 0; index < Math.min(kpValues.length, timestamps.length); index += 1) {
    const timestampMs = parseTimestampMs(timestamps[index]);
    const kp = toFiniteNumber(kpValues[index]);
    if (timestampMs === null || kp === null) continue;

    samples.push({
      timeUtc: toIsoUtc(timestampMs),
      kp,
      status: typeof statuses[index] === 'string' ? String(statuses[index]) : null,
      attribution,
    });
  }

  return samples;
}

function parseDstRows(
  payload: unknown,
  attribution: SourceAttribution,
) {
  const rows = Array.isArray(payload) ? payload : [];
  const samples: Array<{ timeUtc: string; dstNt: number; attribution: SourceAttribution }> = [];

  for (const row of rows) {
    if (Array.isArray(row)) {
      if (row[0] === 'time_tag') continue;
      const timestampMs = parseTimestampMs(row[0]);
      const dstNt = toFiniteNumber(row[1]);
      if (timestampMs !== null && dstNt !== null) {
        samples.push({ timeUtc: toIsoUtc(timestampMs), dstNt, attribution });
      }
      continue;
    }

    if (!row || typeof row !== 'object') continue;

    const record = row as Record<string, unknown>;
    const timestampMs = parseTimestampMs(record.time_tag ?? record.time ?? record.datetime);
    const dstNt = toFiniteNumber(record.dst ?? record.Dst ?? record.DST);
    if (timestampMs !== null && dstNt !== null) {
      samples.push({ timeUtc: toIsoUtc(timestampMs), dstNt, attribution });
    }
  }

  return samples;
}

function sampleQualityFlags(sample: MutableGroundSample, includeSymH: boolean) {
  return compactQualityFlags([
    sample.kp === null ? 'missing_kp' : null,
    sample.dstNt === null ? 'missing_dst' : null,
    includeSymH
      ? sample.symhNt === null ? 'missing_symh' : null
      : 'symh_not_configured',
    ...sample.qualityFlags,
  ]);
}

export async function fetchGroundIndexSamples(
  options: GroundIndexClientOptions = {},
): Promise<DataSourceFetchResult<GroundIndexSample>> {
  const fallbackRange = defaultRange();
  const startUtc = options.startUtc ?? fallbackRange.startUtc;
  const stopUtc = options.stopUtc ?? fallbackRange.stopUtc;
  const dstEndpoint = options.dstEndpoint ?? DEFAULT_DST_ENDPOINT;
  const includeSymH = options.includeSymH ?? false;
  const fetchedAtUtc = new Date().toISOString();
  const gfzKpUrl = buildGfzKpUrl(startUtc, stopUtc);
  const kpAttribution = buildAttribution(
    'gfz_kp',
    'GFZ German Research Centre for Geosciences',
    'Kp JSON API',
    gfzKpUrl,
    fetchedAtUtc,
    10_800,
    'Ground geomagnetic response index.',
  );
  const dstAttribution = buildAttribution(
    'dst_configured',
    'Configured Dst source',
    'Dst index',
    dstEndpoint,
    fetchedAtUtc,
    3600,
    'Ground geomagnetic response index.',
  );
  const sourceAttribution = [kpAttribution, dstAttribution];
  const byTime = new Map<string, MutableGroundSample>();
  const warnings: string[] = [];
  const errors: string[] = [];

  const [kpResult, dstResult] = await Promise.allSettled([
    fetchGfzKp(startUtc, stopUtc, kpAttribution),
    fetchJsonWithRetry(dstEndpoint, { timeoutMs: REQUEST_TIMEOUT_MS, retries: 1, label: 'Dst index' }),
  ]);

  if (kpResult.status === 'fulfilled') {
    kpResult.value.forEach(point => {
      const sample = ensureSample(byTime, point.timeUtc);
      sample.kp = point.kp;
      if (point.status) {
        sample.qualityFlags.push(`kp_status_${point.status}`);
      }
      sample.sourceAttribution.push(point.attribution);
    });
  } else {
    errors.push(kpResult.reason instanceof Error ? kpResult.reason.message : 'GFZ Kp request failed');
  }

  if (dstResult.status === 'fulfilled') {
    const dstRows = parseDstRows(dstResult.value, dstAttribution);
    dstRows.forEach(point => {
      const sample = ensureSample(byTime, point.timeUtc);
      sample.dstNt = point.dstNt;
      sample.sourceAttribution.push(point.attribution);
    });
  } else {
    errors.push(dstResult.reason instanceof Error ? dstResult.reason.message : 'Dst request failed');
  }

  if (!includeSymH) {
    warnings.push('SYM-H is not configured for this MVP ingestion layer yet');
  }

  const startMs = parseTimestampMs(startUtc) ?? Number.NEGATIVE_INFINITY;
  const stopMs = parseTimestampMs(stopUtc) ?? Number.POSITIVE_INFINITY;
  const samples: GroundIndexSample[] = [...byTime.values()]
    .filter(sample => {
      const timestampMs = parseTimestampMs(sample.timeUtc);
      return timestampMs !== null && timestampMs >= startMs && timestampMs <= stopMs;
    })
    .sort((a, b) => new Date(a.timeUtc).getTime() - new Date(b.timeUtc).getTime())
    .map(sample => ({
      timeUtc: sample.timeUtc,
      kp: sample.kp,
      dstNt: sample.dstNt,
      symhNt: sample.symhNt,
      qualityFlags: sampleQualityFlags(sample, includeSymH),
      sourceAttribution: [...new Map(sample.sourceAttribution.map(attr => [attr.dataset, attr])).values()],
    }));

  return {
    samples,
    sourceAttribution,
    qualityFlags: compactQualityFlags([
      samples.length === 0 ? 'no_ground_index_samples' : null,
      ...errors.map(() => 'source_request_failed'),
    ]),
    fetchedAtUtc,
    warnings,
    errors,
  };
}
