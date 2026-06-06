import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { fetchLiveL1History } from '@/services/liveL1HistoryService';
import { fetchPlanetaryKpSeries } from '@/services/noaaStormScalesService';
import { fetchOmniHourlyHistory } from '@/services/omniHistoryService';
import { fetchAceOmniSamples } from '@/services/l1EarthData';
import { propagateL1Series, NOMINAL_L1_DISTANCE_KM, type L1Sample } from '@/services/mruForecastService';
import { downsamplePoints, type ForecastHistoryPoint } from '@/services/forecastHistoryService';
import { classifyGFromKp, kpFromCoupling, mergingFieldMvM } from '@/services/stormScaleService';
import { readSeriesCache, writeSeriesCache, SERIES_TTL_MS } from '@/services/consoleSeriesCache';
import { sliceArchive } from '@/services/omniArchiveStore';
import { sliceAceArchive } from '@/services/aceArchiveStore';
import { fetchGoesGeo } from '@/services/goesGeoService';
import { sliceGeoArchive } from '@/services/geoArchiveStore';
import { fetchNearEarthTelemetry } from '@/services/nearEarthTelemetryService';
import type { L1EventSample, KpPoint } from '@/services/liveEventService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const DAY = 24 * 60 * 60 * 1000;
const TARGET = 2500;

// live  = DSCOVR L1 + MRU (recent; near-Earth not arrived yet)
// compare = ACE L1 + MRU forecast + OMNI near-Earth truth, all overlaid
// omni  = OMNI archive near-Earth only (year scale; ACE 1-min too heavy)
const WINDOWS: Record<string, { source: 'live' | 'compare' | 'omni'; days: number }> = {
  '24h': { source: 'live', days: 1 },
  '3d': { source: 'live', days: 3 },
  '7d': { source: 'live', days: 7 },
  '30d': { source: 'compare', days: 31 },
  '1y': { source: 'omni', days: 366 },
  '5y': { source: 'omni', days: 5 * 366 },
};

function gLevel(speed: number | null, bz: number | null): number {
  return classifyGFromKp(kpFromCoupling(mergingFieldMvM(speed, bz), speed)).level;
}
const toPoint = (s: { ms: number; speed: number | null; density: number | null; bt: number | null; bz: number | null }): ForecastHistoryPoint =>
  ({ t: s.ms, speed: s.speed, density: s.density, bt: s.bt, bz: s.bz });
const toPointL1 = (s: { ms: number; speedKmS: number | null; densityPerCm3: number | null; btNt: number | null; bzNt: number | null }): ForecastHistoryPoint =>
  ({ t: s.ms, speed: s.speedKmS, density: s.densityPerCm3, bt: s.btNt, bz: s.bzNt });

interface SeriesPayload {
  window: string;
  source: 'live' | 'compare' | 'omni';
  startMs: number;
  endMs: number;
  l1: ForecastHistoryPoint[];
  mru: ForecastHistoryPoint[];
  nearEarth: ForecastHistoryPoint[];
  gForecast: Array<{ t: number; level: number }>;
  gObserved: Array<{ t: number; level: number }>;
  // GEO (GOES magnetometer at geostationary orbit): magnetospheric field, nT. Distinct
  // class from the L1 solar wind above. SWPC covers the last ~7 days only.
  geo: Array<{ t: number; hp: number | null; total: number | null }>;
  geoSat: number | null;
  geoSource: 'swpc' | 'archive';
  // All live plot-ready GEO GOES charts from SWPC primary/secondary JSON.
  geoPlots: Array<{
    id: string;
    spacecraft: string;
    title: string;
    unit: string;
    color: string;
    points: Array<{ t: number; value: number | null }>;
  }>;
  warnings: string[];
  archived?: boolean;
}

/**
 * GEO (GOES magnetometer Hp/|H|) for the window. Historical windows slice the LOCAL
 * NCEI archive (years of hourly data); live windows use SWPC (last ~7 days).
 */
