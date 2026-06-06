/**
 * MRU arrival-TIME accuracy, validated against the *real* Earth arrival — for a demo
 * over one well-covered storm interval.
 *
 * The idea the panel sells: a parcel of solar wind is seen upstream, the MRU model
 * predicts WHEN it will reach Earth (lag = L1 distance ÷ bulk speed), and later we
 * re-detect that same parcel arriving near Earth and measure how many MINUTES off the
 * prediction was.
 *
 * Ground truth: OMNI 1-min publishes `Timeshift` — the propagation delay it actually
 * computed (phase-front / minimum-variance technique) for every minute, i.e. the real
 * L1→Earth travel time of the parcel that arrived then. The MRU delay is the simple
 * ballistic distance/speed. Their difference IS the MRU arrival-time error, in minutes,
 * at 1-min resolution. We compute it across the interval (bias / MAE / RMSE / spread),
 * overlay the predicted-vs-actual arrived wind, highlight the observed G storm bands
 * (from the Kp archive) and the GEO (GOES) magnetosphere response, and pull out the
 * individual shock arrivals with their per-event timing error.
 *
 * Interval: the May 2024 "Gannon" G5 superstorm — the strongest in two decades and
 * fully covered by L1 (ACE/OMNI) *and* GEO (GOES). Result is cached on disk (the past
 * is immutable), so after the first build the panel is instant and offline.
 */

import { sliceArchive } from './omniArchiveStore';
import { sliceGeoArchive } from './geoArchiveStore';
import { classifyGFromKp } from './stormScaleService';

const HAPI = 'https://cdaweb.gsfc.nasa.gov/hapi';
const DATASET = 'OMNI_HRO_1MIN';
// HAPI requires parameters in dataset order: Timeshift,BZ_GSM,flow_speed,proton_density,x,BSN_x,SYM_H
const PARAMS = 'Timeshift,BZ_GSM,flow_speed,proton_density,x,BSN_x,SYM_H';
const RE_KM = 6371.2;
const MIN = 60_000;
const HOUR = 3_600_000;
const REQUEST_TIMEOUT_MS = 90_000;

// Aggregate statistics span: the headline error / strata are computed over MANY YEARS so
// the numbers are robust (not just one storm). We use OMNI 5-min here — it carries the
// same `Timeshift` but is ~5× lighter than 1-min, so multiple years are tractable. The
// span is bounded to where the local Kp archive exists (for the storm-intensity strata).
const STATS_DATASET = 'OMNI_HRO_5MIN';
const STATS_PARAMS = 'Timeshift,flow_speed,x,BSN_x';
const STATS_SPAN = { start: '2021-01-01T00:00:00Z', stop: '2026-05-01T00:00:00Z' } as const;
const STATS_CONCURRENCY = 4;

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** The curated demo OVERLAY window (UTC) — one continuous span with L1 + GEO coverage,
 *  shown as the worked example below the aggregate stats. */
export const ARRIVAL_INTERVAL = {
  start: '2024-05-08T00:00:00Z',
  stop: '2024-05-17T00:00:00Z',
  label: 'May 2024 · G5 “Gannon” superstorm',
} as const;

