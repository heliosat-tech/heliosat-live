import {
  columnIndex,
  compactQualityFlags,
  fetchJsonWithRetry,
  minuteKey,
  parseTimestampMs,
  toFiniteNumber,
} from '../dataSourceUtils';
import type {
  L1EphemerisSample,
  L1FetchResult,
  L1Sample,
  L1Spacecraft,
  SourceAttribution,
} from '../types';

type SwpcRtswWindow = '2-hour' | '7-day';

interface SwpcRtswOptions {
  window?: SwpcRtswWindow;
  includeEphemeris?: boolean;
}

const SWPC_SOLAR_WIND_BASE_URL = 'https://services.swpc.noaa.gov/products/solar-wind';
const REQUEST_TIMEOUT_MS = 12_000;

const PRODUCT_BY_WINDOW: Record<SwpcRtswWindow, { mag: string; plasma: string }> = {
  '2-hour': {
    mag: `${SWPC_SOLAR_WIND_BASE_URL}/mag-2-hour.json`,
    plasma: `${SWPC_SOLAR_WIND_BASE_URL}/plasma-2-hour.json`,
  },
  '7-day': {
    mag: `${SWPC_SOLAR_WIND_BASE_URL}/mag-7-day.json`,
    plasma: `${SWPC_SOLAR_WIND_BASE_URL}/plasma-7-day.json`,
  },
};

const EPHEMERIS_URL = `${SWPC_SOLAR_WIND_BASE_URL}/ephemerides.json`;

interface MutableL1Sample {
  timeUtc: string;
  speedKmS: number | null;
  densityCm3: number | null;
  temperatureK: number | null;
  bxGsmNt: number | null;
  byGsmNt: number | null;
  bzGsmNt: number | null;
  btNt: number | null;
  spacecraft: L1Spacecraft;
  sourceAttribution: SourceAttribution[];
}

function buildAttribution(
  dataset: string,
  url: string,
  retrievedAtUtc: string,
  cadenceSeconds: number | null,
): SourceAttribution {
  return {
    sourceId: 'swpc_rtsw',
    provider: 'NOAA SWPC',
    dataset,
    url,
    retrievedAtUtc,
    cadenceSeconds,
  };
}

function parseSpacecraft(value: unknown, fallback: L1Spacecraft): L1Spacecraft {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.includes('dscovr')) return 'dscovr';
  if (normalized.includes('ace')) return 'ace';
  if (normalized.includes('active')) return 'active';

  return fallback;
}

function tableRows(data: unknown) {
  return Array.isArray(data) ? data : [];
}

function sampleQualityFlags(sample: MutableL1Sample) {
  return compactQualityFlags([
    sample.bxGsmNt === null ? 'missing_bx_gsm' : null,
    sample.byGsmNt === null ? 'missing_by_gsm' : null,
    sample.bzGsmNt === null ? 'missing_bz_gsm' : null,
    sample.btNt === null ? 'missing_bt' : null,
    sample.speedKmS === null ? 'missing_speed' : null,
    sample.densityCm3 === null ? 'missing_density' : null,
    sample.temperatureK === null ? 'missing_temperature' : null,
  ]);
}

function parseMagRows(
  data: unknown,
  attribution: SourceAttribution,
  byMinute: Map<number, MutableL1Sample>,
) {
  const rows = tableRows(data);
  const columns = columnIndex(rows);
  const timeIdx = columns.time_tag ?? 0;
  const bxIdx = columns.bx_gsm ?? -1;
  const byIdx = columns.by_gsm ?? -1;
  const bzIdx = columns.bz_gsm ?? -1;
  const btIdx = columns.bt ?? -1;
  const spacecraftIdx = columns.spacecraft ?? columns.satellite ?? columns.source ?? -1;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row)) continue;

    const timestampMs = parseTimestampMs(row[timeIdx]);
    if (timestampMs === null) continue;

    const key = minuteKey(timestampMs);
    const existing = byMinute.get(key);
    const timeUtc = new Date(key).toISOString();
    const spacecraft = parseSpacecraft(spacecraftIdx >= 0 ? row[spacecraftIdx] : null, existing?.spacecraft ?? 'active');

    byMinute.set(key, {
      timeUtc,
      spacecraft,
      speedKmS: existing?.speedKmS ?? null,
      densityCm3: existing?.densityCm3 ?? null,
      temperatureK: existing?.temperatureK ?? null,
      bxGsmNt: bxIdx >= 0 ? toFiniteNumber(row[bxIdx]) : existing?.bxGsmNt ?? null,
      byGsmNt: byIdx >= 0 ? toFiniteNumber(row[byIdx]) : existing?.byGsmNt ?? null,
      bzGsmNt: bzIdx >= 0 ? toFiniteNumber(row[bzIdx]) : existing?.bzGsmNt ?? null,
      btNt: btIdx >= 0 ? toFiniteNumber(row[btIdx]) : existing?.btNt ?? null,
      sourceAttribution: [...(existing?.sourceAttribution ?? []), attribution],
    });
  }
}

