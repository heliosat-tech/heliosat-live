"use client";

import { AlertTriangle, RefreshCw, Sigma, Wand2 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  ExplorationDistribution,
  ExplorationSnapshot,
  ExplorationVariableId,
} from '@/services/explorationService';

interface ExplorationUnivariatePanelProps {
  snapshot: ExplorationSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const VARIABLE_ORDER: ExplorationVariableId[] = ['speed', 'density', 'bt', 'bz'];
const LOCATION_COLOR = { L1: '#38bdf8', Earth: '#34d399' };

function formatNumber(value: number | null, digits = 1) {
  return value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatWindow(range: { startUtc: string; stopUtc: string }) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });
  return `${fmt(range.startUtc)} → ${fmt(range.stopUtc)} UTC`;
}

export function ExplorationHeader({
  snapshot,
  isLoading,
  onRefresh,
  blurb,
}: {
  snapshot: ExplorationSnapshot | null;
  isLoading: boolean;
  onRefresh: () => void;
  blurb: string;
}) {
  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="max-w-2xl text-sm leading-relaxed text-slate-300">{blurb}</p>
          {snapshot && (
            <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              <span className="inline-flex items-center gap-1 rounded border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0.5 text-cyan-200">
                <Wand2 className="h-3 w-3" aria-hidden="true" /> {snapshot.autoSelected ? 'Auto window' : 'Window'}
              </span>
              <span>{formatWindow(snapshot.range)}</span>
              <span className="text-slate-600">·</span>
              <span>ACE (L1) vs OMNI (Earth)</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="flex h-10 shrink-0 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>{isLoading ? 'Loading' : 'Refresh'}</span>
        </button>
      </div>
    </section>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{label}</div>
      <div className="font-mono text-sm text-slate-100">
        {value}
        {unit && value !== '—' && <span className="ml-0.5 text-[10px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

function DistributionColumn({ dist }: { dist: ExplorationDistribution }) {
  const color = LOCATION_COLOR[dist.location];
  const histogramData = dist.histogram.map(bin => ({ x: (bin.binStart + bin.binEnd) / 2, count: bin.count }));

  return (
    <div className="min-w-0 rounded-md border border-slate-800 bg-slate-950/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
          {dist.location === 'L1' ? 'At L1 (ACE)' : 'At Earth (OMNI)'}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">n={dist.count.toLocaleString('en-US')}</span>
      </div>

      {dist.count > 0 ? (
        <>
          <div className="h-28 w-full">
            <ResponsiveContainer width="100%" height={112} minWidth={0} minHeight={112} initialDimension={{ width: 280, height: 112 }}>
              <BarChart data={histogramData} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} fontSize={9} stroke="#64748b" tickFormatter={(value: number) => value.toFixed(0)} minTickGap={24} />
                <YAxis fontSize={9} stroke="#64748b" width={34} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '12px' }}
                  labelFormatter={value => `${dist.label}: ${Number(value).toFixed(1)} ${dist.unit}`}
                  formatter={value => [String(value), 'count']}
                />
                <Bar dataKey="count" fill={color} fillOpacity={0.55} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Stat label="Mean" value={formatNumber(dist.mean)} unit={dist.unit} />
            <Stat label="Median" value={formatNumber(dist.median)} unit={dist.unit} />
            <Stat label="Std" value={formatNumber(dist.std)} unit={dist.unit} />
            <Stat label="Min" value={formatNumber(dist.min)} />
            <Stat label="Max" value={formatNumber(dist.max)} />
            <Stat label="p05–p95" value={`${formatNumber(dist.p05)}–${formatNumber(dist.p95)}`} />
          </div>
        </>
      ) : (
        <div className="flex h-28 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No data</div>
      )}
    </div>
  );
}

export function ExplorationUnivariatePanel({ snapshot, isLoading, error, onRefresh }: ExplorationUnivariatePanelProps) {
  const distByVariable = (variableId: ExplorationVariableId) =>
    VARIABLE_ORDER.includes(variableId)
      ? (snapshot?.distributions.filter(dist => dist.variableId === variableId) ?? [])
      : [];

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      <ExplorationHeader
        snapshot={snapshot}
        isLoading={isLoading}
        onRefresh={onRefresh}
        blurb="What does the solar wind look like? Distribution and summary stats of each variable, measured at L1 (ACE) and at Earth (OMNI), over an automatically chosen historical window."
      />

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {isLoading && !snapshot ? (
        <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Fetching ACE + OMNI…</span>
        </div>
      ) : snapshot ? (
        <>
          <section className="grid gap-4 xl:grid-cols-2">
            {VARIABLE_ORDER.map(variableId => {
              const dists = distByVariable(variableId);
              const meta = dists[0];
              if (!meta) return null;
              return (
                <div key={variableId} className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                  <div className="mb-3 flex items-center gap-2">
                    <Sigma className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{meta.label}</h3>
                    <span className="font-mono text-[10px] text-slate-500">{meta.unit}</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {dists.map(dist => (
                      <DistributionColumn key={dist.location} dist={dist} />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>

          {snapshot.warnings.length > 0 && (
            <section className="grid gap-2">
              {snapshot.warnings.slice(0, 5).map(warning => (
                <div key={warning} className="flex items-start gap-2 rounded-md border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs text-amber-100/90">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{warning}</span>
                </div>
              ))}
            </section>
          )}
        </>
      ) : (
        <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-dashed border-slate-700 bg-slate-950/40 text-sm text-slate-400">
          Loading exploration…
        </div>
      )}
    </main>
  );
}
