"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BarChart3,
  Eye,
  Play,
  RefreshCw,
  RotateCcw,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import {
  TRAINING_MODEL_OPTIONS,
  type ExperimentRunRecord,
  type PredictionRecord,
  type TrainingExperimentRecord,
  type TrainingModelName,
} from '@/services/trainingExperimentConfig';

interface TrainingBaselinesPanelProps {
  activeExperiment: TrainingExperimentRecord | null;
}

type RunsResponse = {
  runs: ExperimentRunRecord[];
};

type RunDetailResponse = {
  run: ExperimentRunRecord;
  predictions: PredictionRecord[];
};

type SortKey = 'model_name' | 'status' | 'rmse' | 'mae' | 'r2' | 'skill' | 'trained_at';

function formatMetric(value: number | null | undefined, digits = 4) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: digits })
    : 'NA';
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return 'NA';
  }

  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function getRunMetric(run: ExperimentRunRecord, key: SortKey) {
  if (key === 'rmse') return run.metrics_global?.rmse ?? null;
  if (key === 'mae') return run.metrics_global?.mae ?? null;
  if (key === 'r2') return run.metrics_global?.r2 ?? null;
  if (key === 'skill') return run.metrics_global?.skill_vs_persistence ?? null;
  if (key === 'trained_at') return run.completed_at ?? run.started_at ?? run.created_at;
  return run[key];
}

async function readError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: string; issues?: string[] };

    return [body.error, ...(body.issues ?? [])].filter(Boolean).join(': ') || fallback;
  } catch {
    return fallback;
  }
}

