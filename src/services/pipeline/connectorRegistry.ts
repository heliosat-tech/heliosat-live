import {
  PUBLIC_SPACE_WEATHER_SOURCES,
  type PublicDataCadence,
} from '../spaceWeatherSourceCatalog';

export type ConnectorProtocol =
  | 'hapi'
  | 'swpc-json'
  | 'archive-files'
  | 'space-track-api'
  | 'gnss-files'
  | 'partner-files';

export type ConnectorImplementationStatus = 'wired' | 'registered';

export interface SourceConnectorRegistration {
  sourceId: string;
  protocol: ConnectorProtocol;
  refreshMode: PublicDataCadence;
  implementationStatus: ConnectorImplementationStatus;
}

const PROTOCOL_BY_SOURCE_ID: Record<string, ConnectorProtocol> = {
  'swpc-rtsw-l1': 'swpc-json',
  'ncei-dscovr-archive': 'archive-files',
  'cdaweb-ace-wind-imap': 'hapi',
  'omni-hro': 'hapi',
  'swpc-goes-json': 'swpc-json',
  'ncei-goes-r-mag-seiss': 'archive-files',
  'ncei-goes-sem': 'archive-files',
  'poes-metop-sem': 'archive-files',
  'us-tec-gnss': 'gnss-files',
  'lanl-gps-energetic-particles': 'partner-files',
  'dmsp-space-weather': 'hapi',
  'starlink-ephemerides': 'space-track-api',
  'space-track-tle-history': 'space-track-api',
  'cdaweb-mms-themis-rbsp': 'hapi',
  'celestrak-gp': 'archive-files',
  'meo-public-gap': 'partner-files',
};

const WIRED_SOURCE_IDS = new Set([
  'swpc-rtsw-l1',
  'cdaweb-ace-wind-imap',
  'swpc-goes-json',
  'ncei-goes-r-mag-seiss',
]);

export const SPACE_WEATHER_CONNECTOR_REGISTRY: SourceConnectorRegistration[] =
  PUBLIC_SPACE_WEATHER_SOURCES.map(source => ({
    sourceId: source.id,
    protocol: PROTOCOL_BY_SOURCE_ID[source.id] ?? 'archive-files',
    refreshMode: source.cadence,
    implementationStatus: WIRED_SOURCE_IDS.has(source.id) ? 'wired' : 'registered',
  }));

export function getSourceConnectorRegistration(sourceId: string) {
  return SPACE_WEATHER_CONNECTOR_REGISTRY.find(registration => registration.sourceId === sourceId) ?? null;
}
