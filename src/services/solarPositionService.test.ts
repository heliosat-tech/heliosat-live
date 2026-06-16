import assert from 'node:assert/strict';
import test from 'node:test';
import { getSolarElevationDeg, getSubsolarPoint } from './solarPositionService';

test('subsolar point is near northeast Africa before June solstice morning UTC', () => {
  const date = new Date('2026-06-15T10:15:00Z');
  const subsolar = getSubsolarPoint(date);

  assert.ok(Math.abs(subsolar.longitudeDeg - 26.38) < 0.25);
  assert.ok(Math.abs(subsolar.latitudeDeg - 23.31) < 0.1);
});

test('Italy and Ethiopia are both in daylight at the reported time', () => {
  const date = new Date('2026-06-15T10:15:00Z');

  assert.ok(getSolarElevationDeg(date, 41.9, 12.5) > 65);
  assert.ok(getSolarElevationDeg(date, 9.0, 38.8) > 65);
});
