export interface HistoricPlotRange {
  startUtc: string;
  stopUtc: string;
}

export interface HistoricPlotPoint {
  time_tag: string;
  value: string | number | null;
}

export interface HistoricPlotChart {
  id: string;
  sourceId: string;
  spacecraftName: string;
  source: string;
  title: string;
  unit: string;
  color: string;
  lastSampleTime: string | null;
  data: HistoricPlotPoint[];
}

export type HistoricOrbitFrame = 'GSE' | 'GEO nominal';
export type HistoricOrbitRegime = 'L1' | 'GEO';

export interface HistoricOrbitTrackPoint {
  time_tag: string;
  xKm: number;
  yKm: number;
  zKm: number;
  distanceKm: number;
  heightKm: number;
  sunAxisAngleDeg: number;
  longitudeDeg: number | null;
}

export interface HistoricOrbitTrack {
  id: string;
  sourceId: string;
  spacecraftName: string;
  source: string;
  frame: HistoricOrbitFrame;
  orbitRegime: HistoricOrbitRegime;
  color: string;
  points: HistoricOrbitTrackPoint[];
  note: string;
}

export interface HistoricPlotsSnapshot {
  generatedAtUtc: string;
  range: HistoricPlotRange;
  requestedSourceIds: string[];
  charts: HistoricPlotChart[];
  orbitTracks: HistoricOrbitTrack[];
  warnings: string[];
  unsupportedSourceIds: string[];
}

interface HapiInfoResponse {
  startDate?: string;
  stopDate?: string;
  status?: {
    code: number;
    message: string;
  };
}

interface HapiDataResponse {
  data?: unknown[][];
  status?: {
    code: number;
    message: string;
  };
}

export interface HapiSeriesResult {
  rows: unknown[][];
  warnings: string[];
}

interface GoesScalarPoint {
  time_tag?: string;
  satellite?: number | string;
  flux?: number | string | null;
  energy?: string;
}

interface GoesMagPoint extends GoesScalarPoint {
  He?: number | string | null;
  Hp?: number | string | null;
  Hn?: number | string | null;
  total?: number | string | null;
}

type GoesRole = 'primary' | 'secondary';

interface SscOrbitRequest {
  observatoryId: string;
  spacecraftName: string;
  sourceId: string;
  source: string;
  color: string;
  orbitRegime: HistoricOrbitRegime;
  note: string;
}

const HAPI_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/hapi';
const SSC_BASE_URL = 'https://sscweb.gsfc.nasa.gov/WS/sscr/2';
const SWPC_GOES_BASE_URL = 'https://services.swpc.noaa.gov/json/goes';
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 350;
const MAX_POINTS_PER_CHART = 240;
const MAX_POINTS_PER_ORBIT_TRACK = 420;
const MAX_HAPI_PREVIEW_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_GOES_PREVIEW_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const EARTH_RADIUS_KM = 6371;
const GSE_EARTH_RADIUS_KM = 6378;
const GEO_ALTITUDE_KM = 35786;
const GEO_RADIUS_KM = EARTH_RADIUS_KM + GEO_ALTITUDE_KM;

const GOES_NOMINAL_LONGITUDE_DEG: Record<string, number> = {
  'GOES-18': -137.0,
  'GOES-19': -75.2,
};

const COLOR = {
  bt: '#38bdf8',
  bx: '#a78bfa',
  by: '#f472b6',
  bz: '#22d3ee',
  speed: '#fb7185',
  density: '#34d399',
  temperature: '#f59e0b',
  x: '#60a5fa',
  y: '#c084fc',
  z: '#2dd4bf',
  electron: '#34d399',
  proton: '#fb7185',
  xrs: '#f59e0b',
};

const PLOT_READY_SOURCE_IDS = new Set([
  'cdaweb-ace-wind-imap',
  'ncei-dscovr-archive',
  'omni-hro',
  'swpc-goes-json',
]);

const SSC_NATIVE_RESOLUTION_SECONDS: Record<string, number> = {
  ace: 720,
  wind: 720,
  dscovr: 60,
  imap: 60,
  goes18: 60,
  goes19: 60,
};

function sleep(delayMs: number) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized).getTime();

  return Number.isNaN(parsed) ? null : parsed;
}

function toIsoUtc(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

function toBasicIsoUtc(timestampMs: number) {
  return toIsoUtc(timestampMs)
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

function normalizeRange(range: HistoricPlotRange): HistoricPlotRange | null {
  const startMs = parseTimestampMs(range.startUtc);
  const stopMs = parseTimestampMs(range.stopUtc);

  if (startMs === null || stopMs === null || stopMs <= startMs) {
    return null;
  }

  return {
    startUtc: toIsoUtc(startMs),
    stopUtc: toIsoUtc(stopMs),
  };
}

function clampRangeToMaxDuration(range: HistoricPlotRange, maxDurationMs: number) {
  const startMs = parseTimestampMs(range.startUtc) ?? 0;
  const stopMs = parseTimestampMs(range.stopUtc) ?? startMs;

  if (stopMs - startMs <= maxDurationMs) {
    return { range, clamped: false };
  }

  return {
    range: {
      startUtc: toIsoUtc(stopMs - maxDurationMs),
      stopUtc: range.stopUtc,
    },
    clamped: true,
  };
}

export function toFiniteNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) < 1e30 ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && Math.abs(parsed) < 1e30 ? parsed : null;
  }

  return null;
}

function vectorComponent(value: unknown, index: number) {
  return Array.isArray(value) ? toFiniteNumber(value[index]) : null;
}