export function TrainingBaselinesPanel({ activeExperiment }: TrainingBaselinesPanelProps) {
  const [runs, setRuns] = useState<ExperimentRunRecord[]>([]);
  const [selectedModel, setSelectedModel] = useState<TrainingModelName>('mru_propagation');
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('trained_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const refreshRuns = useCallback(async (showLoading = false) => {
    if (!activeExperiment) {
      setRuns([]);
      return;
    }

    if (showLoading) {
      setIsLoading(true);
    }

    setError(null);

    try {
      const response = await fetch(`/experiments/${activeExperiment.id}/runs`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(await readError(response, `Runs request failed with ${response.status}`));
      }

      const body = await response.json() as RunsResponse;
      setRuns(body.runs);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Runs request failed');
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  }, [activeExperiment]);

  useEffect(() => {
    const initialRefreshTimeout = window.setTimeout(() => {
      void refreshRuns(true);
    }, 0);

    const interval = window.setInterval(() => {
      void refreshRuns(false);
    }, 5_000);

    return () => {
      window.clearTimeout(initialRefreshTimeout);
      window.clearInterval(interval);
    };
  }, [refreshRuns]);

  const sortedRuns = useMemo(() => runs.slice().sort((a, b) => {
    const direction = sortDirection === 'asc' ? 1 : -1;
    const aValue = getRunMetric(a, sortKey);
    const bValue = getRunMetric(b, sortKey);

    if (typeof aValue === 'number' && typeof bValue === 'number') {
      return (aValue - bValue) * direction;
    }

    return String(aValue ?? '').localeCompare(String(bValue ?? '')) * direction;
  }), [runs, sortDirection, sortKey]);

  const launchTraining = async (models: TrainingModelName[] | 'all') => {
    if (!activeExperiment) {
      return;
    }

    setIsMutating(true);
    setError(null);

    try {
      const response = await fetch(`/experiments/${activeExperiment.id}/runs`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ models }),
      });

      if (!response.ok) {
        throw new Error(await readError(response, `Train request failed with ${response.status}`));
      }

      await refreshRuns(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Train request failed');
    } finally {
      setIsMutating(false);
    }
  };

  const loadRunDetail = async (run: ExperimentRunRecord) => {
    if (!activeExperiment) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/experiments/${activeExperiment.id}/runs/${run.id}?limit=5000`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(await readError(response, `Run detail request failed with ${response.status}`));
      }

      setSelectedRunDetail(await response.json() as RunDetailResponse);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Run detail request failed');
    } finally {
      setIsLoading(false);
    }
  };

  const deleteRun = async (run: ExperimentRunRecord) => {
    if (!activeExperiment) {
      return;
    }

    setIsMutating(true);
    setError(null);

    try {
      const response = await fetch(`/experiments/${activeExperiment.id}/runs/${run.id}`, {
        method: 'DELETE',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(await readError(response, `Delete run failed with ${response.status}`));
      }

      await refreshRuns(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Delete run failed');
    } finally {
      setIsMutating(false);
    }
  };

  const setSort = (nextSortKey: SortKey) => {
    if (sortKey === nextSortKey) {
      setSortDirection(current => current === 'asc' ? 'desc' : 'asc');
      return;
    }

    setSortKey(nextSortKey);
    setSortDirection('asc');
  };

  if (!activeExperiment) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center rounded-lg border border-slate-700/50 bg-slate-900/30 p-6 text-center">
        <div>
          <BarChart3 className="mx-auto h-8 w-8 text-slate-500" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-semibold text-slate-100">No active experiment</h2>
          <p className="mt-2 max-w-md text-sm text-slate-400">
            Configure and activate an experiment in Training Lab before launching baseline training.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="grid gap-4">
        <section className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-4 shadow-2xl shadow-cyan-950/10">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase tracking-widest text-cyan-100">Baselines</h2>
              </div>
              <h3 className="mt-2 truncate text-lg font-semibold text-slate-100">{activeExperiment.name}</h3>
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                <span>{activeExperiment.config.l1_source}</span>
                <span>{activeExperiment.config.target.spacecraft}.{activeExperiment.config.target.variable}</span>
                <span>h={activeExperiment.config.horizon_minutes}m</span>
                <span>hash={activeExperiment.config_hash.slice(0, 12)}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => { void launchTraining('all'); }}
                disabled={isMutating}
                className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 disabled:cursor-wait disabled:text-slate-500"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                <span>Train all models</span>
              </button>
              <label className="flex h-10 items-center gap-2 rounded-md border border-slate-700 bg-slate-950/60 px-2">
                <select
                  value={selectedModel}
                  onChange={(event) => setSelectedModel(event.target.value as TrainingModelName)}
                  className="bg-transparent text-sm text-slate-200 outline-none"
                >
                  {TRAINING_MODEL_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => { void launchTraining([selectedModel]); }}
                disabled={isMutating}
                className="flex h-10 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-wait disabled:text-slate-500"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                <span>Train selected model</span>
              </button>
              <button
                type="button"
                onClick={() => { void refreshRuns(true); }}
                disabled={isLoading}
                className="flex h-10 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-wait"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>Refresh</span>
              </button>
            </div>
          </div>
          {error && (
            <div className="mt-4 rounded-md border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-100">
              {error}
            </div>
          )}
          <div className="mt-4 grid gap-3 rounded-md border border-slate-800 bg-slate-950/45 p-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-widest text-cyan-300">
                Declared baseline · MRU propagation
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">
                Propagates L1 measurements to Earth with constant rectilinear motion using the observed solar wind speed.
                The detected L1 magnitude is held constant until its estimated Earth arrival time.
              </p>
            </div>
            <div className="grid gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500 sm:grid-cols-3 md:grid-cols-1">
              <span className="rounded border border-slate-800 bg-slate-950 px-2 py-1">distance=1.5e6 km</span>
              <span className="rounded border border-slate-800 bg-slate-950 px-2 py-1">arrival=t+distance/vsw</span>
              <span className="rounded border border-slate-800 bg-slate-950 px-2 py-1">signal=held constant</span>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="mb-4 flex items-center gap-2">
            <Table2 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Leaderboard</h2>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/50">
            <table className="min-w-full border-collapse text-left font-mono text-[10px]">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500">
                  {[
                    ['model_name', 'model'],
                    ['status', 'status'],
                    ['rmse', 'RMSE'],
                    ['mae', 'MAE'],
                    ['r2', 'R2'],
                    ['skill', 'skill_vs_persist'],
                    ['trained_at', 'trained_at'],
                  ].map(([key, label]) => (
                    <th key={key} className="border-r border-slate-800 px-3 py-2 font-normal uppercase tracking-widest">
                      <button type="button" onClick={() => setSort(key as SortKey)} className="hover:text-cyan-200">
                        {label}{sortKey === key ? ` ${sortDirection}` : ''}
                      </button>
                    </th>
                  ))}
                  <th className="px-3 py-2 font-normal uppercase tracking-widest">actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedRuns.map(run => (
                  <tr key={run.id} className="border-b border-slate-800/70 text-slate-300 last:border-b-0">
                    <td className="border-r border-slate-800 px-3 py-2">{run.model_name}</td>
                    <td className="border-r border-slate-800 px-3 py-2">{run.status}</td>
                    <td className="border-r border-slate-800 px-3 py-2">{formatMetric(run.metrics_global?.rmse)}</td>
                    <td className="border-r border-slate-800 px-3 py-2">{formatMetric(run.metrics_global?.mae)}</td>
                    <td className="border-r border-slate-800 px-3 py-2">{formatMetric(run.metrics_global?.r2)}</td>
                    <td className="border-r border-slate-800 px-3 py-2">{formatMetric(run.metrics_global?.skill_vs_persistence)}</td>
                    <td className="border-r border-slate-800 px-3 py-2 text-slate-500">{formatDate(run.completed_at ?? run.started_at ?? run.created_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1.5">
                        <IconButton label="View details" onClick={() => { void loadRunDetail(run); }}>
                          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                        <IconButton label="Re-train" onClick={() => { void launchTraining([run.model_name]); }}>
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                        <IconButton label="Delete" onClick={() => { void deleteRun(run); }}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
                {sortedRuns.length === 0 && (
                  <tr>
                    <td className="px-3 py-8 text-center text-slate-500" colSpan={8}>
                      No runs for this experiment
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {selectedRunDetail && (
        <RunDetailModal detail={selectedRunDetail} onClose={() => setSelectedRunDetail(null)} />
      )}
    </main>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-100"
    >
      {children}
    </button>
  );
}

function RunDetailModal({ detail, onClose }: { detail: RunDetailResponse; onClose: () => void }) {
  const [foldFilter, setFoldFilter] = useState<string>('all');
  const folds = Array.from(new Set(detail.predictions.map(row => row.fold).filter((fold): fold is number => fold !== null))).sort((a, b) => a - b);
  const predictions = foldFilter === 'all'
    ? detail.predictions
    : detail.predictions.filter(row => row.fold === Number(foldFilter));

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-md">
      <section className="mx-auto grid w-full max-w-6xl gap-4 rounded-lg border border-slate-700 bg-slate-950 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{detail.run.model_name} details</h2>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {detail.run.status} · {formatDate(detail.run.completed_at ?? detail.run.started_at)}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 items-center gap-2 rounded-md border border-slate-800 bg-slate-900 px-2">
            <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">fold</span>
            <select value={foldFilter} onChange={(event) => setFoldFilter(event.target.value)} className="bg-transparent text-sm text-slate-200 outline-none">
              <option value="all">all</option>
              {folds.map(fold => <option key={fold} value={fold}>{fold}</option>)}
            </select>
          </label>
          {detail.predictions.length === 0 && detail.run.prediction_uri && (
            <span className="font-mono text-[10px] uppercase tracking-widest text-amber-200">
              Predictions stored locally: {detail.run.prediction_uri}
            </span>
          )}
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Predicted vs Observed">
            <TimeSeriesChart predictions={predictions} />
          </Panel>
          <Panel title="Residuals">
            <div className="grid gap-3 md:grid-cols-2">
              <ResidualHistogram predictions={predictions} />
              <ResidualScatter predictions={predictions} />
            </div>
          </Panel>
        </div>

        <Panel title="Feature importance">
          <FeatureImportance rows={detail.run.feature_importance ?? []} />
        </Panel>
      </section>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-300">{title}</h3>
      {children}
    </section>
  );
}

function TimeSeriesChart({ predictions }: { predictions: PredictionRecord[] }) {
  if (predictions.length < 2) {
    return <EmptyChart label="No prediction rows" />;
  }

  const rows = predictions.slice(0, 800);
  const width = 800;
  const height = 260;
  const values = rows.flatMap(row => [row.y_true, row.y_pred]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const x = (index: number) => (index / Math.max(1, rows.length - 1)) * (width - 24) + 12;
  const y = (value: number) => height - ((value - minValue) / range) * (height - 28) - 14;
  const actual = rows.map((row, index) => `${x(index).toFixed(1)},${y(row.y_true).toFixed(1)}`).join(' ');
  const predicted = rows.map((row, index) => `${x(index).toFixed(1)},${y(row.y_pred).toFixed(1)}`).join(' ');

  return (
    <svg className="h-72 w-full rounded border border-slate-800 bg-slate-950/70" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" points={actual} stroke="#22d3ee" strokeLinejoin="round" strokeWidth="2" />
      <polyline fill="none" points={predicted} stroke="#f59e0b" strokeLinejoin="round" strokeWidth="2" />
      <text fill="#22d3ee" fontSize="12" x="12" y="18">observed</text>
      <text fill="#f59e0b" fontSize="12" x="92" y="18">predicted</text>
    </svg>
  );
}

function ResidualHistogram({ predictions }: { predictions: PredictionRecord[] }) {
  if (predictions.length === 0) {
    return <EmptyChart label="No residuals" />;
  }

  const residuals = predictions.map(row => row.residual);
  const minValue = Math.min(...residuals);
  const maxValue = Math.max(...residuals);
  const range = maxValue - minValue || 1;
  const bins = Array.from({ length: 24 }, (_, index) => ({ index, count: 0 }));

  residuals.forEach(value => {
    const bin = Math.min(23, Math.max(0, Math.floor(((value - minValue) / range) * 24)));
    bins[bin].count += 1;
  });

  const maxCount = Math.max(...bins.map(bin => bin.count), 1);

  return (
    <svg className="h-56 w-full rounded border border-slate-800 bg-slate-950/70" preserveAspectRatio="none" viewBox="0 0 240 180">
      {bins.map(bin => {
        const width = 240 / bins.length;
        const height = (bin.count / maxCount) * 164;
        return <rect key={bin.index} fill="#22d3ee" height={height} opacity="0.72" width={Math.max(1, width - 1)} x={bin.index * width} y={174 - height} />;
      })}
    </svg>
  );
}

function ResidualScatter({ predictions }: { predictions: PredictionRecord[] }) {
  if (predictions.length < 2) {
    return <EmptyChart label="No scatter" />;
  }

  const rows = predictions.slice(0, 800);
  const actuals = rows.map(row => row.y_true);
  const residuals = rows.map(row => row.residual);
  const minX = Math.min(...actuals);
  const maxX = Math.max(...actuals);
  const minY = Math.min(...residuals);
  const maxY = Math.max(...residuals);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  return (
    <svg className="h-56 w-full rounded border border-slate-800 bg-slate-950/70" preserveAspectRatio="none" viewBox="0 0 240 180">
      {rows.map(row => (
        <circle
          key={`${row.timestamp_utc}-${row.residual}`}
          cx={((row.y_true - minX) / rangeX) * 220 + 10}
          cy={170 - ((row.residual - minY) / rangeY) * 160}
          fill="#f59e0b"
          opacity="0.55"
          r="2"
        />
      ))}
    </svg>
  );
}

function FeatureImportance({ rows }: { rows: Array<{ feature: string; importance: number }> }) {
  if (rows.length === 0) {
    return <EmptyChart label="No feature importance for this run" />;
  }

  const maxImportance = Math.max(...rows.map(row => row.importance), 1);

  return (
    <div className="grid gap-2">
      {rows.slice(0, 20).map(row => (
        <div key={row.feature} className="grid grid-cols-[minmax(0,1fr)_minmax(120px,40%)] items-center gap-3">
          <span className="truncate font-mono text-[10px] text-slate-400" title={row.feature}>{row.feature}</span>
          <span className="h-3 rounded bg-slate-800">
            <span className="block h-3 rounded bg-cyan-300" style={{ width: `${Math.max(2, (row.importance / maxImportance) * 100)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-56 items-center justify-center rounded border border-slate-800 bg-slate-950/70 font-mono text-[10px] uppercase tracking-widest text-slate-600">
      {label}
    </div>
  );
}
