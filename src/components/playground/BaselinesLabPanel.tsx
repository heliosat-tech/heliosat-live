"use client";

import { useMemo, useState } from 'react';
import {
  Download,
  GitCompare,
  LineChart,
  RefreshCw,
  Table2,
} from 'lucide-react';
import type {
  BaselinesLabSnapshot,
  ModelFamily,
  ModelPredictionRow,
  ModelRunRecord,
} from '@/services/modelBenchmarkService';

interface BaselinesLabPanelProps {
  snapshot: BaselinesLabSnapshot | null;
  isLoading: boolean;
  error: string | null;
  selectedRunId: string | null;
  onSelectedRunChange: (runId: string) => void;
  onRefresh: () => void;
}

type RunFilterFamily = ModelFamily | 'all';

function formatNumber(value: number | null, maximumFractionDigits = 3) {
  if (value === null) {
    return 'NA';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function exportRuns(snapshot: BaselinesLabSnapshot) {
  const blob = new Blob([JSON.stringify({
    runsDbPath: snapshot.runsDbPath,
    runs: snapshot.runs,
    predictionsPath: snapshot.predictionsPath,
    featureImportancePath: snapshot.featureImportancePath,
  }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = 'baselines_lab_runs.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function getRunPredictions(snapshot: BaselinesLabSnapshot, runId: string | null) {
  if (!runId) {
    return [];
  }

  return snapshot.predictions.filter(row => row.runId === runId && row.split === 'test');
}

function TimeSeriesChart({ predictions }: { predictions: ModelPredictionRow[] }) {
  if (predictions.length < 2) {
    return (
      <div className="flex h-56 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No predictions
      </div>
    );
  }

  const width = 520;
  const height = 180;
  const values = predictions.flatMap(row => [row.actual, row.predicted]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const x = (index: number) => (index / Math.max(1, predictions.length - 1)) * (width - 24) + 12;
  const y = (value: number) => height - ((value - minValue) / range) * (height - 22) - 11;
  const actualLine = predictions.map((row, index) => `${x(index).toFixed(1)},${y(row.actual).toFixed(1)}`).join(' ');
  const predictedLine = predictions.map((row, index) => `${x(index).toFixed(1)},${y(row.predicted).toFixed(1)}`).join(' ');

  return (
    <svg aria-hidden="true" className="h-56 w-full rounded border border-slate-800 bg-slate-950/50" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" points={actualLine} stroke="#22d3ee" strokeLinejoin="round" strokeWidth="2.2" />
      <polyline fill="none" points={predictedLine} stroke="#e879f9" strokeDasharray="4 3" strokeLinejoin="round" strokeWidth="2" />
      <text fill="#22d3ee" fontSize="10" x="12" y="16">actual</text>
      <text fill="#e879f9" fontSize="10" x="72" y="16">pred</text>
    </svg>
  );
}

function ScatterChart({ predictions }: { predictions: ModelPredictionRow[] }) {
  if (predictions.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No scatter
      </div>
    );
  }

  const width = 240;
  const height = 180;
  const values = predictions.flatMap(row => [row.actual, row.predicted]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const scale = (value: number) => ((value - minValue) / range) * (width - 22) + 11;
  const yScale = (value: number) => height - ((value - minValue) / range) * (height - 22) - 11;

  return (
    <svg aria-hidden="true" className="h-48 w-full rounded border border-slate-800 bg-slate-950/50" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <line stroke="#475569" strokeDasharray="4 4" x1={scale(minValue)} x2={scale(maxValue)} y1={yScale(minValue)} y2={yScale(maxValue)} />
      {predictions.slice(0, 220).map(row => (
        <circle
          key={`${row.timestampUtc}-${row.predicted}`}
          cx={scale(row.actual)}
          cy={yScale(row.predicted)}
          fill="#22d3ee"
          opacity="0.56"
          r="2"
        />
      ))}
    </svg>
  );
}

function ResidualHistogram({ predictions }: { predictions: ModelPredictionRow[] }) {
  const residuals = predictions.map(row => row.residual);

  if (residuals.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No residuals
      </div>
    );
  }

  const width = 240;
  const height = 180;
  const minValue = Math.min(...residuals);
  const maxValue = Math.max(...residuals);
  const range = maxValue - minValue || 1;
  const bins = Array.from({ length: 18 }, (_, index) => ({
    min: minValue + (range * index) / 18,
    max: minValue + (range * (index + 1)) / 18,
    count: 0,
  }));

  residuals.forEach(value => {
    const binIndex = Math.min(17, Math.max(0, Math.floor(((value - minValue) / range) * 18)));
    bins[binIndex].count += 1;
  });

  const maxCount = Math.max(...bins.map(bin => bin.count), 1);
  const barWidth = width / bins.length;

  return (
    <svg aria-hidden="true" className="h-48 w-full rounded border border-slate-800 bg-slate-950/50" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      {bins.map((bin, index) => {
        const barHeight = (bin.count / maxCount) * (height - 14);
        return (
          <rect
            key={`${bin.min}-${bin.max}`}
            fill="#f59e0b"
            height={barHeight}
            opacity="0.75"
            width={Math.max(1, barWidth - 1)}
            x={index * barWidth}
            y={height - barHeight - 7}
          />
        );
      })}
    </svg>
  );
}

function FeatureImportance({ snapshot, runId }: { snapshot: BaselinesLabSnapshot; runId: string | null }) {
  const rows = snapshot.featureImportance.filter(row => row.runId === runId).slice(0, 20);

  if (rows.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No importance
      </div>
    );
  }

  const maxImportance = Math.max(...rows.map(row => row.importance), 1);

  return (
    <div className="grid gap-1 rounded border border-slate-800 bg-slate-950/50 p-3">
      {rows.map(row => (
        <div key={`${row.runId}-${row.featureId}`} className="grid grid-cols-[minmax(0,1fr)_80px] items-center gap-2">
          <div className="truncate font-mono text-[10px] text-slate-400" title={row.featureId}>{row.featureId}</div>
          <div className="h-3 rounded bg-slate-800">
            <div className="h-3 rounded bg-cyan-300" style={{ width: `${Math.max(3, (row.importance / maxImportance) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Leaderboard({
  runs,
  selectedRunId,
  onSelectedRunChange,
}: {
  runs: ModelRunRecord[];
  selectedRunId: string | null;
  onSelectedRunChange: (runId: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/50">
      <table className="min-w-full border-collapse text-left font-mono text-[10px]">
        <thead>
          <tr className="border-b border-slate-800 text-slate-500">
            {['model', 'target', 'horizon', 'RMSE', 'MAE', 'R2', 'skill', 'status'].map(column => (
              <th key={column} className="border-r border-slate-800 px-3 py-2 font-normal uppercase tracking-widest last:border-r-0">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map(run => {
            const isSelected = run.runId === selectedRunId;

            return (
              <tr
                key={run.runId}
                className={`border-b border-slate-900/80 last:border-b-0 ${isSelected ? 'bg-cyan-400/10' : 'hover:bg-slate-900/60'}`}
              >
                <td className="border-r border-slate-900/80 px-3 py-2">
                  <button type="button" onClick={() => onSelectedRunChange(run.runId)} className="truncate text-left text-cyan-100">
                    {run.model}
                  </button>
                </td>
                <td className="border-r border-slate-900/80 px-3 py-2 text-slate-300">{run.target}</td>
                <td className="border-r border-slate-900/80 px-3 py-2 text-slate-300">{run.horizonMinutes}m</td>
                <td className="border-r border-slate-900/80 px-3 py-2 text-slate-300">{formatNumber(run.metrics.rmse)}</td>
                <td className="border-r border-slate-900/80 px-3 py-2 text-slate-300">{formatNumber(run.metrics.mae)}</td>
                <td className="border-r border-slate-900/80 px-3 py-2 text-slate-300">{formatNumber(run.metrics.r2)}</td>
                <td className="border-r border-slate-900/80 px-3 py-2 text-slate-300">{formatNumber(run.metrics.skillVsPersistence)}</td>
                <td className="px-3 py-2">
                  <span className={`rounded border px-2 py-1 uppercase tracking-widest ${
                    run.status === 'trained'
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
                      : 'border-slate-700 bg-slate-900 text-slate-500'
                  }`}>
                    {run.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BaselinesLabPanel({
  snapshot,
  isLoading,
  error,
  selectedRunId,
  onSelectedRunChange,
  onRefresh,
}: BaselinesLabPanelProps) {
  const [familyFilter, setFamilyFilter] = useState<RunFilterFamily>('all');
  const [horizonFilter, setHorizonFilter] = useState<number | 'all'>('all');
  const [compareRunIds, setCompareRunIds] = useState<string[]>([]);
  const visibleRuns = useMemo(
    () => (snapshot?.runs ?? []).filter(run => (
      (familyFilter === 'all' || run.family === familyFilter) &&
      (horizonFilter === 'all' || run.horizonMinutes === horizonFilter)
    )),
    [familyFilter, horizonFilter, snapshot],
  );
  const selectedRun = snapshot?.runs.find(run => run.runId === selectedRunId) ?? visibleRuns[0] ?? null;
  const selectedPredictions = snapshot && selectedRun ? getRunPredictions(snapshot, selectedRun.runId) : [];
  const comparableRuns = snapshot?.runs.filter(run => run.status === 'trained').slice(0, 12) ?? [];
  const selectedCompareRuns = snapshot?.runs.filter(run => compareRunIds.includes(run.runId)) ?? [];

  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="space-y-4">
        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300">
                Baselines Lab
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold text-slate-100">Model leaderboard</h2>
              <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                {snapshot ? `${snapshot.runs.length} runs · ${snapshot.predictions.length} predictions` : 'Not available'}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {snapshot && (
                <button type="button" onClick={() => exportRuns(snapshot)} className="flex h-10 items-center gap-2 rounded-md border border-slate-700 bg-slate-950/60 px-3 text-sm text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100">
                  <Download className="h-4 w-4" aria-hidden="true" />
                  <span>Runs JSON</span>
                </button>
              )}
              <button type="button" onClick={onRefresh} disabled={isLoading} className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500">
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>{isLoading ? 'Training' : 'Refresh'}</span>
              </button>
            </div>
          </div>
          {(error || (snapshot?.warnings.length ?? 0) > 0) && (
            <div className="mt-4 grid gap-2">
              {error && <div className="rounded border border-rose-400/30 bg-rose-400/10 p-2 font-mono text-[10px] uppercase tracking-widest text-rose-100">{error}</div>}
              {snapshot?.warnings.slice(0, 4).map(warning => (
                <div key={warning} className="rounded border border-amber-300/30 bg-amber-300/10 p-2 font-mono text-[10px] text-amber-100">{warning}</div>
              ))}
            </div>
          )}
        </section>

        {snapshot ? (
          <>
            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Table2 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">Leaderboard</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <select value={familyFilter} onChange={event => setFamilyFilter(event.target.value as RunFilterFamily)} className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-100 outline-none">
                    <option value="all">All families</option>
                    <option value="naive">Naive</option>
                    <option value="linear">Linear</option>
                    <option value="var">VAR</option>
                    <option value="boosting">Boosting</option>
                  </select>
                  <select value={horizonFilter} onChange={event => setHorizonFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))} className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-100 outline-none">
                    <option value="all">All horizons</option>
                    {snapshot.horizonsMinutes.map(horizon => <option key={horizon} value={horizon}>{horizon}m</option>)}
                  </select>
                </div>
              </div>
              <Leaderboard runs={visibleRuns} selectedRunId={selectedRun?.runId ?? selectedRunId} onSelectedRunChange={onSelectedRunChange} />
            </section>

            <section className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-4 flex min-w-0 items-center gap-2">
                  <LineChart className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <div className="min-w-0">
                    <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">Run detail</h2>
                    <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      {selectedRun ? `${selectedRun.model} · ${selectedRun.horizonMinutes}m · ${selectedRun.status}` : 'No run'}
                    </div>
                  </div>
                </div>
                <TimeSeriesChart predictions={selectedPredictions} />
                <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <ScatterChart predictions={selectedPredictions} />
                  <ResidualHistogram predictions={selectedPredictions} />
                  <div className="xl:col-span-2">
                    <FeatureImportance snapshot={snapshot} runId={selectedRun?.runId ?? null} />
                  </div>
                </div>
              </article>

              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-4 flex min-w-0 items-center gap-2">
                  <GitCompare className="h-4 w-4 text-fuchsia-300" aria-hidden="true" />
                  <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">Comparator</h2>
                </div>
                <div className="mb-3 grid gap-2">
                  {comparableRuns.map(run => {
                    const isSelected = compareRunIds.includes(run.runId);
                    return (
                      <label key={run.runId} className="flex min-w-0 items-center gap-2 rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {
                            setCompareRunIds(current => {
                              if (current.includes(run.runId)) {
                                return current.filter(runId => runId !== run.runId);
                              }
                              return current.length >= 5 ? current : [...current, run.runId];
                            });
                          }}
                          className="h-4 w-4 accent-cyan-300"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-300">
                          {run.model} · {run.horizonMinutes}m
                        </span>
                        <span className="font-mono text-[10px] text-slate-500">{formatNumber(run.metrics.rmse)}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="overflow-x-auto rounded border border-slate-800 bg-slate-950/50">
                  <table className="min-w-full font-mono text-[10px]">
                    <tbody>
                      {selectedCompareRuns.map(run => (
                        <tr key={run.runId} className="border-b border-slate-900 last:border-b-0">
                          <td className="px-3 py-2 text-slate-200">{run.model}</td>
                          <td className="px-3 py-2 text-slate-400">RMSE {formatNumber(run.metrics.rmse)}</td>
                          <td className="px-3 py-2 text-slate-400">Skill {formatNumber(run.metrics.skillVsPersistence)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>
          </>
        ) : (
          <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
            {isLoading ? 'Training baselines' : 'Not available'}
          </div>
        )}
      </div>
    </main>
  );
}
