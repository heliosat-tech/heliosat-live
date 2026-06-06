"use client";

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  CircleSlash,
  Clock3,
  Database,
  Globe2,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  PipelineHealthSnapshot,
  PipelinePullLog,
  PipelineSourceGroup,
  PipelineSourceHealth,
  PipelineSourceStatus,
  PipelineSparkPoint,
} from '@/services/pipelineHealthService';
import type { TrainingExperimentRecord } from '@/services/trainingExperimentConfig';
import {
  getModelDataDependencies,
  type ExperimentDataDependency,
} from './experimentDataDependencies';

interface PipelineHealthPanelProps {
  snapshot: PipelineHealthSnapshot | null;
  isLoading: boolean;
  error: string | null;
  activeExperiment: TrainingExperimentRecord | null;
  onRefresh: () => void;
}

const GROUPS: Array<{
  id: PipelineSourceGroup;
  label: string;
  icon: typeof Activity;
}> = [
  { id: 'l1-live', label: 'L1 live', icon: Activity },
  { id: 'l1-historic', label: 'L1 historic', icon: Archive },
  { id: 'near-earth', label: 'Near-Earth', icon: Globe2 },
];

const STATUS_META: Record<PipelineSourceStatus, {
  label: string;
  className: string;
  icon: typeof Activity;
  sparkColor: string;
}> = {
  live: {
    label: 'LIVE',
    className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100',
    icon: CheckCircle2,
    sparkColor: '#34d399',
  },
  historic: {
    label: 'HISTORIC',
    className: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100',
    icon: Archive,
    sparkColor: '#22d3ee',
  },
  stale: {
    label: 'STALE',
    className: 'border-amber-300/30 bg-amber-300/10 text-amber-100',
    icon: Clock3,
    sparkColor: '#f59e0b',
  },
  off: {
    label: 'OFF',
    className: 'border-slate-700 bg-slate-950 text-slate-500',
    icon: CircleSlash,
    sparkColor: '#64748b',
  },
  error: {
    label: 'ERROR',
    className: 'border-rose-400/30 bg-rose-400/10 text-rose-100',
    icon: AlertTriangle,
    sparkColor: '#fb7185',
  },
  'not-wired': {
    label: 'NOT WIRED',
    className: 'border-slate-700 bg-slate-950 text-slate-400',
    icon: CircleSlash,
    sparkColor: '#64748b',
  },
};

const SOURCE_STATUS_ORDER: Record<PipelineSourceStatus, number> = {
  live: 0,
  historic: 1,
  stale: 2,
  error: 3,
  off: 4,
  'not-wired': 5,
};

const DEPENDENCY_ROLE_LABEL: Record<ExperimentDataDependency['role'], string> = {
  l1_source: 'L1',
  target_source: 'TARGET',
  mru_required: 'MRU',
};