function vectorMagnitude(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  const components = value.map(toFiniteNumber);

  if (components.some(component => component === null)) {
    return null;
  }

  return Math.sqrt(
    components.reduce<number>((sum, component) => sum + (component ?? 0) ** 2, 0),
  );
}

function downsample<T>(rows: T[], maxPoints = MAX_POINTS_PER_CHART) {
  if (rows.length <= maxPoints) {
    return rows;
  }

  const step = Math.ceil(rows.length / maxPoints);

  return rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function radiansToDegrees(value: number) {
  return value * (180 / Math.PI);
}

function degreesToRadians(value: number) {
  return value * (Math.PI / 180);
}

function normalizeDegrees(value: number) {
  const normalized = value % 360;

  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeLongitude(value: number) {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;

  return normalized === -180 ? 180 : normalized;
}

function getSunAxisAngleFromVector(xKm: number, yKm: number, zKm: number) {
  const distanceKm = Math.sqrt(xKm ** 2 + yKm ** 2 + zKm ** 2);

  if (distanceKm <= 0) {
    return null;
  }

  return radiansToDegrees(Math.acos(clamp(xKm / distanceKm, -1, 1)));
}

function getJulianDate(date: Date) {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

function getSubsolarPoint(date: Date) {
  const julianDate = getJulianDate(date);
  const daysSinceJ2000 = julianDate - 2_451_545.0;
  const meanLongitude = normalizeDegrees(280.460 + 0.9856474 * daysSinceJ2000);
  const meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * daysSinceJ2000);
  const meanAnomalyRad = degreesToRadians(meanAnomaly);
  const eclipticLongitude = normalizeDegrees(
    meanLongitude +
      1.915 * Math.sin(meanAnomalyRad) +
      0.020 * Math.sin(2 * meanAnomalyRad),
  );
  const obliquity = 23.439 - 0.0000004 * daysSinceJ2000;
  const eclipticLongitudeRad = degreesToRadians(eclipticLongitude);
  const obliquityRad = degreesToRadians(obliquity);
  const declination = Math.asin(Math.sin(obliquityRad) * Math.sin(eclipticLongitudeRad));
  const rightAscension = Math.atan2(
    Math.cos(obliquityRad) * Math.sin(eclipticLongitudeRad),
    Math.cos(eclipticLongitudeRad),
  );
  const greenwichMeanSiderealTime = normalizeDegrees(
    280.46061837 + 360.98564736629 * (julianDate - 2_451_545.0),
  );

  return {
    latitudeDeg: radiansToDegrees(declination),
    longitudeDeg: normalizeLongitude(radiansToDegrees(rightAscension) - greenwichMeanSiderealTime),
  };
}

function getGeoSunAxisAngle(longitudeDeg: number, date: Date) {
  const subsolar = getSubsolarPoint(date);
  const satelliteLongitudeRad = degreesToRadians(longitudeDeg);
  const subsolarLatitudeRad = degreesToRadians(subsolar.latitudeDeg);
  const subsolarLongitudeRad = degreesToRadians(subsolar.longitudeDeg);
  const satelliteVector = {
    x: Math.cos(satelliteLongitudeRad),
    y: Math.sin(satelliteLongitudeRad),
    z: 0,
  };
  const sunVector = {
    x: Math.cos(subsolarLatitudeRad) * Math.cos(subsolarLongitudeRad),
    y: Math.cos(subsolarLatitudeRad) * Math.sin(subsolarLongitudeRad),
    z: Math.sin(subsolarLatitudeRad),
  };
  const dot = satelliteVector.x * sunVector.x + satelliteVector.y * sunVector.y + satelliteVector.z * sunVector.z;

  return radiansToDegrees(Math.acos(clamp(dot, -1, 1)));
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Request failed');

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('Request failed');
}

export async function fetchHapiSeries(
  datasetId: string,
  parameters: string[],
  range: HistoricPlotRange,
): Promise<HapiSeriesResult> {
  const warnings: string[] = [];

  try {
    const infoUrl = new URL(`${HAPI_BASE_URL}/info`);
    infoUrl.searchParams.set('id', datasetId);
    const info = await fetchJsonWithRetry(infoUrl.toString()) as HapiInfoResponse;

    if (info.status && info.status.code !== 1200) {
      return {
        rows: [],
        warnings: [`${datasetId}: ${info.status.message}`],
      };
    }

    const requestedStartMs = parseTimestampMs(range.startUtc) ?? 0;
    const requestedStopMs = parseTimestampMs(range.stopUtc) ?? requestedStartMs;
    const datasetStartMs = parseTimestampMs(info.startDate) ?? requestedStartMs;
    const datasetStopMs = parseTimestampMs(info.stopDate) ?? requestedStopMs;
    const startMs = Math.max(requestedStartMs, datasetStartMs);
    const stopMs = Math.min(requestedStopMs, datasetStopMs);

    if (stopMs <= startMs) {
      return {
        rows: [],
        warnings: [`${datasetId}: no catalog coverage for selected range.`],
      };
    }

    if (stopMs < requestedStopMs) {
      warnings.push(`${datasetId}: data stop is ${toIsoUtc(stopMs)}; selected range was clipped.`);
    }

    const dataUrl = new URL(`${HAPI_BASE_URL}/data`);
    dataUrl.searchParams.set('id', datasetId);
    dataUrl.searchParams.set('parameters', parameters.join(','));
    dataUrl.searchParams.set('time.min', toIsoUtc(startMs));
    dataUrl.searchParams.set('time.max', toIsoUtc(stopMs));
    dataUrl.searchParams.set('format', 'json');

    const data = await fetchJsonWithRetry(dataUrl.toString()) as HapiDataResponse;

    if (data.status && data.status.code !== 1200) {
      return {
        rows: [],
        warnings: [`${datasetId}: ${data.status.message}`],
      };
    }

    return {
      rows: data.data ?? [],
      warnings,
    };
  } catch (error) {
    return {
      rows: [],
      warnings: [error instanceof Error ? `${datasetId}: ${error.message}` : `${datasetId}: HAPI request failed`],
    };
  }
}

/**
 * Fetch a HAPI series over an arbitrarily long window by splitting it into
 * sequential sub-requests, so large ranges don't hit the per-request timeout.
 */
export async function fetchHapiSeriesChunked(
  datasetId: string,
  parameters: string[],
  range: HistoricPlotRange,
  chunkDays = 20,
): Promise<HapiSeriesResult> {
  const startMs = parseTimestampMs(range.startUtc);
  const stopMs = parseTimestampMs(range.stopUtc);
  const chunkMs = chunkDays * 24 * 60 * 60 * 1000;

  if (startMs === null || stopMs === null || stopMs <= startMs || stopMs - startMs <= chunkMs) {
    return fetchHapiSeries(datasetId, parameters, range);
  }

  const rows: unknown[][] = [];
  const warnings = new Set<string>();

  for (let chunkStart = startMs; chunkStart < stopMs; chunkStart += chunkMs) {
    const chunkStop = Math.min(chunkStart + chunkMs, stopMs);
    const result = await fetchHapiSeries(datasetId, parameters, {
      startUtc: toIsoUtc(chunkStart),
      stopUtc: toIsoUtc(chunkStop),
    });
    rows.push(...result.rows);
    for (const warning of result.warnings) {
      warnings.add(warning);
    }
  }

  return { rows, warnings: [...warnings] };
}

function unwrapTypedObject(value: unknown) {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
    return value[1];
  }

  return value;
}

function unwrapJavaList(value: unknown): unknown[] {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === 'java.util.ArrayList' &&
    Array.isArray(value[1])
  ) {
    return value[1];
  }

  return [];
}

