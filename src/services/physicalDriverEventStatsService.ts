const MINUTE = 60 * 1000;
const DEFAULT_CADENCE_MS = 60 * MINUTE;
const PROTON_DYNAMIC_PRESSURE = 1.6726e-6;

export interface PhysicalDriverInputSample {
  t: number;
  level?: number;
  riskAvailable?: boolean;
  detectedMs?: number | null;
  leadTimeMinutes?: number | null;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
}

export interface PhysicalDriverDerivedSample extends PhysicalDriverInputSample {
  pdynNpa: number | null;
  emMvM: number | null;
  speedDeltaKmS: number | null;
  dtMinutes: number;
}

export interface DetectIntervalsOptions {
  minDurationMinutes?: number;
  gapToleranceSamples?: number;
  cadenceMs?: number;
  clipEndMs?: number;
}

export interface DriverInterval {
  startMs: number;
  endMs: number;
  durationMinutes: number;
  maxVsw: number | null;
  minBz: number | null;
  maxBt: number | null;
  maxNp: number | null;
  maxPdyn: number | null;
  maxEm: number | null;
  integratedSouthwardBzNtMin: number;
  integratedEmMvMMin: number;
  sampleCount: number;
}

export interface DriverIntervalSummary {
  start_time: string;
  end_time: string;
  duration_minutes: number;
  peak_value: number | null;
  max_vsw: number | null;
  min_bz: number | null;
  max_bt: number | null;
  max_np: number | null;
  max_pdyn: number | null;
  max_em: number | null;
  integrated_southward_bz_nt_min: number;
  integrated_em_mvm_min: number;
  sample_count: number;
}

export interface DriverThresholdStats {
  id: string;
  event_type: string;
  threshold: string;
  unit: string;
  count: number;
  total_duration_minutes: number;
  longest_interval_minutes: number;
  peak_value: number | null;
  peak_kind: 'maximum' | 'minimum';
  integrated_value_minutes: number | null;
  first_occurrence: string | null;
  last_occurrence: string | null;
  strongest_event: DriverIntervalSummary | null;
}

export interface CompoundDriverStats {
  id: string;
  event_type: string;
  threshold: string;
  count: number;
  total_duration_minutes: number;
  longest_interval_minutes: number;
  peak_drivers: {
    max_vsw: number | null;
    min_bz: number | null;
    max_bt: number | null;
    max_np: number | null;
    max_pdyn: number | null;
    max_em: number | null;
  };
  strongest_event: DriverIntervalSummary | null;
  strongest_event_summary: string | null;
}

export interface PhysicalDriverOccurrenceStrip {
  id: string;
  label: string;
  color: string;
  intervals: Array<{ start_ms: number; end_ms: number; level: number }>;
}

export interface PhysicalDriverEventStatsResponse {
  generated_at: string;
  window: string;
  start_ms: number;
  end_ms: number;
  source: 'propagated_l1_samples';
  target: 'earth_bow_shock_nose';
  sample_count: number;
  cadence_minutes: number;
  stats: {
    speed: DriverThresholdStats[];
    bz: DriverThresholdStats[];
    bt: DriverThresholdStats[];
    density: DriverThresholdStats[];
    pdyn: DriverThresholdStats[];
    em: DriverThresholdStats[];
    compound: CompoundDriverStats[];
  };
  summary: {
    strongest_southward_bz: DriverIntervalSummary | null;
    strongest_high_speed: DriverIntervalSummary | null;
    strongest_pressure: DriverIntervalSummary | null;
    strongest_coupling: DriverIntervalSummary | null;
    total_hazardous_minutes: number;
  };
  occurrence_strips: PhysicalDriverOccurrenceStrip[];
  limitations: string[];
}

interface ThresholdDefinition {
  id: string;
  label: string;
  threshold: string;
  unit: string;
  peakKey: keyof Pick<DriverInterval, 'maxVsw' | 'minBz' | 'maxBt' | 'maxNp' | 'maxPdyn' | 'maxEm'>;
  peakKind: 'maximum' | 'minimum';
  integratedKey?: keyof Pick<DriverInterval, 'integratedSouthwardBzNtMin' | 'integratedEmMvMMin'>;
  predicate: (sample: PhysicalDriverDerivedSample) => boolean;
}

