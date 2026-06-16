function degreesToRadians(value: number) {
  return value * (Math.PI / 180);
}

function radiansToDegrees(value: number) {
  return value * (180 / Math.PI);
}

function normalizeDegrees(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function normalizeLongitude(value: number) {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

function getJulianDate(date: Date) {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

export interface SubsolarPoint {
  longitudeDeg: number;
  latitudeDeg: number;
}

/** Subsolar point in geographic coordinates: longitude/latitude where the Sun is overhead. */
export function getSubsolarPoint(date: Date): SubsolarPoint {
  const julianDate = getJulianDate(date);
  const daysSinceJ2000 = julianDate - 2_451_545.0;
  const meanLongitude = normalizeDegrees(280.460 + 0.9856474 * daysSinceJ2000);
  const meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * daysSinceJ2000);
  const meanAnomalyRad = degreesToRadians(meanAnomaly);
  const eclipticLongitude = normalizeDegrees(
    meanLongitude +
      1.915 * Math.sin(meanAnomalyRad) +
      0.020 * Math.sin(2 * meanAnomalyRad),
  );
  const obliquity = 23.439 - 0.0000004 * daysSinceJ2000;
  const eclipticLongitudeRad = degreesToRadians(eclipticLongitude);
  const obliquityRad = degreesToRadians(obliquity);
  const declination = Math.asin(Math.sin(obliquityRad) * Math.sin(eclipticLongitudeRad));
  const rightAscension = Math.atan2(
    Math.cos(obliquityRad) * Math.sin(eclipticLongitudeRad),
    Math.cos(eclipticLongitudeRad),
  );
  const greenwichMeanSiderealTime = normalizeDegrees(
    280.46061837 + 360.98564736629 * (julianDate - 2_451_545.0),
  );

  return {
    longitudeDeg: normalizeLongitude(radiansToDegrees(rightAscension) - greenwichMeanSiderealTime),
    latitudeDeg: radiansToDegrees(declination),
  };
}

/** Solar elevation angle above the local horizon, useful for validating the terminator. */
export function getSolarElevationDeg(date: Date, latitudeDeg: number, longitudeDeg: number) {
  const subsolar = getSubsolarPoint(date);
  const latitudeRad = degreesToRadians(latitudeDeg);
  const declinationRad = degreesToRadians(subsolar.latitudeDeg);
  const hourAngleRad = degreesToRadians(longitudeDeg - subsolar.longitudeDeg);
  const sinElevation =
    Math.sin(latitudeRad) * Math.sin(declinationRad) +
    Math.cos(latitudeRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad);

  return radiansToDegrees(Math.asin(Math.min(1, Math.max(-1, sinElevation))));
}
