export interface NoaaAlert {
  product_id: string | null;
  issue_datetime: string | null;
  message: string | null;
}

export interface NoaaAlertsResponse {
  isConnected: boolean;
  lastUpdated: string | null;
  errorMessage: string | null;
  alerts: NoaaAlert[];
}

const NOAA_ALERTS_ENDPOINT = 'https://services.swpc.noaa.gov/products/alerts.json';
const NOAA_ALERTS_FETCH_TIMEOUT_MS = 8_000;

type RawNoaaAlert = {
  product_id?: unknown;
  issue_datetime?: unknown;
  message?: unknown;
};

function getStringValue(value: unknown) {
  return typeof value === 'string' ? value : null;
}

export async function fetchNoaaAlerts(): Promise<NoaaAlertsResponse> {
  try {
    const response = await fetch(NOAA_ALERTS_ENDPOINT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(NOAA_ALERTS_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'NOAA alerts unavailable',
        alerts: []
      };
    }

    const data: unknown = await response.json();

    if (!Array.isArray(data)) {
      return {
        isConnected: false,
        lastUpdated: null,
        errorMessage: 'Invalid alerts data format',
        alerts: []
      };
    }

    if (data.length === 0) {
      return {
        isConnected: true,
        lastUpdated: new Date().toISOString(),
        errorMessage: 'No current alerts returned by NOAA.',
        alerts: []
      };
    }

    return {
      isConnected: true,
      lastUpdated: new Date().toISOString(),
      errorMessage: null,
      // Preserve only fields that are actually present; expose null for absent fields
      alerts: data.map((alert: unknown) => {
        const alertRecord: RawNoaaAlert =
          alert && typeof alert === 'object' ? alert : {};

        return {
          product_id: getStringValue(alertRecord.product_id),
          issue_datetime: getStringValue(alertRecord.issue_datetime),
          message: getStringValue(alertRecord.message),
        };
      })
    };
  } catch {
    return {
      isConnected: false,
      lastUpdated: null,
      errorMessage: 'NOAA alerts unavailable',
      alerts: []
    };
  }
}