const round = (value: number, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const maxOrNull = (values: Array<number | null | undefined>) => {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return xs.length ? Math.max(...xs) : null;
};

const minOrNull = (values: Array<number | null | undefined>) => {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return xs.length ? Math.min(...xs) : null;
};

export function computeDynamicPressureNpa(speedKmS: number | null, densityPerCm3: number | null): number | null {
  const speed = finite(speedKmS);
  const density = finite(densityPerCm3);
  if (speed === null || density === null || speed < 0 || density < 0) return null;
  return PROTON_DYNAMIC_PRESSURE * density * speed * speed;
}

export function computeCouplingElectricFieldMvM(speedKmS: number | null, bzNt: number | null): number | null {
  const speed = finite(speedKmS);
  const bz = finite(bzNt);
  if (speed === null || bz === null || speed < 0) return null;
  return speed * Math.max(0, -bz) * 1e-3;
}

export function classifyBzRiskRank(bzNt: number | null): number {
  const bz = finite(bzNt);
  if (bz === null) return -1;
  if (bz >= 0) return 0;
  if (bz > -5) return 1;
  if (bz > -10) return 2;
  if (bz > -20) return 3;
  return 4;
}

export function estimateSampleCadenceMs(samples: Array<{ t: number }>): number {
  const diffs: number[] = [];
  const sorted = samples.slice().sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i += 1) {
    const diff = sorted[i].t - sorted[i - 1].t;
    if (Number.isFinite(diff) && diff >= 10_000 && diff <= 12 * 60 * MINUTE) diffs.push(diff);
  }
  if (diffs.length === 0) return DEFAULT_CADENCE_MS;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] ?? DEFAULT_CADENCE_MS;
}

export function computeDerivedFeatures(samples: PhysicalDriverInputSample[]): PhysicalDriverDerivedSample[] {
  const sorted = samples.slice().sort((a, b) => a.t - b.t);
  const cadenceMs = estimateSampleCadenceMs(sorted);
  let previousSpeed: number | null = null;

  return sorted.map((sample, index) => {
    const next = sorted[index + 1];
    const nextDiff = next ? next.t - sample.t : cadenceMs;
    const dtMs = Number.isFinite(nextDiff) && nextDiff > 0 && nextDiff <= cadenceMs * 4 ? nextDiff : cadenceMs;
    const speed = finite(sample.speedKmS);
    const speedDeltaKmS = speed !== null && previousSpeed !== null ? speed - previousSpeed : null;
    if (speed !== null) previousSpeed = speed;
    return {
      ...sample,
      pdynNpa: computeDynamicPressureNpa(sample.speedKmS, sample.densityPerCm3),
      emMvM: computeCouplingElectricFieldMvM(sample.speedKmS, sample.bzNt),
      speedDeltaKmS,
      dtMinutes: dtMs / MINUTE,
    };
  });
}

function summarizeInterval(
  allSamples: PhysicalDriverDerivedSample[],
  trueSamples: PhysicalDriverDerivedSample[],
  startIndex: number,
  lastTrueIndex: number,
  cadenceMs: number,
  clipEndMs?: number,
): DriverInterval {
  const startMs = allSamples[startIndex].t;
  const rawEndMs = allSamples[lastTrueIndex].t + cadenceMs;
  const endMs = clipEndMs === undefined ? rawEndMs : Math.min(rawEndMs, clipEndMs);
  return {
    startMs,
    endMs,
    durationMinutes: Math.max(cadenceMs / MINUTE, (endMs - startMs) / MINUTE),
    maxVsw: maxOrNull(trueSamples.map(s => s.speedKmS)),
    minBz: minOrNull(trueSamples.map(s => s.bzNt)),
    maxBt: maxOrNull(trueSamples.map(s => s.btNt)),
    maxNp: maxOrNull(trueSamples.map(s => s.densityPerCm3)),
    maxPdyn: maxOrNull(trueSamples.map(s => s.pdynNpa)),
    maxEm: maxOrNull(trueSamples.map(s => s.emMvM)),
    integratedSouthwardBzNtMin: trueSamples.reduce((sum, s) => sum + Math.max(0, -(s.bzNt ?? 0)) * s.dtMinutes, 0),
    integratedEmMvMMin: trueSamples.reduce((sum, s) => sum + (s.emMvM ?? 0) * s.dtMinutes, 0),
    sampleCount: trueSamples.length,
  };
}