async function geoSeries(source: 'live' | 'compare' | 'omni', days: number, startMs: number, nowMs: number): Promise<{ geo: SeriesPayload['geo']; geoSat: number | null; geoSource: 'swpc' | 'archive'; warning: string | null }> {
  if (source !== 'live') {
    const arch = await sliceGeoArchive(startMs, nowMs);
    if (arch.length > 0) {
      const geo = downsamplePoints(arch.map(s => ({ t: s.ms, speed: s.hp, density: s.total, bt: null, bz: null })), TARGET).map(p => ({ t: p.t, hp: p.speed, total: p.density }));
      return { geo, geoSat: null, geoSource: 'archive', warning: null };
    }
  }
  const res = await fetchGoesGeo(Math.min(days, 7));
  return {
    geo: downsamplePoints(res.samples.map(s => ({ t: s.ms, speed: s.hp, density: s.total, bt: null, bz: null })), TARGET).map(p => ({ t: p.t, hp: p.speed, total: p.density })),
    geoSat: res.satellite,
    geoSource: 'swpc',
    warning: res.errorMessage,
  };
}

function plotValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function geoPlotSeries(): Promise<{ plots: SeriesPayload['geoPlots']; warning: string | null }> {
  try {
    const feeds = await fetchNearEarthTelemetry();
    const warnings = feeds.map(feed => feed.errorMessage).filter((message): message is string => Boolean(message));
    const plots = feeds
      .flatMap(feed => feed.charts)
      .map(chart => ({
        id: chart.id,
        spacecraft: chart.spacecraft,
        title: chart.title,
        unit: chart.unit,
        color: chart.color,
        points: chart.data
          .map(point => ({ t: new Date(point.time_tag).getTime(), value: plotValue(point.value) }))
          .filter(point => !Number.isNaN(point.t)),
      }))
      .filter(plot => plot.points.length > 0);

    return {
      plots,
      warning: warnings.length > 0 ? `GOES GEO plots: ${warnings.slice(0, 3).join('; ')}` : null,
    };
  } catch (error) {
    return {
      plots: [],
      warning: error instanceof Error ? `GOES GEO plots: ${error.message}` : 'GOES GEO plots unavailable',
    };
  }
}

