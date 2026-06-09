import {
  compactQualityFlags,
  hourKey,
  parseTimestampMs,
  sanitizePhysicalValue,
  toFiniteNumber,
  vectorComponent,
} from '../dataSourceUtils';
import type { L1FetchResult, L1Sample, SourceAttribution } from '../types';

export interface HistoricalL1Range {
  startUtc: string;
  stopUtc: string;
}

export interface HistoricalL1Options {
  range: HistoricalL1Range;
  chunkDays?: number;
}

const HAPI_DATA_URL = 'https://cdaweb.gsfc.nasa.gov/hapi/data';
const REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_CHUNK_DAYS = 31;

const ACE_MFI_DATASET = 'AC_H2_MFI';
const ACE_SWE_DATASET = 'AC_H2_SWE';

interface HapiDataResponse {
  data?: unknown[][];
  status?: {
    code: number;
    message: string;
  };
}

interface MutableAceSample {
  timeUtc: string;
  speedKmS: number | null;
  densityCm3: number | null;
  temperatureK: number | null;
  bxGsmNt: number | null;
  byGsmNt: number | null;
  bzGsmNt: number | null;
  btNt: number | null;
  sourceAttribution: SourceAttribution[];
}

const PHYSICAL_RANGE = {
  speedKmS: { min: 100, max: 3000 },
  densityCm3: { min: 0.01, max: 300 },
  temperatureK: { min: 1, max: 1e8 },
  btNt: { min: 0, max: 300 },
  componentNt: { min: -300, max: 300 },
};

