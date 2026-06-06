"use client";

import { useMemo } from 'react';
import {
  AlertTriangle,
  CalendarRange,
  History,
  Info,
  Play,
  RefreshCw,
  Ruler,
  Target,
  Wand2,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  MruValidationMetric,
  MruValidationSeries,
  MruValidationSnapshot,
} from '@/services/mruValidationService';

interface ValidationRangeInput {
  start: string;
  stop: string;
}

interface MruValidationPanelProps {
  snapshot: MruValidationSnapshot | null;
  isLoading: boolean;
  error: string | null;
  range: ValidationRangeInput;
  onRangeChange: (range: ValidationRangeInput) => void;
  onSelectInterval: (range: ValidationRangeInput) => void;
  onRefresh: () => void;
}

const RECOMMENDED_INTERVALS = [
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '30 days', days: 30 },
] as const;

/** Build a datetime-local window of `days` ending at the data-coverage stop. */
function intervalEndingAt(stopUtc: string, days: number): ValidationRangeInput | null {
  const stopMs = new Date(stopUtc).getTime();
  if (Number.isNaN(stopMs)) {
    return null;
  }
  const startMs = stopMs - days * 24 * 60 * 60 * 1000;
  return { start: new Date(startMs).toISOString().slice(0, 16), stop: new Date(stopMs).toISOString().slice(0, 16) };
}

const SERIES_COLORS = {
  l1: '#64748b',
  predicted: '#22d3ee',
  ml: '#c084fc',
  truth: '#34d399',
};

