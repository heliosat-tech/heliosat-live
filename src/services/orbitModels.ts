/**
 * Per-orbit impact framework. Different orbit classes live in very different
 * radiation/field environments, so each gets its OWN model with the satellite's
 * position as a first-class input. This config drives the UI and documents the
 * data source for each class. GEO is wired; LEO/MEO are data-identified and
 * ready to wire.
 */
export type OrbitClass = 'LEO' | 'MEO' | 'GEO';

export type OrbitWiringStatus = 'wired' | 'available';

export interface OrbitClassConfig {
  id: OrbitClass;
  label: string;
  altitudeLabel: string;
  /** What the per-orbit model predicts. */
  predicts: string;
  /** Why it matters for an operator at this orbit. */
  hazard: string;
  /** The position variable that dominates at this orbit. */
  positionFeature: string;
  dataSource: {
    name: string;
    datasetId: string;
    coverage: string;
    status: OrbitWiringStatus;
  };
}

export const ORBIT_CLASSES: OrbitClassConfig[] = [
  {
    id: 'LEO',
    label: 'Low Earth Orbit',
    altitudeLabel: '~400–2000 km',
    predicts: 'Precipitating particle flux / radiation dose',
    hazard: 'South Atlantic Anomaly + auroral precipitation; extra drag during storms',
    positionFeature: 'Geomagnetic latitude / L-shell / SAA proximity',
    dataSource: {
      name: 'POES/MetOp SEM-2 (and DMSP SSJ)',
      datasetId: 'METOP1_POES-SEM2_FLUXES-2SEC',
      coverage: '2012–present',
      status: 'available',
    },
  },
  {
    id: 'MEO',
    label: 'Medium Earth Orbit',
    altitudeLabel: '~20,000 km (GPS)',
    predicts: 'Relativistic electron flux (outer radiation belt)',
    hazard: 'Heart of the outer belt — deep-dielectric charging of GNSS sats',
    positionFeature: 'L-shell / magnetic local time',
    dataSource: {
      name: 'Van Allen Probes (RBSP ECT) / GPS-LANL',
      datasetId: 'RBSP-A-RBSPICE_LEV-2_ESRHELT',
      coverage: '2012–2019 (RBSP)',
      status: 'available',
    },
  },
  {
    id: 'GEO',
    label: 'Geostationary',
    altitudeLabel: '~36,000 km',
    predicts: 'Magnetic field |B| at the satellite',
    hazard: 'Outer-belt edge + dayside magnetopause crossings; surface charging',
    positionFeature: 'Magnetic local time (day vs night side)',
    dataSource: {
      name: 'GOES-16 (NCEI archive)',
      datasetId: 'goes_nccei / GOES-16',
      coverage: '2024–2025 (~1 yr extracted)',
      status: 'wired',
    },
  },
];

export function getOrbitClass(id: OrbitClass): OrbitClassConfig {
  return ORBIT_CLASSES.find(orbit => orbit.id === id) ?? ORBIT_CLASSES[2];
}
