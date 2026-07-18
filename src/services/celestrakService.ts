import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SatelliteTLE {
  name: string;
  line1: string;
  line2: string;
  source: string;
}

export type CelesTrakErrorKind = 'timeout' | 'network' | 'http' | 'invalid-payload' | 'cache';

export interface CelesTrakSourceError {
  code: 'CELESTRAK_TIMEOUT' | 'CELESTRAK_NETWORK' | 'CELESTRAK_HTTP' | 'CELESTRAK_INVALID_PAYLOAD' | 'CELESTRAK_CACHE';
  kind: CelesTrakErrorKind;
  message: string;
  attemptedAtUtc: string;
  attempts: number;
  retryable: boolean;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
  upstreamMessage: string | null;
}

export type CelesTrakCacheSource = 'memory' | 'next-data-cache' | 'direct-upstream' | 'local-last-good' | 'none';

/** Which upstream actually produced the catalog: CelesTrak itself or the daily GitHub mirror. */
export type CelesTrakUpstream = 'celestrak' | 'celestrak-mirror';

export interface CelesTrakCacheMetadata {
  source: CelesTrakCacheSource;
  fetchedAtUtc: string | null;
  ageSeconds: number | null;
  refreshIntervalSeconds: number;
}

export interface CelesTrakResponse {
  isConnected: boolean;
  lastUpdated: string | null;
  errorMessage: string | null;
  tles: SatelliteTLE[];
  /** True when the latest real catalog is older than the refresh interval or the source failed. */
  stale?: boolean;
  /** Structured upstream failure details. Kept optional for older callers that construct fallbacks. */
  error?: CelesTrakSourceError | null;
  nextRetryAtUtc?: string | null;
  cache?: CelesTrakCacheMetadata;
  upstreamSource?: CelesTrakUpstream;
}

export const CELESTRAK_TLE_GROUPS = ['stations', 'weather', 'starlink', 'active'] as const;
export type CelesTrakTleGroup = (typeof CELESTRAK_TLE_GROUPS)[number];

/** CelesTrak says GP data need not be requested more often than once every two hours. */
export const CELESTRAK_REFRESH_INTERVAL_SECONDS = 7_200;
export const CELESTRAK_FAILURE_COOLDOWN_SECONDS = 7_200;

/**
 * Daily raw mirror of the CelesTrak group files, used only when CelesTrak itself is unreachable
 * (its firewall blocks IPs it considers noisy, which surfaces as a TCP connect timeout).
 */
const DEFAULT_MIRROR_BASE = 'https://raw.githubusercontent.com/satvisorcom/satvisor-data/master/celestrak/tle';
/** Mirror catalogs whose newest TLE epoch is older than this are rejected as stale. */
const MIRROR_MAX_EPOCH_AGE_DAYS = 10;

const FETCH_TIMEOUT_MS = 6_000;
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 600;
const NEXT_REVALIDATION_GRACE_MS = 60_000;
const MAX_UPSTREAM_MESSAGE_LENGTH = 500;
const CELESTRAK_CACHE_TAG = 'celestrak-tle-catalog';
const groupSet = new Set<string>(CELESTRAK_TLE_GROUPS);

interface CachedCatalog {
  group: CelesTrakTleGroup;
  fetchedAtUtc: string;
  fetchedAtMs: number;
  tles: SatelliteTLE[];
  upstream: CelesTrakUpstream;
}

interface LocalCatalogFile {
  group: CelesTrakTleGroup;
  fetched_at_utc: string;
  tles: SatelliteTLE[];
  upstream?: CelesTrakUpstream;
}

type UpstreamCatalogResult =
  | { ok: true; group: CelesTrakTleGroup; fetchedAtUtc: string; tles: SatelliteTLE[]; upstream: CelesTrakUpstream }
  | { ok: false; group: CelesTrakTleGroup; error: CelesTrakSourceError };

interface CircuitState {
  error: CelesTrakSourceError;
  retryAtMs: number;
}

interface PersistentFetchResult {
  result: UpstreamCatalogResult;
  source: 'next-data-cache' | 'direct-upstream';
}

