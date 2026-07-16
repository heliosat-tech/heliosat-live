import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTleResponsePayload, readTleResponse } from './tleResponse';

test('a structured 503 retains CelesTrak failure metadata', async () => {
  const payload = {
    isConnected: false,
    lastUpdated: null,
    errorMessage: 'CelesTrak timed out after 6000 ms.',
    tles: [],
    stale: false,
    nextRetryAtUtc: '2026-07-16T13:19:09.145Z',
    error: {
      code: 'CELESTRAK_TIMEOUT',
      kind: 'timeout',
      message: 'CelesTrak timed out after 6000 ms.',
      attemptedAtUtc: '2026-07-16T11:19:09.145Z',
      attempts: 2,
      retryable: true,
      httpStatus: null,
      retryAfterSeconds: null,
      upstreamMessage: 'The operation was aborted due to timeout',
    },
    cache: {
      source: 'none',
      fetchedAtUtc: null,
      ageSeconds: null,
      refreshIntervalSeconds: 7200,
    },
  };
  const response = Response.json(payload, { status: 503 });
  const parsed = await readTleResponse(response);

  assert.equal(parsed.errorMessage, payload.errorMessage);
  assert.equal(parsed.nextRetryAtUtc, payload.nextRetryAtUtc);
  assert.equal(parsed.error?.code, 'CELESTRAK_TIMEOUT');
  assert.equal(parsed.cache?.refreshIntervalSeconds, 7200);
});

test('malformed success and error payloads are rejected', () => {
  assert.throws(() => parseTleResponsePayload({ error: 'Unavailable' }, 503), /Invalid CelesTrak response/);
  assert.throws(() => parseTleResponsePayload({ isConnected: true, tles: null }, 200), /Invalid CelesTrak response/);
});
