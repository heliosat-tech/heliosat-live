import type { NormalizedSpaceWeatherRow } from './pipeline/normalizedSchema';
import type { ContextIndexPoint, ContextIndexSnapshot } from './spaceWeatherContextIndexService';

export type StormIntensity = 'moderate' | 'intense' | 'extreme';
export type StormDriver = 'CME-driven' | 'CIR-driven' | 'ambiguous';

export interface StormEvent {
  eventId: string;
  intensity: StormIntensity;
  driver: StormDriver;
  onsetUtc: string;
  peakUtc: string;
  recoveryEndUtc: string | null;
  preEventStartUtc: string;
  durationHours: number | null;
  peakDstNt: number;
  sscUtc: string | null;
}

export interface EventMetricRow {
  eventId: string;
  runId: string;
  model: string;
  leadTimeMinutes: number | null;
  peakError: number | null;
  recoveryCoveragePercent: number | null;
  falseAlarmRateQuiet: number | null;
}

export interface StormBrowserSnapshot {
  generatedAtUtc: string;
  eventsCatalogPath: string;
  splitsConfigPath: string;
  eventMetricsPath: string;
  events: StormEvent[];
  timeline: Array<{
    timestampUtc: string;
    dst: number | null;
    kp: number | null;
    negDst: number | null;
  }>;
  selectedEventId: string | null;
  selectedEventSeries: Array<{
    timestampUtc: string;
    bzGsm: number | null;
    speed: number | null;
    density: number | null;
    bTotal: number | null;
    goesMag: number | null;
    dst: number | null;
    kp: number | null;
  }>;
  splitsConfig: {
    version: string;
    strategy: string;
    folds: Array<{
      fold: number;
      train: string;
      val: string;
      test: string;
    }>;
    eventHoldoutIds: string[];
  };
  eventMetrics: EventMetricRow[];
  warnings: string[];
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const timestampMs = new Date(value).getTime();
  return Number.isNaN(timestampMs) ? null : timestampMs;
}

function toIsoUtc(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

function getSeverity(peakDst: number): StormIntensity {
  if (peakDst < -250) {
    return 'extreme';
  }

  if (peakDst < -100) {
    return 'intense';
  }

  return 'moderate';
}

function valueAtOrBefore(
  points: ContextIndexPoint[],
  kind: ContextIndexPoint['kind'],
  timestampMs: number,
): number | null {
  let bestValue: number | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;

  points.forEach(point => {
    if (point.kind !== kind) {
      return;
    }

    const pointMs = parseTimestampMs(point.timestampUtc);

    if (pointMs !== null && pointMs <= timestampMs && pointMs > bestMs) {
      bestValue = point.value;
      bestMs = pointMs;
    }
  });

  return bestValue;
}

function getSeriesValue(rows: NormalizedSpaceWeatherRow[], source: string, variable: string, timestampMs: number) {
  let bestValue: number | null = null;
  let bestDeltaMs = Number.POSITIVE_INFINITY;

  rows.forEach(row => {
    if (row.source !== source || row.variable !== variable) {
      return;
    }

    const rowMs = parseTimestampMs(row.timestamp_utc);

    if (rowMs === null) {
      return;
    }

    const deltaMs = Math.abs(rowMs - timestampMs);

    if (deltaMs < bestDeltaMs && deltaMs <= 5 * 60 * 1000) {
      bestDeltaMs = deltaMs;
      bestValue = row.value;
    }
  });

  return bestValue;
}

function inferDriver(rows: NormalizedSpaceWeatherRow[], onsetMs: number): StormDriver {
  const beforeMs = onsetMs - 2 * 60 * 60 * 1000;
  const afterMs = onsetMs + 2 * 60 * 60 * 1000;
  const speedBefore = getSeriesValue(rows, 'DSCOVR', 'solar_wind_speed', beforeMs);
  const speedAfter = getSeriesValue(rows, 'DSCOVR', 'solar_wind_speed', afterMs);
  const densityBefore = getSeriesValue(rows, 'DSCOVR', 'proton_density', beforeMs);
  const densityAfter = getSeriesValue(rows, 'DSCOVR', 'proton_density', afterMs);

  if (
    speedBefore !== null &&
    speedAfter !== null &&
    densityBefore !== null &&
    densityAfter !== null &&
    speedAfter - speedBefore > 80 &&
    densityAfter > densityBefore * 1.5
  ) {
    return 'CME-driven';
  }

  if (speedBefore !== null && speedAfter !== null && speedAfter - speedBefore > 40) {
    return 'CIR-driven';
  }

  return 'ambiguous';
}

function detectSsc(dstPoints: ContextIndexPoint[], onsetMs: number) {
  const candidates = dstPoints
    .map(point => ({ timestampMs: parseTimestampMs(point.timestampUtc), value: point.value }))
    .filter((point): point is { timestampMs: number; value: number } => point.timestampMs !== null)
    .filter(point => point.timestampMs >= onsetMs - 6 * 60 * 60 * 1000 && point.timestampMs <= onsetMs + 60 * 60 * 1000)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index].value - candidates[index - 1].value > 15) {
      return toIsoUtc(candidates[index].timestampMs);
    }
  }

  return null;
}

