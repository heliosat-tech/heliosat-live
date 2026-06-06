export type NearEarthConnectionStatus = 'live' | 'stale' | 'off';

export interface NearEarthChartPoint {
  time_tag: string;
  value: string | number | null;
}

export interface NearEarthChartSeries {
  id: string;
  sourceId: string;
  spacecraft: string;
  title: string;
  unit: string;
  color: string;
  data: NearEarthChartPoint[];
}

export interface NearEarthTelemetryFeed {
  id: string;
  sourceId: string;
  displayName: string;
  source: string;
  endpoint: string;
  platform: string;
  description: string;
  variables: string[];
  status: NearEarthConnectionStatus;
  lastSampleTime: string | null;
  errorMessage: string | null;
  charts: NearEarthChartSeries[];
}

type GoesRole = 'primary' | 'secondary';

interface GoesScalarPoint {
  time_tag?: string;
  satellite?: number | string;
  flux?: number | string | null;
  value?: number | string | null;
  energy?: string;
  line?: string;
}

interface GoesMagPoint extends GoesScalarPoint {
  He?: number | string | null;
  Hp?: number | string | null;
  Hn?: number | string | null;
  total?: number | string | null;
}

interface GoesDatasetResult<T> {
  rows: T[];
  errorMessage: string | null;
}

interface GoesRoleDatasets {
  role: GoesRole;
  mag: GoesDatasetResult<GoesMagPoint>;
  electrons: GoesDatasetResult<GoesScalarPoint>;
  protons: GoesDatasetResult<GoesScalarPoint>;
  xrays: GoesDatasetResult<GoesScalarPoint>;
}

const SWPC_GOES_BASE_URL = 'https://services.swpc.noaa.gov/json/goes';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 350;
const CACHE_MS = 60 * 1000;
const FRESH_SAMPLE_MS = 45 * 60 * 1000;
const FUTURE_SAMPLE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_POINTS_PER_CHART = 180;

const COLOR = {
  hn: '#22d3ee',
  hp: '#a78bfa',
  total: '#38bdf8',
  electron: '#34d399',
  proton: '#fb7185',
  xrs: '#f59e0b',
};

let nearEarthTelemetryCache: {
  expiresAt: number;
  data: NearEarthTelemetryFeed[];
} | null = null;