const lastGood = new Map<CelesTrakTleGroup, CachedCatalog>();
const localCacheLoaded = new Set<CelesTrakTleGroup>();
const circuits = new Map<CelesTrakTleGroup, CircuitState>();
const inFlight = new Map<CelesTrakTleGroup, Promise<CelesTrakResponse>>();
let nextDataCacheFetch: ((group: CelesTrakTleGroup) => Promise<UpstreamCatalogResult>) | null = null;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function normalizeGroup(groupName: string): CelesTrakTleGroup {
  const normalized = groupName.trim().toLowerCase();
  return groupSet.has(normalized) ? normalized as CelesTrakTleGroup : 'stations';
}

function parseTimestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSatelliteTle(value: unknown): value is SatelliteTLE {
  if (!value || typeof value !== 'object') return false;
  const tle = value as Partial<SatelliteTLE>;
  return typeof tle.name === 'string' && tle.name.trim().length > 0
    && typeof tle.line1 === 'string' && tle.line1.startsWith('1 ')
    && typeof tle.line2 === 'string' && tle.line2.startsWith('2 ')
    && typeof tle.source === 'string' && tle.source.startsWith('celestrak-');
}

export function parseCelesTrakTleText(text: string, groupName: string): SatelliteTLE[] {
  const group = normalizeGroup(groupName);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const tles: SatelliteTLE[] = [];

  for (let index = 0; index < lines.length - 2; index += 1) {
    const name = lines[index];
    const line1 = lines[index + 1];
    const line2 = lines[index + 2];

    if (!name.startsWith('1 ') && !name.startsWith('2 ') && line1.startsWith('1 ') && line2.startsWith('2 ')) {
      tles.push({ name, line1, line2, source: `celestrak-${group}` });
      index += 2;
    }
  }

  return tles;
}

function runtimeCacheDirectory(): string {
  const configured = process.env.HELIOSAT_CELESTRAK_CACHE_DIR?.trim();
  return configured
    ? path.resolve(process.cwd(), configured)
    : path.join(process.cwd(), 'data', 'cache', 'celestrak');
}

function localCachePath(group: CelesTrakTleGroup): string {
  return path.join(runtimeCacheDirectory(), `${group}.json`);
}

function asLocalCatalog(value: unknown, expectedGroup: CelesTrakTleGroup): CachedCatalog | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LocalCatalogFile>;
  if (candidate.group !== expectedGroup || typeof candidate.fetched_at_utc !== 'string' || !Array.isArray(candidate.tles)) return null;
  const fetchedAtMs = parseTimestampMs(candidate.fetched_at_utc);
  if (fetchedAtMs === null || candidate.tles.length === 0 || !candidate.tles.every(isSatelliteTle)) return null;
  return {
    group: expectedGroup,
    fetchedAtUtc: candidate.fetched_at_utc,
    fetchedAtMs,
    tles: candidate.tles,
    upstream: candidate.upstream === 'celestrak-mirror' ? 'celestrak-mirror' : 'celestrak',
  };
}

async function loadLocalLastGood(group: CelesTrakTleGroup): Promise<CachedCatalog | null> {
  if (localCacheLoaded.has(group)) return lastGood.get(group) ?? null;
  localCacheLoaded.add(group);
  try {
    const parsed = JSON.parse(await fs.readFile(localCachePath(group), 'utf8')) as unknown;
    const catalog = asLocalCatalog(parsed, group);
    if (catalog) lastGood.set(group, catalog);
    return catalog;
  } catch {
    return null;
  }
}

async function persistLocalLastGood(catalog: CachedCatalog): Promise<void> {
  const directory = runtimeCacheDirectory();
  const target = localCachePath(catalog.group);
  const temporary = path.join(directory, `.${catalog.group}.${process.pid}.${Date.now()}.tmp`);
  const payload: LocalCatalogFile = {
    group: catalog.group,
    fetched_at_utc: catalog.fetchedAtUtc,
    tles: catalog.tles,
    upstream: catalog.upstream,
  };

  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(payload), 'utf8');
    await fs.rename(temporary, target);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const atMs = Date.parse(value);
  return Number.isFinite(atMs) ? Math.max(0, Math.ceil((atMs - Date.now()) / 1_000)) : null;
}