export function detectIntervals(
  samples: PhysicalDriverDerivedSample[],
  predicate: (sample: PhysicalDriverDerivedSample) => boolean,
  options: DetectIntervalsOptions = {},
): DriverInterval[] {
  const sorted = samples.slice().sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];

  const cadenceMs = options.cadenceMs ?? estimateSampleCadenceMs(sorted);
  const gapToleranceSamples = options.gapToleranceSamples ?? 2;
  const maxTrueGapMs = cadenceMs * (gapToleranceSamples + 1.5);
  const minDurationMinutes = options.minDurationMinutes ?? 0;
  const intervals: DriverInterval[] = [];

  let startIndex: number | null = null;
  let lastTrueIndex: number | null = null;
  let trueSamples: PhysicalDriverDerivedSample[] = [];

  const close = () => {
    if (startIndex === null || lastTrueIndex === null || trueSamples.length === 0) return;
    const interval = summarizeInterval(sorted, trueSamples, startIndex, lastTrueIndex, cadenceMs, options.clipEndMs);
    if (interval.durationMinutes >= minDurationMinutes) intervals.push(interval);
    startIndex = null;
    lastTrueIndex = null;
    trueSamples = [];
  };

  for (let i = 0; i < sorted.length; i += 1) {
    const sample = sorted[i];
    if (!predicate(sample)) continue;

    if (lastTrueIndex !== null && sample.t - sorted[lastTrueIndex].t > maxTrueGapMs) {
      close();
    }
    if (startIndex === null) startIndex = i;
    lastTrueIndex = i;
    trueSamples.push(sample);
  }
  close();

  return intervals;
}

function intervalPeak(interval: DriverInterval, key: ThresholdDefinition['peakKey']): number | null {
  return interval[key];
}

function chooseStrongest(intervals: DriverInterval[], key: ThresholdDefinition['peakKey'], kind: 'maximum' | 'minimum'): DriverInterval | null {
  let best: DriverInterval | null = null;
  for (const interval of intervals) {
    const value = intervalPeak(interval, key);
    if (value === null) continue;
    if (!best) {
      best = interval;
      continue;
    }
    const bestValue = intervalPeak(best, key);
    if (bestValue === null || (kind === 'maximum' ? value > bestValue : value < bestValue)) best = interval;
  }
  return best ?? intervals[0] ?? null;
}

function intervalToSummary(interval: DriverInterval, peakKey: ThresholdDefinition['peakKey'] = 'maxEm'): DriverIntervalSummary {
  return {
    start_time: new Date(interval.startMs).toISOString(),
    end_time: new Date(interval.endMs).toISOString(),
    duration_minutes: round(interval.durationMinutes),
    peak_value: intervalPeak(interval, peakKey) === null ? null : round(intervalPeak(interval, peakKey)!, 2),
    max_vsw: interval.maxVsw === null ? null : round(interval.maxVsw),
    min_bz: interval.minBz === null ? null : round(interval.minBz),
    max_bt: interval.maxBt === null ? null : round(interval.maxBt),
    max_np: interval.maxNp === null ? null : round(interval.maxNp),
    max_pdyn: interval.maxPdyn === null ? null : round(interval.maxPdyn, 2),
    max_em: interval.maxEm === null ? null : round(interval.maxEm, 2),
    integrated_southward_bz_nt_min: round(interval.integratedSouthwardBzNtMin),
    integrated_em_mvm_min: round(interval.integratedEmMvMMin),
    sample_count: interval.sampleCount,
  };
}