function getObjectProperty(value: unknown, key: string): unknown {
  const objectValue = unwrapTypedObject(value);

  if (objectValue && typeof objectValue === 'object' && key in objectValue) {
    return (objectValue as Record<string, unknown>)[key];
  }

  return undefined;
}

function getSscCoordinateArray(coordinateData: unknown, key: 'X' | 'Y' | 'Z') {
  return unwrapJavaList(getObjectProperty(coordinateData, key))
    .map(toFiniteNumber)
    .filter((value): value is number => value !== null);
}

function getSscTimeArray(satelliteData: unknown) {
  return unwrapJavaList(getObjectProperty(satelliteData, 'Time'))
    .map(value => {
      const unwrapped = unwrapTypedObject(value);

      return typeof unwrapped === 'string' ? unwrapped : null;
    })
    .filter((value): value is string => value !== null);
}

function chooseSscResolutionFactor(observatoryId: string, range: HistoricPlotRange) {
  const startMs = parseTimestampMs(range.startUtc) ?? 0;
  const stopMs = parseTimestampMs(range.stopUtc) ?? startMs;
  const durationMs = Math.max(0, stopMs - startMs);
  const nativeResolutionMs = (SSC_NATIVE_RESOLUTION_SECONDS[observatoryId] ?? 60) * 1000;

  return Math.max(1, Math.ceil(durationMs / (MAX_POINTS_PER_ORBIT_TRACK * nativeResolutionMs)));
}

async function fetchSscOrbitTrack(
  request: SscOrbitRequest,
  range: HistoricPlotRange,
): Promise<{ track: HistoricOrbitTrack | null; warnings: string[] }> {
  const startMs = parseTimestampMs(range.startUtc);
  const stopMs = parseTimestampMs(range.stopUtc);

  if (startMs === null || stopMs === null || stopMs <= startMs) {
    return {
      track: null,
      warnings: [`${request.spacecraftName}: invalid SSCWeb orbit range.`],
    };
  }

  try {
    const resolutionFactor = chooseSscResolutionFactor(request.observatoryId, range);
    const url = `${SSC_BASE_URL}/locations/${request.observatoryId}/${toBasicIsoUtc(startMs)},${toBasicIsoUtc(stopMs)}/gse/?resolutionFactor=${resolutionFactor}`;
    const response = await fetchJsonWithRetry(url);
    const result = getObjectProperty(getObjectProperty(response, 'Result'), 'Data');
    const satelliteData = unwrapJavaList(result)[0];
    const coordinates = unwrapJavaList(getObjectProperty(satelliteData, 'Coordinates'));
    const gseCoordinates = coordinates.find(coordinate => getObjectProperty(coordinate, 'CoordinateSystem') === 'GSE');
    const times = getSscTimeArray(satelliteData);
    const xValues = getSscCoordinateArray(gseCoordinates, 'X');
    const yValues = getSscCoordinateArray(gseCoordinates, 'Y');
    const zValues = getSscCoordinateArray(gseCoordinates, 'Z');
    const pointCount = Math.min(times.length, xValues.length, yValues.length, zValues.length);
    const points = Array.from({ length: pointCount }, (_, index): HistoricOrbitTrackPoint | null => {
      const timestampMs = parseTimestampMs(times[index]);

      if (timestampMs === null) {
        return null;
      }

      const xKm = xValues[index];
      const yKm = yValues[index];
      const zKm = zValues[index];
      const distanceKm = Math.sqrt(xKm ** 2 + yKm ** 2 + zKm ** 2);
      const sunAxisAngleDeg = getSunAxisAngleFromVector(xKm, yKm, zKm);

      if (distanceKm <= 0 || sunAxisAngleDeg === null) {
        return null;
      }

      return {
        time_tag: toIsoUtc(timestampMs),
        xKm,
        yKm,
        zKm,
        distanceKm,
        heightKm: Math.max(0, distanceKm - EARTH_RADIUS_KM),
        sunAxisAngleDeg,
        longitudeDeg: null,
      };
    }).filter((point): point is HistoricOrbitTrackPoint => Boolean(point));

    if (points.length < 2) {
      return {
        track: null,
        warnings: [`${request.spacecraftName}: SSCWeb returned no GSE orbit points for the selected range.`],
      };
    }

    return {
      track: {
        id: `historic-${request.observatoryId}-ssc-gse-orbit`,
        sourceId: request.sourceId,
        spacecraftName: request.spacecraftName,
        source: request.source,
        frame: 'GSE',
        orbitRegime: request.orbitRegime,
        color: request.color,
        points: downsample(points, MAX_POINTS_PER_ORBIT_TRACK),
        note: request.note,
      },
      warnings: [],
    };
  } catch (error) {
    return {
      track: null,
      warnings: [
        error instanceof Error
          ? `${request.spacecraftName}: SSCWeb orbit request failed (${error.message}).`
          : `${request.spacecraftName}: SSCWeb orbit request failed.`,
      ],
    };
  }
}

