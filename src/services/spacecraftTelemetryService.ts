import type {
  NoaaEphemerisData,
  NoaaMagnetometerData,
  NoaaPlasmaData,
  NoaaServiceResponse,
} from './noaaSolarWindService';

export type SpacecraftId = 'ASE' | 'IMAP' | 'WIND' | 'ACE' | 'DSCOVR';
export type SpacecraftConnectionStatus = 'live' | 'stale' | 'off';

export interface SpacecraftChartPoint {
  time_tag: string;
  value: string | number | null;
}

export interface SpacecraftChartSeries {
  id: string;
  title: string;
  unit: string;
  color: string;
  data: SpacecraftChartPoint[];
}

export interface SpacecraftTelemetry {
  id: SpacecraftId;
  displayName: string;
  source: string;
  endpoint: string;
  platform: string;
  description: string;
  variables: string[];
  status: SpacecraftConnectionStatus;
  lastSampleTime: string | null;
  errorMessage: string | null;
  charts: SpacecraftChartSeries[];
}

interface HapiInfoResponse {
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

interface HapiSeriesResult {
  rows: unknown[][];
  stopDate: string | null;
  errorMessage: string | null;
}

interface BuildSpacecraftTelemetryInput {
  magData: NoaaServiceResponse<NoaaMagnetometerData>;
  plasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  ephemerisData: NoaaServiceResponse<NoaaEphemerisData>;
}

const HAPI_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/hapi';
const HAPI_WINDOW_MS = 2 * 60 * 60 * 1000;
const FRESH_SAMPLE_MS = 45 * 60 * 1000;
const FUTURE_SAMPLE_TOLERANCE_MS = 5 * 60 * 1000;
const HAPI_CACHE_MS = 10 * 60 * 1000;
const HAPI_REQUEST_TIMEOUT_MS = 8000;
const EARTH_RADIUS_KM = 6378;
const MAX_POINTS_PER_CHART = 180;

const COLOR = {
  bt: '#38bdf8',
  bx: '#a78bfa',
  by: '#f472b6',
  bz: '#22d3ee',
  speed: '#fb7185',
  density: '#34d399',
  temperature: '#f59e0b',
  thermalSpeed: '#fb923c',
  x: '#60a5fa',
  y: '#c084fc',
  z: '#2dd4bf',
};

let externalSpacecraftCache: {
  expiresAt: number;
  data: SpacecraftTelemetry[];
} | null = null;

function parseTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoString(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toFiniteNumber(value: unknown) {
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

function getLatestSampleTime(charts: SpacecraftChartSeries[]) {
  const latestMs = charts.reduce((currentLatest, chart) => {
    return chart.data.reduce((chartLatest, point) => {
      const parsed = parseTimestamp(point.time_tag);
      return parsed ? Math.max(chartLatest, parsed.getTime()) : chartLatest;
    }, currentLatest);
  }, 0);

  return latestMs > 0 ? new Date(latestMs).toISOString() : null;
}

function getStatusFromCharts(charts: SpacecraftChartSeries[]) {
  const lastSampleTime = getLatestSampleTime(charts);

  if (!lastSampleTime) {
    return { status: 'off' as const, lastSampleTime: null };
  }

  const parsed = parseTimestamp(lastSampleTime);
  const sampleAgeMs = parsed ? Date.now() - parsed.getTime() : null;
  const isFresh = sampleAgeMs !== null
    && sampleAgeMs >= -FUTURE_SAMPLE_TOLERANCE_MS
    && sampleAgeMs <= FRESH_SAMPLE_MS;

  return {
    status: isFresh ? 'live' as const : 'stale' as const,
    lastSampleTime,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), HAPI_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHapiSeries(datasetId: string, parameters: string[]): Promise<HapiSeriesResult> {
  try {
    const infoUrl = new URL(`${HAPI_BASE_URL}/info`);
    infoUrl.searchParams.set('id', datasetId);
    const info = await fetchJson<HapiInfoResponse>(infoUrl.toString());

    if (info.status && info.status.code !== 1200) {
      return {
        rows: [],
        stopDate: null,
        errorMessage: info.status.message,
      };
    }

    const catalogStop = parseTimestamp(info.stopDate);
    const stop = catalogStop && catalogStop.getTime() < Date.now() ? catalogStop : new Date();
    const start = new Date(stop.getTime() - HAPI_WINDOW_MS);

    const dataUrl = new URL(`${HAPI_BASE_URL}/data`);
    dataUrl.searchParams.set('id', datasetId);
    dataUrl.searchParams.set('parameters', parameters.join(','));
    dataUrl.searchParams.set('time.min', toIsoString(start));
    dataUrl.searchParams.set('time.max', toIsoString(stop));
    dataUrl.searchParams.set('format', 'json');

    const response = await fetchJson<HapiDataResponse>(dataUrl.toString());

    if (response.status && response.status.code !== 1200) {
      return {
        rows: [],
        stopDate: info.stopDate ?? null,
        errorMessage: response.status.message,
      };
    }

    return {
      rows: response.data ?? [],
      stopDate: info.stopDate ?? null,
      errorMessage: null,
    };
  } catch (error) {
    return {
      rows: [],
      stopDate: null,
      errorMessage: error instanceof Error ? error.message : 'HAPI request failed',
    };
  }
}

function buildChart(
  id: string,
  title: string,
  unit: string,
  color: string,
  rows: unknown[][],
  getValue: (row: unknown[]) => number | string | null,
) {
  return {
    id,
    title,
    unit,
    color,
    data: downsample(rows)
      .map(row => ({
        time_tag: typeof row[0] === 'string' ? row[0] : '',
        value: getValue(row),
      }))
      .filter(point => point.time_tag),
  };
}

function buildDscovrTelemetry({
  magData,
  plasmaData,
  ephemerisData,
}: BuildSpacecraftTelemetryInput): SpacecraftTelemetry {
  const magCharts: SpacecraftChartSeries[] = [
    {
      id: 'dscovr-bt',
      title: 'BT',
      unit: 'nT',
      color: COLOR.bt,
      data: magData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.bt })),
    },
    {
      id: 'dscovr-bx-gsm',
      title: 'BX GSM',
      unit: 'nT',
      color: COLOR.bx,
      data: magData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.bx_gsm })),
    },
    {
      id: 'dscovr-by-gsm',
      title: 'BY GSM',
      unit: 'nT',
      color: COLOR.by,
      data: magData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.by_gsm })),
    },
    {
      id: 'dscovr-bz-gsm',
      title: 'BZ GSM',
      unit: 'nT',
      color: COLOR.bz,
      data: magData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.bz_gsm })),
    },
  ];
  const plasmaCharts: SpacecraftChartSeries[] = [
    {
      id: 'dscovr-speed',
      title: 'Speed',
      unit: 'km/s',
      color: COLOR.speed,
      data: plasmaData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.speed })),
    },
    {
      id: 'dscovr-density',
      title: 'Density',
      unit: 'cm^-3',
      color: COLOR.density,
      data: plasmaData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.density })),
    },
    {
      id: 'dscovr-temperature',
      title: 'Temperature',
      unit: 'K',
      color: COLOR.temperature,
      data: plasmaData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.temperature })),
    },
  ];
  const ephemerisCharts: SpacecraftChartSeries[] = [
    {
      id: 'dscovr-x-gse',
      title: 'X GSE',
      unit: 'km',
      color: COLOR.x,
      data: ephemerisData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.x_gse })),
    },
    {
      id: 'dscovr-y-gse',
      title: 'Y GSE',
      unit: 'km',
      color: COLOR.y,
      data: ephemerisData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.y_gse })),
    },
    {
      id: 'dscovr-z-gse',
      title: 'Z GSE',
      unit: 'km',
      color: COLOR.z,
      data: ephemerisData.timeSeries.map(point => ({ time_tag: point.time_tag, value: point.z_gse })),
    },
  ];
  const telemetryCharts = [...magCharts, ...plasmaCharts];
  const charts = [...telemetryCharts, ...ephemerisCharts];
  const status = getStatusFromCharts(telemetryCharts);

  return {
    id: 'DSCOVR',
    displayName: 'DISCVR / DSCOVR',
    source: 'RTSW primary stream',
    endpoint: 'SWPC real-time solar-wind stream',
    platform: 'Spacecraft L1 operativo de viento solar',
    description: 'Stream L1 usado para los plots actuales de campo magnetico, plasma y efemerides.',
    variables: ['time_tag', 'bt', 'bx_gsm', 'by_gsm', 'bz_gsm', 'density', 'speed', 'temperature', 'x_gse', 'y_gse', 'z_gse'],
    status: status.status,
    lastSampleTime: status.lastSampleTime,
    errorMessage: magData.errorMessage ?? plasmaData.errorMessage ?? ephemerisData.errorMessage,
    charts,
  };
}

