"use client";

import { BrainCircuit, LineChart, RefreshCw, ShieldCheck } from 'lucide-react';
import type { SequenceModelsSnapshot } from '@/services/sequenceModelService';

interface SequenceModelsPanelProps {
  snapshot: SequenceModelsSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function formatNumber(value: number | null, maximumFractionDigits = 3) {
  if (value === null) {
    return 'NA';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

export function SequenceModelsPanel({
  snapshot,
  isLoading,
  error,
  onRefresh,
}: SequenceModelsPanelProps) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="space-y-4">
        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300">
                Sequence Models
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold text-slate-100">Deep sequence gate</h2>
              <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                {snapshot ? snapshot.decision.reason : 'Not available'}
              </div>
            </div>
            <button type="button" onClick={onRefresh} disabled={isLoading} className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500">
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{isLoading ? 'Evaluating' : 'Refresh'}</span>
            </button>
          </div>
          {error && <div className="mt-3 rounded border border-rose-400/30 bg-rose-400/10 p-2 font-mono text-[10px] uppercase tracking-widest text-rose-100">{error}</div>}
        </section>

        {snapshot ? (
          <>
            <section className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
              <article className={`rounded-lg border p-4 shadow-2xl backdrop-blur-xl ${
                snapshot.decision.canProceed
                  ? 'border-emerald-400/30 bg-emerald-400/10'
                  : 'border-amber-300/30 bg-amber-300/10'
              }`}>
                <div className="mb-2 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest">Decision</h2>
                </div>
                <div className="font-mono text-sm text-slate-100">
                  {snapshot.decision.canProceed ? 'Proceed to scheduled training' : 'Hold sequence training'}
                </div>
                <div className="mt-2 font-mono text-[10px] text-slate-300">
                  Best baseline: {snapshot.decision.bestBaselineModel ?? 'NA'} · skill {formatNumber(snapshot.decision.bestBaselineSkill)}
                </div>
              </article>

              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-2">
                  <BrainCircuit className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Architecture queue</h2>
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {snapshot.sequenceModels.map(model => (
                    <article key={model.architecture} className="rounded-lg border border-slate-800 bg-slate-950/45 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-slate-100">{model.model}</h3>
                          <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                            {model.windowMinutes}m window · {model.horizonMinutes}m horizon
                          </div>
                        </div>
                        <span className={`rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${
                          model.status === 'registered'
                            ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100'
                            : 'border-amber-300/30 bg-amber-300/10 text-amber-100'
                        }`}>
                          {model.status}
                        </span>
                      </div>
                      <div className="mt-3 rounded border border-slate-800 bg-slate-950/60 p-3 font-mono text-[10px] text-slate-400">
                        {model.notes[0]}
                      </div>
                    </article>
                  ))}
                </div>
              </article>
            </section>

            <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-2">
                  <LineChart className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Training curves</h2>
                </div>
                <div className="flex h-64 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                  No trained sequence run yet
                </div>
              </article>

              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-2">
                  <BrainCircuit className="h-4 w-4 text-fuchsia-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Attention / saliency</h2>
                </div>
                <div className="flex h-64 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                  Awaiting trained model artifact
                </div>
              </article>
            </section>
          </>
        ) : (
          <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
            {isLoading ? 'Evaluating sequence gate' : 'Not available'}
          </div>
        )}
      </div>
    </main>
  );
}