function buildThresholdStats(samples: PhysicalDriverDerivedSample[], def: ThresholdDefinition, detectOptions: DetectIntervalsOptions): DriverThresholdStats {
  const intervals = detectIntervals(samples, def.predicate, { gapToleranceSamples: 2, ...detectOptions });
  const strongest = chooseStrongest(intervals, def.peakKey, def.peakKind);
  const peakValues = intervals.map(interval => intervalPeak(interval, def.peakKey)).filter((v): v is number => v !== null);
  const peakValue = peakValues.length === 0
    ? null
    : def.peakKind === 'maximum'
      ? Math.max(...peakValues)
      : Math.min(...peakValues);
  const integrated = def.integratedKey ? intervals.reduce((sum, interval) => sum + interval[def.integratedKey!], 0) : null;

  return {
    id: def.id,
    event_type: def.label,
    threshold: def.threshold,
    unit: def.unit,
    count: intervals.length,
    total_duration_minutes: round(intervals.reduce((sum, interval) => sum + interval.durationMinutes, 0)),
    longest_interval_minutes: round(Math.max(0, ...intervals.map(interval => interval.durationMinutes))),
    peak_value: peakValue === null ? null : round(peakValue, 2),
    peak_kind: def.peakKind,
    integrated_value_minutes: integrated === null ? null : round(integrated),
    first_occurrence: intervals[0] ? new Date(intervals[0].startMs).toISOString() : null,
    last_occurrence: intervals[intervals.length - 1] ? new Date(intervals[intervals.length - 1].endMs).toISOString() : null,
    strongest_event: strongest ? intervalToSummary(strongest, def.peakKey) : null,
  };
}

function strongestByMax(intervals: DriverInterval[], key: Exclude<ThresholdDefinition['peakKey'], 'minBz'>): DriverInterval | null {
  return chooseStrongest(intervals, key, 'maximum');
}

function strongestByMinBz(intervals: DriverInterval[]): DriverInterval | null {
  return chooseStrongest(intervals, 'minBz', 'minimum');
}

function compoundSummary(id: string, eventType: string, threshold: string, intervals: DriverInterval[], strongest: DriverInterval | null): CompoundDriverStats {
  const peakDrivers = intervals.reduce<CompoundDriverStats['peak_drivers']>((acc, interval) => ({
    max_vsw: maxOrNull([acc.max_vsw, interval.maxVsw]),
    min_bz: minOrNull([acc.min_bz, interval.minBz]),
    max_bt: maxOrNull([acc.max_bt, interval.maxBt]),
    max_np: maxOrNull([acc.max_np, interval.maxNp]),
    max_pdyn: maxOrNull([acc.max_pdyn, interval.maxPdyn]),
    max_em: maxOrNull([acc.max_em, interval.maxEm]),
  }), { max_vsw: null, min_bz: null, max_bt: null, max_np: null, max_pdyn: null, max_em: null });
  const strongestSummary = strongest ? intervalToSummary(strongest, id.includes('southward') ? 'minBz' : 'maxEm') : null;

  return {
    id,
    event_type: eventType,
    threshold,
    count: intervals.length,
    total_duration_minutes: round(intervals.reduce((sum, interval) => sum + interval.durationMinutes, 0)),
    longest_interval_minutes: round(Math.max(0, ...intervals.map(interval => interval.durationMinutes))),
    peak_drivers: {
      max_vsw: peakDrivers.max_vsw === null ? null : round(peakDrivers.max_vsw),
      min_bz: peakDrivers.min_bz === null ? null : round(peakDrivers.min_bz),
      max_bt: peakDrivers.max_bt === null ? null : round(peakDrivers.max_bt),
      max_np: peakDrivers.max_np === null ? null : round(peakDrivers.max_np),
      max_pdyn: peakDrivers.max_pdyn === null ? null : round(peakDrivers.max_pdyn, 2),
      max_em: peakDrivers.max_em === null ? null : round(peakDrivers.max_em, 2),
    },
    strongest_event: strongestSummary,
    strongest_event_summary: strongestSummary
      ? `${strongestSummary.start_time} to ${strongestSummary.end_time}; Vsw ${strongestSummary.max_vsw ?? 'NA'} km/s, Bz ${strongestSummary.min_bz ?? 'NA'} nT, Em ${strongestSummary.max_em ?? 'NA'} mV/m`
      : null,
  };
}

function stripIntervals(intervals: DriverInterval[], level: number) {
  return intervals.slice(0, 600).map(interval => ({ start_ms: interval.startMs, end_ms: interval.endMs, level }));
}

