import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import {
  CELESTRAK_FAILURE_COOLDOWN_SECONDS,
  CELESTRAK_REFRESH_INTERVAL_SECONDS,
  fetchTleGroup,
  parseCelesTrakTleText,
  resetCelesTrakServiceForTests,
  type SatelliteTLE,
} from './celestrakService';

const TLE_TEXT = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26196.76640667  .00004078  00000+0  82095-4 0  9992',
  '2 25544  51.6311 158.6576 0006718 300.0875  59.9447 15.49019038576187',
  '',
].join('\r\n');

const TLE: SatelliteTLE = {
  name: 'ISS (ZARYA)',
  line1: '1 25544U 98067A   26196.76640667  .00004078  00000+0  82095-4 0  9992',
  line2: '2 25544  51.6311 158.6576 0006718 300.0875  59.9447 15.49019038576187',
  source: 'celestrak-stations',
};

const MIRROR_URL_PREFIX = 'https://raw.githubusercontent.com/satvisorcom/satvisor-data/master/celestrak/tle/';

/** Builds a mirror-style catalog whose TLE epoch is `ageDays` old, so freshness checks see real dates. */
function mirrorTleText(ageDays: number): string {
  const epoch = new Date(Date.now() - ageDays * 86_400_000);
  const startOfYear = Date.UTC(epoch.getUTCFullYear(), 0, 1);
  const dayOfYear = (epoch.getTime() - startOfYear) / 86_400_000 + 1;
  const epochField = `${String(epoch.getUTCFullYear() % 100).padStart(2, '0')}${dayOfYear.toFixed(8).padStart(12, '0')}`;
  return [
    'ISS (ZARYA)',
    `1 25544U 98067A   ${epochField}  .00004078  00000+0  82095-4 0  9992`,
    '2 25544  51.6311 158.6576 0006718 300.0875  59.9447 15.49019038576187',
    '',
  ].join('\n');
}

const originalFetch = globalThis.fetch;
const originalCacheDirectory = process.env.HELIOSAT_CELESTRAK_CACHE_DIR;
let cacheDirectory = '';

beforeEach(async () => {
  cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'heliosat-celestrak-test-'));
  process.env.HELIOSAT_CELESTRAK_CACHE_DIR = cacheDirectory;
  resetCelesTrakServiceForTests();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetCelesTrakServiceForTests();
  await rm(cacheDirectory, { recursive: true, force: true });
  if (originalCacheDirectory === undefined) delete process.env.HELIOSAT_CELESTRAK_CACHE_DIR;
  else process.env.HELIOSAT_CELESTRAK_CACHE_DIR = originalCacheDirectory;
});

test('parses a named CRLF three-line catalog without fabricating missing records', () => {
  assert.deepEqual(parseCelesTrakTleText(TLE_TEXT, 'stations'), [TLE]);
  assert.deepEqual(parseCelesTrakTleText('<html>blocked</html>', 'stations'), []);
});

test('coalesces concurrent calls, uses the official uppercase query, and persists last-good locally', async () => {
  let calls = 0;
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    requestedUrl = input instanceof Request ? input.url : String(input);
    requestedInit = init;
    return new Response(TLE_TEXT, { status: 200 });
  }) as typeof fetch;

  const results = await Promise.all(Array.from({ length: 8 }, () => fetchTleGroup('stations')));
  assert.equal(calls, 1);
  assert.equal(requestedUrl, 'https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=TLE');
  assert.equal(requestedInit?.redirect, 'manual');
  assert.equal(results.every(result => result.isConnected && result.tles.length === 1), true);
  assert.equal(results.every(result => result.cache?.source === 'direct-upstream'), true);
  assert.equal(CELESTRAK_REFRESH_INTERVAL_SECONDS, 7_200);

  const warm = await fetchTleGroup('stations');
  assert.equal(calls, 1);
  assert.equal(warm.cache?.source, 'memory');

  const saved = JSON.parse(await readFile(path.join(cacheDirectory, 'stations.json'), 'utf8')) as {
    group: string;
    tles: SatelliteTLE[];
  };
  assert.equal(saved.group, 'stations');
  assert.deepEqual(saved.tles, [TLE]);
});