function parsePlasmaRows(
  data: unknown,
  attribution: SourceAttribution,
  byMinute: Map<number, MutableL1Sample>,
) {
  const rows = tableRows(data);
  const columns = columnIndex(rows);
  const timeIdx = columns.time_tag ?? 0;
  const densityIdx = columns.density ?? -1;
  const speedIdx = columns.speed ?? -1;
  const temperatureIdx = columns.temperature ?? -1;
  const spacecraftIdx = columns.spacecraft ?? columns.satellite ?? columns.source ?? -1;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row)) continue;

    const timestampMs = parseTimestampMs(row[timeIdx]);
    if (timestampMs === null) continue;

    const key = minuteKey(timestampMs);
    const existing = byMinute.get(key);
    const timeUtc = new Date(key).toISOString();
    const spacecraft = parseSpacecraft(spacecraftIdx >= 0 ? row[spacecraftIdx] : null, existing?.spacecraft ?? 'active');

    byMinute.set(key, {
      timeUtc,
      spacecraft,
      speedKmS: speedIdx >= 0 ? toFiniteNumber(row[speedIdx]) : existing?.speedKmS ?? null,
      densityCm3: densityIdx >= 0 ? toFiniteNumber(row[densityIdx]) : existing?.densityCm3 ?? null,
      temperatureK: temperatureIdx >= 0 ? toFiniteNumber(row[temperatureIdx]) : existing?.temperatureK ?? null,
      bxGsmNt: existing?.bxGsmNt ?? null,
      byGsmNt: existing?.byGsmNt ?? null,
      bzGsmNt: existing?.bzGsmNt ?? null,
      btNt: existing?.btNt ?? null,
      sourceAttribution: [...(existing?.sourceAttribution ?? []), attribution],
    });
  }
}

function parseEphemerisRows(data: unknown, attribution: SourceAttribution): L1EphemerisSample[] {
  const rows = tableRows(data);
  const columns = columnIndex(rows);
  const timeIdx = columns.time_tag ?? 0;
  const spacecraftIdx = columns.spacecraft ?? columns.satellite ?? columns.source ?? -1;
  const xGseIdx = columns.x_gse ?? -1;
  const yGseIdx = columns.y_gse ?? -1;
  const zGseIdx = columns.z_gse ?? -1;
  const xGsmIdx = columns.x_gsm ?? -1;
  const yGsmIdx = columns.y_gsm ?? -1;
  const zGsmIdx = columns.z_gsm ?? -1;
  const samples: L1EphemerisSample[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row)) continue;

    const timestampMs = parseTimestampMs(row[timeIdx]);
    if (timestampMs === null) continue;

    const sample: L1EphemerisSample = {
      timeUtc: new Date(minuteKey(timestampMs)).toISOString(),
      source: 'swpc_rtsw',
      spacecraft: parseSpacecraft(spacecraftIdx >= 0 ? row[spacecraftIdx] : null, 'active'),
      xGseKm: xGseIdx >= 0 ? toFiniteNumber(row[xGseIdx]) : null,
      yGseKm: yGseIdx >= 0 ? toFiniteNumber(row[yGseIdx]) : null,
      zGseKm: zGseIdx >= 0 ? toFiniteNumber(row[zGseIdx]) : null,
      xGsmKm: xGsmIdx >= 0 ? toFiniteNumber(row[xGsmIdx]) : null,
      yGsmKm: yGsmIdx >= 0 ? toFiniteNumber(row[yGsmIdx]) : null,
      zGsmKm: zGsmIdx >= 0 ? toFiniteNumber(row[zGsmIdx]) : null,
      qualityFlags: [],
      sourceAttribution: [attribution],
    };
    sample.qualityFlags = compactQualityFlags([
      sample.xGseKm === null ? 'missing_x_gse' : null,
      sample.yGseKm === null ? 'missing_y_gse' : null,
      sample.zGseKm === null ? 'missing_z_gse' : null,
      sample.xGsmKm === null ? 'missing_x_gsm' : null,
      sample.yGsmKm === null ? 'missing_y_gsm' : null,
      sample.zGsmKm === null ? 'missing_z_gsm' : null,
    ]);
    samples.push(sample);
  }

  return samples.sort((a, b) => new Date(a.timeUtc).getTime() - new Date(b.timeUtc).getTime());
}

