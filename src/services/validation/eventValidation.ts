/**
 * Validate L1 physical-driver events against the REAL terrestrial response (GOES at GEO
 * and ground geomagnetic indices). This measures RESPONSE CONSISTENCY — whether a hazardous
 * L1 driver was followed by a real GEO/ground response inside the expected window. It is
 * not a causality claim and never refers to satellite anomalies. OMNI is not used.
 */

import type {
  EventSeverity,
  PhysicalDriverEvent,
  PhysicalDriverEventType,
} from '../dataProcessing/eventDetection';
import type { GoesSample, GroundIndexSample } from '../dataSources/types';
import {
  computeGeoResponse,
  computeGroundResponse,
  type GeoResponseMetrics,
  type GroundResponseMetrics,
} from './responseMetrics';
import { computeResponseWindows, type ResponseWindowOptions, type ResponseWindows } from './responseWindows';

export const RESPONSE_THRESHOLDS = {
  kpStorm: 5, // G1+
  kpStrongStorm: 6, // G2+
  dstStormNt: -50,
  geoHpDisturbanceNt: 20,
} as const;

export interface EventValidationRecord {
  eventId: string;
  eventType: PhysicalDriverEventType;
  severity: EventSeverity;
  startUtc: string;
  endUtc: string;
  windows: ResponseWindows;
  geo: GeoResponseMetrics;
  ground: GroundResponseMetrics;
  groundResponseObserved: boolean;
  geoDisturbanceObserved: boolean;
  responseConsistent: boolean;
  /** Whether the event is treated as a geoeffective prediction (for precision/recall). */
  isGeoeffectivePrediction: boolean;
  qualityFlags: string[];
}

/** A simple, interpretable rule for "this driver is expected to be geoeffective". */
export function isGeoeffectivePrediction(event: PhysicalDriverEvent): boolean {
  if (event.eventType === 'compound_geoeffective') return true;
  if (
    (event.eventType === 'southward_imf' || event.eventType === 'high_coupling') &&
    (event.severity === 'strong' || event.severity === 'severe')
  ) {
    return true;
  }
  return false;
}

export function validateEvent(
  event: PhysicalDriverEvent,
  goesSamples: GoesSample[],
  groundSamples: GroundIndexSample[],
  options: ResponseWindowOptions = {},
): EventValidationRecord {
  const windows = computeResponseWindows(event, options);
  const geo = computeGeoResponse(goesSamples, windows);
  const ground = computeGroundResponse(groundSamples, windows);

  const groundResponseObserved =
    (ground.maxKp6h !== null && ground.maxKp6h >= RESPONSE_THRESHOLDS.kpStorm) ||
    (ground.minDst12h !== null && ground.minDst12h <= RESPONSE_THRESHOLDS.dstStormNt);
  const geoDisturbanceObserved =
    geo.maxHpDisturbanceNt !== null && geo.maxHpDisturbanceNt >= RESPONSE_THRESHOLDS.geoHpDisturbanceNt;

  return {
    eventId: event.eventId,
    eventType: event.eventType,
    severity: event.severity,
    startUtc: event.startUtc,
    endUtc: event.endUtc,
    windows,
    geo,
    ground,
    groundResponseObserved,
    geoDisturbanceObserved,
    responseConsistent: groundResponseObserved || geoDisturbanceObserved,
    isGeoeffectivePrediction: isGeoeffectivePrediction(event),
    qualityFlags: [...new Set([...windows.qualityFlags, ...geo.qualityFlags, ...ground.qualityFlags])],
  };
}

export interface FractionSummary {
  count: number;
  total: number;
  fraction: number | null;
}

