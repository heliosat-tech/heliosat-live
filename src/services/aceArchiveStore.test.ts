import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNoaaAceHourly } from './aceArchiveStore';

test('NOAA rolling ACE rows merge magnetic and plasma variables by UTC hour', () => {
  const samples = parseNoaaAceHourly(
    [{ time_tag: '2026-08-06T20:00:00', gsm_bz: -4.5, bt: 7.2 }],
    [{ time_tag: '2026-08-06T20:00:00', speed: 510, dens: 6.4 }],
  );
  assert.deepEqual(samples, [{
    ms: Date.UTC(2026, 7, 6, 20),
    speedKmS: 510,
    densityPerCm3: 6.4,
    bzNt: -4.5,
    btNt: 7.2,
  }]);
});
