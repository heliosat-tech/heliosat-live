"use client";

import { AlertTriangle, Info, Target, Waves } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ExplorationCoupling, ExplorationSnapshot } from '@/services/explorationService';
import { ExplorationHeader } from './ExplorationUnivariatePanel';

interface ExplorationCouplingPanelProps {
  snapshot: ExplorationSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function formatLag(value: number | null) {
  return value === null ? '—' : `${Math.round(value)} min`;
}

function CouplingCard({ coupling }: { coupling: ExplorationCoupling }) {
  const hasData = coupling.peakCorrelation !== null && coupling.ccf.length > 0;
  const lagDelta =
    coupling.optimalLagMinutes !== null && coupling.mruExpectedLagMinutes !== null
      ? coupling.optimalLagMinutes - coupling.mruExpectedLagMinutes
      : null;

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Waves className="h-4 w-4 text-cyan-300" aria-hidden="true" />
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{coupling.label}</h3>
        </div>
        <span className="font-mono text-[10px] text-slate-500">n={coupling.count.toLocaleString('en-US')}</span>
      </div>

      {hasData ? (
        <>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <div className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.06] p-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-cyan-300/80">Measured lag</div>
              <div className="font-mono text-lg text-cyan-100">{formatLag(coupling.optimalLagMinutes)}</div>
            </div>
            <div className="rounded-md border border-amber-300/25 bg-amber-300/[0.06] p-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-amber-300/80">MRU estimate</div>
              <div className="font-mono text-lg text-amber-100">{formatLag(coupling.mruExpectedLagMinutes)}</div>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Peak corr</div>
              <div className="font-mono text-lg text-slate-100">{coupling.peakCorrelation!.toFixed(2)}</div>
            </div>
          </div>

          <div className="h-40 w-full">
            <ResponsiveContainer width="100%" height={160} minWidth={0} minHeight={160} initialDimension={{ width: 360, height: 160 }}>
              <LineChart data={coupling.ccf} margin={{ top: 6, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="lagMinutes"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  fontSize={10}
                  stroke="#64748b"
                  tickMargin={6}
                  tickFormatter={(value: number) => `${value}`}
                />
                <YAxis domain={[-1, 1]} fontSize={10} stroke="#64748b" tickFormatter={(value: number) => value.toFixed(1)} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '12px' }}
                  labelFormatter={value => `Lag ${Number(value)} min`}
                  formatter={value => [Number(value).toFixed(3), 'correlation']}
                />
                <ReferenceLine y={0} stroke="#334155" />
                {coupling.mruExpectedLagMinutes !== null && (
                  <ReferenceLine x={coupling.mruExpectedLagMinutes} stroke="#fbbf24" strokeDasharray="4 3" strokeOpacity={0.8} />
                )}
                {coupling.optimalLagMinutes !== null && (
                  <ReferenceLine x={coupling.optimalLagMinutes} stroke="#22d3ee" strokeOpacity={0.8} />
                )}
                <Line dataKey="correlation" stroke="#38bdf8" strokeWidth={1.7} dot={false} isAnimationActive={false} type="monotone" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-2 text-[11px] leading-relaxed text-slate-400">
            X axis = how many minutes Earth lags L1. The peak (cyan) is the measured travel time; amber is the MRU estimate.
            {lagDelta !== null && (
              <> Measured is <span className="text-slate-200">{Math.abs(Math.round(lagDelta))} min {lagDelta >= 0 ? 'slower' : 'faster'}</span> than MRU.</>
            )}
          </div>
          {coupling.note && (
            <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
              <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{coupling.note}</span>
            </div>
          )}
        </>
      ) : (
        <div className="flex h-40 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">
          Not enough overlapping data
        </div>
      )}
    </div>
  );
}

export function ExplorationCouplingPanel({ snapshot, isLoading, error, onRefresh }: ExplorationCouplingPanelProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      <ExplorationHeader
        snapshot={snapshot}
        isLoading={isLoading}
        onRefresh={onRefresh}
        blurb="How long does the solar wind take to travel L1 → Earth? We cross-correlate ACE (L1) against OMNI (Earth) at many time lags; the peak is the real travel time — and it's exactly what the MRU baseline tries to estimate from distance ÷ speed."
      />

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {isLoading && !snapshot ? (
        <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Fetching ACE + OMNI and correlating…</span>
        </div>
      ) : snapshot ? (
        <>
          {snapshot.meanSpeedKmS !== null && (
            <section className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700/50 bg-slate-900/30 p-3 text-xs text-slate-300 shadow-2xl backdrop-blur-xl">
              <Target className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
              <span>
                Mean L1 speed in this window ≈ <span className="font-mono text-cyan-200">{Math.round(snapshot.meanSpeedKmS)} km/s</span>,
                so the MRU ballistic travel time is about{' '}
                <span className="font-mono text-amber-200">{formatLag(snapshot.coupling[0]?.mruExpectedLagMinutes ?? null)}</span>. Compare it
                with the measured peaks below.
              </span>
            </section>
          )}

          <section className="grid gap-4 xl:grid-cols-2">
            {snapshot.coupling.map(coupling => (
              <CouplingCard key={coupling.variableId} coupling={coupling} />
            ))}
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
