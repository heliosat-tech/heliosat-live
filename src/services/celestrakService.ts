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
}

const CELESTRAK_FETCH_TIMEOUT_MS = 8_000;

export async function fetchTleGroup(groupName: string = 'stations'): Promise<CelesTrakResponse> {
  const CELESTRAK_ENDPOINT = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${groupName}&FORMAT=tle`;
  
  try {
    const response = await fetch(CELESTRAK_ENDPOINT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(CELESTRAK_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'CelesTrak unavailable',
        tles: []
      };
    }

    const text = await response.text();
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
          source: `celestrak-${groupName}`
        });
        i += 2; // Skip the next two lines as they are processed
      }
    }

    if (tles.length === 0) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'No satellite data available',
        tles: []
      };
    }

    return {
      isConnected: true,
      lastUpdated: new Date().toISOString(),
      errorMessage: null,
      tles
    };

  } catch {
    return {
      isConnected: false,
      lastUpdated: null,
      errorMessage: 'CelesTrak unavailable',
      tles: []
    };
  }
}
