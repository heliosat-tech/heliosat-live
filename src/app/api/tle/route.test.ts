import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import {
  resetCelesTrakServiceForTests,
  type CelesTrakResponse,
  type SatelliteTLE,
} from '@/services/celestrakService';
import { GET } from './route';

const TLE: SatelliteTLE = {
  name: 'ISS (ZARYA)',
  line1: '1 25544U 98067A   26196.76640667  .00004078  00000+0  82095-4 0  9992',
  line2: '2 25544  51.6311 158.6576 0006718 300.0875  59.9447 15.49019038576187',
  source: 'celestrak-stations',
};
const TLE_TEXT = `${TLE.name}\n${TLE.line1}\n${TLE.line2}\n`;

const originalFetch = globalThis.fetch;
const originalCacheDirectory = process.env.HELIOSAT_CELESTRAK_CACHE_DIR;
let cacheDirectory = '';

beforeEach(async () => {
  cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'heliosat-tle-route-test-'));
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

test('returns 503 and no-store when no real catalog has ever been obtained', async () => {
  globalThis.fetch = (async () => new Response('forbidden by upstream policy', {
    status: 403,
    statusText: 'Forbidden',
  })) as typeof fetch;

  const response = await GET(new Request('http://localhost/api/tle?group=stations'));
  const body = await response.json() as CelesTrakResponse;
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-heliosat-tle-status'), 'unavailable');
  assert.ok(Number(response.headers.get('retry-after')) >= 7_100);
  assert.equal(body.tles.length, 0);
  assert.equal(body.error?.httpStatus, 403);
  assert.match(body.error?.upstreamMessage ?? '', /forbidden by upstream policy/);
});

test('returns HTTP 200 with explicit stale status when a real last-good catalog exists', async () => {
  await writeFile(path.join(cacheDirectory, 'stations.json'), JSON.stringify({
    group: 'stations',
    fetched_at_utc: new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString(),
    tles: [TLE],
  }), 'utf8');
  globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

  const response = await GET(new Request('http://localhost/api/tle?group=stations'));
  const body = await response.json() as CelesTrakResponse;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-heliosat-tle-status'), 'stale');
  assert.match(response.headers.get('cache-control') ?? '', /^public, max-age=60/);
  assert.equal(body.isConnected, true);
  assert.equal(body.stale, true);
  assert.deepEqual(body.tles, [TLE]);
  assert.equal(body.error?.httpStatus, 404);
});

test('returns HTTP 200 fresh when a valid real catalog is resolved', async () => {
  globalThis.fetch = (async () => new Response(TLE_TEXT, { status: 200 })) as typeof fetch;

  const response = await GET(new Request('http://localhost/api/tle?group=STATIONS'));
  const body = await response.json() as CelesTrakResponse;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-heliosat-tle-status'), 'fresh');
  assert.match(response.headers.get('cache-control') ?? '', /^public, max-age=300/);
  assert.equal(body.isConnected, true);
  assert.equal(body.stale, false);
  assert.deepEqual(body.tles, [TLE]);
  assert.equal(body.cache?.source, 'direct-upstream');
});