async function fetchAceTelemetry(): Promise<SpacecraftTelemetry> {
  const [mag, plasma] = await Promise.all([
    fetchHapiSeries('AC_K0_MFI', ['Magnitude', 'BGSEc']),
    fetchHapiSeries('AC_K0_SWE', ['Np', 'Vp', 'Tpr']),
  ]);
  const charts = [
    buildChart('ace-bt', 'BT', 'nT', COLOR.bt, mag.rows, row => toFiniteNumber(row[1])),
    buildChart('ace-bx-gse', 'BX GSE', 'nT', COLOR.bx, mag.rows, row => vectorComponent(row[2], 0)),
    buildChart('ace-by-gse', 'BY GSE', 'nT', COLOR.by, mag.rows, row => vectorComponent(row[2], 1)),
    buildChart('ace-bz-gse', 'BZ GSE', 'nT', COLOR.bz, mag.rows, row => vectorComponent(row[2], 2)),
    buildChart('ace-density', 'Density', 'cm^-3', COLOR.density, plasma.rows, row => toFiniteNumber(row[1])),
    buildChart('ace-speed', 'Speed', 'km/s', COLOR.speed, plasma.rows, row => toFiniteNumber(row[2])),
    buildChart('ace-temperature', 'Temperature', 'K', COLOR.temperature, plasma.rows, row => toFiniteNumber(row[3])),
  ];
  const status = getStatusFromCharts(charts);

  return {
    id: 'ACE',
    displayName: 'ACE',
    source: 'NASA CDAWeb HAPI',
    endpoint: 'AC_K0_MFI + AC_K0_SWE',
    platform: 'Spacecraft L1 de viento solar',
    description: 'Datos directos de ACE para magnetometro y plasma; se muestran como STALE si el ultimo punto no es reciente.',
    variables: ['Time', 'Magnitude', 'BGSEc', 'Np', 'Vp', 'Tpr'],
    status: status.status,
    lastSampleTime: status.lastSampleTime,
    errorMessage: mag.errorMessage ?? plasma.errorMessage,
    charts,
  };
}