function cleanUpstreamMessage(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, MAX_UPSTREAM_MESSAGE_LENGTH) : null;
}

async function httpErrorDetail(response: Response): Promise<string | null> {
  const location = response.headers.get('location');
  let body = '';
  try {
    body = await response.text();
  } catch {
    // The status and headers still provide a structured cause.
  }
  return cleanUpstreamMessage([location ? `Location: ${location}` : '', body].filter(Boolean).join(' · '));
}

function sourceError(
  input: Omit<CelesTrakSourceError, 'attempts'> & { attempts?: number },
): CelesTrakSourceError {
  return { ...input, attempts: input.attempts ?? 1 };
}

function throwableDetail(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause = error.cause && typeof error.cause === 'object' && 'code' in error.cause
    ? String((error.cause as { code?: unknown }).code ?? '')
    : '';
  return cleanUpstreamMessage(cause ? `${error.message} (${cause})` : error.message);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'TimeoutError' || error.name === 'AbortError' || /timed?\s*out/i.test(error.message));
}

async function fetchOnce(group: CelesTrakTleGroup): Promise<UpstreamCatalogResult> {
  const attemptedAtUtc = new Date().toISOString();
  const endpoint = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group.toUpperCase()}&FORMAT=TLE`;

  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'text/plain' },
    });

    if (!response.ok) {
      const retryable = response.status >= 500 && response.status <= 599;
      return {
        ok: false,
        group,
        error: sourceError({
          code: 'CELESTRAK_HTTP',
          kind: 'http',
          message: `CelesTrak returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
          attemptedAtUtc,
          retryable,
          httpStatus: response.status,
          retryAfterSeconds: retryAfterSeconds(response),
          upstreamMessage: await httpErrorDetail(response),
        }),
      };
    }

    const body = await response.text();
    const tles = parseCelesTrakTleText(body, group);
    if (tles.length === 0) {
      return {
        ok: false,
        group,
        error: sourceError({
          code: 'CELESTRAK_INVALID_PAYLOAD',
          kind: 'invalid-payload',
          message: 'CelesTrak returned HTTP 200 without a valid three-line TLE catalog.',
          attemptedAtUtc,
          retryable: false,
          httpStatus: response.status,
          retryAfterSeconds: null,
          upstreamMessage: null,
        }),
      };
    }

    return { ok: true, group, fetchedAtUtc: new Date().toISOString(), tles, upstream: 'celestrak' };
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        group,
        error: sourceError({
          code: 'CELESTRAK_TIMEOUT',
          kind: 'timeout',
          message: `CelesTrak timed out after ${FETCH_TIMEOUT_MS} ms.`,
          attemptedAtUtc,
          retryable: true,
          httpStatus: null,
          retryAfterSeconds: null,
          upstreamMessage: throwableDetail(error),
        }),
      };
    }

    return {
      ok: false,
      group,
      error: sourceError({
        code: 'CELESTRAK_NETWORK',
        kind: 'network',
        message: 'The network connection to CelesTrak failed before an HTTP response was received.',
        attemptedAtUtc,
        retryable: false,
        httpStatus: null,
        retryAfterSeconds: null,
        upstreamMessage: throwableDetail(error),
      }),
    };
  }
}

function tleEpochMs(line1: string): number | null {
  const yearDigits = Number(line1.slice(18, 20));
  const dayOfYear = Number(line1.slice(20, 32));
  if (!Number.isFinite(yearDigits) || !Number.isFinite(dayOfYear) || dayOfYear <= 0) return null;
  const year = yearDigits < 57 ? 2_000 + yearDigits : 1_900 + yearDigits;
  return Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86_400_000;
}

function newestTleEpochMs(tles: SatelliteTLE[]): number | null {
  let newest: number | null = null;
  for (const tle of tles) {
    const epochMs = tleEpochMs(tle.line1);
    if (epochMs !== null && (newest === null || epochMs > newest)) newest = epochMs;
  }
  return newest;
}

function mirrorEndpoint(group: CelesTrakTleGroup): string {
  const base = process.env.HELIOSAT_TLE_MIRROR_BASE?.trim() || DEFAULT_MIRROR_BASE;
  return `${base.replace(/\/+$/, '')}/${group}.tle`;
}

