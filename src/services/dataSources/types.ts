export interface SourceAttribution {
  sourceId: string;
  provider: string;
  dataset: string;
  url: string;
  retrievedAtUtc: string;
  cadenceSeconds: number | null;
  notes?: string;
}

export interface DataSourceFetchResult<TSample> {
  samples: TSample[];
  sourceAttribution: SourceAttribution[];
  qualityFlags: string[];
  fetchedAtUtc: string;
  warnings: string[];
  errors: string[];
}

export type L1SourceId = 'swpc_rtsw' | 'ace_cdaweb_hapi';
export type L1Spacecraft = 'active' | 'dscovr' | 'ace' | 'unknown';

export interface L1Sample {
  timeUtc: string;
  source: L1SourceId;
  spacecraft: L1Spacecraft;
  speedKmS: number | null;
  densityCm3: number | null;
  temperatureK: number | null;
  bxGsmNt: number | null;
  byGsmNt: number | null;
  bzGsmNt: number | null;
  btNt: number | null;
  qualityFlags: string[];
  sourceAttribution: SourceAttribution[];
}

export interface L1EphemerisSample {
  timeUtc: string;
  source: 'swpc_rtsw';
  spacecraft: L1Spacecraft;
  xGseKm: number | null;
  yGseKm: number | null;
  zGseKm: number | null;
  xGsmKm: number | null;
  yGsmKm: number | null;
  zGsmKm: number | null;
  qualityFlags: string[];
  sourceAttribution: SourceAttribution[];
}

export interface L1FetchResult extends DataSourceFetchResult<L1Sample> {
  ephemerisSamples: L1EphemerisSample[];
}

export interface GoesSample {
  timeUtc: string;
  source: 'goes';
  satellite: string;
  protonFlux: number | null;
  electronFlux: number | null;
  xrayFlux: number | null;
  hpNt: number | null;
  hTotalNt: number | null;
  qualityFlags: string[];
  sourceAttribution: SourceAttribution[];
}

export interface GroundIndexSample {
  timeUtc: string;
  kp: number | null;
  dstNt: number | null;
  symhNt: number | null;
  qualityFlags: string[];
  sourceAttribution: SourceAttribution[];
}

/** Nominal Sun-Earth L1 distance used for ballistic propagation when no reliable
 * spacecraft ephemeris is available (~1.5 million km). */
export const NOMINAL_L1_DISTANCE_KM = 1_500_000;
export const MIN_RELIABLE_L1_KM = 500_000;
export const MAX_RELIABLE_L1_KM = 2_500_000;