function totalUnionMinutes(intervals: DriverInterval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.slice().sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let start = sorted[0].startMs;
  let end = sorted[0].endMs;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].startMs <= end) {
      end = Math.max(end, sorted[i].endMs);
    } else {
      total += (end - start) / MINUTE;
      start = sorted[i].startMs;
      end = sorted[i].endMs;
    }
  }
  total += (end - start) / MINUTE;
  return round(total);
}

const speedDefs: ThresholdDefinition[] = [
  { id: 'speed_moderate', label: 'Vsw moderate', threshold: 'Vsw >= 400 km/s', unit: 'km/s', peakKey: 'maxVsw', peakKind: 'maximum', predicate: s => (s.speedKmS ?? -Infinity) >= 400 },
  { id: 'speed_elevated', label: 'Vsw elevated', threshold: 'Vsw >= 550 km/s', unit: 'km/s', peakKey: 'maxVsw', peakKind: 'maximum', predicate: s => (s.speedKmS ?? -Infinity) >= 550 },
  { id: 'speed_high', label: 'Vsw high', threshold: 'Vsw >= 700 km/s', unit: 'km/s', peakKey: 'maxVsw', peakKind: 'maximum', predicate: s => (s.speedKmS ?? -Infinity) >= 700 },
];

const bzDefs: ThresholdDefinition[] = [
  { id: 'bz_weak_southward', label: 'Bz weak southward', threshold: 'Bz < 0 nT', unit: 'nT', peakKey: 'minBz', peakKind: 'minimum', integratedKey: 'integratedSouthwardBzNtMin', predicate: s => s.bzNt !== null && s.bzNt < 0 },
  { id: 'bz_moderate_southward', label: 'Bz moderate southward', threshold: 'Bz <= -5 nT', unit: 'nT', peakKey: 'minBz', peakKind: 'minimum', integratedKey: 'integratedSouthwardBzNtMin', predicate: s => s.bzNt !== null && s.bzNt <= -5 },
  { id: 'bz_strong_southward', label: 'Bz strong southward', threshold: 'Bz <= -10 nT', unit: 'nT', peakKey: 'minBz', peakKind: 'minimum', integratedKey: 'integratedSouthwardBzNtMin', predicate: s => s.bzNt !== null && s.bzNt <= -10 },
  { id: 'bz_severe_southward', label: 'Bz severe southward', threshold: 'Bz <= -20 nT', unit: 'nT', peakKey: 'minBz', peakKind: 'minimum', integratedKey: 'integratedSouthwardBzNtMin', predicate: s => s.bzNt !== null && s.bzNt <= -20 },
];

const btDefs: ThresholdDefinition[] = [
  { id: 'bt_moderate', label: '|B| moderate', threshold: '|B| >= 5 nT', unit: 'nT', peakKey: 'maxBt', peakKind: 'maximum', predicate: s => (s.btNt ?? -Infinity) >= 5 },
  { id: 'bt_elevated', label: '|B| elevated', threshold: '|B| >= 10 nT', unit: 'nT', peakKey: 'maxBt', peakKind: 'maximum', predicate: s => (s.btNt ?? -Infinity) >= 10 },
  { id: 'bt_high', label: '|B| high', threshold: '|B| >= 20 nT', unit: 'nT', peakKey: 'maxBt', peakKind: 'maximum', predicate: s => (s.btNt ?? -Infinity) >= 20 },
];

const densityDefs: ThresholdDefinition[] = [
  { id: 'density_moderate', label: 'np moderate', threshold: 'np >= 5 cm^-3', unit: 'cm^-3', peakKey: 'maxNp', peakKind: 'maximum', predicate: s => (s.densityPerCm3 ?? -Infinity) >= 5 },
  { id: 'density_elevated', label: 'np elevated', threshold: 'np >= 10 cm^-3', unit: 'cm^-3', peakKey: 'maxNp', peakKind: 'maximum', predicate: s => (s.densityPerCm3 ?? -Infinity) >= 10 },
  { id: 'density_high', label: 'np high', threshold: 'np >= 30 cm^-3', unit: 'cm^-3', peakKey: 'maxNp', peakKind: 'maximum', predicate: s => (s.densityPerCm3 ?? -Infinity) >= 30 },
];