function toIsoUtc(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

function buildAttribution(
  dataset: string,
  parameters: string[],
  range: HistoricalL1Range,
  retrievedAtUtc: string,
): SourceAttribution {
  const url = new URL(HAPI_DATA_URL);
  url.searchParams.set('id', dataset);
  url.searchParams.set('parameters', parameters.join(','));
  url.searchParams.set('time.min', range.startUtc);
  url.searchParams.set('time.max', range.stopUtc);
  url.searchParams.set('format', 'json');

  return {
    sourceId: 'ace_cdaweb_hapi',
    provider: 'NASA CDAWeb HAPI',
    dataset,
    url: url.toString(),
    retrievedAtUtc,
    cadenceSeconds: 3600,
  };
}

async function fetchHapiRows(
  dataset: string,
  parameters: string[],
  range: HistoricalL1Range,
): Promise<{ rows: unknown[][]; warning: string | null }> {
  const url = new URL(HAPI_DATA_URL);
  url.searchParams.set('id', dataset);
  url.searchParams.set('parameters', parameters.join(','));
  url.searchParams.set('time.min', range.startUtc);
  url.searchParams.set('time.max', range.stopUtc);
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString(), {
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${dataset}: CDAWeb HAPI request failed with ${response.status}`);
  }

  const payload = await response.json() as HapiDataResponse;
  if (payload.status && payload.status.code !== 1200) {
    return {
      rows: [],
      warning: `${dataset}: ${payload.status.message}`,
    };
  }

  return {
    rows: Array.isArray(payload.data) ? payload.data : [],
    warning: null,
  };
}

async function fetchHapiRowsChunked(
  dataset: string,
  parameters: string[],
  range: HistoricalL1Range,
  chunkDays: number,
) {
  const startMs = parseTimestampMs(range.startUtc);
  const stopMs = parseTimestampMs(range.stopUtc);
  const chunkMs = chunkDays * 24 * 60 * 60 * 1000;

  if (startMs === null || stopMs === null || stopMs <= startMs) {
    throw new Error('Invalid historical L1 range');
  }

  const rows: unknown[][] = [];
  const warnings = new Set<string>();

  for (let chunkStart = startMs; chunkStart < stopMs; chunkStart += chunkMs) {
    const chunkStop = Math.min(chunkStart + chunkMs, stopMs);
    const result = await fetchHapiRows(dataset, parameters, {
      startUtc: toIsoUtc(chunkStart),
      stopUtc: toIsoUtc(chunkStop),
    });
    rows.push(...result.rows);
    if (result.warning) {
      warnings.add(result.warning);
    }
  }

  return {
    rows,
    warnings: [...warnings],
  };
}

function sampleQualityFlags(sample: MutableAceSample) {
  return compactQualityFlags([
    'historical_hourly_cadence',
    sample.bxGsmNt === null ? 'missing_bx_gsm' : null,
    sample.byGsmNt === null ? 'missing_by_gsm' : null,
    sample.bzGsmNt === null ? 'missing_bz_gsm' : null,
    sample.btNt === null ? 'missing_bt' : null,
    sample.speedKmS === null ? 'missing_speed' : null,
    sample.densityCm3 === null ? 'missing_density' : null,
    sample.temperatureK === null ? 'missing_temperature' : null,
  ]);
}

function mergeMfiRows(
  rows: unknown[][],
  attribution: SourceAttribution,
  byHour: Map<number, MutableAceSample>,
) {
  for (const row of rows) {
    const timestampMs = parseTimestampMs(row[0]);
    if (timestampMs === null) continue;

    const key = hourKey(timestampMs);
    const existing = byHour.get(key);
    const btNt = sanitizePhysicalValue(toFiniteNumber(row[1]), PHYSICAL_RANGE.btNt);
    const bxGsmNt = sanitizePhysicalValue(vectorComponent(row[2], 0), PHYSICAL_RANGE.componentNt);
    const byGsmNt = sanitizePhysicalValue(vectorComponent(row[2], 1), PHYSICAL_RANGE.componentNt);
    const bzGsmNt = sanitizePhysicalValue(vectorComponent(row[2], 2), PHYSICAL_RANGE.componentNt);

    byHour.set(key, {
      timeUtc: toIsoUtc(key),
      speedKmS: existing?.speedKmS ?? null,
      densityCm3: existing?.densityCm3 ?? null,
      temperatureK: existing?.temperatureK ?? null,
      bxGsmNt,
      byGsmNt,
      bzGsmNt,
      btNt,
      sourceAttribution: [...(existing?.sourceAttribution ?? []), attribution],
    });
  }
}

function mergeSweRows(
  rows: unknown[][],
  attribution: SourceAttribution,
  byHour: Map<number, MutableAceSample>,
) {
  for (const row of rows) {
    const timestampMs = parseTimestampMs(row[0]);
    if (timestampMs === null) continue;

    const key = hourKey(timestampMs);
    const existing = byHour.get(key);

    byHour.set(key, {
      timeUtc: toIsoUtc(key),
      speedKmS: sanitizePhysicalValue(toFiniteNumber(row[2]), PHYSICAL_RANGE.speedKmS),
      densityCm3: sanitizePhysicalValue(toFiniteNumber(row[1]), PHYSICAL_RANGE.densityCm3),
      temperatureK: sanitizePhysicalValue(toFiniteNumber(row[3]), PHYSICAL_RANGE.temperatureK),
      bxGsmNt: existing?.bxGsmNt ?? null,
      byGsmNt: existing?.byGsmNt ?? null,
      bzGsmNt: existing?.bzGsmNt ?? null,
      btNt: existing?.btNt ?? null,
      sourceAttribution: [...(existing?.sourceAttribution ?? []), attribution],
    });
  }
}

export async function fetchAceHistoricalL1Samples(options: HistoricalL1Options): Promise<L1FetchResult> {
  const fetchedAtUtc = new Date().toISOString();
  const chunkDays = options.chunkDays ?? DEFAULT_CHUNK_DAYS;
  const mfiParameters = ['Magnitude', 'BGSM'];
  const sweParameters = ['Np', 'Vp', 'Tpr'];
  const mfiAttribution = buildAttribution(ACE_MFI_DATASET, mfiParameters, options.range, fetchedAtUtc);
  const sweAttribution = buildAttribution(ACE_SWE_DATASET, sweParameters, options.range, fetchedAtUtc);
  const sourceAttribution = [mfiAttribution, sweAttribution];
  const warnings: string[] = [];
  const errors: string[] = [];
  const byHour = new Map<number, MutableAceSample>();

  const [mfiResult, sweResult] = await Promise.allSettled([
    fetchHapiRowsChunked(ACE_MFI_DATASET, mfiParameters, options.range, chunkDays),
    fetchHapiRowsChunked(ACE_SWE_DATASET, sweParameters, options.range, chunkDays),
  ]);

  if (mfiResult.status === 'fulfilled') {
    mergeMfiRows(mfiResult.value.rows, mfiAttribution, byHour);
    warnings.push(...mfiResult.value.warnings);
  } else {
    errors.push(mfiResult.reason instanceof Error ? mfiResult.reason.message : `${ACE_MFI_DATASET}: request failed`);
  }

  if (sweResult.status === 'fulfilled') {
    mergeSweRows(sweResult.value.rows, sweAttribution, byHour);
    warnings.push(...sweResult.value.warnings);
  } else {
    errors.push(sweResult.reason instanceof Error ? sweResult.reason.message : `${ACE_SWE_DATASET}: request failed`);
  }

  const samples: L1Sample[] = [...byHour.values()]
    .sort((a, b) => new Date(a.timeUtc).getTime() - new Date(b.timeUtc).getTime())
    .filter(sample => (
      sample.speedKmS !== null
      || sample.densityCm3 !== null
      || sample.temperatureK !== null
      || sample.btNt !== null
      || sample.bzGsmNt !== null
    ))
    .map(sample => ({
      timeUtc: sample.timeUtc,
      source: 'ace_cdaweb_hapi',
      spacecraft: 'ace',
      speedKmS: sample.speedKmS,
      densityCm3: sample.densityCm3,
      temperatureK: sample.temperatureK,
      bxGsmNt: sample.bxGsmNt,
      byGsmNt: sample.byGsmNt,
      bzGsmNt: sample.bzGsmNt,
      btNt: sample.btNt,
      qualityFlags: sampleQualityFlags(sample),
      sourceAttribution: [...new Map(sample.sourceAttribution.map(attr => [attr.dataset, attr])).values()],
    }));

  return {
    samples,
    ephemerisSamples: [],
    sourceAttribution,
    qualityFlags: compactQualityFlags([
      samples.length === 0 ? 'no_l1_samples' : null,
      ...errors.map(() => 'source_request_failed'),
    ]),
    fetchedAtUtc,
    warnings,
    errors,
  };
}
