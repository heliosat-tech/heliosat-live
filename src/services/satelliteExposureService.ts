import type { NoaaMagnetometerData, NoaaPlasmaData, NoaaServiceResponse } from './noaaSolarWindService';
import type { PropagatedSatelliteData } from './satellitePropagationService';
import type {
  EarthArrivalEstimate,
  OrbitClassification,
  PhysicalFluxState,
  PhysicalQuantity,
  SatelliteExposureChannel,
  SatelliteOperatorDecisionReport,
  SpaceWeatherFlag,
} from '@/types/spaceWeather';

const PROTON_MASS_KG = 1.67262192369e-27;
const ELEMENTARY_CHARGE_C = 1.602176634e-19;
const ELEVATED_SPEED_THRESHOLD_KM_S = 500;
const ELEVATED_DENSITY_THRESHOLD_CM3 = 10;
const HIGH_INCLINATION_THRESHOLD_DEG = 60;

function parseFiniteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: number | null, maximumFractionDigits = 2) {
  if (value === null) return 'Not available';
  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function measuredQuantity(id: string, label: string, value: number | null, unit: string, details: string): PhysicalQuantity {
  return {
    id,
    label,
    value,
    formattedValue: formatNumber(value, Math.abs(value ?? 0) >= 1000 ? 0 : 2),
    unit,
    source: value === null ? 'not_connected' : 'measured',
    badge: value === null ? 'UNAVAILABLE' : 'MEASURED',
    details,
  };
}

function derivedQuantity(id: string, label: string, value: number | null, unit: string, details: string): PhysicalQuantity {
  return {
    id,
    label,
    value,
    formattedValue: formatNumber(value, value !== null && value < 10 ? 3 : 2),
    unit,
    source: value === null ? 'not_connected' : 'derived',
    badge: value === null ? 'UNAVAILABLE' : 'DERIVED',
    details,
  };
}

function flagFromValue(
  id: string,
  label: string,
  value: number | null,
  isActive: (value: number) => boolean,
  badge: SpaceWeatherFlag['badge'],
  details: string,
): SpaceWeatherFlag {
  return {
    id,
    label,
    isActive: value === null ? null : isActive(value),
    badge: value === null ? 'UNAVAILABLE' : badge,
    details,
  };
}

export function derivePhysicalFluxState(
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>,
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>,
): PhysicalFluxState {
  const mag = noaaMagData.latestData;
  const plasma = noaaPlasmaData.latestData;

  const bt = parseFiniteNumber(mag?.bt);
  const bx = parseFiniteNumber(mag?.bx_gsm);
  const by = parseFiniteNumber(mag?.by_gsm);
  const bz = parseFiniteNumber(mag?.bz_gsm);
  const speed = parseFiniteNumber(plasma?.speed);
  const density = parseFiniteNumber(plasma?.density);
  const temperature = parseFiniteNumber(plasma?.temperature);

  const dynamicPressureNPa = speed !== null && density !== null
    ? density * PROTON_MASS_KG * Math.pow(speed * 1000, 2) * 1e15
    : null;

  const protonBulkKineticEnergyEv = speed !== null
    ? (0.5 * PROTON_MASS_KG * Math.pow(speed * 1000, 2)) / ELEMENTARY_CHARGE_C
    : null;

  const quantities: PhysicalQuantity[] = [
    measuredQuantity('bt', 'Bt', bt, 'nT', 'NOAA RTSW magnetometer total interplanetary magnetic field.'),
    measuredQuantity('bx_gsm', 'Bx GSM', bx, 'nT', 'NOAA RTSW magnetometer Bx component in GSM coordinates.'),
    measuredQuantity('by_gsm', 'By GSM', by, 'nT', 'NOAA RTSW magnetometer By component in GSM coordinates.'),
    measuredQuantity('bz_gsm', 'Bz GSM', bz, 'nT', 'NOAA RTSW magnetometer Bz component in GSM coordinates.'),
    measuredQuantity('speed', 'Solar-wind speed', speed, 'km/s', 'NOAA RTSW plasma bulk speed.'),
    measuredQuantity('density', 'Proton density', density, 'cm^-3', 'NOAA RTSW plasma proton density.'),
    measuredQuantity('temperature', 'Proton temperature', temperature, 'K', 'NOAA RTSW plasma proton temperature.'),
    derivedQuantity(
      'dynamic_pressure',
      'Dynamic pressure',
      dynamicPressureNPa,
      'nPa',
      'Derived as n_p m_p v^2 from NOAA proton density and bulk speed; alpha-particle correction is not applied.',
    ),
    derivedQuantity(
      'proton_bulk_kinetic_energy',
      'Proton bulk kinetic energy',
      protonBulkKineticEnergyEv,
      'eV/proton',
      'Derived as 1/2 m_p v^2 per proton from NOAA bulk speed.',
    ),
  ];

  const flags: SpaceWeatherFlag[] = [
    flagFromValue(
      'southward_bz',
      'Southward Bz',
      bz,
      value => value < 0,
      'MEASURED',
      'Active when measured Bz GSM is below 0 nT. This is a physical orientation flag, not a risk score.',
    ),
    flagFromValue(
      'elevated_speed',
      'Elevated speed',
      speed,
      value => value >= ELEVATED_SPEED_THRESHOLD_KM_S,
      'HEURISTIC',
      `Active when measured speed is at or above ${ELEVATED_SPEED_THRESHOLD_KM_S} km/s. Threshold is a transparent decision-support heuristic, not a risk score.`,
    ),
    flagFromValue(
      'elevated_density',
      'Elevated density',
      density,
      value => value >= ELEVATED_DENSITY_THRESHOLD_CM3,
      'HEURISTIC',
      `Active when measured density is at or above ${ELEVATED_DENSITY_THRESHOLD_CM3} cm^-3. Threshold is a transparent decision-support heuristic, not a risk score.`,
    ),
  ];

  return {
    quantities,
    flags,
    radiation: [
      {
        channel: 'energetic_proton_flux',
        label: 'Energetic proton flux',
        status: 'not_connected',
        badge: 'UNAVAILABLE',
        details: 'Not connected until real GOES/SEP energetic proton flux data is integrated.',
      },
      {
        channel: 'energetic_electron_flux',
        label: 'Energetic electron flux',
        status: 'not_connected',
        badge: 'UNAVAILABLE',
        details: 'Not connected until real GOES/SEP energetic electron flux data is integrated.',
      },
    ],
    assumptions: [
      'Dynamic pressure assumes proton mass and uses NOAA proton density as the ion number density.',
      'Elevated speed and density flags are heuristic decision-support thresholds and do not form a numerical risk score.',
    ],
    limitations: [
      'No radiation dose is estimated.',
      'No energetic particle flux is available until a real GOES/SEP source is connected.',
      'No spacecraft charging, drag, or anomaly probability is computed.',
    ],
  };
}

export function classifyOrbitFromPropagation(propagatedData: PropagatedSatelliteData | null): OrbitClassification {
  const altitudeKm = propagatedData?.altitudeAvailable ? propagatedData.altitudeKm : null;
  const inclinationDeg = propagatedData?.inclinationAvailable ? propagatedData.inclinationDeg : null;

  if (altitudeKm === null || altitudeKm === undefined) {
    return {
      orbitClass: 'Unavailable',
      altitudeKm: null,
      inclinationDeg: inclinationDeg ?? null,
      isHighInclinationLeo: false,
      badge: 'UNAVAILABLE',
      details: 'Satellite altitude is unavailable, so orbit class cannot be derived.',
    };
  }

  const orbitClass = altitudeKm < 1200
    ? 'LEO'
    : altitudeKm < 30000
      ? 'MEO'
      : altitudeKm <= 37000
        ? 'GEO-like'
        : 'HEO';

  const isHighInclinationLeo = orbitClass === 'LEO'
    && inclinationDeg !== null
    && inclinationDeg !== undefined
    && inclinationDeg >= HIGH_INCLINATION_THRESHOLD_DEG;

  return {
    orbitClass,
    altitudeKm,
    inclinationDeg: inclinationDeg ?? null,
    isHighInclinationLeo,
    badge: 'DERIVED',
    details: `Orbit class derived from propagated TLE altitude using fixed altitude bands. High-inclination LEO flag uses inclination >= ${HIGH_INCLINATION_THRESHOLD_DEG} deg.`,
  };
}

function getExposureChannels(orbit: OrbitClassification): SatelliteExposureChannel[] {
  if (orbit.orbitClass === 'Unavailable') {
    return [];
  }

  if (orbit.isHighInclinationLeo) {
    return [
      {
        label: 'Drag/orbit uncertainty',
        badge: 'HEURISTIC',
        details: 'LEO altitude maps to drag and orbit-determination sensitivity during disturbed thermospheric conditions.',
      },
      {
        label: 'Auroral/polar exposure',
        badge: 'HEURISTIC',
        details: 'High-inclination LEO maps to increased polar and auroral-zone exposure potential.',
      },
    ];
  }

  if (orbit.orbitClass === 'LEO') {
    return [
      {
        label: 'Drag/orbit uncertainty',
        badge: 'HEURISTIC',
        details: 'LEO altitude maps to drag and orbit-determination sensitivity during disturbed thermospheric conditions.',
      },
    ];
  }

  if (orbit.orbitClass === 'MEO') {
    return [
      {
        label: 'Radiation belt/particle exposure',
        badge: 'HEURISTIC',
        details: 'MEO altitude maps to radiation belt and particle-environment exposure channels.',
      },
    ];
  }

  if (orbit.orbitClass === 'GEO-like') {
    return [
      {
        label: 'Surface charging/deep dielectric charging/comms attribution',
        badge: 'HEURISTIC',
        details: 'GEO-like altitude maps to surface charging, deep dielectric charging, and communications anomaly attribution watch items.',
      },
    ];
  }

  return [
    {
      label: 'Radiation exposure',
      badge: 'HEURISTIC',
      details: 'HEO altitude maps to radiation exposure watch items, especially during high-altitude magnetospheric passes.',
    },
  ];
}

function getQuantity(state: PhysicalFluxState, id: string) {
  return state.quantities.find(quantity => quantity.id === id) ?? null;
}

function getActiveFlags(state: PhysicalFluxState) {
  const active = state.flags.filter(flag => flag.isActive === true).map(flag => flag.label);
  return active.length > 0 ? active.join(', ') : 'No active physical flags from connected NOAA inputs.';
}

function formatArrivalSeconds(arrivalEstimate: EarthArrivalEstimate) {
  if (arrivalEstimate.travelTimeSeconds === null) return 'Not available';
  return Math.round(arrivalEstimate.travelTimeSeconds).toLocaleString('en-US');
}

export function buildSatelliteOperatorReport(input: {
  satelliteName: string | null;
  satelliteSource: string | null;
  propagatedData: PropagatedSatelliteData | null;
  arrivalEstimate: EarthArrivalEstimate;
  physicalFluxState: PhysicalFluxState;
  generatedAt?: Date;
}): SatelliteOperatorDecisionReport {
  const generatedAtUtc = (input.generatedAt ?? new Date()).toISOString();
  const orbit = classifyOrbitFromPropagation(input.propagatedData);
  const exposureChannels = getExposureChannels(orbit);
  const speed = getQuantity(input.physicalFluxState, 'speed');
  const density = getQuantity(input.physicalFluxState, 'density');
  const bz = getQuantity(input.physicalFluxState, 'bz_gsm');
  const dynamicPressure = getQuantity(input.physicalFluxState, 'dynamic_pressure');
  const kineticEnergy = getQuantity(input.physicalFluxState, 'proton_bulk_kinetic_energy');

  const missingData: string[] = [
    'Energetic proton flux: Not connected.',
    'Energetic electron flux: Not connected.',
    'Radiation dose: Not estimated.',
  ];

  if (!input.satelliteName) missingData.unshift('Active satellite: Not selected.');
  if (!input.propagatedData?.positionAvailable) missingData.push('Selected satellite propagated position: Not available.');
  if (!input.propagatedData?.altitudeAvailable) missingData.push('Selected satellite altitude: Not available.');
  if (!input.propagatedData?.velocityAvailable) missingData.push('Selected satellite velocity: Not available.');
  if (!input.propagatedData?.inclinationAvailable) missingData.push('Selected satellite inclination: Not available.');
  if (!input.arrivalEstimate.isAvailable) missingData.push('Earth-arrival estimate: Not available because solar-wind speed is missing.');

  const arrivalSentence = input.arrivalEstimate.isAvailable
    ? `Estimated Earth-arrival in ${formatArrivalSeconds(input.arrivalEstimate)} seconds. If this mission has pre-defined safe-mode criteria for geomagnetic disturbances, review readiness before the estimated arrival window.`
    : 'Estimated Earth-arrival unavailable. If this mission has pre-defined safe-mode criteria for geomagnetic disturbances, review readiness according to mission-specific flight rules.';

  const channelText = exposureChannels.length > 0
    ? exposureChannels.map(channel => channel.label).join(', ')
    : 'Not available until satellite orbit class is derived.';

  const report: SatelliteOperatorDecisionReport = {
    isAvailable: Boolean(input.satelliteName),
    satelliteName: input.satelliteName,
    generatedAtUtc,
    orbit,
    exposureChannels,
    missingData,
    limitations: [
      'Decision-support advisory only. HelioSat does not issue spacecraft commands and does not replace mission-specific flight rules.',
      'No numerical risk score is generated.',
      'No radiation dose, internal charging model, drag acceleration, orbit covariance, or anomaly probability is computed.',
      'Operational procedures and mission-specific flight rules remain authoritative.',
    ],
    sections: [
      {
        title: 'Executive summary',
        items: [
          input.satelliteName
            ? `${input.satelliteName} report generated from connected NOAA solar-wind inputs and CelesTrak TLE propagation.`
            : 'No active satellite is selected; report remains limited to environmental context.',
          'Decision-support advisory only. HelioSat does not issue spacecraft commands and does not replace mission-specific flight rules.',
          `Current exposure channel mapping: ${channelText}`,
          `Active physical flags: ${getActiveFlags(input.physicalFluxState)}`,
        ],
      },
      {
        title: 'Satellite context',
        items: [
          `Designator: ${input.satelliteName ?? 'Not available'}`,
          `Source: ${input.satelliteSource ?? 'Not available'}`,
          `Orbit class: ${orbit.orbitClass}`,
          `Altitude: ${orbit.altitudeKm === null ? 'Not available' : `${formatNumber(orbit.altitudeKm, 0)} km`}`,
          `Inclination: ${orbit.inclinationDeg === null ? 'Not available' : `${formatNumber(orbit.inclinationDeg, 2)} deg`}`,
          `Exposure channels: ${channelText}`,
        ],
      },
      {
        title: 'Earth arrival estimate',
        items: [
          `Confidence: ${input.arrivalEstimate.confidence}`,
          `Travel time: ${input.arrivalEstimate.travelTimeSeconds === null ? 'Not available' : `${formatNumber(input.arrivalEstimate.travelTimeSeconds, 0)} s / ${formatNumber(input.arrivalEstimate.travelTimeMinutes, 1)} min / ${formatNumber(input.arrivalEstimate.travelTimeHours, 2)} h`}`,
          `Estimated arrival UTC: ${input.arrivalEstimate.estimatedArrivalUtc ?? 'Not available'}`,
          `Distance source: ${input.arrivalEstimate.distanceSourceLabel}${input.arrivalEstimate.distanceIsAssumption ? ' (assumption)' : ''}`,
        ],
      },
      {
        title: 'Physical drivers',
        items: [
          `Bz GSM: ${bz?.formattedValue ?? 'Not available'} ${bz?.unit ?? ''}`.trim(),
          `Solar-wind speed: ${speed?.formattedValue ?? 'Not available'} ${speed?.unit ?? ''}`.trim(),
          `Proton density: ${density?.formattedValue ?? 'Not available'} ${density?.unit ?? ''}`.trim(),
          `Dynamic pressure: ${dynamicPressure?.formattedValue ?? 'Not available'} ${dynamicPressure?.unit ?? ''}`.trim(),
          `Proton bulk kinetic energy: ${kineticEnergy?.formattedValue ?? 'Not available'} ${kineticEnergy?.unit ?? ''}`.trim(),
        ],
      },
      {
        title: 'Operational interpretation',
        items: [
          orbit.orbitClass === 'LEO' || orbit.isHighInclinationLeo
            ? 'Primary exposure channel: atmospheric drag and orbit-determination uncertainty.'
            : orbit.orbitClass === 'MEO'
              ? 'MEO mapping emphasizes radiation belt and energetic particle awareness; connected energetic flux data is still missing.'
              : orbit.orbitClass === 'GEO-like'
                ? 'Primary exposure channel: surface charging, deep dielectric charging and communications anomaly attribution.'
                : orbit.orbitClass === 'HEO'
                  ? 'HEO mapping emphasizes radiation exposure awareness over high-altitude magnetospheric regions; connected energetic particle data is still missing.'
                  : 'Operational interpretation is limited until a selected satellite has propagated altitude and inclination.',
          orbit.isHighInclinationLeo
            ? 'High-inclination LEO adds auroral and polar exposure awareness.'
            : 'No additional high-inclination LEO polar exposure flag is active.',
          'Southward Bz, elevated speed, and elevated density flags are physical/heuristic watch items only, not a numerical risk score.',
        ],
      },
      {
        title: 'Advisory operator actions',
        items: [
          arrivalSentence,
          'Review spacecraft attitude constraints and consider lower-risk configurations only according to operator procedures.',
          'Review tracking, communications, and anomaly-monitoring readiness according to mission-specific operating rules.',
        ],
      },
      {
        title: 'Missing data',
        items: missingData,
      },
      {
        title: 'Limitations',
        items: [
          'The report uses current NOAA solar-wind measurements and TLE-derived satellite state only.',
          'It does not estimate radiation dose, charging probability, drag acceleration, anomaly likelihood, or mission risk.',
          'It should be treated as decision-support context, not as a flight rule or command recommendation.',
        ],
      },
    ],
  };

  return report;
}
