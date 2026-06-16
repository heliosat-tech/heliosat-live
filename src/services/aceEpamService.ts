export interface AceEpamPoint {
  t: number;
  de1: number | null;
  de4: number | null;
}

export interface AceEpamSeries {
  sourceLabel: string;
  unit: string;
  latestTimeUtc: string | null;
  latestDe1: number | null;
  latestDe4: number | null;
  points: AceEpamPoint[];
  warning: string | null;
}

interface AceEpamRow {
  time_tag?: string;
  dsflag_de1?: number;
  dsflag_de4?: number;
  de1?: number;
  de4?: number;
}

const ACE_EPAM_32S_URL = 'https://services.swpc.noaa.gov/json/ace/epam/ace_epam_32s.json';
const MISSING_FLUX = -1.0e5;

function parseSwpcTime(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value.endsWith('Z') ? value : `${value}Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function validFlux(value: unknown, flag: unknown): number | null {
  if (flag !== 0) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= MISSING_FLUX || value < 0) return null;
  return value;
}

export async function fetchAceEpamElectronFlux(options: {
  startMs?: number;
  endMs?: number;
  maxPoints?: number;
} = {}): Promise<AceEpamSeries> {
  const sourceLabel = 'ACE EPAM L1';
  const unit = 'particles/cm^2-s-sr-MeV';

  try {
    const response = await fetch(ACE_EPAM_32S_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`SWPC ACE EPAM returned ${response.status}`);
    }

    const rows = await response.json() as AceEpamRow[];
    const points = rows
      .map((row): AceEpamPoint | null => {
        const t = parseSwpcTime(row.time_tag);
        if (t === null) return null;
        return {
          t,
          de1: validFlux(row.de1, row.dsflag_de1),
          de4: validFlux(row.de4, row.dsflag_de4),
        };
      })
      .filter((point): point is AceEpamPoint => point !== null)
      .filter(point => (options.startMs === undefined || point.t >= options.startMs) && (options.endMs === undefined || point.t <= options.endMs))
      .sort((a, b) => a.t - b.t);

    const sampledPoints = downsampleEpamPoints(points, options.maxPoints ?? 180);
    const latest = [...points].reverse().find(point => point.de1 !== null || point.de4 !== null) ?? null;

    return {
      sourceLabel,
      unit,
      latestTimeUtc: latest ? new Date(latest.t).toISOString() : null,
      latestDe1: latest?.de1 ?? null,
      latestDe4: latest?.de4 ?? null,
      points: sampledPoints,
      warning: null,
    };
  } catch (error) {
    return {
      sourceLabel,
      unit,
      latestTimeUtc: null,
      latestDe1: null,
      latestDe4: null,
      points: [],
      warning: error instanceof Error ? error.message : 'ACE EPAM electron flux unavailable.',
    };
  }
}

function downsampleEpamPoints(points: AceEpamPoint[], target: number): AceEpamPoint[] {
  if (points.length <= target) return points;
  const startMs = points[0].t;
  const endMs = points[points.length - 1].t;
  const span = Math.max(1, endMs - startMs);
  const bucketMs = span / target;
  const buckets = new Map<number, { t: number; de1: number[]; de4: number[] }>();

  for (const point of points) {
    const key = Math.floor((point.t - startMs) / bucketMs);
    const bucket = buckets.get(key) ?? { t: startMs + (key + 0.5) * bucketMs, de1: [], de4: [] };
    if (point.de1 !== null) bucket.de1.push(point.de1);
    if (point.de4 !== null) bucket.de4.push(point.de4);
    buckets.set(key, bucket);
  }

  const avg = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  return [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map(bucket => ({
      t: Math.round(bucket.t),
      de1: avg(bucket.de1),
      de4: avg(bucket.de4),
    }));
}
