import {
  compactQualityFlags,
  fetchJsonWithRetry,
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

const SWPC_RTSW_BASE_URL = 'https://services.swpc.noaa.gov/json/rtsw';
const MAGNETIC_FIELD_URL = `${SWPC_RTSW_BASE_URL}/rtsw_mag_1m.json`;
const SOLAR_WIND_URL = `${SWPC_RTSW_BASE_URL}/rtsw_wind_1m.json`;
const EPHEMERIS_URL = `${SWPC_RTSW_BASE_URL}/rtsw_ephemerides_1h.json`;
const REQUEST_TIMEOUT_MS = 12_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

interface SelectedRtswRecord {
  record: Record<string, unknown>;
  timestampMs: number;
  active: boolean;
  source: string;
}

interface RtswMinuteGroup {
  minuteMs: number;
  records: SelectedRtswRecord[];
}

interface MutableL1Sample {
  timeMs: number;
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
  cadenceSeconds: number,
  window: SwpcRtswWindow,
): SourceAttribution {
  return {
    sourceId: 'swpc_rtsw',
    provider: 'NOAA SWPC',
    dataset,
    url,
    retrievedAtUtc,
    cadenceSeconds,
    notes: window === '7-day'
      ? 'The canonical RTSW object feed exposes its available retention window; the retired seven-day product is not queried.'
      : undefined,
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

function mergeSpacecraft(current: L1Spacecraft | null, next: L1Spacecraft): L1Spacecraft {
  if (current === null || current === 'unknown') return next;
  if (next === 'unknown' || next === current) return current;
  return 'active';
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
    const timestampMs = parseTimestampMs(record.time_tag);
    if (timestampMs === null) {
      continue;
    }

    const candidate: SelectedRtswRecord = {
      record,
      timestampMs,
      active: isActiveRecord(record.active),
      source: recordSource(record),
    };
    const key = minuteBucket(timestampMs);
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  return [...grouped.entries()]
    .map(([minuteMs, records]) => ({
      minuteMs,
      records: records.sort(comparePreferredRecord),
    }))
    .sort((a, b) => a.minuteMs - b.minuteMs);
}

function preferredRecord(group: RtswMinuteGroup) {
  return group.records[0];
}

function valueFromGroup(group: RtswMinuteGroup, field: string): number | null {
  for (const { record } of group.records) {
    const value = toFiniteNumber(record[field]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function applyRequestedWindow(groups: RtswMinuteGroup[], window: SwpcRtswWindow) {
  if (window !== '2-hour' || groups.length === 0) {
    return groups;
  }

  const latestTimestampMs = preferredRecord(groups[groups.length - 1]).timestampMs;
  return groups.filter(group => preferredRecord(group).timestampMs >= latestTimestampMs - TWO_HOURS_MS);
}

function spacecraftFor(record: SelectedRtswRecord): L1Spacecraft {
  return parseSpacecraft(record.source, record.active ? 'active' : 'unknown');
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

function parseMagRecords(
  data: unknown,
  window: SwpcRtswWindow,
  attribution: SourceAttribution,
  byMinute: Map<number, MutableL1Sample>,
) {
  const groups = applyRequestedWindow(groupRecordsByMinute(data), window);

  for (const group of groups) {
    const selected = preferredRecord(group);
    const key = group.minuteMs;
    const existing = byMinute.get(key);

    byMinute.set(key, {
      timeMs: Math.max(existing?.timeMs ?? -Infinity, selected.timestampMs),
      spacecraft: mergeSpacecraft(existing?.spacecraft ?? null, spacecraftFor(selected)),
      speedKmS: existing?.speedKmS ?? null,
      densityCm3: existing?.densityCm3 ?? null,
      temperatureK: existing?.temperatureK ?? null,
      bxGsmNt: valueFromGroup(group, 'bx_gsm'),
      byGsmNt: valueFromGroup(group, 'by_gsm'),
      bzGsmNt: valueFromGroup(group, 'bz_gsm'),
      btNt: valueFromGroup(group, 'bt'),
      sourceAttribution: [...(existing?.sourceAttribution ?? []), attribution],
    });
  }

  return groups.length;
}

function parseWindRecords(
  data: unknown,
  window: SwpcRtswWindow,
  attribution: SourceAttribution,
  byMinute: Map<number, MutableL1Sample>,
) {
  const groups = applyRequestedWindow(groupRecordsByMinute(data), window);

  for (const group of groups) {
    const selected = preferredRecord(group);
    const key = group.minuteMs;
    const existing = byMinute.get(key);

    byMinute.set(key, {
      timeMs: Math.max(existing?.timeMs ?? -Infinity, selected.timestampMs),
      spacecraft: mergeSpacecraft(existing?.spacecraft ?? null, spacecraftFor(selected)),
      speedKmS: valueFromGroup(group, 'proton_speed'),
      densityCm3: valueFromGroup(group, 'proton_density'),
      temperatureK: valueFromGroup(group, 'proton_temperature'),
      bxGsmNt: existing?.bxGsmNt ?? null,
      byGsmNt: existing?.byGsmNt ?? null,
      bzGsmNt: existing?.bzGsmNt ?? null,
      btNt: existing?.btNt ?? null,
      sourceAttribution: [...(existing?.sourceAttribution ?? []), attribution],
    });
  }

  return groups.length;
}

function parseEphemerisRecords(
  data: unknown,
  window: SwpcRtswWindow,
  attribution: SourceAttribution,
): L1EphemerisSample[] {
  return applyRequestedWindow(groupRecordsByMinute(data), window).map(group => {
    const selected = preferredRecord(group);
    const sample: L1EphemerisSample = {
      timeUtc: new Date(selected.timestampMs).toISOString(),
      source: 'swpc_rtsw',
      spacecraft: spacecraftFor(selected),
      xGseKm: valueFromGroup(group, 'x_gse'),
      yGseKm: valueFromGroup(group, 'y_gse'),
      zGseKm: valueFromGroup(group, 'z_gse'),
      xGsmKm: valueFromGroup(group, 'x_gsm'),
      yGsmKm: valueFromGroup(group, 'y_gsm'),
      zGsmKm: valueFromGroup(group, 'z_gsm'),
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
    return sample;
  });
}

export async function fetchSwpcRtswL1Samples(options: SwpcRtswOptions = {}): Promise<L1FetchResult> {
  const fetchedAtUtc = new Date().toISOString();
  const window = options.window ?? '2-hour';
  const includeEphemeris = options.includeEphemeris ?? true;
  const magAttribution = buildAttribution(
    'RTSW magnetic field 1-minute',
    MAGNETIC_FIELD_URL,
    fetchedAtUtc,
    60,
    window,
  );
  const windAttribution = buildAttribution(
    'RTSW solar wind 1-minute',
    SOLAR_WIND_URL,
    fetchedAtUtc,
    60,
    window,
  );
  const ephemerisAttribution = buildAttribution(
    'RTSW spacecraft ephemeris 1-hour',
    EPHEMERIS_URL,
    fetchedAtUtc,
    3_600,
    window,
  );
  const attributions = includeEphemeris
    ? [magAttribution, windAttribution, ephemerisAttribution]
    : [magAttribution, windAttribution];
  const warnings: string[] = [];
  const errors: string[] = [];
  const byMinute = new Map<number, MutableL1Sample>();
  let ephemerisSamples: L1EphemerisSample[] = [];

  const [magResult, windResult, ephemerisResult] = await Promise.allSettled([
    fetchJsonWithRetry(MAGNETIC_FIELD_URL, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: 1,
      label: 'NOAA SWPC RTSW magnetic field',
    }),
    fetchJsonWithRetry(SOLAR_WIND_URL, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: 1,
      label: 'NOAA SWPC RTSW solar wind',
    }),
    includeEphemeris
      ? fetchJsonWithRetry(EPHEMERIS_URL, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        retries: 1,
        label: 'NOAA SWPC RTSW ephemeris',
      })
      : Promise.resolve([]),
  ]);

  if (magResult.status === 'fulfilled') {
    if (parseMagRecords(magResult.value, window, magAttribution, byMinute) === 0) {
      errors.push('NOAA SWPC RTSW magnetic field returned no usable object records');
    }
  } else {
    errors.push(magResult.reason instanceof Error
      ? magResult.reason.message
      : 'NOAA SWPC RTSW magnetic field failed');
  }

  if (windResult.status === 'fulfilled') {
    if (parseWindRecords(windResult.value, window, windAttribution, byMinute) === 0) {
      errors.push('NOAA SWPC RTSW solar wind returned no usable object records');
    }
  } else {
    errors.push(windResult.reason instanceof Error
      ? windResult.reason.message
      : 'NOAA SWPC RTSW solar wind failed');
  }

  if (includeEphemeris && ephemerisResult.status === 'fulfilled') {
    ephemerisSamples = parseEphemerisRecords(ephemerisResult.value, window, ephemerisAttribution);
    if (ephemerisSamples.length === 0) {
      warnings.push('NOAA SWPC RTSW ephemeris returned no usable object records');
    }
  } else if (includeEphemeris && ephemerisResult.status === 'rejected') {
    warnings.push(ephemerisResult.reason instanceof Error
      ? ephemerisResult.reason.message
      : 'NOAA SWPC RTSW ephemeris failed');
  }

  const samples: L1Sample[] = [...byMinute.values()]
    .sort((a, b) => a.timeMs - b.timeMs)
    .map(sample => ({
      timeUtc: new Date(sample.timeMs).toISOString(),
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
      sourceAttribution: [
        ...new Map(sample.sourceAttribution.map(attribution => [attribution.dataset, attribution])).values(),
      ],
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
