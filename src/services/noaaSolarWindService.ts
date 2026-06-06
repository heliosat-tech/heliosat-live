export interface NoaaMagnetometerData {
  time_tag: string;
  bx_gsm: string | null;
  by_gsm: string | null;
  bz_gsm: string | null;
  lon_gsm: string | null;
  lat_gsm: string | null;
  bt: string | null;
}

export interface NoaaPlasmaData {
  time_tag: string;
  density: string | null;
  speed: string | null;
  temperature: string | null;
}

export interface NoaaEphemerisData {
  time_tag: string;
  x_gse: string | null;
  y_gse: string | null;
  z_gse: string | null;
  vx_gse: string | null;
  vy_gse: string | null;
  vz_gse: string | null;
  x_gsm: string | null;
  y_gsm: string | null;
  z_gsm: string | null;
  vx_gsm: string | null;
  vy_gsm: string | null;
  vz_gsm: string | null;
}

export interface NoaaServiceResponse<T> {
  isConnected: boolean;
  lastUpdated: string | null;
  errorMessage: string | null;
  latestData: T | null;
  timeSeries: T[];
}

const NOAA_MAG_ENDPOINT = 'https://services.swpc.noaa.gov/products/solar-wind/mag-2-hour.json';
const NOAA_PLASMA_ENDPOINT = 'https://services.swpc.noaa.gov/products/solar-wind/plasma-2-hour.json';
const NOAA_EPHEMERIS_ENDPOINT = 'https://services.swpc.noaa.gov/products/solar-wind/ephemerides.json';
const NOAA_LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
const NOAA_FUTURE_SAMPLE_TOLERANCE_MS = 5 * 60 * 1000;
const NOAA_FETCH_TIMEOUT_MS = 8_000;