async function fetchSscOrbitTracks(
  requests: SscOrbitRequest[],
  range: HistoricPlotRange,
) {
  const results = await Promise.all(requests.map(request => fetchSscOrbitTrack(request, range)));

  return {
    orbitTracks: results
      .map(result => result.track)
      .filter((track): track is HistoricOrbitTrack => Boolean(track)),
    warnings: results.flatMap(result => result.warnings),
  };
}

function buildHapiChart(
  id: string,
  sourceId: string,
  spacecraftName: string,
  source: string,
  title: string,
  unit: string,
  color: string,
  rows: unknown[][],
  getValue: (row: unknown[]) => number | null,
): HistoricPlotChart | null {
  const data = downsample(rows)
    .map(row => {
      const timestampMs = typeof row[0] === 'string' ? parseTimestampMs(row[0]) : null;

      return {
        time_tag: timestampMs === null ? '' : toIsoUtc(timestampMs),
        value: getValue(row),
      };
    })
    .filter(point => point.time_tag);

  if (data.length === 0) {
    return null;
  }

  return {
    id,
    sourceId,
    spacecraftName,
    source,
    title,
    unit,
    color,
    lastSampleTime: data[data.length - 1]?.time_tag ?? null,
    data,
  };
}

function buildGseOrbitTrack({
  id,
  sourceId,
  spacecraftName,
  source,
  color,
  rows,
  getVector,
  orbitRegime = 'L1',
  coordinateScale = 1,
  note,
}: {
  id: string;
  sourceId: string;
  spacecraftName: string;
  source: string;
  color: string;
  rows: unknown[][];
  getVector: (row: unknown[]) => unknown;
  orbitRegime?: HistoricOrbitRegime;
  coordinateScale?: number;
  note: string;
}): HistoricOrbitTrack | null {
  const points = downsample(rows, MAX_POINTS_PER_ORBIT_TRACK)
    .map((row): HistoricOrbitTrackPoint | null => {
      const timestampMs = typeof row[0] === 'string' ? parseTimestampMs(row[0]) : null;
      const vector = getVector(row);
      const xRaw = vectorComponent(vector, 0);
      const yRaw = vectorComponent(vector, 1);
      const zRaw = vectorComponent(vector, 2);

      if (timestampMs === null || xRaw === null || yRaw === null || zRaw === null) {
        return null;
      }

      const xKm = xRaw * coordinateScale;
      const yKm = yRaw * coordinateScale;
      const zKm = zRaw * coordinateScale;
      const distanceKm = Math.sqrt(xKm ** 2 + yKm ** 2 + zKm ** 2);
      const sunAxisAngleDeg = getSunAxisAngleFromVector(xKm, yKm, zKm);

      if (distanceKm <= 0 || sunAxisAngleDeg === null) {
        return null;
      }

      return {
        time_tag: toIsoUtc(timestampMs),
        xKm,
        yKm,
        zKm,
        distanceKm,
        heightKm: Math.max(0, distanceKm - EARTH_RADIUS_KM),
        sunAxisAngleDeg,
        longitudeDeg: null,
      };
    })
    .filter((point): point is HistoricOrbitTrackPoint => Boolean(point));

  if (points.length < 2) {
    return null;
  }

  return {
    id,
    sourceId,
    spacecraftName,
    source,
    frame: 'GSE',
    orbitRegime,
    color,
    points,
    note,
  };
}