export async function fetchSwpcRtswL1Samples(options: SwpcRtswOptions = {}): Promise<L1FetchResult> {
  const fetchedAtUtc = new Date().toISOString();
  const window = options.window ?? '2-hour';
  const includeEphemeris = options.includeEphemeris ?? true;
  const products = PRODUCT_BY_WINDOW[window];
  const magAttribution = buildAttribution(`RTSW magnetic field ${window}`, products.mag, fetchedAtUtc, 60);
  const plasmaAttribution = buildAttribution(`RTSW plasma ${window}`, products.plasma, fetchedAtUtc, 60);
  const ephemerisAttribution = buildAttribution('RTSW spacecraft ephemeris', EPHEMERIS_URL, fetchedAtUtc, 60);
  const attributions = includeEphemeris
    ? [magAttribution, plasmaAttribution, ephemerisAttribution]
    : [magAttribution, plasmaAttribution];
  const warnings: string[] = [];
  const errors: string[] = [];
  const byMinute = new Map<number, MutableL1Sample>();
  let ephemerisSamples: L1EphemerisSample[] = [];

  const [magResult, plasmaResult, ephemerisResult] = await Promise.allSettled([
    fetchJsonWithRetry(products.mag, { timeoutMs: REQUEST_TIMEOUT_MS, retries: 1, label: 'NOAA SWPC RTSW magnetic field' }),
    fetchJsonWithRetry(products.plasma, { timeoutMs: REQUEST_TIMEOUT_MS, retries: 1, label: 'NOAA SWPC RTSW plasma' }),
    includeEphemeris
      ? fetchJsonWithRetry(EPHEMERIS_URL, { timeoutMs: REQUEST_TIMEOUT_MS, retries: 1, label: 'NOAA SWPC RTSW ephemeris' })
      : Promise.resolve([]),
  ]);

  if (magResult.status === 'fulfilled') {
    parseMagRows(magResult.value, magAttribution, byMinute);
  } else {
    errors.push(magResult.reason instanceof Error ? magResult.reason.message : 'NOAA SWPC RTSW magnetic field failed');
  }

  if (plasmaResult.status === 'fulfilled') {
    parsePlasmaRows(plasmaResult.value, plasmaAttribution, byMinute);
  } else {
    errors.push(plasmaResult.reason instanceof Error ? plasmaResult.reason.message : 'NOAA SWPC RTSW plasma failed');
  }

  if (includeEphemeris && ephemerisResult.status === 'fulfilled') {
    ephemerisSamples = parseEphemerisRows(ephemerisResult.value, ephemerisAttribution);
  } else if (includeEphemeris && ephemerisResult.status === 'rejected') {
    warnings.push(ephemerisResult.reason instanceof Error ? ephemerisResult.reason.message : 'NOAA SWPC RTSW ephemeris failed');
  }

  const samples: L1Sample[] = [...byMinute.values()]
    .sort((a, b) => new Date(a.timeUtc).getTime() - new Date(b.timeUtc).getTime())
    .map(sample => ({
      timeUtc: sample.timeUtc,
      source: 'swpc_rtsw',
      spacecraft: sample.spacecraft,
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
    ephemerisSamples,
    sourceAttribution: attributions,
    qualityFlags: compactQualityFlags([
      samples.length === 0 ? 'no_l1_samples' : null,
      ephemerisSamples.length === 0 && includeEphemeris ? 'no_ephemeris_samples' : null,
      ...errors.map(() => 'source_request_failed'),
    ]),
    fetchedAtUtc,
    warnings,
    errors,
  };
}