export interface ArrivalOverlayPoint { t: number; speed: number | null; bz: number | null }
export interface ArrivalPredPoint { t: number; speed: number | null }
export interface GBand { from: number; to: number; level: number }
export interface ArrivalEvent {
  id: string;
  /** Minute the shock front was first cleanly re-detected at Earth (OMNI). */
  observedArrivalMs: number;
  /** Where MRU said that same parcel would arrive. */
  predictedArrivalMs: number;
  /** predicted − observed, minutes. + = forecast was late. */
  errorMin: number;
  /** Warning lead = L1→Earth transit time of this parcel (min). The margin operators get. */
  leadMin: number;
  speedBefore: number;
  speedAfter: number;
  deltaSpeed: number;
  minBz: number | null;
  peakKp: number | null;
  peakG: number;
}
/** Arrival-error stats for one activity stratum (e.g. severe-storm minutes vs quiet). */
export interface ArrivalStratum {
  key: 'severe' | 'storm' | 'quiet';
  label: string;
  n: number;
  sharePct: number; // % of all interval minutes in this stratum
  maeMin: number;
  biasMin: number;
  within20Pct: number;
  leadMin: number; // mean warning lead (transit time) for this regime
}
export interface ArrivalAccuracy {
  interval: { startUtc: string; stopUtc: string; label: string }; // the overlay/example window
  source: 'omni-1min';
  // Span the AGGREGATE stats below were computed over (many years, OMNI 5-min) — or the
  // overlay window itself if the multi-year fetch failed.
  statsSpan: { startUtc: string; stopUtc: string; multiYear: boolean };
  samples: number; // valid arrival-error samples in statsSpan
  biasMin: number;
  maeMin: number;
  rmseMin: number;
  medianAbsMin: number;
  p90AbsMin: number;
  withinMinPct: { '10': number; '20': number; '30': number };
  // Mean warning lead (L1→Earth transit time) over the span — the margin operators have.
  // The error only matters relative to this: ±8 min on a 30-min lead is fine.
  meanLeadMin: number;
  // The same error sliced by how disturbed the wind was at each instant (observed G),
  // plus the error across only the detected shock fronts — so "aggressive vs calm" is explicit.
  strata: ArrivalStratum[];
  eventsMaeMin: number | null;
  actual: ArrivalOverlayPoint[]; // OMNI arrived wind (the truth), at its real arrival times
  predicted: ArrivalPredPoint[]; // the same wind re-timed to the MRU-predicted arrival
  bands: GBand[]; // observed G storm bands (from the Kp archive)
  geo: Array<{ t: number; hp: number | null }>; // GEO (GOES) magnetosphere response
  events: ArrivalEvent[];
  headlineEventId: string | null;
  computedAtUtc: string;
}

/** Keep at most `target` points by even striding (the chart re-buckets anyway). */
function stride<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
  return out;
}

