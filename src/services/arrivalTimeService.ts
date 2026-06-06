import type { NoaaEphemerisData, NoaaPlasmaData, NoaaServiceResponse } from './noaaSolarWindService';
import type { EarthArrivalEstimate } from '@/types/spaceWeather';

const NOMINAL_L1_DISTANCE_KM = 1_500_000;
const MIN_RELIABLE_L1_DISTANCE_KM = 500_000;
const MAX_RELIABLE_L1_DISTANCE_KM = 2_500_000;

function parseFiniteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function getNoaaEphemerisDistanceKm(ephemeris: NoaaEphemerisData | null) {
  const x = parseFiniteNumber(ephemeris?.x_gse);
  const y = parseFiniteNumber(ephemeris?.y_gse);
  const z = parseFiniteNumber(ephemeris?.z_gse);

  if (x === null || y === null || z === null) {
    return {
      distanceKm: null,
      isReliable: false,
      reason: 'NOAA ephemeris GSE coordinates are incomplete.',
    };
  }

  const distanceKm = Math.sqrt(x * x + y * y + z * z);
  const isReliable = distanceKm >= MIN_RELIABLE_L1_DISTANCE_KM && distanceKm <= MAX_RELIABLE_L1_DISTANCE_KM;

  return {
    distanceKm,
    isReliable,
    reason: isReliable
      ? 'NOAA ephemeris distance is inside the configured L1 reliability window.'
      : `NOAA ephemeris distance is outside the configured ${MIN_RELIABLE_L1_DISTANCE_KM.toLocaleString('en-US')}-${MAX_RELIABLE_L1_DISTANCE_KM.toLocaleString('en-US')} km L1 reliability window.`,
  };
}

export function estimateEarthArrival(
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>,
  noaaEphemerisData: NoaaServiceResponse<NoaaEphemerisData>,
  calculatedAt: Date = new Date(),
): EarthArrivalEstimate {
  const calculatedAtUtc = calculatedAt.toISOString();
  const speedKmS = parseFiniteNumber(noaaPlasmaData.latestData?.speed);
  const speedTimestamp = noaaPlasmaData.latestData?.time_tag ?? null;
  const speedTime = parseTimestamp(speedTimestamp);
  const ephemerisDistance = getNoaaEphemerisDistanceKm(noaaEphemerisData.latestData);

  const baseAssumptions: string[] = [
    'Earth-arrival estimate uses current L1 distance and NOAA solar-wind speed.',
    'Solar-wind speed is taken from the NOAA RTSW plasma feed.',
  ];

  const baseLimitations: string[] = [
    'This is a bulk-flow timing estimate, not a CME, shock, WSA-Enlil, or geomagnetic forecast.',
    'The calculation assumes the measured L1 solar-wind speed remains representative over the L1-to-Earth path.',
    'No uncertainty propagation, magnetic connectivity modelling, or magnetospheric response modelling is included.',
  ];

  if (speedKmS === null || speedKmS <= 0) {
    return {
      isAvailable: false,
      speedKmS,
      speedTimestamp,
      distanceKm: ephemerisDistance.isReliable ? ephemerisDistance.distanceKm : NOMINAL_L1_DISTANCE_KM,
      distanceSource: ephemerisDistance.isReliable ? 'noaa_ephemeris' : 'nominal_l1',
      distanceSourceLabel: ephemerisDistance.isReliable ? 'NOAA ephemeris distance' : 'Nominal Sun-Earth L1 distance',
      distanceIsAssumption: !ephemerisDistance.isReliable,
      travelTimeSeconds: null,
      travelTimeMinutes: null,
      travelTimeHours: null,
      estimatedArrivalUtc: null,
      calculatedAtUtc,
      confidence: 'UNAVAILABLE',
      assumptions: ephemerisDistance.isReliable
        ? baseAssumptions
        : [...baseAssumptions, `Nominal L1 distance ${NOMINAL_L1_DISTANCE_KM.toLocaleString('en-US')} km would be used if speed were available.`],
      limitations: ['Solar-wind speed is required for arrival-time estimation.', ...baseLimitations],
    };
  }

  const distanceKm = ephemerisDistance.isReliable && ephemerisDistance.distanceKm !== null
    ? ephemerisDistance.distanceKm
    : NOMINAL_L1_DISTANCE_KM;
  const travelTimeSeconds = distanceKm / speedKmS;
  const travelTimeMinutes = travelTimeSeconds / 60;
  const travelTimeHours = travelTimeMinutes / 60;
  const originTime = speedTime ?? calculatedAt;
  const estimatedArrivalUtc = new Date(originTime.getTime() + travelTimeSeconds * 1000).toISOString();

  const assumptions = ephemerisDistance.isReliable
    ? [
        ...baseAssumptions,
        'Distance is derived from the Euclidean magnitude of NOAA RTSW GSE spacecraft coordinates.',
        ephemerisDistance.reason,
      ]
    : [
        ...baseAssumptions,
        `Nominal Sun-Earth L1 distance ${NOMINAL_L1_DISTANCE_KM.toLocaleString('en-US')} km is used because reliable NOAA ephemeris distance is unavailable.`,
        ephemerisDistance.reason,
      ];

  if (!speedTime) {
    assumptions.push('NOAA plasma timestamp is unavailable or invalid; dashboard calculation time is used as the timing origin.');
  }

  return {
    isAvailable: true,
    speedKmS,
    speedTimestamp,
    distanceKm,
    distanceSource: ephemerisDistance.isReliable ? 'noaa_ephemeris' : 'nominal_l1',
    distanceSourceLabel: ephemerisDistance.isReliable ? 'NOAA ephemeris distance' : 'Nominal Sun-Earth L1 distance',
    distanceIsAssumption: !ephemerisDistance.isReliable,
    travelTimeSeconds,
    travelTimeMinutes,
    travelTimeHours,
    estimatedArrivalUtc,
    calculatedAtUtc,
    confidence: 'PARTIAL',
    assumptions,
    limitations: baseLimitations,
  };
}