function parseNoaaTimeTag(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value.replace(' ', 'T')}Z`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isInNoaaLiveWindow(value: string | null | undefined, nowMs = Date.now()) {
  const parsed = parseNoaaTimeTag(value);

  if (!parsed) {
    return false;
  }

  const sampleAgeMs = nowMs - parsed.getTime();

  return sampleAgeMs >= -NOAA_FUTURE_SAMPLE_TOLERANCE_MS
    && sampleAgeMs <= NOAA_LIVE_WINDOW_MS;
}

export async function fetchNoaaMagnetometerData(): Promise<NoaaServiceResponse<NoaaMagnetometerData>> {
  try {
    const response = await fetch(NOAA_MAG_ENDPOINT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(NOAA_FETCH_TIMEOUT_MS),
    });
    
    if (!response.ok) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'NOAA magnetometer unavailable',
        latestData: null,
        timeSeries: []
      };
    }

    const data: string[][] = await response.json();

    if (!Array.isArray(data) || data.length <= 1) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'No magnetometer data available',
        latestData: null,
        timeSeries: []
      };
    }

    // Parse header
    const header = data[0];
    const timeIdx = header.indexOf('time_tag');
    const bxIdx = header.indexOf('bx_gsm');
    const byIdx = header.indexOf('by_gsm');
    const bzIdx = header.indexOf('bz_gsm');
    const lonIdx = header.indexOf('lon_gsm');
    const latIdx = header.indexOf('lat_gsm');
    const btIdx = header.indexOf('bt');

    if (timeIdx === -1) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'Invalid data format',
        latestData: null,
        timeSeries: []
      };
    }

    const timeSeries: NoaaMagnetometerData[] = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      timeSeries.push({
        time_tag: row[timeIdx],
        bx_gsm: bxIdx !== -1 ? row[bxIdx] : null,
        by_gsm: byIdx !== -1 ? row[byIdx] : null,
        bz_gsm: bzIdx !== -1 ? row[bzIdx] : null,
        lon_gsm: lonIdx !== -1 ? row[lonIdx] : null,
        lat_gsm: latIdx !== -1 ? row[latIdx] : null,
        bt: btIdx !== -1 ? row[btIdx] : null,
      });
    }

    // Get the latest valid row
    const latestData = timeSeries.length > 0 ? timeSeries[timeSeries.length - 1] : null;

    return {
      isConnected: true,
      lastUpdated: new Date().toISOString(),
      errorMessage: null,
      latestData,
      timeSeries
    };

  } catch {
    return {
      isConnected: false,
      lastUpdated: null,
      errorMessage: 'NOAA magnetometer unavailable',
      latestData: null,
      timeSeries: []
    };
  }
}

export async function fetchNoaaPlasmaData(): Promise<NoaaServiceResponse<NoaaPlasmaData>> {
  try {
    const response = await fetch(NOAA_PLASMA_ENDPOINT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(NOAA_FETCH_TIMEOUT_MS),
    });
    
    if (!response.ok) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'NOAA plasma unavailable',
        latestData: null,
        timeSeries: []
      };
    }

    const data: string[][] = await response.json();

    if (!Array.isArray(data) || data.length <= 1) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'No plasma data available',
        latestData: null,
        timeSeries: []
      };
    }

    const header = data[0];
    const timeIdx = header.indexOf('time_tag');
    const densityIdx = header.indexOf('density');
    const speedIdx = header.indexOf('speed');
    const tempIdx = header.indexOf('temperature');

    if (timeIdx === -1) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'Invalid data format',
        latestData: null,
        timeSeries: []
      };
    }

    const timeSeries: NoaaPlasmaData[] = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      timeSeries.push({
        time_tag: row[timeIdx],
        density: densityIdx !== -1 ? row[densityIdx] : null,
        speed: speedIdx !== -1 ? row[speedIdx] : null,
        temperature: tempIdx !== -1 ? row[tempIdx] : null,
      });
    }

    const latestData = timeSeries.length > 0 ? timeSeries[timeSeries.length - 1] : null;

    return {
      isConnected: true,
      lastUpdated: new Date().toISOString(),
      errorMessage: null,
      latestData,
      timeSeries
    };

  } catch {
    return {
      isConnected: false,
      lastUpdated: null,
      errorMessage: 'NOAA plasma unavailable',
      latestData: null,
      timeSeries: []
    };
  }
}

export async function fetchNoaaEphemerisData(): Promise<NoaaServiceResponse<NoaaEphemerisData>> {
  try {
    const response = await fetch(NOAA_EPHEMERIS_ENDPOINT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(NOAA_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'NOAA spacecraft ephemeris unavailable',
        latestData: null,
        timeSeries: []
      };
    }

    const data: string[][] = await response.json();

    if (!Array.isArray(data) || data.length <= 1) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'No spacecraft ephemeris available',
        latestData: null,
        timeSeries: []
      };
    }

    const header = data[0];
    const timeIdx = header.indexOf('time_tag');
    const xGseIdx = header.indexOf('x_gse');
    const yGseIdx = header.indexOf('y_gse');
    const zGseIdx = header.indexOf('z_gse');
    const vxGseIdx = header.indexOf('vx_gse');
    const vyGseIdx = header.indexOf('vy_gse');
    const vzGseIdx = header.indexOf('vz_gse');
    const xGsmIdx = header.indexOf('x_gsm');
    const yGsmIdx = header.indexOf('y_gsm');
    const zGsmIdx = header.indexOf('z_gsm');
    const vxGsmIdx = header.indexOf('vx_gsm');
    const vyGsmIdx = header.indexOf('vy_gsm');
    const vzGsmIdx = header.indexOf('vz_gsm');

    if (timeIdx === -1) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'Invalid ephemeris format',
        latestData: null,
        timeSeries: []
      };
    }

    const timeSeries: NoaaEphemerisData[] = [];
    const nowMs = Date.now();

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const timeTag = row[timeIdx];

      if (!isInNoaaLiveWindow(timeTag, nowMs)) {
        continue;
      }

      timeSeries.push({
        time_tag: timeTag,
        x_gse: xGseIdx !== -1 ? row[xGseIdx] : null,
        y_gse: yGseIdx !== -1 ? row[yGseIdx] : null,
        z_gse: zGseIdx !== -1 ? row[zGseIdx] : null,
        vx_gse: vxGseIdx !== -1 ? row[vxGseIdx] : null,
        vy_gse: vyGseIdx !== -1 ? row[vyGseIdx] : null,
        vz_gse: vzGseIdx !== -1 ? row[vzGseIdx] : null,
        x_gsm: xGsmIdx !== -1 ? row[xGsmIdx] : null,
        y_gsm: yGsmIdx !== -1 ? row[yGsmIdx] : null,
        z_gsm: zGsmIdx !== -1 ? row[zGsmIdx] : null,
        vx_gsm: vxGsmIdx !== -1 ? row[vxGsmIdx] : null,
        vy_gsm: vyGsmIdx !== -1 ? row[vyGsmIdx] : null,
        vz_gsm: vzGsmIdx !== -1 ? row[vzGsmIdx] : null,
      });
    }

    const latestData = timeSeries.length > 0 ? timeSeries[timeSeries.length - 1] : null;

    return {
      isConnected: true,
      lastUpdated: new Date().toISOString(),
      errorMessage: null,
      latestData,
      timeSeries
    };
  } catch {
    return {
      isConnected: false,
      lastUpdated: null,
      errorMessage: 'NOAA spacecraft ephemeris unavailable',
      latestData: null,
      timeSeries: []
    };
  }
}