function fractionWhere(records: EventValidationRecord[], subset: (r: EventValidationRecord) => boolean, hit: (r: EventValidationRecord) => boolean): FractionSummary {
  const pool = records.filter(subset);
  const count = pool.filter(hit).length;
  return { count, total: pool.length, fraction: pool.length > 0 ? count / pool.length : null };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Onset timestamps (ms) where Kp first reaches the storm threshold. */
function detectKpStormOnsets(ground: GroundIndexSample[], threshold: number): number[] {
  const sorted = ground
    .filter(s => s.kp !== null)
    .map(s => ({ timeMs: Date.parse(s.timeUtc), kp: s.kp as number }))
    .filter(s => !Number.isNaN(s.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
  const onsets: number[] = [];
  let inStorm = false;
  for (const point of sorted) {
    const storm = point.kp >= threshold;
    if (storm && !inStorm) onsets.push(point.timeMs);
    inStorm = storm;
  }
  return onsets;
}

export interface ValidationSummary {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  highCouplingFollowedByKp5: FractionSummary;
  severeBzFollowedByKp6: FractionSummary;
  highPdynFollowedByGeoDisturbance: FractionSummary;
  predictionCount: number;
  truePositives: number;
  falsePositives: number;
  precision: number | null;
  recall: number | null;
  falseAlarmRate: number | null;
  missedResponseEvents: number;
  observedStormOnsets: number;
  medianGroundResponseDelayMinutes: number | null;
}

export function summarizeValidation(
  records: EventValidationRecord[],
  groundSamples: GroundIndexSample[],
): ValidationSummary {
  const eventsByType: Record<string, number> = {};
  const eventsBySeverity: Record<string, number> = {};
  for (const record of records) {
    eventsByType[record.eventType] = (eventsByType[record.eventType] ?? 0) + 1;
    eventsBySeverity[record.severity] = (eventsBySeverity[record.severity] ?? 0) + 1;
  }

  const predictions = records.filter(r => r.isGeoeffectivePrediction);
  const truePositives = predictions.filter(r => r.responseConsistent).length;
  const falsePositives = predictions.length - truePositives;
  const precision = predictions.length > 0 ? truePositives / predictions.length : null;
  const falseAlarmRate = predictions.length > 0 ? falsePositives / predictions.length : null;

  // Recall: how many real Kp storms were "caught" by some geoeffective prediction window.
  const stormOnsets = detectKpStormOnsets(groundSamples, RESPONSE_THRESHOLDS.kpStorm);
  let caught = 0;
  for (const onsetMs of stormOnsets) {
    const isCaught = predictions.some(r => {
      const start = Date.parse(r.windows.groundLong.startUtc);
      const end = Date.parse(r.windows.groundLong.endUtc);
      return onsetMs >= start && onsetMs <= end;
    });
    if (isCaught) caught += 1;
  }
  const recall = stormOnsets.length > 0 ? caught / stormOnsets.length : null;

  const responseDelays = records
    .filter(r => r.groundResponseObserved && r.ground.kpResponseDelayMinutes !== null)
    .map(r => r.ground.kpResponseDelayMinutes as number);

  return {
    totalEvents: records.length,
    eventsByType,
    eventsBySeverity,
    highCouplingFollowedByKp5: fractionWhere(
      records,
      r => r.eventType === 'high_coupling',
      r => r.ground.maxKp6h !== null && r.ground.maxKp6h >= RESPONSE_THRESHOLDS.kpStorm,
    ),
    severeBzFollowedByKp6: fractionWhere(
      records,
      r => r.eventType === 'southward_imf' && r.severity === 'severe',
      r => r.ground.maxKp6h !== null && r.ground.maxKp6h >= RESPONSE_THRESHOLDS.kpStrongStorm,
    ),
    highPdynFollowedByGeoDisturbance: fractionWhere(
      records,
      r => r.eventType === 'high_dynamic_pressure',
      r => r.geoDisturbanceObserved,
    ),
    predictionCount: predictions.length,
    truePositives,
    falsePositives,
    precision,
    recall,
    falseAlarmRate,
    missedResponseEvents: stormOnsets.length - caught,
    observedStormOnsets: stormOnsets.length,
    medianGroundResponseDelayMinutes: median(responseDelays),
  };
}

export interface ValidationReport {
  records: EventValidationRecord[];
  summary: ValidationSummary;
}

/** Validate a batch of L1 events against GOES + ground series and summarize. */
export function validatePhysicalDriverEvents(
  events: PhysicalDriverEvent[],
  goesSamples: GoesSample[],
  groundSamples: GroundIndexSample[],
  options: ResponseWindowOptions = {},
): ValidationReport {
  const records = events.map(event => validateEvent(event, goesSamples, groundSamples, options));
  return { records, summary: summarizeValidation(records, groundSamples) };
}

/**
 * Derived G-risk indicator from observed ground response — clearly a PROXY, not an in-situ
 * variable. Mapping follows the NOAA G-scale Kp thresholds (Kp5->G1 ... Kp9->G5).
 */
export function gLevelFromKp(kp: number | null): { level: number; label: string } {
  if (kp === null) return { level: 0, label: 'G0 (none)' };
  if (kp >= 9) return { level: 5, label: 'G5 (extreme)' };
  if (kp >= 8) return { level: 4, label: 'G4 (severe)' };
  if (kp >= 7) return { level: 3, label: 'G3 (strong)' };
  if (kp >= 6) return { level: 2, label: 'G2 (moderate)' };
  if (kp >= 5) return { level: 1, label: 'G1 (minor)' };
  return { level: 0, label: 'G0 (none)' };
}