async function fetchWindTelemetry(): Promise<SpacecraftTelemetry> {
  const [mag, plasma] = await Promise.all([
    fetchHapiSeries('WI_K0_MFI', ['BF1', 'BGSMc', 'PGSE']),
    fetchHapiSeries('WI_K0_SWE', ['SC_pos_gse', 'V_GSE', 'THERMAL_SPD', 'Np']),
  ]);
  const charts = [
    buildChart('wind-bt', 'BT', 'nT', COLOR.bt, mag.rows, row => toFiniteNumber(row[1])),
    buildChart('wind-bx-gsm', 'BX GSM', 'nT', COLOR.bx, mag.rows, row => vectorComponent(row[2], 0)),
    buildChart('wind-by-gsm', 'BY GSM', 'nT', COLOR.by, mag.rows, row => vectorComponent(row[2], 1)),
    buildChart('wind-bz-gsm', 'BZ GSM', 'nT', COLOR.bz, mag.rows, row => vectorComponent(row[2], 2)),
    buildChart('wind-x-gse', 'X GSE', 'km', COLOR.x, mag.rows, row => {
      const value = vectorComponent(row[3], 0);
      return value === null ? null : value * EARTH_RADIUS_KM;
    }),
    buildChart('wind-y-gse', 'Y GSE', 'km', COLOR.y, mag.rows, row => {
      const value = vectorComponent(row[3], 1);
      return value === null ? null : value * EARTH_RADIUS_KM;
    }),
    buildChart('wind-z-gse', 'Z GSE', 'km', COLOR.z, mag.rows, row => {
      const value = vectorComponent(row[3], 2);
      return value === null ? null : value * EARTH_RADIUS_KM;
    }),
    buildChart('wind-speed', 'Speed', 'km/s', COLOR.speed, plasma.rows, row => vectorMagnitude(row[2])),
    buildChart('wind-thermal-speed', 'Thermal speed', 'km/s', COLOR.thermalSpeed, plasma.rows, row => toFiniteNumber(row[3])),
    buildChart('wind-density', 'Density', 'cm^-3', COLOR.density, plasma.rows, row => toFiniteNumber(row[4])),
  ];
  const status = getStatusFromCharts(charts);

  return {
    id: 'WIND',
    displayName: 'WIND',
    source: 'NASA CDAWeb HAPI',
    endpoint: 'WI_K0_MFI + WI_K0_SWE',
    platform: 'Spacecraft de viento solar / campo magnetico',
    description: 'Datos directos de WIND para campo magnetico, plasma y posicion GSE.',
    variables: ['Time', 'BF1', 'BGSMc', 'PGSE', 'SC_pos_gse', 'V_GSE', 'THERMAL_SPD', 'Np'],
    status: status.status,
    lastSampleTime: status.lastSampleTime,
    errorMessage: mag.errorMessage ?? plasma.errorMessage,
    charts,
  };
}

