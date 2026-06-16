import * as satellite from 'satellite.js';
import type { SatelliteTLE } from './celestrakService';

export interface PropagatedSatelliteData {
  satelliteName: string;
  source: string;
  timestamp: string;
  
  positionAvailable: boolean;
  latitude: number | null;
  longitude: number | null;
  
  altitudeAvailable: boolean;
  altitudeKm: number | null;

  velocityAvailable: boolean;
  velocityKmS: number | null;

  inclinationAvailable: boolean;
  inclinationDeg: number | null;
}

export function propagateSatelliteFromTle(tle: SatelliteTLE, date: Date): PropagatedSatelliteData {
  const result: PropagatedSatelliteData = {
    satelliteName: tle.name,
    source: tle.source,
    timestamp: date.toISOString(),
    positionAvailable: false,
    latitude: null,
    longitude: null,
    altitudeAvailable: false,
    altitudeKm: null,
    velocityAvailable: false,
    velocityKmS: null,
    inclinationAvailable: false,
    inclinationDeg: null,
  };

  try {
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    
    // Extract inclination (satrec.inclo is in radians)
    if (satrec.inclo !== undefined) {
      result.inclinationAvailable = true;
      result.inclinationDeg = satellite.degreesLong(satrec.inclo); 
    }

    const positionAndVelocity = satellite.propagate(satrec, date);

    if (positionAndVelocity) {
      const gmst = satellite.gstime(date);
      const positionGd = satellite.eciToGeodetic(positionAndVelocity.position, gmst);

      result.positionAvailable = true;
      result.latitude = satellite.degreesLat(positionGd.latitude);
      result.longitude = satellite.degreesLong(positionGd.longitude);
      
      result.altitudeAvailable = true;
      result.altitudeKm = positionGd.height;
  
      const vX = positionAndVelocity.velocity.x;
      const vY = positionAndVelocity.velocity.y;
      const vZ = positionAndVelocity.velocity.z;
      
      if (vX !== undefined && vY !== undefined && vZ !== undefined) {
        const vMag = Math.sqrt(vX*vX + vY*vY + vZ*vZ);
        result.velocityAvailable = true;
        result.velocityKmS = vMag;
      }
    }
  } catch {
    // If propagation fails for a satellite, do not display propagated values for it.
    // It will return false for all availability flags.
  }

  return result;
}

/**
 * Orbital period in minutes from the TLE mean motion (satrec.no is rad/min), or null if
 * the TLE can't be parsed. Used to sample exactly one full orbit when drawing the path, so
 * LEO, MEO, GEO and high-eccentricity orbits all render as a complete loop rather than a
 * partial arc.
 */
export function orbitalPeriodMinutes(tle: SatelliteTLE): number | null {
  try {
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    const meanMotion = satrec.no; // radians per minute
    if (typeof meanMotion === 'number' && meanMotion > 0) {
      return (2 * Math.PI) / meanMotion;
    }
    return null;
  } catch {
    return null;
  }
}
