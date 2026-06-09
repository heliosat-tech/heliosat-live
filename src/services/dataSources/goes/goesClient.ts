import {
  compactQualityFlags,
  fetchJsonWithRetry,
  minuteKey,
  parseTimestampMs,
  toFiniteNumber,
} from '../dataSourceUtils';
import type { DataSourceFetchResult, GoesSample, SourceAttribution } from '../types';

type GoesRole = 'primary' | 'secondary';
type GoesWindow = '6-hour' | '1-day' | '3-day' | '7-day';

export interface GoesClientOptions {
  role?: GoesRole;
  window?: GoesWindow;
  protonEnergy?: string;
  electronEnergy?: string;
  xrayEnergy?: string;
}

interface GoesScalarPoint {
  time_tag?: string;
  satellite?: number | string | null;
  flux?: number | string | null;
  energy?: string | null;
}

interface GoesMagPoint extends GoesScalarPoint {
  Hp?: number | string | null;
  total?: number | string | null;
  arcjet_flag?: boolean | string | number | null;
}

interface MutableGoesSample {
  timeUtc: string;
  satellite: string;
  protonFlux: number | null;
  electronFlux: number | null;
  xrayFlux: number | null;
  hpNt: number | null;
  hTotalNt: number | null;
  qualityFlags: string[];
  sourceAttribution: SourceAttribution[];
}

const SWPC_GOES_BASE_URL = 'https://services.swpc.noaa.gov/json/goes';
const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_PROTON_ENERGY = '>=10 MeV';
const DEFAULT_ELECTRON_ENERGY = '>=2 MeV';
const DEFAULT_XRAY_ENERGY = '0.1-0.8nm';

function buildProductUrl(role: GoesRole, product: string, window: GoesWindow) {
  return `${SWPC_GOES_BASE_URL}/${role}/${product}-${window}.json`;
}

function buildAttribution(
  role: GoesRole,
  dataset: string,
  url: string,
  retrievedAtUtc: string,
): SourceAttribution {
  return {
    sourceId: 'goes',
    provider: 'NOAA SWPC',
    dataset: `GOES ${role} ${dataset}`,
    url,
    retrievedAtUtc,
    cadenceSeconds: 60,
    notes: 'GEO context measurement, not an L1 solar-wind source.',
  };
}

function parseSatellite(value: unknown, fallback: string) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const label = String(value);
  return /^goes-/i.test(label) ? label.toUpperCase() : `GOES-${label}`;
}

function parseArcjetFlag(value: GoesMagPoint['arcjet_flag']) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  return false;
}

async function fetchGoesProduct<T>(
  role: GoesRole,
  product: string,
  window: GoesWindow,
): Promise<{ rows: T[]; attribution: SourceAttribution; error: string | null }> {
  const retrievedAtUtc = new Date().toISOString();
  const url = buildProductUrl(role, product, window);
  const attribution = buildAttribution(role, product, url, retrievedAtUtc);

  try {
    const payload = await fetchJsonWithRetry(url, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: 1,
      label: `NOAA SWPC GOES ${product}`,
    });

    return {
      rows: Array.isArray(payload) ? payload as T[] : [],
      attribution,
      error: Array.isArray(payload) ? null : `${product}: unexpected response shape`,
    };
  } catch (error) {
    return {
      rows: [],
      attribution,
      error: error instanceof Error ? error.message : `${product}: request failed`,
    };
  }
}

function ensureSample(
  byMinute: Map<number, MutableGoesSample>,
  timestampMs: number,
  satellite: string,
) {
  const key = minuteKey(timestampMs);
  const existing = byMinute.get(key);

  if (existing) {
    if (existing.satellite === 'GOES-primary' || existing.satellite === 'GOES-secondary') {
      existing.satellite = satellite;
    }
    return existing;
  }

  const sample: MutableGoesSample = {
    timeUtc: new Date(key).toISOString(),
    satellite,
    protonFlux: null,
    electronFlux: null,
    xrayFlux: null,
    hpNt: null,
    hTotalNt: null,
    qualityFlags: [],
    sourceAttribution: [],
  };
  byMinute.set(key, sample);

  return sample;
}

function mergeMagRows(
  rows: GoesMagPoint[],
  attribution: SourceAttribution,
  role: GoesRole,
  byMinute: Map<number, MutableGoesSample>,
) {
  for (const row of rows) {
    const timestampMs = parseTimestampMs(row.time_tag);
    if (timestampMs === null) continue;

    const contaminated = parseArcjetFlag(row.arcjet_flag);
    const sample = ensureSample(byMinute, timestampMs, parseSatellite(row.satellite, `GOES-${role}`));
    sample.hpNt = contaminated ? null : toFiniteNumber(row.Hp);
    sample.hTotalNt = contaminated ? null : toFiniteNumber(row.total);
    if (contaminated) {
      sample.qualityFlags.push('goes_mag_arcjet_contaminated');
    }
    sample.sourceAttribution.push(attribution);
  }
}