async function buildCdawebAceWindImapCharts(range: HistoricPlotRange) {
  const warnings: string[] = [];
  const charts: HistoricPlotChart[] = [];
  const orbitTracks: HistoricOrbitTrack[] = [];

  const [
    aceMag,
    acePlasma,
    windMag,
    windPlasma,
    imapMag,
    imapSwapi,
    imapEphemeris,
  ] = await Promise.all([
    fetchHapiSeries('AC_K0_MFI', ['Magnitude', 'BGSEc'], range),
    fetchHapiSeries('AC_K0_SWE', ['Np', 'Vp', 'Tpr'], range),
    fetchHapiSeries('WI_K0_MFI', ['BF1', 'BGSMc', 'PGSE'], range),
    fetchHapiSeries('WI_K0_SWE', ['SC_pos_gse', 'V_GSE', 'THERMAL_SPD', 'Np'], range),
    fetchHapiSeries('IMAP_IALIRT_L1_REALTIME@1', ['mag_B_magnitude', 'mag_B_GSM'], range),
    fetchHapiSeries('IMAP_IALIRT_L1_REALTIME@2', [
      'swapi_pseudo_proton_density',
      'swapi_pseudo_proton_speed',
      'swapi_pseudo_proton_temperature',
    ], range),
    fetchHapiSeries('IMAP_IALIRT_L1_REALTIME@4', ['sc_position_GSE'], range),
  ]);

  warnings.push(
    ...aceMag.warnings,
    ...acePlasma.warnings,
    ...windMag.warnings,
    ...windPlasma.warnings,
    ...imapMag.warnings,
    ...imapSwapi.warnings,
    ...imapEphemeris.warnings,
  );

  [
    buildHapiChart('historic-ace-bt', 'cdaweb-ace-wind-imap', 'ACE', 'NASA CDAWeb HAPI', 'ACE BT', 'nT', COLOR.bt, aceMag.rows, row => toFiniteNumber(row[1])),
    buildHapiChart('historic-ace-bx-gse', 'cdaweb-ace-wind-imap', 'ACE', 'NASA CDAWeb HAPI', 'ACE Bx GSE', 'nT', COLOR.bx, aceMag.rows, row => vectorComponent(row[2], 0)),
    buildHapiChart('historic-ace-by-gse', 'cdaweb-ace-wind-imap', 'ACE', 'NASA CDAWeb HAPI', 'ACE By GSE', 'nT', COLOR.by, aceMag.rows, row => vectorComponent(row[2], 1)),
    buildHapiChart('historic-ace-bz-gse', 'cdaweb-ace-wind-imap', 'ACE', 'NASA CDAWeb HAPI', 'ACE Bz GSE', 'nT', COLOR.bz, aceMag.rows, row => vectorComponent(row[2], 2)),
    buildHapiChart('historic-ace-density', 'cdaweb-ace-wind-imap', 'ACE', 'NASA CDAWeb HAPI', 'ACE density', 'cm^-3', COLOR.density, acePlasma.rows, row => toFiniteNumber(row[1])),
    buildHapiChart('historic-ace-speed', 'cdaweb-ace-wind-imap', 'ACE', 'NASA CDAWeb HAPI', 'ACE speed', 'km/s', COLOR.speed, acePlasma.rows, row => toFiniteNumber(row[2])),
    buildHapiChart('historic-wind-bt', 'cdaweb-ace-wind-imap', 'WIND', 'NASA CDAWeb HAPI', 'WIND BT', 'nT', COLOR.bt, windMag.rows, row => toFiniteNumber(row[1])),
    buildHapiChart('historic-wind-bx-gsm', 'cdaweb-ace-wind-imap', 'WIND', 'NASA CDAWeb HAPI', 'WIND Bx GSM', 'nT', COLOR.bx, windMag.rows, row => vectorComponent(row[2], 0)),
    buildHapiChart('historic-wind-by-gsm', 'cdaweb-ace-wind-imap', 'WIND', 'NASA CDAWeb HAPI', 'WIND By GSM', 'nT', COLOR.by, windMag.rows, row => vectorComponent(row[2], 1)),
    buildHapiChart('historic-wind-bz-gsm', 'cdaweb-ace-wind-imap', 'WIND', 'NASA CDAWeb HAPI', 'WIND Bz GSM', 'nT', COLOR.bz, windMag.rows, row => vectorComponent(row[2], 2)),
    buildHapiChart('historic-wind-speed', 'cdaweb-ace-wind-imap', 'WIND', 'NASA CDAWeb HAPI', 'WIND speed', 'km/s', COLOR.speed, windPlasma.rows, row => vectorMagnitude(row[2])),
    buildHapiChart('historic-wind-density', 'cdaweb-ace-wind-imap', 'WIND', 'NASA CDAWeb HAPI', 'WIND density', 'cm^-3', COLOR.density, windPlasma.rows, row => toFiniteNumber(row[4])),
    buildHapiChart('historic-imap-bt', 'cdaweb-ace-wind-imap', 'IMAP', 'NASA CDAWeb HAPI', 'IMAP BT', 'nT', COLOR.bt, imapMag.rows, row => toFiniteNumber(row[1])),
    buildHapiChart('historic-imap-bz-gsm', 'cdaweb-ace-wind-imap', 'IMAP', 'NASA CDAWeb HAPI', 'IMAP Bz GSM', 'nT', COLOR.bz, imapMag.rows, row => vectorComponent(row[2], 2)),
    buildHapiChart('historic-imap-speed', 'cdaweb-ace-wind-imap', 'IMAP', 'NASA CDAWeb HAPI', 'IMAP speed', 'km/s', COLOR.speed, imapSwapi.rows, row => toFiniteNumber(row[2])),
    buildHapiChart('historic-imap-density', 'cdaweb-ace-wind-imap', 'IMAP', 'NASA CDAWeb HAPI', 'IMAP density', 'cm^-3', COLOR.density, imapSwapi.rows, row => toFiniteNumber(row[1])),
  ].forEach(chart => {
    if (chart) {
      charts.push(chart);
    }
  });

  const sscOrbitResult = await fetchSscOrbitTracks([
    {
      observatoryId: 'ace',
      spacecraftName: 'ACE',
      sourceId: 'cdaweb-ace-wind-imap',
      source: 'NASA SSCWeb',
      color: '#a78bfa',
      orbitRegime: 'L1',
      note: 'ACE orbit uses NASA SSCWeb geocentric GSE trajectory points; telemetry plots still come from CDAWeb HAPI.',
    },
    {
      observatoryId: 'wind',
      spacecraftName: 'WIND',
      sourceId: 'cdaweb-ace-wind-imap',
      source: 'NASA SSCWeb',
      color: '#f472b6',
      orbitRegime: 'L1',
      note: 'WIND orbit uses NASA SSCWeb geocentric GSE trajectory points for the selected interval.',
    },
    {
      observatoryId: 'imap',
      spacecraftName: 'IMAP',
      sourceId: 'cdaweb-ace-wind-imap',
      source: 'NASA SSCWeb',
      color: '#34d399',
      orbitRegime: 'L1',
      note: 'IMAP orbit uses NASA SSCWeb geocentric GSE trajectory points for the selected interval.',
    },
  ], range);
  const sscTrackNames = new Set(sscOrbitResult.orbitTracks.map(track => track.spacecraftName));

  orbitTracks.push(...sscOrbitResult.orbitTracks);
  warnings.push(...sscOrbitResult.warnings);

  [
    sscTrackNames.has('WIND') ? null : buildGseOrbitTrack({
      id: 'historic-wind-hapi-gse-orbit',
      sourceId: 'cdaweb-ace-wind-imap',
      spacecraftName: 'WIND',
      source: 'NASA CDAWeb HAPI',
      color: '#f472b6',
      rows: windMag.rows,
      getVector: row => row[3],
      coordinateScale: GSE_EARTH_RADIUS_KM,
      note: 'WIND fallback orbit uses CDAWeb PGSE vectors converted from Earth radii to kilometers.',
    }),
    sscTrackNames.has('IMAP') ? null : buildGseOrbitTrack({
      id: 'historic-imap-hapi-gse-orbit',
      sourceId: 'cdaweb-ace-wind-imap',
      spacecraftName: 'IMAP',
      source: 'NASA CDAWeb HAPI',
      color: '#34d399',
      rows: imapEphemeris.rows,
      getVector: row => row[1],
      note: 'IMAP fallback orbit uses I-ALiRT sc_position_GSE vectors in kilometers.',
    }),
  ].forEach(track => {
    if (track) {
      orbitTracks.push(track);
    }
  });

  return { charts, orbitTracks, warnings };
}