const pdynDefs: ThresholdDefinition[] = [
  { id: 'pdyn_moderate', label: 'Pdyn moderate', threshold: 'Pdyn >= 2 nPa', unit: 'nPa', peakKey: 'maxPdyn', peakKind: 'maximum', predicate: s => (s.pdynNpa ?? -Infinity) >= 2 },
  { id: 'pdyn_elevated', label: 'Pdyn elevated', threshold: 'Pdyn >= 5 nPa', unit: 'nPa', peakKey: 'maxPdyn', peakKind: 'maximum', predicate: s => (s.pdynNpa ?? -Infinity) >= 5 },
  { id: 'pdyn_high', label: 'Pdyn high', threshold: 'Pdyn >= 10 nPa', unit: 'nPa', peakKey: 'maxPdyn', peakKind: 'maximum', predicate: s => (s.pdynNpa ?? -Infinity) >= 10 },
];

const emDefs: ThresholdDefinition[] = [
  { id: 'em_moderate', label: 'Em moderate', threshold: 'Em >= 2 mV/m', unit: 'mV/m', peakKey: 'maxEm', peakKind: 'maximum', integratedKey: 'integratedEmMvMMin', predicate: s => (s.emMvM ?? -Infinity) >= 2 },
  { id: 'em_elevated', label: 'Em elevated', threshold: 'Em >= 5 mV/m', unit: 'mV/m', peakKey: 'maxEm', peakKind: 'maximum', integratedKey: 'integratedEmMvMMin', predicate: s => (s.emMvM ?? -Infinity) >= 5 },
  { id: 'em_high', label: 'Em high', threshold: 'Em >= 8 mV/m', unit: 'mV/m', peakKey: 'maxEm', peakKind: 'maximum', integratedKey: 'integratedEmMvMMin', predicate: s => (s.emMvM ?? -Infinity) >= 8 },
  { id: 'em_severe', label: 'Em severe', threshold: 'Em >= 12 mV/m', unit: 'mV/m', peakKey: 'maxEm', peakKind: 'maximum', integratedKey: 'integratedEmMvMMin', predicate: s => (s.emMvM ?? -Infinity) >= 12 },
];

