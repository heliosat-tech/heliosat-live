/**
 * Terrestrial response windows for a detected L1 physical-driver event (no OMNI).
 *
 * The driver is measured at L1; its terrestrial effect is expected after a ballistic
 * propagation delay plus a magnetospheric/ground response lag. We therefore express the
 * expected response as WINDOWS (not single instants), anchored on the event's estimated
 * arrival time. If no arrival estimate exists, we fall back to detection time + a nominal
 * ballistic delay and flag it.
 */

import type { PhysicalDriverEvent } from '../dataProcessing/eventDetection';
import { NOMINAL_L1_DISTANCE_KM } from '../dataSources/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface ResponseWindow {
  startUtc: string;
  endUtc: string;
}

export interface ResponseWindows {
  arrivalUtc: string;
  arrivalBasis: 'event_estimate' | 'detection_plus_nominal';
  /** Arrival +/- 30 min — short window around the expected impact. */
  short: ResponseWindow;
  /** Arrival .. +3 h — GEO magnetometer response. */
  geoMagnetic: ResponseWindow;
  /** Arrival .. +24 h — particle/radiation response at GEO. */
  particle: ResponseWindow;
  /** Arrival .. +6 h — short ground geomagnetic response. */
  groundShort: ResponseWindow;
  /** Arrival .. +12 h — extended ground geomagnetic response. */
  groundLong: ResponseWindow;
  qualityFlags: string[];
}

export interface ResponseWindowOptions {
  /** Used when the event has no arrival estimate (nominal speed assumption). */
  nominalSpeedKmS?: number;
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

export function computeResponseWindows(
  event: PhysicalDriverEvent,
  options: ResponseWindowOptions = {},
): ResponseWindows {
  const qualityFlags: string[] = [];
  const arrivalStart = event.estimatedResponseWindow.arrivalStartUtc;

  let arrivalMs: number;
  let arrivalBasis: ResponseWindows['arrivalBasis'];

  if (arrivalStart) {
    arrivalMs = Date.parse(arrivalStart);
    arrivalBasis = 'event_estimate';
  } else {
    const detectionMs = Date.parse(event.startUtc);
    const nominalSpeed = options.nominalSpeedKmS ?? 450;
    const nominalDelayMinutes = NOMINAL_L1_DISTANCE_KM / nominalSpeed / 60;
    arrivalMs = detectionMs + nominalDelayMinutes * MINUTE_MS;
    arrivalBasis = 'detection_plus_nominal';
    qualityFlags.push('arrival_estimated_from_detection');
  }

  if (event.estimatedResponseWindow.basis === 'nominal') {
    qualityFlags.push('nominal_l1_distance');
  }

  return {
    arrivalUtc: iso(arrivalMs),
    arrivalBasis,
    short: { startUtc: iso(arrivalMs - 30 * MINUTE_MS), endUtc: iso(arrivalMs + 30 * MINUTE_MS) },
    geoMagnetic: { startUtc: iso(arrivalMs), endUtc: iso(arrivalMs + 3 * HOUR_MS) },
    particle: { startUtc: iso(arrivalMs), endUtc: iso(arrivalMs + 24 * HOUR_MS) },
    groundShort: { startUtc: iso(arrivalMs), endUtc: iso(arrivalMs + 6 * HOUR_MS) },
    groundLong: { startUtc: iso(arrivalMs), endUtc: iso(arrivalMs + 12 * HOUR_MS) },
    qualityFlags,
  };
}