async function fetchOmniInterval(): Promise<string | null> {
  const url = `${HAPI}/data?id=${DATASET}&parameters=${PARAMS}&time.min=${ARRIVAL_INTERVAL.start}&time.max=${ARRIVAL_INTERVAL.stop}&format=csv`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface Row { t: number; speed: number; bz: number | null; tPred: number; errMin: number; leadMin: number }

interface ErrorSummary {
  samples: number;
  biasMin: number;
  maeMin: number;
  rmseMin: number;
  medianAbsMin: number;
  p90AbsMin: number;
  withinMinPct: { '10': number; '20': number; '30': number };
}

/** Distribution stats from a list of signed per-sample arrival errors (minutes). */
function summarize(errors: number[]): ErrorSummary {
  const n = errors.length;
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const pct = (f: number) => abs[Math.min(abs.length - 1, Math.floor(abs.length * f))];
  const within = (m: number) => round((abs.filter(a => a <= m).length / n) * 100, 1);
  return {
    samples: n,
    biasMin: round(mean(errors)),
    maeMin: round(mean(abs)),
    rmseMin: round(Math.sqrt(mean(errors.map(e => e * e)))),
    medianAbsMin: round(pct(0.5)),
    p90AbsMin: round(pct(0.9)),
    withinMinPct: { '10': within(10), '20': within(20), '30': within(30) },
  };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; await fn(items[k]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Fetch one OMNI 5-min chunk (Timeshift,flow_speed,x,BSN_x) as CSV. */
async function fetchStatsChunk(startUtc: string, stopUtc: string): Promise<string | null> {
  const url = `${HAPI}/data?id=${STATS_DATASET}&parameters=${STATS_PARAMS}&time.min=${startUtc}&time.max=${stopUtc}&format=csv`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface StratAcc { n: number; sumAbs: number; sumE: number; within20: number; sumLead: number }

const STRAT_LABEL: Record<ArrivalStratum['key'], string> = {
  severe: 'Severe storm · G3–G5',
  storm: 'Storm · G1–G2',
  quiet: 'Quiet · G0',
};

/**
 * Aggregate arrival-time error over the multi-year STATS_SPAN (OMNI 5-min, yearly chunks
 * in parallel), with the storm-intensity strata classified by the local Kp archive.
 * Returns null only if every chunk fetch failed (caller falls back to the overlay window).
 */
async function computeBigSpanStats(): Promise<{ summary: ErrorSummary; strata: ArrivalStratum[]; span: { startUtc: string; stopUtc: string }; meanLeadMin: number } | null> {
  const start = Date.parse(STATS_SPAN.start);
  const stop = Date.parse(STATS_SPAN.stop);

  // Kp step lookup from the local hourly archive (for G classification of each sample).
  const omni = await sliceArchive(start, stop);
  const kp = (omni?.kpSeries ?? []).slice().sort((a, b) => a.ms - b.ms);
  const kpMs = kp.map(p => p.ms);
  const kpLvl = kp.map(p => classifyGFromKp(p.kp).level);
  const gAt = (t: number): number => {
    if (kpMs.length === 0) return 0;
    let lo = 0, hi = kpMs.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (kpMs[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx < 0 || t - kpMs[idx] > 3 * HOUR + 30 * MIN) return 0; // gap → quiet
    return kpLvl[idx];
  };

  // Yearly chunks across the span.
  const chunks: Array<[string, string]> = [];
  for (let y = new Date(start).getUTCFullYear(); ; y++) {
    const s = Date.UTC(y, 0, 1);
    if (s >= stop) break;
    const cs = Math.max(s, start);
    const ce = Math.min(Date.UTC(y + 1, 0, 1), stop);
    if (ce > cs) chunks.push([new Date(cs).toISOString(), new Date(ce).toISOString()]);
  }

  const errors: number[] = [];
  let sumLead = 0;
  const acc: Record<ArrivalStratum['key'], StratAcc> = {
    severe: { n: 0, sumAbs: 0, sumE: 0, within20: 0, sumLead: 0 },
    storm: { n: 0, sumAbs: 0, sumE: 0, within20: 0, sumLead: 0 },
    quiet: { n: 0, sumAbs: 0, sumE: 0, within20: 0, sumLead: 0 },
  };
  await mapLimit(chunks, STATS_CONCURRENCY, async ([a, b]) => {
    const text = await fetchStatsChunk(a, b);
    if (!text) return;
    for (const line of text.split('\n')) {
      const c = line.split(',');
      if (c.length < 5) continue;
      const t = Date.parse(c[0]);
      const ts = Number(c[1]);
      const speed = Number(c[2]);
      const x = Number(c[3]);
      const bsn = Number(c[4]);
      if (!Number.isFinite(t) || !Number.isFinite(ts) || ts <= 0 || ts >= 900_000) continue;
      if (!Number.isFinite(speed) || speed <= 0 || speed >= 90_000) continue;
      if (!Number.isFinite(x) || Math.abs(x) >= 9_999 || !Number.isFinite(bsn) || Math.abs(bsn) >= 9_999) continue;
      const errMin = (((x - bsn) * RE_KM) / speed - ts) / 60;
      const leadMin = ts / 60;
      errors.push(errMin);
      sumLead += leadMin;
      const g = gAt(t);
      const A = acc[g >= 3 ? 'severe' : g >= 1 ? 'storm' : 'quiet'];
      A.n += 1; A.sumAbs += Math.abs(errMin); A.sumE += errMin; A.sumLead += leadMin; if (Math.abs(errMin) <= 20) A.within20 += 1;
    }
  });
  if (errors.length === 0) return null;

  const total = errors.length;
  const strata: ArrivalStratum[] = (['severe', 'storm', 'quiet'] as const)
    .map(key => {
      const A = acc[key];
      return {
        key, label: STRAT_LABEL[key], n: A.n,
        sharePct: round((A.n / total) * 100, 1),
        maeMin: A.n ? round(A.sumAbs / A.n) : 0,
        biasMin: A.n ? round(A.sumE / A.n) : 0,
        within20Pct: A.n ? round((A.within20 / A.n) * 100, 1) : 0,
        leadMin: A.n ? round(A.sumLead / A.n) : 0,
      };
    })
    .filter(s => s.n > 0);

  return { summary: summarize(errors), strata, span: { startUtc: STATS_SPAN.start, stopUtc: STATS_SPAN.stop }, meanLeadMin: round(sumLead / total) };
}

/** Observed G storm bands (level ≥ 1) over the interval, from the local Kp archive. */
async function stormBands(start: number, stop: number): Promise<{ bands: GBand[]; kp: Array<{ ms: number; kp: number }> }> {
  const omni = await sliceArchive(start, stop);
  const kp = (omni?.kpSeries ?? []).slice().sort((a, b) => a.ms - b.ms);
  const bands: GBand[] = [];
  for (let i = 0; i < kp.length; i++) {
    const level = classifyGFromKp(kp[i].kp).level;
    if (level < 1) continue;
    const segEnd = i + 1 < kp.length ? kp[i + 1].ms : kp[i].ms + 3 * HOUR;
    const last = bands[bands.length - 1];
    if (last && last.level === level && Math.abs(last.to - kp[i].ms) < MIN) last.to = segEnd;
    else bands.push({ from: kp[i].ms, to: segEnd, level });
  }
  return { bands, kp };
}

/** Detect sustained solar-wind shock fronts (speed jumps) in the arrived record. */
function detectShocks(rows: Row[]): number[] {
  const cand: Array<{ k: number; delta: number }> = [];
  for (let k = 1; k < rows.length; k++) {
    const delta = rows[k].speed - rows[k - 1].speed;
    if (delta < 60 || rows[k].speed < 420) continue;
    // Must stay elevated for ~2 h (a real shock, not a 1-sample spike).
    let sum = 0;
    let n = 0;
    for (let m = k + 1; m < rows.length && rows[m].t - rows[k].t <= 2 * HOUR; m++) { sum += rows[m].speed; n += 1; }
    if (n > 0 && sum / n < rows[k].speed - 60) continue;
    cand.push({ k, delta });
  }
  // Dedupe within 8 h, keep the steepest front in each cluster.
  cand.sort((a, b) => b.delta - a.delta);
  const chosen: number[] = [];
  for (const c of cand) {
    if (chosen.every(k => Math.abs(rows[k].t - rows[c.k].t) > 8 * HOUR)) chosen.push(c.k);
    if (chosen.length >= 6) break;
  }
  return chosen.sort((a, b) => rows[a].t - rows[b].t);
}

export async function computeArrivalAccuracy(): Promise<ArrivalAccuracy | null> {
  const text = await fetchOmniInterval();
  if (!text) return null;
  const start = Date.parse(ARRIVAL_INTERVAL.start);
  const stop = Date.parse(ARRIVAL_INTERVAL.stop);

  const rows: Row[] = [];
  const errors: number[] = [];
  for (const line of text.split('\n')) {
    const c = line.split(',');
    if (c.length < 8) continue;
    const t = Date.parse(c[0]);
    const ts = Number(c[1]); // Timeshift, s
    const bzRaw = Number(c[2]);
    const speed = Number(c[3]); // flow_speed, km/s
    const x = Number(c[5]); // spacecraft X (Re)
    const bsn = Number(c[6]); // bow-shock-nose X (Re)
    if (!Number.isFinite(t)) continue;
    if (!Number.isFinite(ts) || ts <= 0 || ts >= 900_000) continue;
    if (!Number.isFinite(speed) || speed <= 0 || speed >= 90_000) continue;
    if (!Number.isFinite(x) || Math.abs(x) >= 9_999) continue;
    if (!Number.isFinite(bsn) || Math.abs(bsn) >= 9_999) continue;
    const bz = Number.isFinite(bzRaw) && Math.abs(bzRaw) < 9_999 ? bzRaw : null;
    const mruDelayS = ((x - bsn) * RE_KM) / speed; // ballistic L1→bow-shock travel time
    const errMin = (mruDelayS - ts) / 60;
    rows.push({ t, speed, bz, tPred: t + (mruDelayS - ts) * 1000, errMin, leadMin: ts / 60 });
    errors.push(errMin);
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.t - b.t);

  // Overlay-window summary — used only as a fallback if the multi-year fetch fails.
  const overlaySummary = summarize(errors);

  const { bands, kp } = await stormBands(start, stop);
  const peakGin = (from: number, to: number) => {
    let g = 0;
    let maxKp: number | null = null;
    for (const p of kp) {
      if (p.ms < from || p.ms > to) continue;
      g = Math.max(g, classifyGFromKp(p.kp).level);
      maxKp = maxKp === null ? p.kp : Math.max(maxKp, p.kp);
    }
    return { g, maxKp };
  };

  // Per-event arrival timing.
  const events: ArrivalEvent[] = detectShocks(rows).map(k => {
    const r = rows[k];
    let minBz: number | null = null;
    for (let m = k; m < rows.length && rows[m].t - r.t <= 24 * HOUR; m++) {
      if (rows[m].bz !== null) minBz = minBz === null ? rows[m].bz : Math.min(minBz, rows[m].bz as number);
    }
    const { g, maxKp } = peakGin(r.t, r.t + 36 * HOUR);
    return {
      id: `evt-${new Date(r.t).toISOString().slice(0, 16).replace(/[:T-]/g, '')}`,
      observedArrivalMs: r.t,
      predictedArrivalMs: r.tPred,
      errorMin: round(r.errMin),
      leadMin: round(r.leadMin),
      speedBefore: Math.round(rows[k - 1].speed),
      speedAfter: Math.round(r.speed),
      deltaSpeed: Math.round(r.speed - rows[k - 1].speed),
      minBz: minBz === null ? null : round(minBz),
      peakKp: maxKp,
      peakG: g,
    };
  });
  const headline = events.slice().sort((a, b) => b.peakG - a.peakG || b.deltaSpeed - a.deltaSpeed)[0] ?? null;

  // ---- Stratify the per-minute error by how disturbed the wind was (observed G at that
  // instant) so "aggressive event minutes" vs "calm minutes" are separated. ----
  const sortedBands = bands.slice().sort((a, b) => a.from - b.from);
  const gAt = (t: number): number => {
    let lvl = 0;
    for (const b of sortedBands) { if (t < b.from) break; if (t < b.to) lvl = Math.max(lvl, b.level); }
    return lvl;
  };
  const buckets: Record<'severe' | 'storm' | 'quiet', Row[]> = { severe: [], storm: [], quiet: [] };
  for (const r of rows) {
    const g = gAt(r.t);
    (g >= 3 ? buckets.severe : g >= 1 ? buckets.storm : buckets.quiet).push(r);
  }
  const stratum = (key: ArrivalStratum['key'], label: string, rs: Row[]): ArrivalStratum => {
    const nn = rs.length;
    const a = rs.map(r => Math.abs(r.errMin));
    return {
      key, label, n: nn,
      sharePct: Math.round((nn / rows.length) * 1000) / 10,
      maeMin: nn ? round(a.reduce((s, x) => s + x, 0) / nn) : 0,
      biasMin: nn ? round(rs.reduce((s, r) => s + r.errMin, 0) / nn) : 0,
      within20Pct: nn ? Math.round((a.filter(x => x <= 20).length / nn) * 1000) / 10 : 0,
      leadMin: nn ? round(rs.reduce((s, r) => s + r.leadMin, 0) / nn) : 0,
    };
  };
  const overlayStrata: ArrivalStratum[] = [
    stratum('severe', 'Severe storm · G3–G5', buckets.severe),
    stratum('storm', 'Storm · G1–G2', buckets.storm),
    stratum('quiet', 'Quiet · G0', buckets.quiet),
  ].filter(s => s.n > 0);
  const eventsMaeMin = events.length ? round(events.reduce((s, e) => s + Math.abs(e.errorMin), 0) / events.length) : null;
  const overlayMeanLead = round(rows.reduce((s, r) => s + r.leadMin, 0) / rows.length);

  // ---- Aggregate stats over MANY YEARS (OMNI 5-min). Falls back to the overlay window
  // if the multi-year fetch fails entirely, so the panel always renders. ----
  const big = await computeBigSpanStats();
  const summary = big ? big.summary : overlaySummary;
  const finalStrata = big ? big.strata : overlayStrata;
  const meanLeadMin = big ? big.meanLeadMin : overlayMeanLead;
  const statsSpan = big
    ? { startUtc: big.span.startUtc, stopUtc: big.span.stopUtc, multiYear: true }
    : { startUtc: ARRIVAL_INTERVAL.start, stopUtc: ARRIVAL_INTERVAL.stop, multiYear: false };

  // GEO (GOES) magnetosphere response over the interval.
  const geo = stride((await sliceGeoArchive(start, stop)).map(s => ({ t: s.ms, hp: s.hp })), 900);

  return {
    interval: { startUtc: ARRIVAL_INTERVAL.start, stopUtc: ARRIVAL_INTERVAL.stop, label: ARRIVAL_INTERVAL.label },
    source: 'omni-1min',
    statsSpan,
    ...summary,
    meanLeadMin,
    strata: finalStrata,
    eventsMaeMin,
    actual: stride(rows.map(r => ({ t: r.t, speed: r.speed, bz: r.bz })), 1800),
    predicted: stride(rows.map(r => ({ t: r.tPred, speed: r.speed })).sort((a, b) => a.t - b.t), 1800),
    bands,
    geo,
    events,
    headlineEventId: headline?.id ?? null,
    computedAtUtc: new Date().toISOString(),
  };
}
