import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCelestrakSourceStatus,
  classifyL1SourceStatus,
  summarizeSourceStatuses,
  type SourceStatus,
} from './sourceStatus';

const staticConnectedSources: SourceStatus[] = [
  { id: 'l1', name: 'L1', status: 'connected', lastUpdated: '2026-07-16T10:00:00Z' },
  { id: 'alerts', name: 'Alerts', status: 'connected', lastUpdated: '2026-07-16T10:00:00Z' },
  { id: 'scales', name: 'Scales', status: 'connected', lastUpdated: '2026-07-16T10:00:00Z' },
];

const catalog = [{
  name: 'ISS (ZARYA)',
  line1: '1 25544U 98067A   26197.00000000  .00000000  00000-0  00000-0 0  9999',
  line2: '2 25544  51.6400   0.0000 0004000   0.0000   0.0000 15.50000000000000',
  source: 'celestrak-stations',
}];

test('a time-capped empty SSR catalog is Checking and is not counted as available', () => {
  const tle = buildCelestrakSourceStatus({
    isConnected: false,
    lastUpdated: null,
    errorMessage: 'CelesTrak slow - loading in background',
    tles: [],
    stale: false,
  }, true);
  const summary = summarizeSourceStatuses([...staticConnectedSources, tle]);

  assert.equal(tle.status, 'checking');
  assert.equal(tle.lastUpdated, null);
  assert.deepEqual(summary, { availableCount: 3, totalCount: 4, tone: 'checking' });
});

test('the same client reconciliation moves from Checking to Connected or Offline', () => {
  const connected = buildCelestrakSourceStatus({
    isConnected: true,
    lastUpdated: '2026-07-16T10:05:00Z',
    errorMessage: null,
    tles: catalog,
    stale: false,
  }, false);
  const offline = buildCelestrakSourceStatus({
    isConnected: false,
    lastUpdated: null,
    errorMessage: 'CelesTrak unavailable',
    tles: [],
    stale: false,
    error: {
      code: 'CELESTRAK_TIMEOUT',
      kind: 'timeout',
      message: 'CelesTrak unavailable',
      attemptedAtUtc: '2026-07-16T10:00:00Z',
      attempts: 2,
      retryable: true,
      httpStatus: null,
      retryAfterSeconds: null,
      upstreamMessage: null,
    },
    nextRetryAtUtc: '2026-07-16T12:00:00Z',
  }, false);

  assert.equal(connected.status, 'connected');
  assert.deepEqual(summarizeSourceStatuses([...staticConnectedSources, connected]), {
    availableCount: 4,
    totalCount: 4,
    tone: 'connected',
  });
  assert.equal(offline.status, 'offline');
  assert.match(offline.detail ?? '', /CELESTRAK_TIMEOUT/);
  assert.match(offline.detail ?? '', /2026-07-16T12:00:00Z/);
  assert.deepEqual(summarizeSourceStatuses([...staticConnectedSources, offline]), {
    availableCount: 3,
    totalCount: 4,
    tone: 'offline',
  });
});

test('a last-good CelesTrak catalog is Cached and remains available', () => {
  const cached = buildCelestrakSourceStatus({
    isConnected: true,
    lastUpdated: '2026-07-16T09:00:00Z',
    errorMessage: null,
    tles: catalog,
    stale: true,
  }, false);
  const summary = summarizeSourceStatuses([...staticConnectedSources, cached]);

  assert.equal(cached.status, 'cached');
  assert.deepEqual(summary, { availableCount: 4, totalCount: 4, tone: 'degraded' });
});

test('Partial sources count as available while an Offline source controls overall severity', () => {
  const sources: SourceStatus[] = [
    { id: 'partial', name: 'Partial', status: 'partial', lastUpdated: null },
    { id: 'cached', name: 'Cached', status: 'cached', lastUpdated: null },
    { id: 'offline', name: 'Offline', status: 'offline', lastUpdated: null },
  ];

  assert.deepEqual(summarizeSourceStatuses(sources), {
    availableCount: 2,
    totalCount: 3,
    tone: 'offline',
  });
});

test('live L1 state is based on usable sample families and scientific freshness', () => {
  assert.equal(classifyL1SourceStatus({
    sampleTimeUtc: '2026-07-16T10:00:00Z',
    freshness: 'fresh',
    magneticAvailable: true,
    plasmaAvailable: true,
  }), 'connected');
  assert.equal(classifyL1SourceStatus({
    sampleTimeUtc: '2026-07-16T10:00:00Z',
    freshness: 'fresh',
    magneticAvailable: true,
    plasmaAvailable: false,
  }), 'partial');
  assert.equal(classifyL1SourceStatus({
    sampleTimeUtc: '2026-07-16T10:00:00Z',
    freshness: 'degraded',
    magneticAvailable: true,
    plasmaAvailable: true,
  }), 'partial');
  assert.equal(classifyL1SourceStatus({
    sampleTimeUtc: '2026-07-16T10:00:00Z',
    freshness: 'stale',
    magneticAvailable: true,
    plasmaAvailable: true,
  }), 'offline');
  assert.equal(classifyL1SourceStatus({
    sampleTimeUtc: null,
    freshness: 'stale',
    magneticAvailable: false,
    plasmaAvailable: false,
  }), 'offline');
});