/**
 * Backup catalog from the daily GitHub mirror. Returns null on any failure so the caller keeps
 * reporting the primary CelesTrak error; a mirror whose newest epoch is too old is also rejected
 * rather than silently propagating stale orbits.
 */
async function fetchMirrorOnce(group: CelesTrakTleGroup): Promise<UpstreamCatalogResult | null> {
  try {
    const response = await fetch(mirrorEndpoint(group), {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) return null;

    const tles = parseCelesTrakTleText(await response.text(), group);
    const newestEpochMs = newestTleEpochMs(tles);
    if (tles.length === 0 || newestEpochMs === null) return null;
    if (Date.now() - newestEpochMs > MIRROR_MAX_EPOCH_AGE_DAYS * 86_400_000) return null;

    return { ok: true, group, fetchedAtUtc: new Date().toISOString(), tles, upstream: 'celestrak-mirror' };
  } catch {
    return null;
  }
}

async function fetchCatalogWithRetry(group: CelesTrakTleGroup): Promise<UpstreamCatalogResult> {
  let failure: UpstreamCatalogResult & { ok: false } | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(RETRY_BACKOFF_MS);
    const result = await fetchOnce(group);
    if (result.ok) return result;
    failure = { ...result, error: { ...result.error, attempts: attempt } };
    if (!result.error.retryable) break;
  }

  const mirror = await fetchMirrorOnce(group);
  if (mirror) return mirror;

  return failure ?? {
    ok: false,
    group,
    error: sourceError({
      code: 'CELESTRAK_NETWORK',
      kind: 'network',
      message: 'CelesTrak retrieval ended without a response.',
      attemptedAtUtc: new Date().toISOString(),
      retryable: false,
      httpStatus: null,
      retryAfterSeconds: null,
      upstreamMessage: null,
    }),
  };
}

function hasNoNextCacheRuntime(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as NodeJS.ErrnoException).code ?? '') : '';
  return error.message.includes('incrementalCache missing in unstable_cache')
    || (code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('next/cache'));
}

async function fetchPersistent(group: CelesTrakTleGroup): Promise<PersistentFetchResult> {
  try {
    if (!nextDataCacheFetch) {
      // This project does not enable Cache Components. unstable_cache is the documented Next 16
      // API that persists results across requests and deployments in that configuration.
      const { unstable_cache } = await import('next/cache');
      nextDataCacheFetch = unstable_cache(
        fetchCatalogWithRetry,
        ['heliosat-celestrak-tle-catalog'],
        { revalidate: CELESTRAK_REFRESH_INTERVAL_SECONDS, tags: [CELESTRAK_CACHE_TAG] },
      );
    }
    return { result: await nextDataCacheFetch(group), source: 'next-data-cache' };
  } catch (error) {
    // Direct scientific scripts and focused Node tests have no Next incremental-cache context.
    // The process-level circuit and local last-good cache still bound this fallback to one cycle.
    if (hasNoNextCacheRuntime(error)) {
      return { result: await fetchCatalogWithRetry(group), source: 'direct-upstream' };
    }
    return {
      source: 'next-data-cache',
      result: {
        ok: false,
        group,
        error: sourceError({
          code: 'CELESTRAK_CACHE',
          kind: 'cache',
          message: 'The Next.js persistent CelesTrak cache failed before a catalog could be resolved.',
          attemptedAtUtc: new Date().toISOString(),
          retryable: false,
          httpStatus: null,
          retryAfterSeconds: null,
          upstreamMessage: throwableDetail(error),
        }),
      },
    };
  }
}

function catalogAgeSeconds(catalog: CachedCatalog, nowMs = Date.now()): number {
  return Math.max(0, (nowMs - catalog.fetchedAtMs) / 1_000);
}

function cacheMetadata(catalog: CachedCatalog | null, source: CelesTrakCacheSource): CelesTrakCacheMetadata {
  return {
    source,
    fetchedAtUtc: catalog?.fetchedAtUtc ?? null,
    ageSeconds: catalog ? catalogAgeSeconds(catalog) : null,
    refreshIntervalSeconds: CELESTRAK_REFRESH_INTERVAL_SECONDS,
  };
}

