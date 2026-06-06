"use client";

import { Activity, CalendarDays, Gauge, RefreshCw, RadioTower } from 'lucide-react';
import type { LiveForecastSnapshot } from '@/services/liveForecastService';

interface LiveForecastPanelProps {
  snapshot: LiveForecastSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function formatNumber(value: number | null, maximumFractionDigits = 2) {
  if (value === null) {
    return 'NA';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function ForecastChart({ snapshot }: { snapshot: LiveForecastSnapshot }) {
  const points = snapshot.forecast;

  if (points.length < 2) {
    return (
      <div className="flex h-[360px] items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No forecast
      </div>
    );
  }

  const width = 920;
  const height = 300;
  const values = points.flatMap(point => [point.observed, point.predicted, point.lower, point.upper]).filter((value): value is number => value !== null);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const x = (index: number) => (index / Math.max(1, points.length - 1)) * (width - 28) + 14;
  const y = (value: number) => height - ((value - minValue) / range) * (height - 28) - 14;
  const observedLine = points.map((point, index) => point.observed === null ? null : `${x(index).toFixed(1)},${y(point.observed).toFixed(1)}`).filter(Boolean).join(' ');
  const predictedLine = points.map((point, index) => point.predicted === null ? null : `${x(index).toFixed(1)},${y(point.predicted).toFixed(1)}`).filter(Boolean).join(' ');
  const bandTop = points.map((point, index) => point.upper === null ? null : `${x(index).toFixed(1)},${y(point.upper).toFixed(1)}`).filter(Boolean);
  const bandBottom = points.slice().reverse().map((point, reverseIndex) => {
    const index = points.length - 1 - reverseIndex;
    return point.lower === null ? null : `${x(index).toFixed(1)},${y(point.lower).toFixed(1)}`;
  }).filter(Boolean);
  const nowIndex = points.findIndex(point => point.horizonMinutes === 15) - 1;
  const nowX = nowIndex >= 0 ? x(nowIndex) : width / 2;

  return (
    <svg aria-hidden="true" className="h-[360px] w-full rounded border border-slate-800 bg-slate-950/50" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      {(bandTop.length > 1 && bandBottom.length > 1) && <polygon fill="#22d3ee" opacity="0.14" points={[...bandTop, ...bandBottom].join(' ')} />}
      <polyline fill="none" points={observedLine} stroke="#22d3ee" strokeLinejoin="round" strokeWidth="2.5" />
      <polyline fill="none" points={predictedLine} stroke="#e879f9" strokeDasharray="5 4" strokeLinejoin="round" strokeWidth="2.4" />
      <line stroke="#f59e0b" strokeDasharray="4 4" x1={nowX} x2={nowX} y1="10" y2={height - 10} />
      <circle cx={nowX} cy="18" fill="#f59e0b" r="5" />
      <text fill="#94a3b8" fontSize="10" x="14" y="18">observed / forecast</text>
    </svg>
  );
}

function MiniSpark({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="h-12 rounded border border-slate-800 bg-slate-950/50" />;
  }

  const width = 160;
  const height = 44;
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const line = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * (width - 8) + 4;
    const y = height - ((value - minValue) / range) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg aria-hidden="true" className="h-12 w-full rounded border border-slate-800 bg-slate-950/50" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" points={line} stroke="#22d3ee" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

export function LiveForecastPanel({ snapshot, isLoading, error, onRefresh }: LiveForecastPanelProps) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="space-y-4">
        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300">Live Forecast</div>
              <h2 className="mt-1 truncate text-lg font-semibold text-slate-100">{snapshot?.model.target ?? 'Operational target'}</h2>
              <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                {snapshot ? `${snapshot.model.model} · ${snapshot.model.status}` : 'Not available'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {snapshot && (
                <span className={`rounded border px-3 py-2 font-mono text-[10px] uppercase tracking-widest ${
                  snapshot.currentAlert === 'green'
                    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
                    : snapshot.currentAlert === 'yellow'
                      ? 'border-amber-300/30 bg-amber-300/10 text-amber-100'
                      : snapshot.currentAlert === 'red'
                        ? 'border-rose-400/30 bg-rose-400/10 text-rose-100'
                        : 'border-slate-700 bg-slate-900 text-slate-500'
                }`}>
                  {snapshot.currentAlert}
                </span>
              )}
              <button type="button" onClick={onRefresh} disabled={isLoading} className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500">
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>{isLoading ? 'Updating' : 'Refresh'}</span>
              </button>
            </div>
          </div>
          {error && <div className="mt-3 rounded border border-rose-400/30 bg-rose-400/10 p-2 font-mono text-[10px] uppercase tracking-widest text-rose-100">{error}</div>}
        </section>

        {snapshot ? (
          <>
            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <ForecastChart snapshot={snapshot} />
            </section>
            <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Track record</h2>
                </div>
                <div className="grid gap-2">
                  {snapshot.rollingRmse.slice(-8).map(point => (
                    <div key={`${point.timestampUtc}-${point.horizonMinutes}`} className="flex justify-between rounded border border-slate-800 bg-slate-950/50 px-3 py-2 font-mono text-[10px]">
                      <span className="text-slate-500">{point.timestampUtc.slice(11, 16)} UTC</span>
                      <span className="text-slate-200">RMSE {formatNumber(point.rmse24h)}</span>
                    </div>
                  ))}
                </div>
              </article>
              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-2">
                  <Gauge className="h-4 w-4 text-amber-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">System health</h2>
                </div>
                <div className="grid gap-3">
                  <div className="rounded border border-slate-800 bg-slate-950/50 p-3">
                    <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Drift score</div>
                    <div className="mt-1 font-mono text-sm text-slate-100">{formatNumber(snapshot.systemHealth.driftScore)}</div>
                  </div>
                  <MiniSpark values={snapshot.systemHealth.driftSparkline} />
                  <div className="rounded border border-slate-800 bg-slate-950/50 p-3 font-mono text-[10px] text-slate-400">
                    P50 {formatNumber(snapshot.systemHealth.inferenceLatencyMsP50, 0)} ms · P95 {formatNumber(snapshot.systemHealth.inferenceLatencyMsP95, 0)} ms
                  </div>
                </div>
              </article>
              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-2">
                  <RadioTower className="h-4 w-4 text-emerald-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Upstream freshness</h2>
                </div>
                <div className="grid max-h-56 gap-2 overflow-y-auto">
                  {snapshot.systemHealth.upstreamFreshness.slice(0, 8).map(source => (
                    <div key={source.sourceId} className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950/50 px-3 py-2">
                      <span className="min-w-0 truncate text-xs text-slate-300">{source.name}</span>
                      <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{source.status}</span>
                    </div>
                  ))}
                </div>
              </article>
            </section>
            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-3 flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Operational history</h2>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {snapshot.operationalHistory.map(day => (
                  <div key={day.dayUtc} title={`${day.dayUtc}: ${formatNumber(day.meanAbsoluteError)}`} className="h-5 w-5 rounded-sm border border-slate-800" style={{ backgroundColor: `rgba(34, 211, 238, ${Math.min(0.85, 0.12 + (day.meanAbsoluteError ?? 0) / 20)})` }} />
                ))}
              </div>
            </section>
          </>
        ) : (
          <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
            {isLoading ? 'Updating forecast' : 'Not available'}
          </div>
        )}
      </div>
    </main>
  );
}
