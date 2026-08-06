import assert from 'node:assert/strict';
import test from 'node:test';
import { omniArchiveTailNeedsRefresh } from './omniArchiveStore';

const HOUR = 60 * 60 * 1000;
const now = Date.UTC(2026, 7, 6, 12);

test('refreshes a near-now request when the committed OMNI tail is stale', () => {
  assert.equal(omniArchiveTailNeedsRefresh(Date.UTC(2026, 4, 27, 12), now, now), true);
});

test('does not redownload the current-year file when local coverage is recent', () => {
  assert.equal(omniArchiveTailNeedsRefresh(now - 2 * HOUR, now, now), false);
});

test('does not refresh an explicitly historical slice', () => {
  const historicalEnd = now - 7 * 24 * HOUR;
  assert.equal(omniArchiveTailNeedsRefresh(Date.UTC(2026, 4, 27, 12), historicalEnd, now), false);
});

test('does not use the current-year tail for a prior-year request', () => {
  const priorYearEnd = Date.UTC(2025, 11, 31, 23);
  assert.equal(omniArchiveTailNeedsRefresh(null, priorYearEnd, now), false);
});