/** Build the payload for a window from upstream (uncached). */
async function computeSeries(window: string, config: { source: 'live' | 'compare' | 'omni'; days: number }): Promise<SeriesPayload> {
  const nowMs = Date.now();
  const warnings: string[] = [];

  // GEO (GOES magnetometer) for all windows — appears on the recent tail.
  const [g, availableGeo] = await Promise.all([geoSeries(config.source, config.days, nowMs - config.days * DAY, nowMs), geoPlotSeries()]);
  if (g.warning) warnings.push(g.warning);
  if (availableGeo.warning) warnings.push(availableGeo.warning);

  // ---- Year-scale OMNI archive (near-Earth only). Slice the LOCAL archive when built
  // (instant); otherwise fall back to a live CDAWeb fetch. ----
  if (config.source === 'omni') {
    const start = nowMs - config.days * DAY;
    const sliced = await sliceArchive(start, nowMs);
    let samples: L1EventSample[];
    let kpSeries: KpPoint[];
    let startOut = start;
    let endOut = nowMs;
    let archived = false;
    if (sliced && sliced.samples.length > 0) {
      samples = sliced.samples; kpSeries = sliced.kpSeries; archived = true;
    } else {
      const omni = await fetchOmniHourlyHistory(config.days);
      if (omni.errorMessage) warnings.push(omni.errorMessage);
      else warnings.push('Local OMNI archive empty — fetched live (slow). Build it from the chart toolbar to speed this up.');
      samples = omni.samples; kpSeries = omni.kpSeries; startOut = omni.startMs; endOut = omni.endMs;
    }
    const nearEarth = downsamplePoints(samples.map(toPointL1), TARGET);

    // L1 (ACE) detected + its MRU forecast, from the ACE archive when built. Keeps the
    // 3-line overlay on multi-year ranges. (L1 = ACE at the Lagrange point — never
    // "near Earth"; near-Earth is the OMNI line above.)
    let l1: ForecastHistoryPoint[] = [];
    let mru: ForecastHistoryPoint[] = [];
    const ace = await sliceAceArchive(start, nowMs);
    if (ace && ace.samples.length > 0) {
      l1 = downsamplePoints(ace.samples.map(toPointL1), TARGET);
      const asL1: L1Sample[] = ace.samples.map(s => ({ timeUtc: new Date(s.ms).toISOString(), speedKmS: s.speedKmS, densityPerCm3: s.densityPerCm3, bzNt: s.bzNt, btNt: s.btNt, temperatureK: null }));
      mru = downsamplePoints(
        propagateL1Series(asL1, NOMINAL_L1_DISTANCE_KM)
          .map(p => ({ t: new Date(p.arrivalTimeUtc).getTime(), speed: p.speedKmS, density: p.densityPerCm3, bt: p.btNt, bz: p.bzNt })),
        TARGET,
      );
    }

    return {
      window, source: 'omni', startMs: startOut, endMs: endOut, archived,
      l1, mru, nearEarth,
      // G forecast from the complete near-Earth record (ACE plasma is sparse post-2024,
      // so the MRU line alone would leave the G chart with a recent hole).
      gForecast: nearEarth.map(p => ({ t: p.t, level: gLevel(p.speed, p.bz) })),
      gObserved: kpSeries.map(p => ({ t: p.ms, level: classifyGFromKp(p.kp).level })),
      geo: g.geo, geoSat: g.geoSat, geoSource: g.geoSource, geoPlots: availableGeo.plots,
      warnings,
    };
  }

  // ---- Compare: ACE L1 + MRU forecast + OMNI near-Earth truth, all overlaid.
  // Anchored to the END of OMNI coverage (~weeks ago) so the near-Earth line spans
  // the whole window. Near-Earth + Kp come from the RELIABLE hourly OMNI (single
  // request); ACE L1 is best-effort (HAPI 1-min chunks can flake) — if it fails we
  // still show the near-Earth truth. ----
  if (config.source === 'compare') {
    // Anchor to NOW so the window runs right up to today: L1 (ACE) reaches ~now, while
    // near-Earth (OMNI) lags ~3 weeks → the recent tail is intentionally blank.
    const stop = nowMs;
    const start = nowMs - config.days * DAY;

    // Near-Earth + Kp: slice the local archive (instant) or fall back to a live fetch.
    let nearEarthSamples: L1EventSample[];
    let kpInRange: KpPoint[];
    const sliced = await sliceArchive(start, stop);
    if (sliced && sliced.samples.length > 0) {
      nearEarthSamples = sliced.samples; kpInRange = sliced.kpSeries;
    } else {
      const daysForOmni = Math.ceil((nowMs - start) / DAY) + 2;
      const omni = await fetchOmniHourlyHistory(daysForOmni);
      if (omni.errorMessage) warnings.push(omni.errorMessage);
      nearEarthSamples = omni.samples.filter(s => s.ms >= start && s.ms <= stop);
      kpInRange = omni.kpSeries.filter(p => p.ms >= start && p.ms <= stop);
    }
    const nearEarth = downsamplePoints(nearEarthSamples.map(toPointL1), TARGET);

    // Best-effort upstream ACE for the L1 input + MRU forecast overlay. Bounded so a
    // flaky HAPI never blocks the (already-loaded) near-Earth truth from returning.
    let l1: ForecastHistoryPoint[] = [];
    let mru: ForecastHistoryPoint[] = [];
    try {
      const ace = await Promise.race([
        fetchAceOmniSamples({ startUtc: new Date(start).toISOString(), stopUtc: new Date(stop).toISOString() }, { source: 'k0' }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 35000)),
      ]);
      if (ace && ace.l1.length > 0) {
        l1 = downsamplePoints(ace.l1.map(toPoint), TARGET);
        const asL1: L1Sample[] = ace.l1.map(s => ({ timeUtc: new Date(s.ms).toISOString(), speedKmS: s.speed, densityPerCm3: s.density, bzNt: s.bz, btNt: s.bt, temperatureK: null }));
        mru = downsamplePoints(
          propagateL1Series(asL1, NOMINAL_L1_DISTANCE_KM)
            .map(p => ({ t: new Date(p.arrivalTimeUtc).getTime(), speed: p.speedKmS, density: p.densityPerCm3, bt: p.btNt, bz: p.bzNt }))
            .filter(p => p.t >= start && p.t <= stop),
          TARGET,
        );
      } else {
        warnings.push('ACE upstream L1 unavailable for this window — showing OMNI (L1 at Earth) only.');
      }
    } catch {
      warnings.push('ACE upstream L1 fetch failed — showing OMNI (L1 at Earth) only.');
    }

    return {
      window, source: 'compare', startMs: start, endMs: stop, archived: sliced !== null && sliced.samples.length > 0,
      l1, mru, nearEarth,
      gForecast: (mru.length > 0 ? mru : nearEarth).map(p => ({ t: p.t, level: gLevel(p.speed, p.bz) })),
      gObserved: kpInRange.map(p => ({ t: p.ms, level: classifyGFromKp(p.kp).level })),
      geo: g.geo, geoSat: g.geoSat, geoSource: g.geoSource, geoPlots: availableGeo.plots,
      warnings,
    };
  }

  // ---- Live (DSCOVR) window ----
  const [history, kpSeries] = await Promise.all([fetchLiveL1History(), fetchPlanetaryKpSeries()]);
  const samples = history.samples.slice().sort((a, b) => a.ms - b.ms);
  const start = nowMs - config.days * DAY;
  const l1Points = samples.filter(s => s.ms >= start).map(toPointL1);
  const asL1: L1Sample[] = samples.map(s => ({ timeUtc: new Date(s.ms).toISOString(), speedKmS: s.speedKmS, densityPerCm3: s.densityPerCm3, bzNt: s.bzNt, btNt: s.btNt, temperatureK: null }));
  const mruRaw = propagateL1Series(asL1, history.distanceKm)
    .map(p => ({ t: new Date(p.arrivalTimeUtc).getTime(), speed: p.speedKmS, density: p.densityPerCm3, bt: p.btNt, bz: p.bzNt }))
    .filter(p => p.t >= start);
  const mru = downsamplePoints(mruRaw, TARGET);

  return {
    window, source: 'live', startMs: start, endMs: nowMs,
    l1: downsamplePoints(l1Points, TARGET), mru, nearEarth: [],
    gForecast: mru.map(p => ({ t: p.t, level: gLevel(p.speed, p.bz) })),
    gObserved: kpSeries.filter(p => p.ms >= start).map(p => ({ t: p.ms, level: classifyGFromKp(p.kp).level })),
    geo: g.geo, geoSat: g.geoSat, geoSource: g.geoSource, geoPlots: availableGeo.plots,
    warnings,
  };
}

