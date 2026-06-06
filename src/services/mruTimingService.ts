/**
 * How accurate is the MRU arrival-TIME estimate? MRU predicts the L1→Earth travel
 * time as distance / bulk-speed (a radial, flat-front ballistic guess). OMNI
 * publishes `Timeshift` — the propagation delay it actually computed (phase-front /
 * minimum-variance technique) to the bow shock — which is the community ground
 * truth for "when the parcel really arrived". Comparing the two over years of
 * history gives the MRU timing error (bias, MAE, RMSE, distribution).
 */

const HAPI = 'https://cdaweb.gsfc.nasa.gov/hapi';
const DATASET = 'OMNI_HRO_1MIN';
// Must be in dataset order (HAPI rule 1411): Timeshift, flow_speed, x, BSN_x.
const PARAMS = 'Timeshift,flow_speed,x,BSN_x';
const RE_KM = 6371.2;
const DAY = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const WINDOW_DAYS = 14;
const TARGET_WINDOWS = 14;
const CONCURRENCY = 4;

export interface MruTimingStats {
  samples: number;
  windowsUsed: number;
  mruLagMeanMin: number;
  actualLagMeanMin: number;
  biasMin: number; // mean(MRU − actual); + means MRU over-predicts the travel time
  maeMin: number;
  medianAbsMin: number;
  rmseMin: number;
  stdMin: number;
  p90AbsMin: number;
  maxAbsMin: number;
  withinMinPct: { '5': number; '10': number; '20': number };
  histogram: Array<{ from: number; to: number; count: number }>;
  coverage: { startUtc: string; stopUtc: string } | null;
  computedAtUtc: string;
}

async function datasetSpan(): Promise<{ start: number; stop: number } | null> {
  try {
    const r = await fetch(`${HAPI}/info?id=${DATASET}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const info = (await r.json()) as { startDate?: string; stopDate?: string };
    const start = info.startDate ? new Date(info.startDate).getTime() : Number.NaN;
    const stop = info.stopDate ? new Date(info.stopDate).getTime() : Number.NaN;
    if (Number.isNaN(start) || Number.isNaN(stop)) return null;
    return { start, stop };
  } catch {
    return null;
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const current = i;
      i += 1;
      await fn(items[current]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

interface WindowResult { errors: number[]; mruSum: number; actualSum: number }

/** Per-sample MRU-minus-actual travel-time error (minutes) for one window. */
async function fetchWindowErrors(startUtc: string, stopUtc: string): Promise<WindowResult> {
  const url = `${HAPI}/data?id=${DATASET}&parameters=${PARAMS}&time.min=${startUtc}&time.max=${stopUtc}&format=csv`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const result: WindowResult = { errors: [], mruSum: 0, actualSum: 0 };
  try {
    const r = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!r.ok) return result;
    const text = await r.text();
    for (const line of text.split('\n')) {
      const c = line.split(',');
      if (c.length < 5) continue;
      const ts = Number(c[1]);
      const v = Number(c[2]);
      const x = Number(c[3]);
      const bsn = Number(c[4]);
      if (!Number.isFinite(ts) || !Number.isFinite(v) || !Number.isFinite(x) || !Number.isFinite(bsn)) continue;
      if (ts >= 999999 || v >= 99999 || Math.abs(x) >= 9999 || Math.abs(bsn) >= 9999 || v <= 0) continue;
      const mruLagMin = ((x - bsn) * RE_KM) / v / 60;
      const actualMin = ts / 60;
      result.errors.push(mruLagMin - actualMin);
      result.mruSum += mruLagMin;
      result.actualSum += actualMin;
    }
    return result;
  } catch {
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/** Sample windows across the whole OMNI coverage and aggregate the timing error. */
export async function computeMruTimingStats(): Promise<MruTimingStats | null> {
  const span = await datasetSpan();
  if (!span) return null;

  const windowMs = WINDOW_DAYS * DAY;
  const total = span.stop - span.start;
  const count = Math.max(1, Math.min(TARGET_WINDOWS, Math.floor(total / windowMs)));
  const step = count > 1 ? (total - windowMs) / (count - 1) : 0;
  const windows = Array.from({ length: count }, (_, k) => {
    const ws = span.start + Math.round(k * step);
    return { startUtc: new Date(ws).toISOString(), stopUtc: new Date(Math.min(ws + windowMs, span.stop)).toISOString() };
  });

  const errors: number[] = [];
  let mruSum = 0;
  let actualSum = 0;
  let windowsUsed = 0;
  await mapLimit(windows, CONCURRENCY, async w => {
    const res = await fetchWindowErrors(w.startUtc, w.stopUtc);
    if (res.errors.length > 0) windowsUsed += 1;
    mruSum += res.mruSum;
    actualSum += res.actualSum;
    for (const x of res.errors) errors.push(x);
  });

  if (errors.length === 0) return null;

  const n = errors.length;
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const bias = mean(errors);
  const mae = mean(abs);
  const rmse = Math.sqrt(mean(errors.map(e => e * e)));
  const variance = mean(errors.map(e => (e - bias) ** 2));
  const pct = (frac: number) => abs[Math.min(abs.length - 1, Math.floor(abs.length * frac))];
  const within = (m: number) => Math.round((abs.filter(a => a <= m).length / n) * 1000) / 10;

  // Histogram of signed error, 10-min bins from −60 to +60 (plus tails).
  const bins: Array<{ from: number; to: number; count: number }> = [];
  for (let from = -70; from < 70; from += 10) bins.push({ from, to: from + 10, count: 0 });
  for (const e of errors) {
    const idx = Math.max(0, Math.min(bins.length - 1, Math.floor((e + 70) / 10)));
    bins[idx].count += 1;
  }

  const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    samples: n,
    windowsUsed,
    mruLagMeanMin: round(mruSum / n, 1),
    actualLagMeanMin: round(actualSum / n, 1),
    biasMin: round(bias),
    maeMin: round(mae),
    medianAbsMin: round(pct(0.5)),
    rmseMin: round(rmse),
    stdMin: round(Math.sqrt(variance)),
    p90AbsMin: round(pct(0.9)),
    maxAbsMin: round(abs[abs.length - 1], 1),
    withinMinPct: { '5': within(5), '10': within(10), '20': within(20) },
    histogram: bins,
    coverage: { startUtc: new Date(span.start).toISOString(), stopUtc: new Date(span.stop).toISOString() },
    computedAtUtc: new Date().toISOString(),
  };
}
