/**
 * Resolves a historical window anchored to the *actual* data coverage of the
 * CDAWeb HAPI datasets, instead of the machine clock. This matters because the
 * datasets lag real time (e.g. OMNI ~2 weeks, ACE ~1 week), so a "last N days"
 * window computed from `now` can land entirely in a future gap with no data.
 *
 * We end the window at the earliest stop date across the datasets (the binding
 * constraint) so every dataset has data throughout the window.
 */
const HAPI_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/hapi';
const DEFAULT_COVERAGE_DATASETS = ['OMNI_HRO_1MIN', 'AC_K0_SWE'];

export interface CoverageRange {
  startUtc: string;
  stopUtc: string;
}

/** Latest timestamp a HAPI dataset actually has data for (from /info stopDate). */
async function fetchDatasetStopMs(datasetId: string): Promise<number | null> {
  try {
    const response = await fetch(`${HAPI_BASE_URL}/info?id=${encodeURIComponent(datasetId)}`, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const info = (await response.json()) as { stopDate?: string };
    const ms = info.stopDate ? new Date(info.stopDate).getTime() : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Returns a `days`-long window ending at the earliest dataset stop date, or
 * `null` if coverage could not be probed (callers fall back to a clock window).
 */
export async function resolveCoverageAnchoredRange(
  days = 3,
  datasets: string[] = DEFAULT_COVERAGE_DATASETS,
): Promise<CoverageRange | null> {
  const stops = (await Promise.all(datasets.map(fetchDatasetStopMs))).filter(
    (value): value is number => value !== null,
  );

  if (stops.length === 0) {
    return null;
  }

  const stopMs = Math.min(...stops);
  const startMs = stopMs - days * 24 * 60 * 60 * 1000;

  return { startUtc: new Date(startMs).toISOString(), stopUtc: new Date(stopMs).toISOString() };
}