function formatNumber(value: number | null, digits = 1) {
  return value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatClock(ms: number) {
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
}

function mergeSeries(series: MruValidationSeries) {
  const byTime = new Map<number, { t: number; l1: number | null; predicted: number | null; ml: number | null; truth: number | null }>();

  const ensure = (timeUtc: string) => {
    const t = new Date(timeUtc).getTime();
    if (Number.isNaN(t)) {
      return null;
    }
    let row = byTime.get(t);
    if (!row) {
      row = { t, l1: null, predicted: null, ml: null, truth: null };
      byTime.set(t, row);
    }
    return row;
  };

  for (const point of series.l1) {
    const row = ensure(point.timeUtc);
    if (row) row.l1 = point.value;
  }
  for (const point of series.predicted) {
    const row = ensure(point.timeUtc);
    if (row) row.predicted = point.value;
  }
  for (const point of series.mlPredicted) {
    const row = ensure(point.timeUtc);
    if (row) row.ml = point.value;
  }
  for (const point of series.truth) {
    const row = ensure(point.timeUtc);
    if (row) row.truth = point.value;
  }

  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function formatR2(value: number | null) {
  return value === null ? '—' : value.toFixed(2);
}

/** One row of model stats (R² is the headline quality coefficient: 1 = perfect, 0 = no better than the mean). */
function ModelRow({ label, color, r2, mae, unit }: { label: string; color: string; r2: number | null; mae: number | null; unit: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-2.5 py-2">
      <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-300">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
        {label}
      </span>
      <span className="flex items-baseline gap-3 font-mono text-xs">
        <span className="text-slate-400">R² <span className="text-slate-100">{formatR2(r2)}</span></span>
        <span className="text-slate-400">MAE <span className="text-slate-100">{formatNumber(mae)}</span> <span className="text-[10px] text-slate-500">{unit}</span></span>
      </span>
    </div>
  );
}

function MetricCard({ mru, ml }: { mru: MruValidationMetric; ml: MruValidationMetric | null }) {
  const skillPct =
    ml && ml.rmse !== null && mru.rmse !== null && mru.rmse > 0 ? (1 - ml.rmse / mru.rmse) * 100 : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">{mru.label}</h4>
        {skillPct !== null && (
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${
              skillPct >= 0 ? 'border-purple-400/40 bg-purple-400/15 text-purple-100' : 'border-slate-700 bg-slate-800/60 text-slate-400'
            }`}
          >
            ML {skillPct >= 0 ? '+' : ''}{skillPct.toFixed(0)}% vs MRU
          </span>
        )}
      </div>
      {mru.count > 0 ? (
        <div className="mt-3 grid gap-1.5">
          <ModelRow label="MRU" color={SERIES_COLORS.predicted} r2={mru.r2} mae={mru.mae} unit={mru.unit} />
          {ml ? (
            <ModelRow label="ML" color={SERIES_COLORS.ml} r2={ml.r2} mae={ml.mae} unit={ml.unit} />
          ) : (
            <div className="rounded-md border border-dashed border-slate-800 px-2.5 py-2 font-mono text-[10px] uppercase tracking-widest text-slate-600">
              ML not trained
            </div>
          )}
          <div className="mt-1 font-mono text-[10px] text-slate-600">{mru.count.toLocaleString('en-US')} points scored</div>
        </div>
      ) : (
        <div className="mt-3 text-sm text-slate-500">No overlapping data to score.</div>
      )}
    </div>
  );
}

function ComparisonChart({ series, showMl }: { series: MruValidationSeries; showMl: boolean }) {
  const data = useMemo(() => mergeSeries(series), [series]);
  const hasData = data.some(row => row.predicted !== null || row.truth !== null);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{series.label}</h4>
        <div className="flex items-center gap-3 font-mono text-[9px] uppercase tracking-widest">
          <span className="flex items-center gap-1 text-slate-500"><span className="h-0.5 w-3" style={{ backgroundColor: SERIES_COLORS.l1 }} />L1 raw</span>
          <span className="flex items-center gap-1 text-cyan-200"><span className="h-0.5 w-3" style={{ backgroundColor: SERIES_COLORS.predicted }} />MRU</span>
          {showMl && <span className="flex items-center gap-1 text-purple-200"><span className="h-0.5 w-3" style={{ backgroundColor: SERIES_COLORS.ml }} />ML</span>}
          <span className="flex items-center gap-1 text-emerald-200"><span className="h-0.5 w-3" style={{ backgroundColor: SERIES_COLORS.truth }} />OMNI (truth)</span>
        </div>
      </div>
      {hasData ? (
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height={176} minWidth={0} minHeight={176} initialDimension={{ width: 480, height: 176 }}>
            <LineChart data={data} margin={{ top: 6, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                fontSize={10}
                stroke="#64748b"
                tickMargin={6}
                minTickGap={36}
                tickFormatter={(value: number) => formatClock(value)}
              />
              <YAxis domain={['auto', 'auto']} fontSize={10} stroke="#64748b" tickFormatter={(value: number) => value.toFixed(0)} />
              <Tooltip
                contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '12px' }}
                labelFormatter={value => `${formatClock(Number(value))} UTC`}
                formatter={(value, name) => [Number(value).toFixed(2), String(name)]}
              />
              <Line name="L1 raw" dataKey="l1" stroke={SERIES_COLORS.l1} strokeWidth={1} strokeOpacity={0.6} dot={false} connectNulls isAnimationActive={false} type="linear" />
              <Line name="MRU" dataKey="predicted" stroke={SERIES_COLORS.predicted} strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} type="linear" />
              {showMl && (
                <Line name="ML" dataKey="ml" stroke={SERIES_COLORS.ml} strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} type="linear" />
              )}
              <Line name="OMNI (truth)" dataKey="truth" stroke={SERIES_COLORS.truth} strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} type="linear" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-44 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No data for this window</div>
      )}
      {series.note && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{series.note}</span>
        </div>
      )}
    </div>
  );
}

export function MruValidationPanel({ snapshot, isLoading, error, range, onRangeChange, onSelectInterval, onRefresh }: MruValidationPanelProps) {
  const coverageStopUtc = snapshot?.range.stopUtc ?? null;
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      {/* Controls + explanation */}
      <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-5 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Ruler className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Backtest the MRU baseline</h2>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-300">
              We replay the solar wind measured at L1 (ACE) over a past window, propagate it to Earth with MRU, and compare it
              against what actually reached Earth (OMNI). Lower error = the baseline tracked reality better.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="flex h-10 shrink-0 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
          >
            {isLoading ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
            <span>{isLoading ? 'Running' : 'Run backtest'}</span>
          </button>
        </div>

        {snapshot?.autoSelected && (
          <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            <span className="inline-flex items-center gap-1 rounded border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0.5 text-cyan-200">
              <Wand2 className="h-3 w-3" aria-hidden="true" /> Auto window
            </span>
            <span>chosen automatically where ACE + OMNI both have data — edit below to pick another.</span>
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:max-w-xl">
          <label className="grid gap-1.5">
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" /> Start UTC
            </span>
            <input
              type="datetime-local"
              value={range.start}
              onChange={event => onRangeChange({ ...range, start: event.target.value })}
              className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" /> Stop UTC
            </span>
            <input
              type="datetime-local"
              value={range.stop}
              onChange={event => onRangeChange({ ...range, stop: event.target.value })}
              className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60"
            />
          </label>
        </div>

        {coverageStopUtc && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Recommended (verified to have data):</span>
            {RECOMMENDED_INTERVALS.map(interval => {
              const next = intervalEndingAt(coverageStopUtc, interval.days);
              if (!next) return null;
              return (
                <button
                  key={interval.days}
                  type="button"
                  onClick={() => onSelectInterval(next)}
                  disabled={isLoading}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-2.5 font-mono text-[11px] text-slate-300 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100 disabled:cursor-wait disabled:text-slate-600"
                >
                  <History className="h-3.5 w-3.5" aria-hidden="true" />
                  {interval.label}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {isLoading && !snapshot ? (
        <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Fetching ACE + OMNI and scoring…</span>
        </div>
      ) : snapshot ? (
        <>
          {/* Headline numbers */}
          <section className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] p-4">
              <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-cyan-300/80">
                <Target className="h-3.5 w-3.5" aria-hidden="true" /> Mean transit lag
              </div>
              <div className="mt-2 font-mono text-2xl text-cyan-100">
                {snapshot.meanLagMinutes !== null ? `${Math.round(snapshot.meanLagMinutes)} min` : '—'}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">MRU shifted L1 forward by this much on average.</div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Matched points</div>
              <div className="mt-2 font-mono text-2xl text-slate-100">{snapshot.sampleCount.matched.toLocaleString('en-US')}</div>
              <div className="mt-1 text-[11px] text-slate-400">L1 {snapshot.sampleCount.l1.toLocaleString('en-US')} · truth {snapshot.sampleCount.truth.toLocaleString('en-US')}</div>
            </div>
            {snapshot.mlAvailable && snapshot.mlOverallSkillPct !== null ? (
              <div className="rounded-lg border border-purple-400/25 bg-purple-400/[0.06] p-4">
                <div className="font-mono text-[9px] uppercase tracking-widest text-purple-300/80">ML skill vs MRU</div>
                <div className="mt-2 font-mono text-2xl text-purple-100">
                  {snapshot.mlOverallSkillPct >= 0 ? '+' : ''}{snapshot.mlOverallSkillPct.toFixed(0)}%
                </div>
                <div className="mt-1 text-[11px] text-slate-400">Average error reduction vs the baseline.</div>
              </div>
            ) : (
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Sources</div>
                <div className="mt-2 text-sm text-slate-200">{snapshot.l1Source}</div>
                <div className="mt-1 text-[11px] text-slate-400">vs {snapshot.truthSource}</div>
              </div>
            )}
          </section>

          {/* Scoreboard: R² is the quality coefficient (1 = perfect). Higher = better. */}
          {snapshot.metrics.length > 0 && (
            <section className="grid gap-3 sm:grid-cols-3">
              {snapshot.metrics.map(metric => (
                <MetricCard
                  key={metric.variableId}
                  mru={metric}
                  ml={snapshot.mlMetrics?.find(m => m.variableId === metric.variableId) ?? null}
                />
              ))}
            </section>
          )}

          {/* Comparison charts */}
          {snapshot.series.length > 0 && (
            <section className="grid gap-4 xl:grid-cols-2">
              {snapshot.series.map(series => (
                <ComparisonChart key={series.variableId} series={series} showMl={snapshot.mlAvailable} />
              ))}
            </section>
          )}

          {/* Warnings */}
          {snapshot.warnings.length > 0 && (
            <section className="grid gap-2">
              {snapshot.warnings.slice(0, 6).map(warning => (
                <div key={warning} className="flex items-start gap-2 rounded-md border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs text-amber-100/90">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{warning}</span>
                </div>
              ))}
            </section>
          )}
        </>
      ) : (
        <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-700 bg-slate-950/40 text-center">
          <Ruler className="h-6 w-6 text-slate-600" aria-hidden="true" />
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Pick a window and run the backtest</div>
          <div className="max-w-md text-sm text-slate-400">A past storm is a good test — the MRU baseline is easy when the wind is steady and harder when it is gusty.</div>
        </div>
      )}
    </main>
  );
}
