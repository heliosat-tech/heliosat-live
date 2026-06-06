export type MissionBadge =
  | 'AVAILABLE'
  | 'PARTIAL'
  | 'UNAVAILABLE'
  | 'MEASURED'
  | 'DERIVED'
  | 'HEURISTIC'
  | 'DECISION SUPPORT ONLY';

export type QuantitySource = 'measured' | 'derived' | 'heuristic' | 'not_connected';

export interface PhysicalQuantity {
  id: string;
  label: string;
  value: number | string | null;
  formattedValue: string;
  unit: string;
  source: QuantitySource;
  badge: MissionBadge;
  details: string;
}

export interface SpaceWeatherFlag {
  id: string;
  label: string;
  isActive: boolean | null;
  badge: MissionBadge;
  details: string;
}

export interface RadiationFluxConnectionState {
  channel: 'energetic_proton_flux' | 'energetic_electron_flux';
  label: string;
  status: 'not_connected';
  badge: 'UNAVAILABLE';
  details: string;
}

export type ArrivalDistanceSource = 'noaa_ephemeris' | 'nominal_l1' | 'unavailable';

export interface EarthArrivalEstimate {
  isAvailable: boolean;
  speedKmS: number | null;
  speedTimestamp: string | null;
  distanceKm: number | null;
  distanceSource: ArrivalDistanceSource;
  distanceSourceLabel: string;
  distanceIsAssumption: boolean;
  travelTimeSeconds: number | null;
  travelTimeMinutes: number | null;
  travelTimeHours: number | null;
  estimatedArrivalUtc: string | null;
  calculatedAtUtc: string;
  confidence: 'PARTIAL' | 'UNAVAILABLE';
  assumptions: string[];
  limitations: string[];
}

export interface PhysicalFluxState {
  quantities: PhysicalQuantity[];
  flags: SpaceWeatherFlag[];
  radiation: RadiationFluxConnectionState[];
  assumptions: string[];
  limitations: string[];
}

export type OrbitClass = 'LEO' | 'MEO' | 'GEO-like' | 'HEO' | 'Unavailable';

export interface OrbitClassification {
  orbitClass: OrbitClass;
  altitudeKm: number | null;
  inclinationDeg: number | null;
  isHighInclinationLeo: boolean;
  badge: MissionBadge;
  details: string;
}

export interface SatelliteExposureChannel {
  label: string;
  badge: 'HEURISTIC';
  details: string;
}

export interface SatelliteOperatorReportSection {
  title: string;
  items: string[];
}

export interface SatelliteOperatorDecisionReport {
  isAvailable: boolean;
  satelliteName: string | null;
  generatedAtUtc: string;
  orbit: OrbitClassification;
  exposureChannels: SatelliteExposureChannel[];
  missingData: string[];
  limitations: string[];
  sections: SatelliteOperatorReportSection[];
}