async function fetchImapTelemetry(): Promise<SpacecraftTelemetry> {
  const [mag, swapi, ephemeris] = await Promise.all([
    fetchHapiSeries('IMAP_IALIRT_L1_REALTIME@1', ['mag_B_magnitude', 'mag_B_GSM']),
    fetchHapiSeries('IMAP_IALIRT_L1_REALTIME@2', [
      'swapi_pseudo_proton_density',
      'swapi_pseudo_proton_speed',
      'swapi_pseudo_proton_temperature',
    ]),
    fetchHapiSeries('IMAP_IALIRT_L1_REALTIME@4', ['sc_position_GSE', 'sc_velocity_GSE']),
  ]);
  const charts = [
    buildChart('imap-bt', 'BT', 'nT', COLOR.bt, mag.rows, row => toFiniteNumber(row[1])),
    buildChart('imap-bx-gsm', 'BX GSM', 'nT', COLOR.bx, mag.rows, row => vectorComponent(row[2], 0)),
    buildChart('imap-by-gsm', 'BY GSM', 'nT', COLOR.by, mag.rows, row => vectorComponent(row[2], 1)),
    buildChart('imap-bz-gsm', 'BZ GSM', 'nT', COLOR.bz, mag.rows, row => vectorComponent(row[2], 2)),
    buildChart('imap-density', 'Density', 'cm^-3', COLOR.density, swapi.rows, row => toFiniteNumber(row[1])),
    buildChart('imap-speed', 'Speed', 'km/s', COLOR.speed, swapi.rows, row => toFiniteNumber(row[2])),
    buildChart('imap-temperature', 'Temperature', 'K', COLOR.temperature, swapi.rows, row => toFiniteNumber(row[3])),
    buildChart('imap-x-gse', 'X GSE', 'km', COLOR.x, ephemeris.rows, row => vectorComponent(row[1], 0)),
    buildChart('imap-y-gse', 'Y GSE', 'km', COLOR.y, ephemeris.rows, row => vectorComponent(row[1], 1)),
    buildChart('imap-z-gse', 'Z GSE', 'km', COLOR.z, ephemeris.rows, row => vectorComponent(row[1], 2)),
  ];
  const status = getStatusFromCharts(charts);

  return {
    id: 'IMAP',
    displayName: 'IMAP',
    source: 'NASA CDAWeb HAPI',
    endpoint: 'IMAP_IALIRT_L1_REALTIME @1 + @2 + @4',
    platform: 'Spacecraft L1 de viento solar y particulas energeticas',
    description: 'Datos I-ALiRT de IMAP para MAG, SWAPI y posicion/velocidad GSE.',
    variables: ['Time', 'mag_B_magnitude', 'mag_B_GSM', 'swapi_pseudo_proton_density', 'swapi_pseudo_proton_speed', 'swapi_pseudo_proton_temperature', 'sc_position_GSE', 'sc_velocity_GSE'],
    status: status.status,
    lastSampleTime: status.lastSampleTime,
    errorMessage: mag.errorMessage ?? swapi.errorMessage ?? ephemeris.errorMessage,
    charts,
  };
}

function buildAseTelemetry(): SpacecraftTelemetry {
  return {
    id: 'ASE',
    displayName: 'ASE',
    source: 'Sin fuente identificada',
    endpoint: 'Pendiente de confirmar dataset',
    platform: 'Spacecraft solicitado para integracion',
    description: 'No he encontrado un dataset heliosferico oficial identificable como ASE en CDAWeb/HAPI. Se mantiene como seleccionable pendiente de confirmar el nombre correcto de la mision.',
    variables: ['sin feed conectado'],
    status: 'off',
    lastSampleTime: null,
    errorMessage: 'Dataset ASE no identificado',
    charts: [],
  };
}

async function fetchExternalSpacecraftTelemetry(): Promise<SpacecraftTelemetry[]> {
  if (externalSpacecraftCache && Date.now() < externalSpacecraftCache.expiresAt) {
    return externalSpacecraftCache.data;
  }

  const [imapTelemetry, windTelemetry, aceTelemetry] = await Promise.all([
    fetchImapTelemetry(),
    fetchWindTelemetry(),
    fetchAceTelemetry(),
  ]);

  const data = [
    buildAseTelemetry(),
    imapTelemetry,
    windTelemetry,
    aceTelemetry,
  ];

  externalSpacecraftCache = {
    expiresAt: Date.now() + HAPI_CACHE_MS,
    data,
  };

  return data;
}

export async function fetchSpacecraftTelemetry(
  input: BuildSpacecraftTelemetryInput,
): Promise<SpacecraftTelemetry[]> {
  const externalTelemetry = await fetchExternalSpacecraftTelemetry();

  return [
    ...externalTelemetry,
    buildDscovrTelemetry(input),
  ];
}