test('does not retry terminal redirects, client errors, or rate limits and opens a two-hour circuit', async () => {
  let status = 301;
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(MIRROR_URL_PREFIX)) return new Response('mirror unavailable', { status: 404 });
    calls += 1;
    return new Response(status === 429 ? 'rate limited' : 'terminal response', {
      status,
      headers: status === 301
        ? { Location: 'https://celestrak.org/' }
        : status === 429
          ? { 'Retry-After': '900' }
          : undefined,
    });
  }) as typeof fetch;

  for (const terminalStatus of [301, 403, 404, 429]) {
    status = terminalStatus;
    calls = 0;
    resetCelesTrakServiceForTests();
    const startedAt = Date.now();
    const first = await fetchTleGroup('stations');
    const second = await fetchTleGroup('stations');

    assert.equal(calls, 1, `HTTP ${terminalStatus} must not be retried`);
    assert.equal(first.isConnected, false);
    assert.equal(first.error?.httpStatus, terminalStatus);
    assert.equal(first.error?.attempts, 1);
    assert.equal(second.error?.httpStatus, terminalStatus);
    assert.ok(Date.parse(first.nextRetryAtUtc ?? '') >= startedAt + (CELESTRAK_FAILURE_COOLDOWN_SECONDS - 2) * 1_000);
  }
});

test('retries only a timeout or 5xx once before entering cooldown', async t => {
  await t.test('timeout', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(MIRROR_URL_PREFIX)) return new Response('mirror unavailable', { status: 404 });
      calls += 1;
      const error = new Error('operation timed out');
      error.name = 'TimeoutError';
      throw error;
    }) as typeof fetch;
    const result = await fetchTleGroup('stations');
    assert.equal(calls, 2);
    assert.equal(result.error?.kind, 'timeout');
    assert.equal(result.error?.attempts, 2);
  });

  resetCelesTrakServiceForTests();
  await t.test('HTTP 503', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(MIRROR_URL_PREFIX)) return new Response('mirror unavailable', { status: 404 });
      calls += 1;
      return new Response('temporarily unavailable', { status: 503, statusText: 'Service Unavailable' });
    }) as typeof fetch;
    const result = await fetchTleGroup('stations');
    assert.equal(calls, 2);
    assert.equal(result.error?.httpStatus, 503);
    assert.equal(result.error?.attempts, 2);
    assert.match(result.error?.upstreamMessage ?? '', /temporarily unavailable/);
  });
});

test('serves an expired real local catalog as stale when refresh fails', async () => {
  const fetchedAtUtc = new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString();
  await writeFile(path.join(cacheDirectory, 'stations.json'), JSON.stringify({
    group: 'stations',
    fetched_at_utc: fetchedAtUtc,
    tles: [TLE],
  }), 'utf8');
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(MIRROR_URL_PREFIX)) return new Response('mirror unavailable', { status: 404 });
    calls += 1;
    return new Response('blocked until next update', { status: 429, headers: { 'Retry-After': '7200' } });
  }) as typeof fetch;

  const result = await fetchTleGroup('stations');
  assert.equal(calls, 1);
  assert.equal(result.isConnected, true);
  assert.equal(result.stale, true);
  assert.deepEqual(result.tles, [TLE]);
  assert.equal(result.cache?.source, 'local-last-good');
  assert.equal(result.error?.httpStatus, 429);
  assert.equal(result.lastUpdated, fetchedAtUtc);
});

test('treats an HTTP 200 non-TLE body as a terminal structured failure', async () => {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(MIRROR_URL_PREFIX)) return new Response('mirror unavailable', { status: 404 });
    calls += 1;
    return new Response('<html>maintenance</html>', { status: 200 });
  }) as typeof fetch;
  const result = await fetchTleGroup('weather');
  assert.equal(calls, 1);
  assert.equal(result.error?.kind, 'invalid-payload');
  assert.equal(result.error?.attempts, 1);
  assert.equal(result.tles.length, 0);
});

test('serves the daily mirror when CelesTrak itself is unreachable', async () => {
  let mirrorUrl = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(MIRROR_URL_PREFIX)) {
      mirrorUrl = url;
      return new Response(mirrorTleText(1), { status: 200 });
    }
    return new Response('blocked', { status: 403 });
  }) as typeof fetch;

  const result = await fetchTleGroup('stations');
  assert.equal(mirrorUrl, `${MIRROR_URL_PREFIX}stations.tle`);
  assert.equal(result.isConnected, true);
  assert.equal(result.stale, false);
  assert.equal(result.upstreamSource, 'celestrak-mirror');
  assert.equal(result.tles.length, 1);
  assert.equal(result.tles[0]?.source, 'celestrak-stations');
  assert.equal(result.errorMessage, null);

  const saved = JSON.parse(await readFile(path.join(cacheDirectory, 'stations.json'), 'utf8')) as {
    upstream?: string;
  };
  assert.equal(saved.upstream, 'celestrak-mirror');
});

test('rejects a mirror catalog whose newest epoch is too old', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(MIRROR_URL_PREFIX)) return new Response(mirrorTleText(30), { status: 200 });
    return new Response('blocked', { status: 403 });
  }) as typeof fetch;

  const result = await fetchTleGroup('stations');
  assert.equal(result.isConnected, false);
  assert.equal(result.tles.length, 0);
  assert.equal(result.error?.httpStatus, 403);
});