function detectStormEvents(context: ContextIndexSnapshot, rows: NormalizedSpaceWeatherRow[]) {
  const dstPoints = context.points
    .filter(point => point.kind === 'dst')
    .map(point => ({ ...point, timestampMs: parseTimestampMs(point.timestampUtc) }))
    .filter((point): point is ContextIndexPoint & { timestampMs: number } => point.timestampMs !== null)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const events: StormEvent[] = [];
  let index = 0;

  while (index < dstPoints.length) {
    if (dstPoints[index].value >= -50) {
      index += 1;
      continue;
    }

    const onsetIndex = index;
    let peakIndex = index;

    while (index < dstPoints.length && dstPoints[index].value < -30) {
      if (dstPoints[index].value < dstPoints[peakIndex].value) {
        peakIndex = index;
      }
      index += 1;
    }

    const recoveryIndex = index < dstPoints.length ? index : -1;
    const onset = dstPoints[onsetIndex];
    const peak = dstPoints[peakIndex];
    const recovery = recoveryIndex >= 0 ? dstPoints[recoveryIndex] : null;
    const eventId = `storm_${onset.timestampUtc.slice(0, 10).replace(/-/g, '')}_${Math.abs(Math.round(peak.value))}`;

    events.push({
      eventId,
      intensity: getSeverity(peak.value),
      driver: inferDriver(rows, onset.timestampMs),
      onsetUtc: onset.timestampUtc,
      peakUtc: peak.timestampUtc,
      recoveryEndUtc: recovery?.timestampUtc ?? null,
      preEventStartUtc: toIsoUtc(onset.timestampMs - 24 * 60 * 60 * 1000),
      durationHours: recovery ? (recovery.timestampMs - onset.timestampMs) / (60 * 60 * 1000) : null,
      peakDstNt: peak.value,
      sscUtc: detectSsc(dstPoints, onset.timestampMs),
    });
  }

  return events;
}

function buildTimeline(context: ContextIndexSnapshot) {
  const timestampsMs = Array.from(new Set(
    context.points
      .map(point => parseTimestampMs(point.timestampUtc))
      .filter((timestampMs): timestampMs is number => timestampMs !== null),
  )).sort((a, b) => a - b);

  return timestampsMs.map(timestampMs => {
    const dst = valueAtOrBefore(context.points, 'dst', timestampMs);
    const kp = valueAtOrBefore(context.points, 'kp', timestampMs);

    return {
      timestampUtc: toIsoUtc(timestampMs),
      dst,
      kp,
      negDst: dst === null ? null : -dst,
    };
  });
}

function buildSelectedEventSeries(
  event: StormEvent | null,
  context: ContextIndexSnapshot,
  rows: NormalizedSpaceWeatherRow[],
) {
  if (!event) {
    return [];
  }

  const startMs = parseTimestampMs(event.preEventStartUtc);
  const stopMs = parseTimestampMs(event.recoveryEndUtc ?? event.peakUtc);

  if (startMs === null || stopMs === null || stopMs <= startMs) {
    return [];
  }

  const stepMs = 60 * 60 * 1000;
  const series = [];

  for (let timestampMs = startMs; timestampMs <= stopMs; timestampMs += stepMs) {
    series.push({
      timestampUtc: toIsoUtc(timestampMs),
      bzGsm: getSeriesValue(rows, 'DSCOVR', 'bz_gsm', timestampMs),
      speed: getSeriesValue(rows, 'DSCOVR', 'solar_wind_speed', timestampMs),
      density: getSeriesValue(rows, 'DSCOVR', 'proton_density', timestampMs),
      bTotal: getSeriesValue(rows, 'DSCOVR', 'b_total', timestampMs),
      goesMag: getSeriesValue(rows, 'GOES', 'goes_mag_hn', timestampMs),
      dst: valueAtOrBefore(context.points, 'dst', timestampMs),
      kp: valueAtOrBefore(context.points, 'kp', timestampMs),
    });
  }

  return series;
}

export function buildStormBrowserSnapshot(
  context: ContextIndexSnapshot,
  rows: NormalizedSpaceWeatherRow[],
): StormBrowserSnapshot {
  const events = detectStormEvents(context, rows);
  const selectedEvent = events[0] ?? null;
  const warnings: string[] = [];

  if (context.points.filter(point => point.kind === 'dst').length === 0) {
    warnings.push('Dst context points are unavailable; storm detection cannot run.');
  }

  if (events.length === 0) {
    warnings.push('No Dst < -50 nT event was detected in the available context window.');
  }

  return {
    generatedAtUtc: new Date().toISOString(),
    eventsCatalogPath: 'local://data/events/events_catalog.parquet',
    splitsConfigPath: 'data/splits_config.yaml',
    eventMetricsPath: 'local://data/events/event_metrics.parquet',
    events,
    timeline: buildTimeline(context),
    selectedEventId: selectedEvent?.eventId ?? null,
    selectedEventSeries: buildSelectedEventSeries(selectedEvent, context, rows),
    splitsConfig: {
      version: 'event-splits-v1',
      strategy: 'expanding_walk_forward_with_event_holdout',
      folds: [
        { fold: 1, train: '2010-2014', val: '2015', test: '2016' },
        { fold: 2, train: '2010-2015', val: '2016', test: '2017' },
        { fold: 3, train: '2010-2016', val: '2017', test: '2018' },
      ],
      eventHoldoutIds: events.filter(event => event.intensity === 'extreme').map(event => event.eventId),
    },
    eventMetrics: [],
    warnings,
  };
}
