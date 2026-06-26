export interface SatelliteTLE {
  name: string;
  line1: string;
  line2: string;
  source: string;
}

export interface CelesTrakResponse {
  isConnected: boolean;
  lastUpdated: string | null;
  errorMessage: string | null;
  tles: SatelliteTLE[];
  /** True when CelesTrak was unreachable and we served the last good copy from cache. */
  stale?: boolean;
}

const FETCH_TIMEOUT_MS = 6_000;
const MAX_ATTEMPTS = 2; // initial try + one retry; CelesTrak blips are usually transient
const RETRY_BACKOFF_MS = 600;

// TLEs only refresh a few times a day, so a copy this recent is "fresh" for our purposes.
// Within this window we serve the cached catalog directly and never touch CelesTrak — fast
// repeat loads and far fewer requests (CelesTrak rate-limits aggressive callers).
const SOFT_TTL_MS = 30 * 60 * 1_000;

// Last good catalog per group, kept in module memory for the life of the server process.
// Shared by the server page load and the /api/tle route (same process), so a catalog fetched
// once is reused everywhere until it goes stale. In-memory only: a restart re-fetches.
const lastGood = new Map<string, { response: CelesTrakResponse; fetchedAtMs: number }>();

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const parseTleText = (text: string, groupName: string): SatelliteTLE[] => {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tles: SatelliteTLE[] = [];

  for (let i = 0; i < lines.length - 2; i++) {
    const current = lines[i];
    const next1 = lines[i + 1];
    const next2 = lines[i + 2];

    if (!current.startsWith('1 ') && !current.startsWith('2 ') && next1.startsWith('1 ') && next2.startsWith('2 ')) {
      tles.push({
        name: current,
        line1: next1,
        line2: next2,
        source: `celestrak-${groupName}`,
      });
      i += 2; // Skip the next two lines as they are processed
    }
  }

  return tles;
};

// One CelesTrak request. Returns the parsed catalog, or null on any failure (HTTP error,
// timeout, network error, or empty/garbled body) so the caller can retry / fall back.
async function fetchOnce(groupName: string): Promise<SatelliteTLE[] | null> {
  const endpoint = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${groupName}&FORMAT=tle`;
  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const tles = parseTleText(await response.text(), groupName);
    return tles.length > 0 ? tles : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a CelesTrak TLE group, resilient to CelesTrak being slow or down.
 *
 * Order of preference:
 *  1. A cached catalog younger than SOFT_TTL_MS — returned instantly, no upstream call.
 *  2. A fresh fetch (retried once on a transient failure/timeout).
 *  3. The last good cached catalog, marked `stale` — real orbits, just an older snapshot.
 *  4. An offline response, only if we have never successfully fetched this group.
 */
export async function fetchTleGroup(groupName: string = 'stations'): Promise<CelesTrakResponse> {
  // 1. Serve a recent copy without hitting CelesTrak at all.
  const cached = lastGood.get(groupName);
  if (cached && Date.now() - cached.fetchedAtMs < SOFT_TTL_MS) {
    return cached.response;
  }

  // 2. Cache is missing or expired — try CelesTrak, retrying a transient failure/timeout.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS);
    const tles = await fetchOnce(groupName);
    if (tles) {
      const response: CelesTrakResponse = {
        isConnected: true,
        lastUpdated: new Date().toISOString(),
        errorMessage: null,
        tles,
        stale: false,
      };
      lastGood.set(groupName, { response, fetchedAtMs: Date.now() });
      return response;
    }
  }

  // 3. CelesTrak is unreachable. Serve the last good copy (real data, just older) if we have one.
  if (cached) {
    return { ...cached.response, stale: true };
  }

  // 4. Never fetched this group successfully and CelesTrak is down — nothing real to show.
  return {
    isConnected: false,
    lastUpdated: null,
    errorMessage: 'CelesTrak unavailable',
    tles: [],
    stale: false,
  };
}