async function buildOmniCharts(range: HistoricPlotRange) {
  const result = await fetchHapiSeries('OMNI_HRO_1MIN', [
    'F',
    'BX_GSE',
    'BY_GSM',
    'BZ_GSM',
    'flow_speed',
    'proton_density',
    'T',
  ], range);
  const charts = [
    buildHapiChart('historic-omni-bt', 'omni-hro', 'OMNI HRO', 'NASA SPDF HAPI', 'OMNI |B|', 'nT', COLOR.bt, result.rows, row => toFiniteNumber(row[1])),
    buildHapiChart('historic-omni-bx-gse', 'omni-hro', 'OMNI HRO', 'NASA SPDF HAPI', 'OMNI Bx GSE', 'nT', COLOR.bx, result.rows, row => toFiniteNumber(row[2])),
    buildHapiChart('historic-omni-by-gsm', 'omni-hro', 'OMNI HRO', 'NASA SPDF HAPI', 'OMNI By GSM', 'nT', COLOR.by, result.rows, row => toFiniteNumber(row[3])),
    buildHapiChart('historic-omni-bz-gsm', 'omni-hro', 'OMNI HRO', 'NASA SPDF HAPI', 'OMNI Bz GSM', 'nT', COLOR.bz, result.rows, row => toFiniteNumber(row[4])),
    buildHapiChart('historic-omni-speed', 'omni-hro', 'OMNI HRO', 'NASA SPDF HAPI', 'OMNI speed', 'km/s', COLOR.speed, result.rows, row => toFiniteNumber(row[5])),
    buildHapiChart('historic-omni-density', 'omni-hro', 'OMNI HRO', 'NASA SPDF HAPI', 'OMNI density', 'n/cc', COLOR.density, result.rows, row => toFiniteNumber(row[6])),
    buildHapiChart('historic-omni-temperature', 'omni-hro', 'OMNI HRO', 'NASA SPDF HAPI', 'OMNI temperature', 'K', COLOR.temperature, result.rows, row => toFiniteNumber(row[7])),
  ].filter((chart): chart is HistoricPlotChart => Boolean(chart));

  return {
    charts,
    warnings: result.warnings,
  };
}

function chooseGoesFileSuffix(range: HistoricPlotRange) {
  const startMs = parseTimestampMs(range.startUtc) ?? 0;
  const stopMs = parseTimestampMs(range.stopUtc) ?? startMs;
  const durationMs = stopMs - startMs;

  if (durationMs <= 6 * 60 * 60 * 1000) {
    return '6-hour';
  }

  if (durationMs <= 24 * 60 * 60 * 1000) {
    return '1-day';
  }

  if (durationMs <= 3 * 24 * 60 * 60 * 1000) {
    return '3-day';
  }

  return '7-day';
}

async function fetchGoesDataset<T>(role: GoesRole, fileName: string) {
  try {
    const data = await fetchJsonWithRetry(`${SWPC_GOES_BASE_URL}/${role}/${fileName}`);

    return Array.isArray(data) ? data as T[] : [];
  } catch {
    return [];
  }
}

function getSpacecraftLabel(rows: GoesScalarPoint[], role: GoesRole) {
  const satellite = rows.find(row => row.satellite !== undefined && row.satellite !== null)?.satellite;

  return satellite ? `GOES-${satellite}` : `GOES ${role}`;
}

function filterGoesRows<T extends GoesScalarPoint>(rows: T[], range: HistoricPlotRange) {
  const startMs = parseTimestampMs(range.startUtc) ?? 0;
  const stopMs = parseTimestampMs(range.stopUtc) ?? startMs;

  return rows.filter(row => {
    const timestampMs = parseTimestampMs(row.time_tag);

    return timestampMs !== null && timestampMs >= startMs && timestampMs <= stopMs;
  });
}

