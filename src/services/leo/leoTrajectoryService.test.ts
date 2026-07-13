import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atmosphereCorotationVelocity,
  classifyTleFreshness,
  propagateLeoTrajectory,
  subtractVectors,
  vectorMagnitude,
} from './leoTrajectoryService';

test('rigid Earth co-rotation uses omega cross r in TEME coordinates', () => {
  const velocity = atmosphereCorotationVelocity({ x: 7_000, y: 0, z: 100 });
  assert.equal(Math.abs(velocity.x), 0);
  assert.equal(velocity.z, 0);
  assert.ok(Math.abs(velocity.y - 0.51044805) < 1e-9);
});

test('SGP4 trajectory exposes TEME state and air-relative speed without satellite properties', () => {
  // Static parser fixture only; it is not exposed by the application as a current observation.
  const trajectory = propagateLeoTrajectory({
    name: 'TEST LEO OBJECT',
    line1: '1 25544U 98067A   24001.00000000  .00016717  00000-0  30237-3 0  9991',
    line2: '2 25544  51.6416  40.0000 0004000  20.0000  60.0000 15.50000000000001',
    source: 'test fixture',
  }, { startMs: Date.parse('2024-01-01T00:00:00Z'), horizonMinutes: 10, cadenceMinutes: 5 });
  assert.equal(trajectory.points.length, 3);
  assert.ok(trajectory.points.every(point => point.frame === 'TEME'));
  assert.ok(trajectory.points.every(point => point.air_relative_speed_km_s > 0));
  assert.equal(trajectory.satellite?.norad_id, '25544');
});

test('air-relative velocity subtracts atmospheric co-rotation', () => {
  const relative = subtractVectors({ x: 0, y: 7.5, z: 0 }, atmosphereCorotationVelocity({ x: 7_000, y: 0, z: 0 }));
  assert.ok(Math.abs(vectorMagnitude(relative) - (7.5 - 0.51044805)) < 1e-9);
});

test('TLE freshness states do not turn an unknown epoch into a fresh orbit', () => {
  const now = Date.parse('2026-07-12T12:00:00Z');
  assert.equal(classifyTleFreshness(null, now).freshness, 'unknown');
  assert.equal(classifyTleFreshness('2026-07-13T00:00:00Z', now).freshness, 'unknown');
  assert.equal(classifyTleFreshness('2026-07-12T00:00:00Z', now).freshness, 'fresh');
  assert.equal(classifyTleFreshness('2026-07-10T12:00:00Z', now).freshness, 'degraded');
  assert.equal(classifyTleFreshness('2026-07-01T00:00:00Z', now).freshness, 'stale');
});