function sleep(delayMs: number) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function parseTimestampUtc(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

function downsample<T>(rows: T[], maxPoints = MAX_POINTS_PER_CHART) {
  if (rows.length <= maxPoints) {
    return rows;
  }

  const step = Math.ceil(rows.length / maxPoints);

  return rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
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
        throw new Error(`NOAA GOES request failed with ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('NOAA GOES request failed');

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('NOAA GOES request failed');
}

async function fetchGoesDataset<T>(role: GoesRole, fileName: string): Promise<GoesDatasetResult<T>> {
  const url = `${SWPC_GOES_BASE_URL}/${role}/${fileName}`;

  try {
    const data = await fetchJsonWithRetry(url);

    if (!Array.isArray(data)) {
      return {
        rows: [],
        errorMessage: `${role}/${fileName}: unexpected response shape`,
      };
    }

    return {
      rows: data as T[],
      errorMessage: null,
    };
  } catch (error) {
    return {
      rows: [],
      errorMessage: error instanceof Error ? `${role}/${fileName}: ${error.message}` : `${role}/${fileName}: request failed`,
    };
  }
}

async function fetchGoesRoleDatasets(role: GoesRole): Promise<GoesRoleDatasets> {
  const [mag, electrons, protons, xrays] = await Promise.all([
    fetchGoesDataset<GoesMagPoint>(role, 'magnetometers-6-hour.json'),
    fetchGoesDataset<GoesScalarPoint>(role, 'integral-electrons-6-hour.json'),
    fetchGoesDataset<GoesScalarPoint>(role, 'integral-protons-6-hour.json'),
    fetchGoesDataset<GoesScalarPoint>(role, 'xrays-6-hour.json'),
  ]);

  return {
    role,
    mag,
    electrons,
    protons,
    xrays,
  };
}

function getSpacecraftLabel(rows: GoesScalarPoint[], role: GoesRole) {
  const satellite = rows.find(row => row.satellite !== undefined && row.satellite !== null)?.satellite;

  return satellite ? `GOES-${satellite}` : `GOES ${role}`;
}

function buildChart(
  id: string,
  sourceId: string,
  spacecraft: string,
  title: string,
  unit: string,
  color: string,
  rows: GoesScalarPoint[],
  getValue: (row: GoesScalarPoint) => number | null,
) {
  return {
    id,
    sourceId,
    spacecraft,
    title,
    unit,
    color,
    data: downsample(rows)
      .map(row => {
        const timestampUtc = parseTimestampUtc(row.time_tag);

        return {
          time_tag: timestampUtc ?? '',
          value: getValue(row),
        };
      })
      .filter(point => point.time_tag),
  };
}

function buildGoesCharts(datasets: GoesRoleDatasets) {
  const sourceId = 'swpc-goes-json';
  const roleLabel = datasets.role === 'primary' ? 'primary' : 'secondary';
  const electronRows = datasets.electrons.rows.filter(row => row.energy === '>=2 MeV');
  const protonRows = datasets.protons.rows.filter(row => row.energy === '>=10 MeV');
  const xrsRows = datasets.xrays.rows.filter(row => row.energy === '0.1-0.8nm');
  const magSpacecraft = getSpacecraftLabel(datasets.mag.rows, datasets.role);
  const electronSpacecraft = getSpacecraftLabel(electronRows, datasets.role);
  const protonSpacecraft = getSpacecraftLabel(protonRows, datasets.role);
  const xrsSpacecraft = getSpacecraftLabel(xrsRows, datasets.role);

  return [
    buildChart(
      `goes-${datasets.role}-mag-hn`,
      sourceId,
      magSpacecraft,
      `${roleLabel} MAG Hn`,
      'nT',
      COLOR.hn,
      datasets.mag.rows,
      row => toFiniteNumber((row as GoesMagPoint).Hn),
    ),
    buildChart(
      `goes-${datasets.role}-mag-hp`,
      sourceId,
      magSpacecraft,
      `${roleLabel} MAG Hp`,
      'nT',
      COLOR.hp,
      datasets.mag.rows,
      row => toFiniteNumber((row as GoesMagPoint).Hp),
    ),
    buildChart(
      `goes-${datasets.role}-mag-total`,
      sourceId,
      magSpacecraft,
      `${roleLabel} MAG |H|`,
      'nT',
      COLOR.total,
      datasets.mag.rows,
      row => toFiniteNumber((row as GoesMagPoint).total),
    ),
    buildChart(
      `goes-${datasets.role}-electrons-2mev`,
      sourceId,
      electronSpacecraft,
      `${roleLabel} electrons >=2 MeV`,
      'pfu',
      COLOR.electron,
      electronRows,
      row => toFiniteNumber(row.flux),
    ),
    buildChart(
      `goes-${datasets.role}-protons-10mev`,
      sourceId,
      protonSpacecraft,
      `${roleLabel} protons >=10 MeV`,
      'pfu',
      COLOR.proton,
      protonRows,
      row => toFiniteNumber(row.flux),
    ),
    buildChart(
      `goes-${datasets.role}-xrs-long`,
      sourceId,
      xrsSpacecraft,
      `${roleLabel} XRS 0.1-0.8 nm`,
      'W/m^2',
      COLOR.xrs,
      xrsRows,
      row => toFiniteNumber(row.flux),
    ),
  ].filter(chart => chart.data.length > 0);
}

function getLatestSampleTime(charts: NearEarthChartSeries[]) {
  const latestMs = charts.reduce((currentLatest, chart) => {
    return chart.data.reduce((chartLatest, point) => {
      const timestamp = parseTimestampUtc(point.time_tag);
      const parsed = timestamp ? new Date(timestamp) : null;

      return parsed ? Math.max(chartLatest, parsed.getTime()) : chartLatest;
    }, currentLatest);
  }, 0);

  return latestMs > 0 ? new Date(latestMs).toISOString() : null;
}

function getStatusFromCharts(charts: NearEarthChartSeries[]) {
  const lastSampleTime = getLatestSampleTime(charts);

  if (!lastSampleTime) {
    return { status: 'off' as const, lastSampleTime: null };
  }

  const sampleAgeMs = Date.now() - new Date(lastSampleTime).getTime();
  const isFresh = sampleAgeMs >= -FUTURE_SAMPLE_TOLERANCE_MS && sampleAgeMs <= FRESH_SAMPLE_MS;

  return {
    status: isFresh ? 'live' as const : 'stale' as const,
    lastSampleTime,
  };
}

export async function fetchNearEarthTelemetry(): Promise<NearEarthTelemetryFeed[]> {
  if (nearEarthTelemetryCache && Date.now() < nearEarthTelemetryCache.expiresAt) {
    return nearEarthTelemetryCache.data;
  }

  const roleDatasets = await Promise.all([
    fetchGoesRoleDatasets('primary'),
    fetchGoesRoleDatasets('secondary'),
  ]);
  const charts = roleDatasets.flatMap(buildGoesCharts);
  const status = getStatusFromCharts(charts);
  const errors = roleDatasets
    .flatMap(datasets => [
      datasets.mag.errorMessage,
      datasets.electrons.errorMessage,
      datasets.protons.errorMessage,
      datasets.xrays.errorMessage,
    ])
    .filter((message): message is string => Boolean(message));

  const data: NearEarthTelemetryFeed[] = [
    {
      id: 'goes-primary-secondary',
      sourceId: 'swpc-goes-json',
      displayName: 'GOES primary/secondary',
      source: 'NOAA SWPC GOES JSON',
      endpoint: `${SWPC_GOES_BASE_URL}/{primary,secondary}/*-6-hour.json`,
      platform: 'GEO operational space-weather environment',
      description: 'Live GOES magnetometer, integral particle flux, and XRS products from NOAA SWPC.',
      variables: ['MAG Hn/Hp/|H|', 'electrons >=2 MeV', 'protons >=10 MeV', 'XRS 0.1-0.8 nm'],
      status: status.status,
      lastSampleTime: status.lastSampleTime,
      errorMessage: errors.length > 0 ? errors.slice(0, 4).join('; ') : null,
      charts,
    },
  ];

  nearEarthTelemetryCache = {
    expiresAt: Date.now() + CACHE_MS,
    data,
  };

  return data;
}
