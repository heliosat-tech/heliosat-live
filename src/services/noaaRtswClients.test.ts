import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  fetchNoaaEphemerisData,
  fetchNoaaMagnetometerData,
  fetchNoaaPlasmaData,
} from './noaaSolarWindService';
import { fetchSwpcRtswL1Samples } from './dataSources/l1/swpcRtswClient';
import { fetchSwpc } from './l1/swpcRtswSource';

interface MockRoute {
  match: string;
  body?: unknown;
  status?: number;
}

interface CanonicalFixtures {
  minute0Active: string;
  minute0Fallback: string;
  minute1Active: string;
  minute1Fallback: string;
  mag: Array<Record<string, unknown>>;
  wind: Array<Record<string, unknown>>;
  ephemeris: Array<Record<string, unknown>>;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(routes: MockRoute[]) {
  const calls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    calls.push(url);
    const route = routes.find(candidate => url.includes(candidate.match));

    if (!route) {
      throw new Error(`Unexpected test request: ${url}`);
    }

    return new Response(JSON.stringify(route.body ?? []), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return calls;
}

function utcAt(baseMs: number, minuteOffset: number, second = 0) {
  return new Date(baseMs + minuteOffset * 60_000 + second * 1_000).toISOString();
}

function canonicalFixtures(baseMs: number): CanonicalFixtures {
  const minute0Active = utcAt(baseMs, 0, 5);
  const minute0Fallback = utcAt(baseMs, 0, 10);
  const minute1Active = utcAt(baseMs, 1, 5);
  const minute1Fallback = utcAt(baseMs, 1, 10);

  return {
    minute0Active,
    minute0Fallback,
    minute1Active,
    minute1Fallback,
    mag: [
      {
        time_tag: minute1Fallback,
        active: false,
        source: 'ACE',
        bx_gsm: 91,
        by_gsm: 4,
        bz_gsm: -91,
        bt: 91,
        phi_gsm: 191,
        theta_gsm: 81,
      },
      {
        time_tag: minute1Active,
        active: true,
        source: 'SOLAR1',
        bx_gsm: 1,
        by_gsm: null,
        bz_gsm: -7,
        bt: null,
        phi_gsm: 101,
        theta_gsm: null,
      },
      {
        time_tag: minute0Fallback,
        active: false,
        source: 'ACE',
        bx_gsm: 90,
        by_gsm: 3,
        bz_gsm: -90,
        bt: 9,
        phi_gsm: 190,
        theta_gsm: 80,
      },
      {
        time_tag: minute0Active,
        active: true,
        source: 'SOLAR1',
        bx_gsm: 0,
        by_gsm: null,
        bz_gsm: -6,
        bt: null,
        phi_gsm: 100,
        theta_gsm: null,
      },
    ],
    wind: [
      {
        time_tag: minute1Fallback,
        active: false,
        source: 'ACE',
        proton_speed: 901,
        proton_density: 6,
        proton_temperature: 91_000,
      },
      {
        time_tag: minute1Active,
        active: true,
        source: 'SOLAR1',
        proton_speed: 510,
        proton_density: null,
        proton_temperature: 51_000,
      },
      {
        time_tag: minute0Fallback,
        active: false,
        source: 'ACE',
        proton_speed: 900,
        proton_density: 5,
        proton_temperature: 90_000,
      },
      {
        time_tag: minute0Active,
        active: true,
        source: 'SOLAR1',
        proton_speed: 500,
        proton_density: null,
        proton_temperature: 50_000,
      },
    ],
    ephemeris: [
      {
        time_tag: minute1Fallback,
        active: false,
        source: 'ACE',
        x_gse: -1_500_000,
        y_gse: 1_000,
        z_gse: 2_000,
        x_gsm: -1_490_000,
        y_gsm: 2_000,
        z_gsm: 3_000,
      },
      {
        time_tag: minute1Active,
        active: true,
        source: 'SOLAR1',
        x_gse: null,
        y_gse: 10,
        z_gse: 20,
        x_gsm: null,
        y_gsm: 20,
        z_gsm: 30,
      },
    ],
  };
}

function canonicalRoutes(fixtures: ReturnType<typeof canonicalFixtures>): MockRoute[] {
  return [
    { match: 'rtsw_mag_1m.json', body: fixtures.mag },
    { match: 'rtsw_wind_1m.json', body: fixtures.wind },
    { match: 'rtsw_ephemerides_1h.json', body: fixtures.ephemeris },
  ];
}

function assertOnlyCanonicalUrls(calls: string[]) {
  assert.ok(calls.length > 0);
  assert.ok(calls.every(url => url.includes('/json/rtsw/')));
  assert.ok(calls.every(url => !url.includes('/products/solar-wind/')));
}

test('public NOAA service uses live canonical object feeds with active-first field fallback', { concurrency: false }, async () => {
  const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const fixtures = canonicalFixtures(nowMinute - 2 * 60_000);
  const oldTime = utcAt(nowMinute, -121);
  const futureTime = utcAt(nowMinute, 6);
  fixtures.mag.push(
    { time_tag: oldTime, active: true, source: 'SOLAR1', bx_gsm: 200 },
    { time_tag: futureTime, active: true, source: 'SOLAR1', bx_gsm: 201 },
  );
  fixtures.wind.push(
    { time_tag: oldTime, active: true, source: 'SOLAR1', proton_speed: 200 },
    { time_tag: futureTime, active: true, source: 'SOLAR1', proton_speed: 201 },
  );
  fixtures.ephemeris.push(
    { time_tag: oldTime, active: true, source: 'SOLAR1', x_gse: -1_500_000, y_gse: 0, z_gse: 0 },
    { time_tag: futureTime, active: true, source: 'SOLAR1', x_gse: -1_500_000, y_gse: 0, z_gse: 0 },
  );
  const calls = installFetch(canonicalRoutes(fixtures));

  const [mag, wind, ephemeris] = await Promise.all([
    fetchNoaaMagnetometerData(),
    fetchNoaaPlasmaData(),
    fetchNoaaEphemerisData(),
  ]);

  assert.equal(mag.isConnected, true);
  assert.equal(wind.isConnected, true);
  assert.equal(ephemeris.isConnected, true);
  assert.equal(mag.timeSeries.length, 2);
  assert.equal(wind.timeSeries.length, 2);
  assert.equal(ephemeris.timeSeries.length, 1);
  assert.ok(Date.parse(mag.timeSeries[0].time_tag) < Date.parse(mag.timeSeries[1].time_tag));
  assert.equal(mag.timeSeries[0].bz_gsm, '-6');
  assert.equal(mag.timeSeries[0].bt, '9');
  assert.equal(mag.timeSeries[0].by_gsm, '3');
  assert.equal(mag.timeSeries[0].lat_gsm, '80');
  assert.equal(wind.timeSeries[0].speed, '500');
  assert.equal(wind.timeSeries[0].density, '5');
  assert.equal(ephemeris.latestData?.x_gse, '-1500000');
  assert.equal(ephemeris.latestData?.y_gse, '10');
  assert.equal(mag.lastUpdated, mag.latestData?.time_tag);
  assert.equal(wind.lastUpdated, wind.latestData?.time_tag);
  assert.equal(ephemeris.lastUpdated, ephemeris.latestData?.time_tag);
  assert.deepEqual(mag.spacecraft.map(spacecraft => ({ name: spacecraft.name, active: spacecraft.active })), [
    { name: 'SOLAR1', active: true },
    { name: 'ACE', active: false },
  ]);
  assert.deepEqual(wind.spacecraft.map(spacecraft => ({ name: spacecraft.name, active: spacecraft.active })), [
    { name: 'SOLAR1', active: true },
    { name: 'ACE', active: false },
  ]);
  assert.deepEqual(ephemeris.spacecraft.map(spacecraft => ({ name: spacecraft.name, active: spacecraft.active })), [
    { name: 'SOLAR1', active: true },
    { name: 'ACE', active: false },
  ]);
  assertOnlyCanonicalUrls(calls);
});

test('public NOAA service does not report a stale-only feed as connected', { concurrency: false }, async () => {
  const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const stale = utcAt(nowMinute, -121);
  installFetch([{
    match: 'rtsw_mag_1m.json',
    body: [{ time_tag: stale, active: true, source: 'SOLAR1', bz_gsm: -5, bt: 8 }],
  }]);

  const result = await fetchNoaaMagnetometerData();

  assert.equal(result.isConnected, false);
  assert.equal(result.lastUpdated, null);
  assert.equal(result.latestData, null);
  assert.deepEqual(result.timeSeries, []);
  assert.deepEqual(result.spacecraft, []);
});

test('ingestion RTSW client resolves object arrays per minute and preserves observation time', { concurrency: false }, async () => {
  const baseMs = Date.parse('2026-07-16T10:00:00.000Z');
  const fixtures = canonicalFixtures(baseMs);
  const calls = installFetch(canonicalRoutes(fixtures));

  const result = await fetchSwpcRtswL1Samples({ window: '2-hour', includeEphemeris: true });

  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.samples.length, 2);
  assert.ok(Date.parse(result.samples[0].timeUtc) < Date.parse(result.samples[1].timeUtc));
  assert.equal(result.samples[0].timeUtc, fixtures.minute0Active);
  assert.equal(result.samples[0].bzGsmNt, -6);
  assert.equal(result.samples[0].btNt, 9);
  assert.equal(result.samples[0].byGsmNt, 3);
  assert.equal(result.samples[0].speedKmS, 500);
  assert.equal(result.samples[0].densityCm3, 5);
  assert.equal(result.ephemerisSamples[0].timeUtc, fixtures.minute1Active);
  assert.equal(result.ephemerisSamples[0].xGseKm, -1_500_000);
  assert.equal(result.ephemerisSamples[0].yGseKm, 10);
  assertOnlyCanonicalUrls(calls);
  assert.ok(result.sourceAttribution.every(attribution => attribution.url.includes('/json/rtsw/')));
});

test('ingestion RTSW client retains magnetic samples when wind and ephemeris fail', { concurrency: false }, async () => {
  const fixtures = canonicalFixtures(Date.parse('2026-07-16T10:00:00.000Z'));
  const calls = installFetch([
    { match: 'rtsw_mag_1m.json', body: fixtures.mag },
    { match: 'rtsw_wind_1m.json', status: 503 },
    { match: 'rtsw_ephemerides_1h.json', status: 503 },
  ]);

  const result = await fetchSwpcRtswL1Samples();

  assert.equal(result.samples.length, 2);
  assert.equal(result.samples[0].bzGsmNt, -6);
  assert.equal(result.samples[0].speedKmS, null);
  assert.ok(result.errors.some(message => message.includes('solar wind')));
  assert.ok(result.warnings.some(message => message.includes('ephemeris')));
  assert.ok(result.qualityFlags.includes('source_request_failed'));
  assertOnlyCanonicalUrls(calls);
});

test('live RTSW source uses per-variable fallback and observation timestamps', { concurrency: false }, async () => {
  const fixtures = canonicalFixtures(Date.parse('2026-07-16T10:00:00.000Z'));
  const calls = installFetch(canonicalRoutes(fixtures));

  const result = await fetchSwpc();

  assert.equal(result.sourceId, 'swpc_rtsw');
  assert.equal(result.errorMessage, null);
  assert.equal(result.samples.length, 2);
  assert.ok(result.samples[0].ms < result.samples[1].ms);
  assert.equal(result.samples[0].bzNt, -6);
  assert.equal(result.samples[0].btNt, 9);
  assert.equal(result.samples[0].byNt, 3);
  assert.equal(result.samples[0].speedKmS, 500);
  assert.equal(result.samples[0].densityPerCm3, 5);
  assert.equal(result.samples[0].sourceTimeByVariable.bz, fixtures.minute0Active);
  assert.equal(result.samples[0].sourceTimeByVariable.bt, fixtures.minute0Fallback);
  assert.equal(result.samples[0].sourceTimeByVariable.speed, fixtures.minute0Active);
  assert.equal(result.samples[0].sourceTimeByVariable.density, fixtures.minute0Fallback);
  assert.equal(result.latestSampleMs, Date.parse(fixtures.minute1Fallback));
  assert.equal(result.distanceIsMeasured, true);
  assert.equal(result.scPositionGseKm?.x, -1_500_000);
  assertOnlyCanonicalUrls(calls);
});

test('live RTSW source exposes a partial feed without discarding available data', { concurrency: false }, async () => {
  const fixtures = canonicalFixtures(Date.parse('2026-07-16T10:00:00.000Z'));
  const calls = installFetch([
    { match: 'rtsw_mag_1m.json', body: fixtures.mag },
    { match: 'rtsw_wind_1m.json', status: 503 },
    { match: 'rtsw_ephemerides_1h.json', status: 503 },
  ]);

  const result = await fetchSwpc();

  assert.equal(result.sourceId, 'swpc_rtsw');
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples[0].bzNt, -6);
  assert.equal(result.samples[0].speedKmS, null);
  assert.match(result.errorMessage ?? '', /partial feed/);
  assert.match(result.errorMessage ?? '', /solar wind unavailable/);
  assert.equal(result.distanceIsMeasured, false);
  assertOnlyCanonicalUrls(calls);
});