export function computePhysicalDriverEventStats(
  samples: PhysicalDriverInputSample[],
  options: { window: string; startMs: number; endMs: number; generatedAtMs?: number },
): PhysicalDriverEventStatsResponse {
  const derived = computeDerivedFeatures(samples).filter(sample => sample.t >= options.startMs && sample.t <= options.endMs);
  const cadenceMs = estimateSampleCadenceMs(derived);
  const detectOptions: DetectIntervalsOptions = { cadenceMs, clipEndMs: options.endMs };

  const speed = speedDefs.map(def => buildThresholdStats(derived, def, detectOptions));
  const bz = bzDefs.map(def => buildThresholdStats(derived, def, detectOptions));
  const bt = btDefs.map(def => buildThresholdStats(derived, def, detectOptions));
  const density = densityDefs.map(def => buildThresholdStats(derived, def, detectOptions));
  const pdyn = pdynDefs.map(def => buildThresholdStats(derived, def, detectOptions));
  const em = emDefs.map(def => buildThresholdStats(derived, def, detectOptions));

  const geoeffectiveSouthward = detectIntervals(
    derived,
    s => s.bzNt !== null && s.bzNt <= -10 && s.speedKmS !== null && s.speedKmS >= 500,
    { minDurationMinutes: 10, gapToleranceSamples: 2, ...detectOptions },
  );
  const pressureCompression = detectIntervals(
    derived,
    s => (s.pdynNpa !== null && s.pdynNpa >= 5) || (s.densityPerCm3 !== null && s.densityPerCm3 >= 10 && (s.speedDeltaKmS ?? 0) > 0),
    { gapToleranceSamples: 2, ...detectOptions },
  );
  const highCoupling = detectIntervals(
    derived,
    s => s.emMvM !== null && s.emMvM >= 5,
    { minDurationMinutes: 10, gapToleranceSamples: 2, ...detectOptions },
  );
  const severeCoupling = detectIntervals(
    derived,
    s => s.emMvM !== null && s.emMvM >= 8,
    { minDurationMinutes: 10, gapToleranceSamples: 2, ...detectOptions },
  );

  const compound: CompoundDriverStats[] = [
    compoundSummary('compound_geoeffective_southward', 'Compound geoeffective southward interval', 'Bz <= -10 nT AND Vsw >= 500 km/s for at least 10 min', geoeffectiveSouthward, strongestByMinBz(geoeffectiveSouthward)),
    compoundSummary('compound_pressure_compression', 'Compound pressure compression interval', 'Pdyn >= 5 nPa OR np >= 10 cm^-3 with increasing Vsw', pressureCompression, strongestByMax(pressureCompression, 'maxPdyn')),
    compoundSummary('compound_high_coupling', 'Compound high-coupling interval', 'Em >= 5 mV/m for at least 10 min', highCoupling, strongestByMax(highCoupling, 'maxEm')),
    compoundSummary('compound_severe_coupling', 'Compound severe-coupling interval', 'Em >= 8 mV/m for at least 10 min', severeCoupling, strongestByMax(severeCoupling, 'maxEm')),
  ];

  const strongestSouthward = bz.find(row => row.id === 'bz_weak_southward')?.strongest_event ?? null;
  const strongestHighSpeed = speed.find(row => row.id === 'speed_moderate')?.strongest_event ?? null;
  const strongestPressure = pdyn.find(row => row.id === 'pdyn_moderate')?.strongest_event ?? null;
  const strongestCoupling = em.find(row => row.id === 'em_moderate')?.strongest_event ?? null;
  const hazardousIntervals = [
    ...detectIntervals(derived, s => (s.speedKmS ?? -Infinity) >= 550, detectOptions),
    ...detectIntervals(derived, s => s.bzNt !== null && s.bzNt <= -5, detectOptions),
    ...detectIntervals(derived, s => (s.btNt ?? -Infinity) >= 10, detectOptions),
    ...detectIntervals(derived, s => (s.densityPerCm3 ?? -Infinity) >= 10, detectOptions),
    ...detectIntervals(derived, s => (s.pdynNpa ?? -Infinity) >= 5, detectOptions),
    ...detectIntervals(derived, s => (s.emMvM ?? -Infinity) >= 5, detectOptions),
  ];

  return {
    generated_at: new Date(options.generatedAtMs ?? Date.now()).toISOString(),
    window: options.window,
    start_ms: options.startMs,
    end_ms: options.endMs,
    source: 'propagated_l1_samples',
    target: 'earth_bow_shock_nose',
    sample_count: derived.length,
    cadence_minutes: round(cadenceMs / MINUTE),
    stats: { speed, bz, bt, density, pdyn, em, compound },
    summary: {
      strongest_southward_bz: strongestSouthward,
      strongest_high_speed: strongestHighSpeed,
      strongest_pressure: strongestPressure,
      strongest_coupling: strongestCoupling,
      total_hazardous_minutes: totalUnionMinutes(hazardousIntervals),
    },
    occurrence_strips: [
      { id: 'speed_elevated', label: 'Vsw elevated/high', color: '#fbbf24', intervals: stripIntervals(detectIntervals(derived, speedDefs[1].predicate, detectOptions), 2) },
      { id: 'bz_strong_southward', label: 'Bz strong southward', color: '#fb923c', intervals: stripIntervals(detectIntervals(derived, bzDefs[2].predicate, detectOptions), 3) },
      { id: 'pdyn_elevated', label: 'Pdyn elevated/high', color: '#a78bfa', intervals: stripIntervals(detectIntervals(derived, pdynDefs[1].predicate, detectOptions), 2) },
      { id: 'em_elevated', label: 'Em elevated/severe', color: '#f87171', intervals: stripIntervals(detectIntervals(derived, emDefs[1].predicate, detectOptions), 3) },
      { id: 'compound_high_coupling', label: 'Compound coupling', color: '#e879f9', intervals: stripIntervals(highCoupling, 4) },
    ],
    limitations: [
      'Counts physical-driver intervals, not guaranteed spacecraft anomalies.',
      'G-level is a derived risk indicator, not the primary validation target.',
      'Samples are physical in-situ variables measured at L1 and shifted to estimated Earth bow-shock nose arrival time.',
    ],
  };
}