const isEmptyPayload = (p: SeriesPayload) => p.l1.length === 0 && p.mru.length === 0 && p.nearEarth.length === 0;
const noStore = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Chart series for the Internal Console. Returns L1 detected, the MRU forecast, the
 * near-Earth OMNI truth (where it exists), and the discrete forecast-vs-observed G
 * step series. Split from the status endpoint so the 60s poll stays light.
 *
 * Backed by an on-disk per-window cache (see consoleSeriesCache): historical ranges
 * are near-immutable, so within a per-window TTL repeat loads are an instant disk
 * read instead of a fresh multi-thousand-row HAPI download. `?refresh=1` forces a
 * recompute; if upstream returns nothing we serve the last good snapshot.
 */
export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, ...noStore });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get('window') ?? '24h';
  const refresh = url.searchParams.get('refresh') === '1';
  const window = key in WINDOWS ? key : '24h';
  const config = WINDOWS[window];
  const ttl = SERIES_TTL_MS[window] ?? 60_000;
  const now = Date.now();

  const cached = await readSeriesCache<SeriesPayload>(window);
  const cachedHasGeoPlots = Array.isArray(cached?.payload?.geoPlots);
  if (!refresh && cached && cachedHasGeoPlots && now - cached.fetchedAtMs < ttl) {
    return NextResponse.json({ ...cached.payload, cached: true, cacheAgeMs: now - cached.fetchedAtMs }, noStore);
  }

  let payload: SeriesPayload;
  try {
    payload = await computeSeries(window, config);
  } catch (error) {
    if (cached) {
      return NextResponse.json(
        { ...cached.payload, cached: true, stale: true, cacheAgeMs: now - cached.fetchedAtMs, warnings: [...cached.payload.warnings, 'Upstream fetch failed — showing last cached snapshot.'] },
        noStore,
      );
    }
    throw error;
  }

  // Upstream gave nothing usable — prefer the last good snapshot over a blank chart.
  if (isEmptyPayload(payload) && cached) {
    return NextResponse.json(
      { ...cached.payload, cached: true, stale: true, cacheAgeMs: now - cached.fetchedAtMs, warnings: [...cached.payload.warnings, 'Upstream returned no data — showing last cached snapshot.'] },
      noStore,
    );
  }

  if (!isEmptyPayload(payload)) await writeSeriesCache(window, payload);
  return NextResponse.json(payload, noStore);
}
