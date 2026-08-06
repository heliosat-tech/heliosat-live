import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeGeomagneticForecast, type L1ForecastSeriesPoint } from './l1ForecastPanelService';

const MINUTE = 60_000;
const now = Date.UTC(2026, 7, 6, 12);

function point(offsetMinutes: number, speed = 720, bz = -12): L1ForecastSeriesPoint {
  return { t: now + offsetMinutes * MINUTE, speed, bz, bt: 16, density: 8 };
}

test('G3 browser-alert event requires at least ten sustained forecast minutes', () => {
  const summary = summarizeGeomagneticForecast(
    Array.from({ length: 16 }, (_, index) => point(index + 5)),
    now,
  );
  assert.ok(summary.severeEvent);
  assert.equal(summary.severeEvent.etaMinutes, 5);
  assert.ok(summary.severeEvent.peak.level >= 3);
  assert.ok(summary.severeEvent.durationMinutes >= 10);
});

test('a short G3 spike remains visible as the peak but does not trigger an event alert', () => {
  const summary = summarizeGeomagneticForecast(
    Array.from({ length: 5 }, (_, index) => point(index + 5)),
    now,
  );
  assert.ok((summary.peak?.level ?? 0) >= 3);
  assert.equal(summary.severeEvent, null);
});

test('missing Bz is counted as unavailable rather than quiet G0', () => {
  const points = [{ ...point(1), bz: null }, { ...point(2), bz: null }];
  const summary = summarizeGeomagneticForecast(points, now);
  assert.equal(summary.totalPoints, 2);
  assert.equal(summary.availablePoints, 0);
  assert.equal(summary.coveragePct, 0);
  assert.equal(summary.peak, null);
});