function formatTimestamp(value: string | null) {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function formatDelta(seconds: number | null) {
  if (seconds === null) {
    return 'Not available';
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s ago`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 48) {
    return `${hours}h ${remainingMinutes}m ago`;
  }

  const days = Math.floor(hours / 24);

  return `${days}d ago`;
}

function formatPercent(value: number | null) {
  if (value === null) {
    return 'Not available';
  }

  if (value > 0 && value < 0.1) {
    return '<0.1%';
  }

  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

function formatNumber(value: number | null, maximumFractionDigits = 1) {
  if (value === null) {
    return 'Not available';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function getSourceHealthGrade(source: PipelineSourceHealth) {
  if (source.status === 'not-wired') {
    return {
      label: 'Catalog only',
      score: null,
      className: 'border-slate-700 bg-slate-950 text-slate-400',
    };
  }

  if (source.status === 'error' || source.status === 'off') {
    return {
      label: 'Blocked',
      score: 0,
      className: 'border-rose-400/30 bg-rose-400/10 text-rose-100',
    };
  }

  const coverageValues = source.coverage
    .map(metric => metric.percent)
    .filter((value): value is number => value !== null);
  const coverageScore = coverageValues.length > 0
    ? coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length
    : source.status === 'live'
      ? 75
      : 50;
  const freshnessScore = source.status === 'live'
    ? 100
    : source.status === 'historic'
      ? 85
      : source.status === 'stale'
        ? 45
        : 20;
  const errorPenalty = source.errorRate24hPercent === null ? 0 : Math.min(40, source.errorRate24hPercent);
  const score = Math.max(0, Math.min(100, (coverageScore * 0.45) + (freshnessScore * 0.55) - errorPenalty));

  if (score >= 80) {
    return {
      label: 'Ready',
      score,
      className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100',
    };
  }

  if (score >= 60) {
    return {
      label: 'Usable',
      score,
      className: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100',
    };
  }

  if (score >= 35) {
    return {
      label: 'Degraded',
      score,
      className: 'border-amber-300/30 bg-amber-300/10 text-amber-100',
    };
  }

  return {
    label: 'Blocked',
    score,
    className: 'border-rose-400/30 bg-rose-400/10 text-rose-100',
  };
}

function StatusBadge({ status }: { status: PipelineSourceStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;

  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded border px-2 font-mono text-[9px] uppercase tracking-widest ${meta.className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}

function MiniSparkline({
  points,
  color,
}: {
  points: PipelineSparkPoint[];
  color: string;
}) {
  const validPoints = points.filter(
    (point): point is PipelineSparkPoint & { value: number } =>
      typeof point.value === 'number' && Number.isFinite(point.value),
  );

  if (validPoints.length < 2) {
    return (
      <div className="flex h-9 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[9px] uppercase tracking-widest text-slate-600">
        No data
      </div>
    );
  }

  const width = 116;
  const height = 34;
  const values = validPoints.map(point => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const polylinePoints = validPoints
    .map((point, index) => {
      const x = (index / (validPoints.length - 1)) * width;
      const y = height - ((point.value - minValue) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      aria-hidden="true"
      className="h-9 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        fill="none"
        points={polylinePoints}
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function CoverageGrid({ source }: { source: PipelineSourceHealth }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {source.coverage.map(metric => (
        <div
          key={metric.window}
          className="min-w-0 rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5"
        >
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{metric.window}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-slate-200">
            {formatPercent(metric.percent)}
          </div>
        </div>
      ))}
    </div>
  );
}

function PipelineSourceCard({
  source,
  dependencies,
  onOpen,
}: {
  source: PipelineSourceHealth;
  dependencies: ExperimentDataDependency[];
  onOpen: (source: PipelineSourceHealth) => void;
}) {
  const statusMeta = STATUS_META[source.status];
  const grade = getSourceHealthGrade(source);
  const isExperimentDependency = dependencies.length > 0;

  return (
    <button
      type="button"
      onClick={() => onOpen(source)}
      className={`min-w-0 rounded-lg border p-3 text-left transition hover:border-cyan-400/35 hover:bg-slate-900/55 ${
        isExperimentDependency
          ? 'border-cyan-400/45 bg-cyan-400/[0.07] shadow-[0_0_24px_rgba(34,211,238,0.08)]'
          : 'border-slate-800 bg-slate-950/45'
      }`}
    >
      <span className="flex min-w-0 items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-slate-100">{source.name}</span>
          <span className="mt-1 block truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
            {source.provider}
          </span>
        </span>
        <StatusBadge status={source.status} />
      </span>

      <span className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
        <span className={`rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${grade.className}`}>
          {grade.label}{grade.score === null ? '' : ` ${Math.round(grade.score)}%`}
        </span>
        {dependencies.map(dependency => (
          <span
            key={`${source.sourceId}-${dependency.role}`}
            className="rounded border border-cyan-300/35 bg-cyan-300/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-cyan-100"
          >
            {DEPENDENCY_ROLE_LABEL[dependency.role]}
          </span>
        ))}
      </span>

      <span className="mt-3 grid gap-1.5 rounded-md border border-slate-800 bg-slate-950/50 p-2">
        <span className="flex min-w-0 items-center justify-between gap-2 font-mono text-[10px]">
          <span className="uppercase tracking-widest text-slate-600">Last sample</span>
          <span className="truncate text-slate-300">{formatDelta(source.lastSampleDeltaSeconds)}</span>
        </span>
        <span className="truncate font-mono text-[10px] text-slate-500">
          {formatTimestamp(source.lastSampleTimestampUtc)}
        </span>
      </span>

      <span className="mt-3 block">
        <CoverageGrid source={source} />
      </span>

      <span className="mt-3 grid grid-cols-2 gap-2">
        <span className="min-w-0">
          <span className="mb-1 block font-mono text-[9px] uppercase tracking-widest text-slate-600">
            Errors 24h
          </span>
          <MiniSparkline points={source.errorRateSparkline} color={statusMeta.sparkColor} />
          <span className="mt-1 block truncate font-mono text-[10px] text-slate-500">
            {formatPercent(source.errorRate24hPercent)}
          </span>
        </span>
        <span className="min-w-0">
          <span className="mb-1 block font-mono text-[9px] uppercase tracking-widest text-slate-600">
            Rows/min
          </span>
          <MiniSparkline points={source.throughputSparkline} color="#22d3ee" />
          <span className="mt-1 block truncate font-mono text-[10px] text-slate-500">
            {formatNumber(source.throughputRowsPerMinute)}
          </span>
        </span>
      </span>

      <span className="mt-3 flex min-w-0 flex-wrap gap-1.5">
        <span className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-400">
          {source.protocol.toUpperCase()}
        </span>
        <span className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-400">
          {source.implementationStatus.toUpperCase()}
        </span>
        <span className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-400">
          {source.refreshMode.toUpperCase()}
        </span>
      </span>
    </button>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-800 bg-slate-950/55 p-3">
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{label}</div>
      <div className="mt-2 truncate font-mono text-sm text-slate-100" title={value}>{value}</div>
    </div>
  );
}

function LogRow({ log }: { log: PipelinePullLog }) {
  const levelClassName = log.level === 'error'
    ? 'text-rose-200'
    : log.level === 'warning'
      ? 'text-amber-100'
      : 'text-slate-300';

  return (
    <div className="grid gap-2 border-b border-slate-800 px-3 py-3 last:border-b-0 lg:grid-cols-[170px_84px_88px_minmax(0,1fr)]">
      <div className="truncate font-mono text-[10px] text-slate-500">{formatTimestamp(log.timestampUtc)}</div>
      <div className={`font-mono text-[10px] uppercase tracking-widest ${levelClassName}`}>{log.level}</div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-slate-400">{log.status}</div>
      <div className="min-w-0 text-sm text-slate-300">
        <span className="mr-2 font-mono text-[10px] uppercase tracking-widest text-slate-600">
          rows {log.rows ?? 'NA'}
        </span>
        {log.message}
      </div>
    </div>
  );
}

function PipelineSourceDetailModal({
  source,
  onClose,
}: {
  source: PipelineSourceHealth;
  onClose: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[2147483647] bg-slate-950/85 p-4 backdrop-blur-md sm:p-8">
      <button
        type="button"
        aria-label="Close source detail"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <section className="relative mx-auto flex h-full max-h-[900px] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-slate-200 shadow-2xl shadow-cyan-950/30">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold text-slate-100">{source.name}</h2>
              <StatusBadge status={source.status} />
            </div>
            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {source.provider} · {source.endpoint}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <DetailMetric label="Last sample" value={formatTimestamp(source.lastSampleTimestampUtc)} />
            <DetailMetric label="Delta" value={formatDelta(source.lastSampleDeltaSeconds)} />
            <DetailMetric label="Cadence" value={source.cadenceSeconds === null ? 'Not available' : `${formatNumber(source.cadenceSeconds)} s`} />
            <DetailMetric label="Rows/min" value={formatNumber(source.throughputRowsPerMinute)} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-900/30">
              <div className="border-b border-slate-800 px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  Structured pull logs
                </div>
              </div>
              <div>
                {source.logs.length > 0 ? (
                  source.logs.map(log => (
                    <LogRow
                      key={`${log.timestampUtc}-${log.sourceId}-${log.message}`}
                      log={log}
                    />
                  ))
                ) : (
                  <div className="px-4 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">
                    No logs
                  </div>
                )}
              </div>
            </section>

            <aside className="grid content-start gap-4">
              <section className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Database className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">
                    Coverage
                  </h3>
                </div>
                <CoverageGrid source={source} />
              </section>

              <section className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
                <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  Spacecraft
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {source.spacecraft.map(spacecraft => (
                    <span
                      key={spacecraft}
                      className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-300"
                    >
                      {spacecraft}
                    </span>
                  ))}
                </div>
              </section>

              <section className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
                <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  Variables
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {source.variables.map(variable => (
                    <span
                      key={variable}
                      className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-300"
                    >
                      {variable}
                    </span>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </div>
      </section>
    </div>
  );
}

export function PipelineHealthPanel({
  snapshot,
  isLoading,
  error,
  activeExperiment,
  onRefresh,
}: PipelineHealthPanelProps) {
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const dependencies = useMemo(
    () => getModelDataDependencies(activeExperiment),
    [activeExperiment],
  );
  const dependenciesBySourceId = useMemo(() => {
    const bySourceId = new Map<string, ExperimentDataDependency[]>();

    dependencies.forEach(dependency => {
      bySourceId.set(dependency.sourceId, [...(bySourceId.get(dependency.sourceId) ?? []), dependency]);
    });

    return bySourceId;
  }, [dependencies]);
  const groupedSources = useMemo(
    () =>
      GROUPS.map(group => ({
        ...group,
        sources: (snapshot?.sources.filter(source => source.group === group.id) ?? [])
          .sort((a, b) => {
            const aIsDependency = dependenciesBySourceId.has(a.sourceId);
            const bIsDependency = dependenciesBySourceId.has(b.sourceId);

            if (aIsDependency !== bIsDependency) {
              return aIsDependency ? -1 : 1;
            }

            return SOURCE_STATUS_ORDER[a.status] - SOURCE_STATUS_ORDER[b.status] || a.name.localeCompare(b.name);
          }),
      })),
    [dependenciesBySourceId, snapshot],
  );
  const selectedSource = useMemo(
    () => snapshot?.sources.find(source => source.sourceId === selectedSourceId) ?? null,
    [selectedSourceId, snapshot],
  );
  const activeDependencySources = useMemo(
    () => dependencies.map(dependency => ({
      dependency,
      source: snapshot?.sources.find(candidate => candidate.sourceId === dependency.sourceId) ?? null,
    })),
    [dependencies, snapshot],
  );

  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Database className="h-4 w-4 text-cyan-300" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                Pipeline Health
              </h2>
              <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                Generated {snapshot ? formatTimestamp(snapshot.generatedAtUtc) : 'Not available'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {error && (
              <div className="max-w-72 truncate font-mono text-[10px] uppercase tracking-widest text-rose-300" title={error}>
                {error}
              </div>
            )}
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className="flex h-9 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-xs text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{isLoading ? 'Syncing' : 'Refresh'}</span>
            </button>
          </div>
        </div>

        {snapshot ? (
          <div className="grid gap-4">
            {activeDependencySources.length > 0 && (
              <section className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.04] p-3">
                <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-cyan-300">
                  Modeling data dependencies
                </div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {activeDependencySources.map(({ dependency, source }) => {
                    const grade = source ? getSourceHealthGrade(source) : null;

                    return (
                      <button
                        key={`${dependency.sourceId}-${dependency.role}`}
                        type="button"
                        onClick={() => source && setSelectedSourceId(source.sourceId)}
                        disabled={!source}
                        className="min-w-0 rounded-md border border-slate-800 bg-slate-950/45 p-3 text-left transition enabled:hover:border-cyan-400/40"
                      >
                        <span className="block font-mono text-[9px] uppercase tracking-widest text-slate-500">
                          {dependency.label}
                        </span>
                        <span className="mt-1 block truncate text-sm font-semibold text-slate-100">
                          {source?.name ?? dependency.sourceId}
                        </span>
                        <span className="mt-2 flex flex-wrap gap-1.5">
                          <span className={`rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${
                            grade?.className ?? 'border-slate-700 bg-slate-950 text-slate-500'
                          }`}>
                            {grade ? `${grade.label}${grade.score === null ? '' : ` ${Math.round(grade.score)}%`}` : 'Missing'}
                          </span>
                          {dependency.variables.map(variable => (
                            <span key={variable} className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[9px] text-slate-400">
                              {variable}
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {groupedSources.map(group => {
              const Icon = group.icon;

              return (
                <section
                  key={group.id}
                  className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/30 p-3"
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
                      <h3 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                        {group.label}
                      </h3>
                    </div>
                    <span className="rounded border border-slate-700 bg-slate-950 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-500">
                      {group.sources.length}
                    </span>
                  </div>

                  <div className="grid gap-3">
                    {group.sources.map(source => (
                      <PipelineSourceCard
                        key={source.sourceId}
                        source={source}
                        dependencies={dependenciesBySourceId.get(source.sourceId) ?? []}
                        onOpen={(nextSource) => setSelectedSourceId(nextSource.sourceId)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            </div>
          </div>
        ) : (
          <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50">
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-600">
              {isLoading ? 'Loading' : 'Not available'}
            </div>
          </div>
        )}
      </section>

      {selectedSource && (
        <PipelineSourceDetailModal
          source={selectedSource}
          onClose={() => setSelectedSourceId(null)}
        />
      )}
    </main>
  );
}