function buildGoesChart(
  id: string,
  spacecraftName: string,
  title: string,
  unit: string,
  color: string,
  rows: GoesScalarPoint[],
  getValue: (row: GoesScalarPoint) => number | null,
): HistoricPlotChart | null {
  const data = downsample(rows)
    .map(row => {
      const timestampMs = parseTimestampMs(row.time_tag);

      return {
        time_tag: timestampMs === null ? '' : toIsoUtc(timestampMs),
        value: getValue(row),
      };
    })
    .filter(point => point.time_tag);

  if (data.length === 0) {
    return null;
  }

  return {
    id,
    sourceId: 'swpc-goes-json',
    spacecraftName,
    source: 'NOAA SWPC GOES JSON',
    title,
    unit,
    color,
    lastSampleTime: data[data.length - 1]?.time_tag ?? null,
    data,
  };
}

function buildGoesNominalOrbitTrack({
  id,
  spacecraftName,
  color,
  rows,
}: {
  id: string;
  spacecraftName: string;
  color: string;
  rows: GoesScalarPoint[];
}): HistoricOrbitTrack | null {
  const longitudeDeg = GOES_NOMINAL_LONGITUDE_DEG[spacecraftName];

  if (longitudeDeg === undefined) {
    return null;
  }

  const longitudeRad = degreesToRadians(longitudeDeg);
  const xKm = Math.cos(longitudeRad) * GEO_RADIUS_KM;
  const yKm = Math.sin(longitudeRad) * GEO_RADIUS_KM;
  const zKm = 0;
  const distanceKm = GEO_RADIUS_KM;
  const points = downsample(rows, MAX_POINTS_PER_ORBIT_TRACK)
    .map((row): HistoricOrbitTrackPoint | null => {
      const timestampMs = parseTimestampMs(row.time_tag);

      if (timestampMs === null) {
        return null;
      }

      return {
        time_tag: toIsoUtc(timestampMs),
        xKm,
        yKm,
        zKm,
        distanceKm,
        heightKm: GEO_ALTITUDE_KM,
        sunAxisAngleDeg: getGeoSunAxisAngle(longitudeDeg, new Date(timestampMs)),
        longitudeDeg,
      };
    })
    .filter((point): point is HistoricOrbitTrackPoint => Boolean(point));

  if (points.length < 2) {
    return null;
  }

  return {
    id,
    sourceId: 'swpc-goes-json',
    spacecraftName,
    source: 'NOAA SWPC GOES JSON',
    frame: 'GEO nominal',
    orbitRegime: 'GEO',
    color,
    points,
    note: 'NOAA GOES JSON identifies the spacecraft but does not include historical ephemerides; this replay uses the nominal operational GEO longitude.',
  };
}

async function buildGoesCharts(range: HistoricPlotRange) {
  const suffix = chooseGoesFileSuffix(range);
  const roles: GoesRole[] = ['primary', 'secondary'];
  const charts: HistoricPlotChart[] = [];
  const orbitTracks: HistoricOrbitTrack[] = [];
  const warnings: string[] = [];

  await Promise.all(roles.map(async role => {
    const [magRowsRaw, electronRowsRaw, protonRowsRaw, xrsRowsRaw] = await Promise.all([
      fetchGoesDataset<GoesMagPoint>(role, `magnetometers-${suffix}.json`),
      fetchGoesDataset<GoesScalarPoint>(role, `integral-electrons-${suffix}.json`),
      fetchGoesDataset<GoesScalarPoint>(role, `integral-protons-${suffix}.json`),
      fetchGoesDataset<GoesScalarPoint>(role, `xrays-${suffix}.json`),
    ]);
    const magRows = filterGoesRows(magRowsRaw, range);
    const electronRows = filterGoesRows(electronRowsRaw.filter(row => row.energy === '>=2 MeV'), range);
    const protonRows = filterGoesRows(protonRowsRaw.filter(row => row.energy === '>=10 MeV'), range);
    const xrsRows = filterGoesRows(xrsRowsRaw.filter(row => row.energy === '0.1-0.8nm'), range);
    const roleLabel = role === 'primary' ? 'primary' : 'secondary';
    const spacecraftName = getSpacecraftLabel(
      [...magRows, ...electronRows, ...protonRows, ...xrsRows],
      role,
    );
    const orbitRows = magRows.length > 0
      ? magRows
      : electronRows.length > 0
        ? electronRows
        : protonRows.length > 0
          ? protonRows
          : xrsRows;

    [
      buildGoesChart(`historic-goes-${role}-mag-hn`, getSpacecraftLabel(magRows, role), `${roleLabel} MAG Hn`, 'nT', COLOR.bz, magRows, row => toFiniteNumber((row as GoesMagPoint).Hn)),
      buildGoesChart(`historic-goes-${role}-mag-hp`, getSpacecraftLabel(magRows, role), `${roleLabel} MAG Hp`, 'nT', COLOR.by, magRows, row => toFiniteNumber((row as GoesMagPoint).Hp)),
      buildGoesChart(`historic-goes-${role}-mag-total`, getSpacecraftLabel(magRows, role), `${roleLabel} MAG |H|`, 'nT', COLOR.bt, magRows, row => toFiniteNumber((row as GoesMagPoint).total)),
      buildGoesChart(`historic-goes-${role}-electrons-2mev`, getSpacecraftLabel(electronRows, role), `${roleLabel} electrons >=2 MeV`, 'pfu', COLOR.electron, electronRows, row => toFiniteNumber(row.flux)),
      buildGoesChart(`historic-goes-${role}-protons-10mev`, getSpacecraftLabel(protonRows, role), `${roleLabel} protons >=10 MeV`, 'pfu', COLOR.proton, protonRows, row => toFiniteNumber(row.flux)),
      buildGoesChart(`historic-goes-${role}-xrs-long`, getSpacecraftLabel(xrsRows, role), `${roleLabel} XRS 0.1-0.8 nm`, 'W/m^2', COLOR.xrs, xrsRows, row => toFiniteNumber(row.flux)),
    ].forEach(chart => {
      if (chart) {
        charts.push(chart);
      }
    });

    const sscObservatoryId = /^GOES-\d+$/i.test(spacecraftName)
      ? spacecraftName.toLowerCase().replace('-', '')
      : null;
    const sscOrbitResult = sscObservatoryId
      ? await fetchSscOrbitTrack({
          observatoryId: sscObservatoryId,
          spacecraftName,
          sourceId: 'swpc-goes-json',
          source: 'NASA SSCWeb',
          color: role === 'primary' ? '#34d399' : '#fbbf24',
          orbitRegime: 'GEO',
          note: 'GOES orbit uses NASA SSCWeb geocentric GSE trajectory points; particle and X-ray plots still come from NOAA SWPC JSON.',
        }, range)
      : { track: null, warnings: [`${spacecraftName}: no SSCWeb observatory id was inferred for the GOES orbit.`] };
    const orbitTrack = sscOrbitResult.track ?? buildGoesNominalOrbitTrack({
      id: `historic-goes-${role}-geo-orbit`,
      spacecraftName,
      color: role === 'primary' ? '#34d399' : '#fbbf24',
      rows: orbitRows,
    });

    warnings.push(...sscOrbitResult.warnings);

    if (orbitTrack) {
      orbitTracks.push(orbitTrack);
    }
  }));

  if (charts.length === 0) {
    warnings.push('GOES SWPC preview exposes only the latest 7 days; no rows matched the selected range.');
  }

  return { charts, orbitTracks, warnings };
}

