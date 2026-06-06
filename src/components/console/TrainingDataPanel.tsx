"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, Layers, Loader2, RefreshCw } from 'lucide-react';

type Orbit = 'L1' | 'GEO' | 'LEO' | 'MEO';
interface DatasetInfo {
  id: string; orbit: Orbit; mission: string; label: string; category: string;
  variables: string[]; startMs: number | null; endMs: number | null; samples: number;
  days: number | null; cadence: string; coveragePct: number | null; format: string; store: string;
}
interface TrainingInventory {
  generatedAtUtc: string; spanStartMs: number | null; spanEndMs: number;
  parquetBytes: number; datasets: DatasetInfo[]; warnings: string[];
}

const ORBITS: Array<{ orbit: Orbit; title: string; blurb: string; bar: string; chip: string }> = [
  { orbit: 'L1', title: 'L1 · Lagrange point', blurb: 'incoming solar wind, ~1.5M km sunward', bar: 'bg-cyan-400/70', chip: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200' },
  { orbit: 'GEO', title: 'GEO · geostationary', blurb: 'magnetosphere at ~35,786 km (GOES)', bar: 'bg-violet-400/70', chip: 'border-violet-400/40 bg-violet-400/10 text-violet-200' },
  { orbit: 'LEO', title: 'LEO · low Earth orbit', blurb: '~160–2,000 km', bar: 'bg-sky-400/70', chip: 'border-sky-400/40 bg-sky-400/10 text-sky-200' },
  { orbit: 'MEO', title: 'MEO · medium Earth orbit', blurb: '~2,000–35,786 km', bar: 'bg-pink-400/70', chip: 'border-pink-400/40 bg-pink-400/10 text-pink-200' },
];

const fmtDate = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
const fmtInt = (n: number) => n.toLocaleString('en-US');
const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(0)} MB`);

function YearRuler({ startMs, endMs }: { startMs: number; endMs: number }) {
  const ticks = useMemo(() => {
    const out: Array<{ y: number; pct: number }> = [];
    for (let y = new Date(startMs).getUTCFullYear(); y <= new Date(endMs).getUTCFullYear() + 1; y += 1) {
      const ms = Date.UTC(y, 0, 1);
      if (ms < startMs || ms > endMs) continue;
      out.push({ y, pct: ((ms - startMs) / (endMs - startMs)) * 100 });
    }
    return out;
  }, [startMs, endMs]);
  return (
    <div className="relative h-4">
      {ticks.map(t => (
        <div key={t.y} className="absolute top-0 -translate-x-1/2 font-mono text-[9px] text-slate-500" style={{ left: `${t.pct}%` }}>{t.y}</div>
      ))}
    </div>
  );
}

/** Faint year gridlines behind every coverage bar so spans line up with the ruler. */
function GridLines({ startMs, endMs }: { startMs: number; endMs: number }) {
  const lines = useMemo(() => {
    const out: number[] = [];
    for (let y = new Date(startMs).getUTCFullYear(); y <= new Date(endMs).getUTCFullYear() + 1; y += 1) {
      const ms = Date.UTC(y, 0, 1);
      if (ms < startMs || ms > endMs) continue;
      out.push(((ms - startMs) / (endMs - startMs)) * 100);
    }
    return out;
  }, [startMs, endMs]);
  return <>{lines.map((p, i) => <div key={i} className="absolute top-0 h-full w-px bg-slate-800/70" style={{ left: `${p}%` }} />)}</>;
}

function DatasetRow({ ds, startMs, endMs, bar }: { ds: DatasetInfo; startMs: number; endMs: number; bar: string }) {
  const left = ds.startMs !== null ? ((ds.startMs - startMs) / (endMs - startMs)) * 100 : 0;
  const right = ds.endMs !== null ? ((ds.endMs - startMs) / (endMs - startMs)) * 100 : 0;
  const width = Math.max(0.6, right - left);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-slate-200">{ds.mission}</span>
          <span className="truncate text-[11px] text-slate-400">· {ds.category}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-slate-500">
          <span>{ds.cadence}</span>
          <span className="rounded border border-slate-700/60 px-1.5 py-0.5 text-slate-400">{ds.format}</span>
          <span className="text-slate-400">{fmtInt(ds.samples)} smpl</span>
          {ds.coveragePct !== null && <span className={ds.coveragePct >= 95 ? 'text-emerald-300' : ds.coveragePct >= 75 ? 'text-amber-300' : 'text-rose-300'}>{ds.coveragePct}% cov</span>}
        </div>
      </div>
      <div className="mb-1.5 flex flex-wrap gap-1">
        {ds.variables.map(v => <span key={v} className="rounded bg-slate-800/60 px-1.5 py-0.5 font-mono text-[9px] text-slate-300">{v}</span>)}
      </div>
      {/* Coverage bar on the shared time axis */}
      <div className="relative h-5 overflow-hidden rounded border border-slate-800 bg-slate-900/50" title={`${fmtDate(ds.startMs)} → ${fmtDate(ds.endMs)}`}>
        <GridLines startMs={startMs} endMs={endMs} />
        <div className={`absolute top-0.5 bottom-0.5 rounded ${bar}`} style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-500">
        <span>{fmtDate(ds.startMs)}</span>
        <span className="text-slate-600">{ds.days !== null ? `${fmtInt(ds.days)} days` : ''}</span>
        <span>{fmtDate(ds.endMs)}</span>
      </div>
    </div>
  );
}

export function TrainingDataPanel() {
  const [inv, setInv] = useState<TrainingInventory | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/console/training-data', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.ok) setInv((await r.json()) as TrainingInventory);
    } catch { /* keep */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t); }, [load]);

  const span = inv && inv.spanStartMs !== null ? { start: inv.spanStartMs, end: inv.spanEndMs } : null;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
        <div className="flex items-center gap-3">
          <Layers className="h-5 w-5 text-cyan-300" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Training data · local historical archive</h1>
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              everything downloaded locally · classified by orbit · UTC dates
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-slate-400">
          {inv && <span>{inv.datasets.length} datasets</span>}
          {inv && <span className="text-violet-200">{fmtBytes(inv.parquetBytes)} parquet</span>}
          {span && <span className="text-slate-500">{fmtDate(span.start)} → {fmtDate(span.end)}</span>}
          <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1 rounded border border-slate-700/60 px-2 py-1 text-slate-400 hover:text-cyan-200 disabled:cursor-wait">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />} refresh
          </button>
        </div>
      </header>

      {loading && !inv ? (
        <div className="flex h-40 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Scanning local archives…</div>
      ) : !inv ? (
        <div className="flex h-40 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No inventory available</div>
      ) : span ? (
        <>
          <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
            <div className="mb-2 pl-1 font-mono text-[9px] uppercase tracking-widest text-slate-500">coverage timeline</div>
            <div className="pr-1"><YearRuler startMs={span.start} endMs={span.end} /></div>
          </div>
          {ORBITS.map(o => {
            const list = inv.datasets.filter(d => d.orbit === o.orbit);
            return (
              <div key={o.orbit} className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest ${o.chip}`}>{o.orbit}</span>
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{o.title}</h2>
                  <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{o.blurb}</span>
                </div>
                {list.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {list.map(ds => <DatasetRow key={ds.id} ds={ds} startMs={span.start} endMs={span.end} bar={o.bar} />)}
                  </div>
                ) : (
                  <div className="flex h-12 items-center gap-2 rounded-lg border border-dashed border-slate-800 px-4 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                    <Database className="h-3.5 w-3.5" aria-hidden="true" /> no local data yet
                  </div>
                )}
              </div>
            );
          })}
          {inv.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-amber-100/90">{inv.warnings.join(' · ')}</div>
          )}
        </>
      ) : (
        <div className="flex h-40 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No local datasets found</div>
      )}
    </section>
  );
}