function mergeFluxRows(
  rows: GoesScalarPoint[],
  attribution: SourceAttribution,
  role: GoesRole,
  energy: string,
  field: 'protonFlux' | 'electronFlux' | 'xrayFlux',
  byMinute: Map<number, MutableGoesSample>,
) {
  for (const row of rows) {
    if (row.energy !== energy) continue;

    const timestampMs = parseTimestampMs(row.time_tag);
    if (timestampMs === null) continue;

    const sample = ensureSample(byMinute, timestampMs, parseSatellite(row.satellite, `GOES-${role}`));
    sample[field] = toFiniteNumber(row.flux);
    sample.sourceAttribution.push(attribution);
  }
}

function sampleQualityFlags(sample: MutableGoesSample) {
  return compactQualityFlags([
    ...sample.qualityFlags,
    sample.protonFlux === null ? 'missing_proton_flux' : null,
    sample.electronFlux === null ? 'missing_electron_flux' : null,
    sample.xrayFlux === null ? 'missing_xray_flux' : null,
    sample.hpNt === null ? 'missing_hp' : null,
    sample.hTotalNt === null ? 'missing_h_total' : null,
  ]);
}

export async function fetchGoesContextSamples(
  options: GoesClientOptions = {},
): Promise<DataSourceFetchResult<GoesSample>> {
  const role = options.role ?? 'primary';
  const window = options.window ?? '6-hour';
  const protonEnergy = options.protonEnergy ?? DEFAULT_PROTON_ENERGY;
  const electronEnergy = options.electronEnergy ?? DEFAULT_ELECTRON_ENERGY;
  const xrayEnergy = options.xrayEnergy ?? DEFAULT_XRAY_ENERGY;
  const fetchedAtUtc = new Date().toISOString();
  const byMinute = new Map<number, MutableGoesSample>();
  const warnings: string[] = [];

  const [mag, protons, electrons, xrays] = await Promise.all([
    fetchGoesProduct<GoesMagPoint>(role, 'magnetometers', window),
    fetchGoesProduct<GoesScalarPoint>(role, 'integral-protons', window),
    fetchGoesProduct<GoesScalarPoint>(role, 'integral-electrons', window),
    fetchGoesProduct<GoesScalarPoint>(role, 'xrays', window),
  ]);

  const sourceAttribution = [mag.attribution, protons.attribution, electrons.attribution, xrays.attribution];
  const errors = [mag.error, protons.error, electrons.error, xrays.error]
    .filter((error): error is string => Boolean(error));

  if (mag.rows.length === 0) warnings.push('GOES magnetometer returned no samples');
  if (protons.rows.length === 0) warnings.push('GOES proton flux returned no samples');
  if (electrons.rows.length === 0) warnings.push('GOES electron flux returned no samples');
  if (xrays.rows.length === 0) warnings.push('GOES X-ray flux returned no samples');

  mergeMagRows(mag.rows, mag.attribution, role, byMinute);
  mergeFluxRows(protons.rows, protons.attribution, role, protonEnergy, 'protonFlux', byMinute);
  mergeFluxRows(electrons.rows, electrons.attribution, role, electronEnergy, 'electronFlux', byMinute);
  mergeFluxRows(xrays.rows, xrays.attribution, role, xrayEnergy, 'xrayFlux', byMinute);

  const samples: GoesSample[] = [...byMinute.values()]
    .sort((a, b) => new Date(a.timeUtc).getTime() - new Date(b.timeUtc).getTime())
    .map(sample => ({
      timeUtc: sample.timeUtc,
      source: 'goes',
      satellite: sample.satellite,
      protonFlux: sample.protonFlux,
      electronFlux: sample.electronFlux,
      xrayFlux: sample.xrayFlux,
      hpNt: sample.hpNt,
      hTotalNt: sample.hTotalNt,
      qualityFlags: sampleQualityFlags(sample),
      sourceAttribution: [...new Map(sample.sourceAttribution.map(attr => [attr.dataset, attr])).values()],
    }));

  return {
    samples,
    sourceAttribution,
    qualityFlags: compactQualityFlags([
      samples.length === 0 ? 'no_goes_samples' : null,
      ...errors.map(() => 'source_request_failed'),
    ]),
    fetchedAtUtc,
    warnings,
    errors,
  };
}