export async function buildHistoricPlotsSnapshot(
  inputRange: HistoricPlotRange,
  requestedSourceIds: string[],
): Promise<HistoricPlotsSnapshot> {
  const normalizedRange = normalizeRange(inputRange);
  const sourceIds = Array.from(new Set(requestedSourceIds));

  if (!normalizedRange) {
    return {
      generatedAtUtc: toIsoUtc(Date.now()),
      range: inputRange,
      requestedSourceIds: sourceIds,
      charts: [],
      orbitTracks: [],
      warnings: ['Invalid historic plot range.'],
      unsupportedSourceIds: sourceIds,
    };
  }

  const charts: HistoricPlotChart[] = [];
  const orbitTracks: HistoricOrbitTrack[] = [];
  const warnings: string[] = [];
  const unsupportedSourceIds = sourceIds.filter(sourceId => !PLOT_READY_SOURCE_IDS.has(sourceId));
  const hapiRangeResult = clampRangeToMaxDuration(normalizedRange, MAX_HAPI_PREVIEW_RANGE_MS);
  const goesRangeResult = clampRangeToMaxDuration(normalizedRange, MAX_GOES_PREVIEW_RANGE_MS);

  if (hapiRangeResult.clamped && (sourceIds.includes('cdaweb-ace-wind-imap') || sourceIds.includes('omni-hro'))) {
    warnings.push('HAPI preview was limited to the last 31 days of the selected window.');
  }

  if (hapiRangeResult.clamped && sourceIds.includes('ncei-dscovr-archive')) {
    warnings.push('DSCOVR orbit preview was limited to the last 31 days of the selected window.');
  }

  if (goesRangeResult.clamped && (sourceIds.includes('swpc-goes-json') || sourceIds.includes('ncei-goes-r-mag-seiss'))) {
    warnings.push('GOES JSON preview was limited to the last 7 days of the selected window.');
  }

  if (sourceIds.includes('cdaweb-ace-wind-imap')) {
    const result = await buildCdawebAceWindImapCharts(hapiRangeResult.range);
    charts.push(...result.charts);
    orbitTracks.push(...result.orbitTracks);
    warnings.push(...result.warnings);
  }

  if (sourceIds.includes('ncei-dscovr-archive')) {
    const result = await fetchSscOrbitTracks([
      {
        observatoryId: 'dscovr',
        spacecraftName: 'DSCOVR',
        sourceId: 'ncei-dscovr-archive',
        source: 'NASA SSCWeb',
        color: '#22d3ee',
        orbitRegime: 'L1',
        note: 'DSCOVR orbit uses NASA SSCWeb geocentric GSE trajectory points for the selected interval.',
      },
    ], hapiRangeResult.range);
    orbitTracks.push(...result.orbitTracks);
    warnings.push(...result.warnings);
  }

  if (sourceIds.includes('omni-hro')) {
    const result = await buildOmniCharts(hapiRangeResult.range);
    charts.push(...result.charts);
    warnings.push(...result.warnings);
  }

  if (sourceIds.includes('swpc-goes-json')) {
    const result = await buildGoesCharts(goesRangeResult.range);
    charts.push(...result.charts);
    orbitTracks.push(...result.orbitTracks);
    warnings.push(...result.warnings);
  }

  if (unsupportedSourceIds.length > 0) {
    warnings.push(`No plot parser wired yet for: ${unsupportedSourceIds.join(', ')}.`);
  }

  return {
    generatedAtUtc: toIsoUtc(Date.now()),
    range: normalizedRange,
    requestedSourceIds: sourceIds,
    charts,
    orbitTracks,
    warnings: Array.from(new Set(warnings)).slice(0, 12),
    unsupportedSourceIds,
  };
}