function connectedResponse(
  catalog: CachedCatalog,
  source: CelesTrakCacheSource,
  stale: boolean,
  error: CelesTrakSourceError | null = null,
  retryAtMs: number | null = null,
): CelesTrakResponse {
  return {
    isConnected: true,
    lastUpdated: catalog.fetchedAtUtc,
    errorMessage: error?.message ?? null,
    tles: catalog.tles,
    stale,
    error,
    nextRetryAtUtc: retryAtMs === null ? null : new Date(retryAtMs).toISOString(),
    cache: cacheMetadata(catalog, source),
    upstreamSource: catalog.upstream,
  };
}

function unavailableResponse(error: CelesTrakSourceError, retryAtMs: number): CelesTrakResponse {
  return {
    isConnected: false,
    lastUpdated: null,
    errorMessage: error.message,
    tles: [],
    stale: false,
    error,
    nextRetryAtUtc: new Date(retryAtMs).toISOString(),
    cache: cacheMetadata(null, 'none'),
  };
}

function retryAtFor(error: CelesTrakSourceError, nowMs = Date.now()): number {
  const attemptedAtMs = parseTimestampMs(error.attemptedAtUtc) ?? nowMs;
  const minimum = attemptedAtMs + CELESTRAK_FAILURE_COOLDOWN_SECONDS * 1_000;
  const requested = error.retryAfterSeconds === null
    ? minimum
    : attemptedAtMs + error.retryAfterSeconds * 1_000;
  return Math.max(minimum, requested, nowMs + NEXT_REVALIDATION_GRACE_MS);
}

async function resolveTleGroup(group: CelesTrakTleGroup): Promise<CelesTrakResponse> {
  const memoryCached = lastGood.get(group) ?? null;
  let cached = memoryCached ?? await loadLocalLastGood(group);
  const existingCacheSource: CelesTrakCacheSource = memoryCached ? 'memory' : 'local-last-good';
  const refreshMs = CELESTRAK_REFRESH_INTERVAL_SECONDS * 1_000;
  if (cached && Date.now() - cached.fetchedAtMs < refreshMs) {
    return connectedResponse(cached, existingCacheSource, false);
  }

  const circuit = circuits.get(group);
  if (circuit && Date.now() < circuit.retryAtMs) {
    return cached
      ? connectedResponse(cached, existingCacheSource, true, circuit.error, circuit.retryAtMs)
      : unavailableResponse(circuit.error, circuit.retryAtMs);
  }
  circuits.delete(group);

  const persistent = await fetchPersistent(group);
  const result = persistent.result;
  if (result.ok) {
    const fetchedAtMs = parseTimestampMs(result.fetchedAtUtc) ?? Date.now();
    cached = { group, fetchedAtUtc: result.fetchedAtUtc, fetchedAtMs, tles: result.tles, upstream: result.upstream };
    lastGood.set(group, cached);
    circuits.delete(group);
    await persistLocalLastGood(cached);
    return connectedResponse(cached, persistent.source, Date.now() - fetchedAtMs >= refreshMs);
  }

  const retryAtMs = retryAtFor(result.error);
  circuits.set(group, { error: result.error, retryAtMs });
  return cached
    ? connectedResponse(cached, existingCacheSource, true, result.error, retryAtMs)
    : unavailableResponse(result.error, retryAtMs);
}

/**
 * Fetch a real CelesTrak group with a two-hour persistent cache, process-local single-flight,
 * negative cooldown, and a best-effort on-disk last-good fallback.
 */
export function fetchTleGroup(groupName: string = 'stations'): Promise<CelesTrakResponse> {
  const group = normalizeGroup(groupName);
  const active = inFlight.get(group);
  if (active) return active;

  const request = resolveTleGroup(group).finally(() => {
    if (inFlight.get(group) === request) inFlight.delete(group);
  });
  inFlight.set(group, request);
  return request;
}

/** Focused test isolation; production callers must not clear resilience state. */
export function resetCelesTrakServiceForTests(): void {
  lastGood.clear();
  localCacheLoaded.clear();
  circuits.clear();
  inFlight.clear();
  nextDataCacheFetch = null;
}
