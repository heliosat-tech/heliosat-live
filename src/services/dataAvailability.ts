import type { NoaaServiceResponse, NoaaMagnetometerData, NoaaPlasmaData } from './noaaSolarWindService';
import type { NoaaAlertsResponse } from './noaaAlertsService';
import type { CelesTrakResponse } from './celestrakService';
import type { PropagatedSatelliteData } from './satellitePropagationService';

export interface DataReadinessState {
  magBt: boolean;
  magBx: boolean;
  magBy: boolean;
  magBz: boolean;
  windSpeed: boolean;
  protonDensity: boolean;
  protonTemp: boolean;
  noaaAlerts: boolean;
  satelliteTle: boolean;
  satellitePosition: boolean;
  satelliteVelocity: boolean;
  satelliteAltitude: boolean;
  satelliteInclination: boolean;
  allAvailable: boolean;
}

export function checkDataReadiness(
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>,
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>,
  noaaAlertsData: NoaaAlertsResponse,
  celestrakData: CelesTrakResponse,
  propagatedData: PropagatedSatelliteData | null
): DataReadinessState {
  const magBt = noaaMagData.latestData?.bt !== null && noaaMagData.latestData?.bt !== undefined;
  const magBx = noaaMagData.latestData?.bx_gsm !== null && noaaMagData.latestData?.bx_gsm !== undefined;
  const magBy = noaaMagData.latestData?.by_gsm !== null && noaaMagData.latestData?.by_gsm !== undefined;
  const magBz = noaaMagData.latestData?.bz_gsm !== null && noaaMagData.latestData?.bz_gsm !== undefined;
  
  const windSpeed = noaaPlasmaData.latestData?.speed !== null && noaaPlasmaData.latestData?.speed !== undefined;
  const protonDensity = noaaPlasmaData.latestData?.density !== null && noaaPlasmaData.latestData?.density !== undefined;
  const protonTemp = noaaPlasmaData.latestData?.temperature !== null && noaaPlasmaData.latestData?.temperature !== undefined;
  
  const noaaAlerts = noaaAlertsData.isConnected;
  
  const satelliteTle = celestrakData.tles.length > 0;
  
  const satellitePosition = !!propagatedData?.positionAvailable;
  const satelliteVelocity = !!propagatedData?.velocityAvailable;
  const satelliteAltitude = !!propagatedData?.altitudeAvailable;
  const satelliteInclination = !!propagatedData?.inclinationAvailable;

  const allAvailable = magBt && magBx && magBy && magBz && windSpeed && protonDensity && protonTemp && noaaAlerts && satelliteTle && satellitePosition && satelliteVelocity && satelliteAltitude && satelliteInclination;

  return {
    magBt,
    magBx,
    magBy,
    magBz,
    windSpeed,
    protonDensity,
    protonTemp,
    noaaAlerts,
    satelliteTle,
    satellitePosition,
    satelliteVelocity,
    satelliteAltitude,
    satelliteInclination,
    allAvailable
  };
}
