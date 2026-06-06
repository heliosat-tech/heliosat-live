"use client";

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarRange,
  Database,
  Download,
  Gauge,
  Grid2X2,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  CoverageHeatmapCell,
  DataQualitySnapshot,
  QualitySummaryRow,
  SourceGapCard,
  VariableCadenceOutlierCard,
} from '@/services/dataQualityService';
import type { TrainingExperimentRecord } from '@/services/trainingExperimentConfig';
import { getModelDataDependencies } from './experimentDataDependencies';

interface DataQualityRangeInput {
  start: string;
  stop: string;
}

interface DataQualityPanelProps {
  snapshot: DataQualitySnapshot | null;
  isLoading: boolean;
  error: string | null;
  activeExperiment: TrainingExperimentRecord | null;
  range: DataQualityRangeInput;
  onRangeChange: (range: DataQualityRangeInput) => void;
  onRefresh: () => void;
}

function formatTimestamp(value: string | null | undefined) {
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

function formatDateLabel(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });
}

function formatPercent(value: number | null) {
  if (value === null) {
    return 'N/A';
  }

  if (value > 0 && value < 0.1) {
    return '<0.1%';
  }

  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

function formatDuration(seconds: number | null) {
  if (seconds === null) {
    return 'Not available';
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = seconds / 60;

  if (minutes < 60) {
    return `${minutes.toLocaleString('en-US', { maximumFractionDigits: 1 })}m`;
  }

  const hours = minutes / 60;

  if (hours < 48) {
    return `${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
  }

  return `${(hours / 24).toLocaleString('en-US', { maximumFractionDigits: 1 })}d`;
}

function formatNumber(value: number | null, maximumFractionDigits = 1) {
  if (value === null) {
    return 'Not available';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function coverageClassName(cell: CoverageHeatmapCell | null) {
  if (!cell || cell.status === 'na') {
    return 'border-slate-800 bg-slate-800/60 text-slate-500';
  }

  if (cell.status === 'good') {
    return 'border-emerald-400/30 bg-emerald-400/20 text-emerald-100';
  }

  if (cell.status === 'partial') {
    return 'border-amber-300/30 bg-amber-300/20 text-amber-100';
  }

  return 'border-rose-400/30 bg-rose-400/20 text-rose-100';
}

function getQualityGrade(
  card: VariableCadenceOutlierCard,
  summary: QualitySummaryRow | null,
) {
  const coverageScore = summary?.coveragePercent ?? 0;
  const cadencePenalty = card.nominalCadenceSeconds !== null && card.effectiveCadenceSeconds !== null
    ? Math.min(25, (Math.abs(card.effectiveCadenceSeconds - card.nominalCadenceSeconds) / Math.max(1, card.nominalCadenceSeconds)) * 100)
    : 15;
  const jitterPenalty = card.jitterSeconds !== null && card.nominalCadenceSeconds !== null
    ? Math.min(20, (card.jitterSeconds / Math.max(1, card.nominalCadenceSeconds)) * 20)
    : 0;
  const outlierCount = card.outliersRobustZScoreCount + card.outliersIqrCount;
  const outlierPenalty = Math.min(30, outlierCount * 2);
  const gapPenalty = Math.min(30, (summary?.gapsCount ?? 0) * 3);
  const score = Math.max(0, Math.min(100, coverageScore - cadencePenalty - jitterPenalty - outlierPenalty - gapPenalty));

  if (score >= 85) {
    return {
      label: 'Ready',
      score,
      className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100',
    };
  }

  if (score >= 65) {
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

function sourceMatchesExperimentDependency(source: string, dependencySourceId: string) {
  const normalized = source.toLowerCase().replace(/[^a-z0-9]+/g, '_');

  if (dependencySourceId === 'cdaweb-ace-wind-imap') {
    return ['ace', 'wind', 'imap'].some(token => normalized.includes(token));
  }

  if (dependencySourceId === 'ncei-dscovr-archive' || dependencySourceId === 'swpc-rtsw-l1') {
    return normalized.includes('dscovr');
  }

  if (dependencySourceId === 'omni-hro') {
    return normalized.includes('omni');
  }

  if (dependencySourceId === 'ncei-goes-r-mag-seiss') {
    return normalized.includes('goes') || normalized.includes('goes_nccei');
  }

  return normalized.includes(dependencySourceId.replace(/[^a-z0-9]+/g, '_'));
}

function downloadCleanTimestampExport(snapshot: DataQualitySnapshot) {
  const blob = new Blob(
    [JSON.stringify(snapshot.cleanTimestampExport, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = `clean-timestamps-${snapshot.range.startUtc.slice(0, 10)}-${snapshot.range.stopUtc.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-800 bg-slate-950/50 p-3">
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{label}</div>
      <div className="mt-2 truncate font-mono text-sm text-slate-100" title={value}>{value}</div>
    </div>
  );
}

function GapHistogram({ card }: { card: SourceGapCard }) {
  if (card.histogram.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[9px] uppercase tracking-widest text-slate-600">
        No gaps
      </div>
    );
  }

  const width = 180;
  const height = 56;
  const maxCount = Math.max(...card.histogram.map(bin => bin.count), 1);
  const barWidth = width / card.histogram.length;

  return (
    <svg
      aria-hidden="true"
      className="h-16 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      {card.histogram.map((bin, index) => {
        const barHeight = Math.max(2, (Math.log10(bin.count + 1) / Math.log10(maxCount + 1)) * (height - 10));
        const x = index * barWidth + 2;
        const y = height - barHeight - 4;

        return (
          <rect
            key={`${bin.minSeconds}-${bin.maxSeconds}`}
            fill="#22d3ee"
            height={barHeight}
            opacity={0.75}
            rx={1}
            width={Math.max(2, barWidth - 4)}
            x={x}
            y={y}
          />
        );
      })}
    </svg>
  );
}

function SeriesSparkline({ card }: { card: VariableCadenceOutlierCard }) {
  if (card.points.length < 2) {
    return (
      <div className="flex h-24 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[9px] uppercase tracking-widest text-slate-600">
        No series
      </div>
    );
  }

  const width = 240;
  const height = 84;
  const values = card.points.map(point => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const linePoints = card.points
    .map((point, index) => {
      const x = (index / (card.points.length - 1)) * width;
      const y = height - ((point.value - minValue) / range) * (height - 10) - 5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      aria-hidden="true"
      className="h-24 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        fill="none"
        points={linePoints}
        stroke="#38bdf8"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      {card.points.map((point, index) => {
        if (!point.isOutlier) {
          return null;
        }

        const x = (index / (card.points.length - 1)) * width;
        const y = height - ((point.value - minValue) / range) * (height - 10) - 5;

        return (
          <circle
            key={`${point.timestampUtc}-${point.value}`}
            cx={x}
            cy={y}
            fill="#e879f9"
            r="3.2"
          />
        );
      })}
    </svg>
  );
}

function DataQualityDrilldown({
  cell,
  onClose,
}: {
  cell: CoverageHeatmapCell;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[2147483647] bg-slate-950/85 p-4 backdrop-blur-md sm:p-8">
      <button
        type="button"
        aria-label="Close coverage detail"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <section className="relative mx-auto flex max-h-[780px] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-slate-200 shadow-2xl shadow-cyan-950/30">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-100">
              {cell.source} · {cell.variable} · {cell.dayUtc}
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Coverage {formatPercent(cell.coveragePercent)} · observed {cell.observedTimestamps} · expected {cell.expectedTimestamps ?? 'NA'}
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
          {cell.gaps.length > 0 ? (
            <div className="grid gap-2">
              {cell.gaps.map(gap => (
                <div
                  key={`${gap.startUtc}-${gap.stopUtc}`}
                  className="grid gap-2 rounded-md border border-slate-800 bg-slate-900/40 p-3 md:grid-cols-[minmax(0,1fr)_120px]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-slate-300">
                      {formatTimestamp(gap.startUtc)} {'>'} {formatTimestamp(gap.stopUtc)}
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                      missing expected {gap.missingExpectedTimestamps ?? 'NA'}
                    </div>
                  </div>
                  <div className="font-mono text-sm text-amber-100">
                    {formatDuration(gap.durationSeconds)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-8 text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">
              No gaps in this cell
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function DataQualityPanel({
  snapshot,
  isLoading,
  error,
  activeExperiment,
  range,
  onRangeChange,
  onRefresh,
}: DataQualityPanelProps) {
  const [selectedCell, setSelectedCell] = useState<CoverageHeatmapCell | null>(null);
  const experimentDependencies = useMemo(
    () => getModelDataDependencies(activeExperiment),
    [activeExperiment],
  );
  const selectedSummaryBySeries = useMemo(() => {
    const summaries = new Map<string, QualitySummaryRow>();

    snapshot?.qualitySummary
      .filter(summary => summary.window === 'selected')
      .forEach(summary => {
        summaries.set(`${summary.source}:${summary.variable}`, summary);
      });

    return summaries;
  }, [snapshot]);
  const qualityCards = useMemo(() => {
    const cards = snapshot?.variableCards ?? [];

    return cards.map(card => {
      const summary = selectedSummaryBySeries.get(`${card.source}:${card.variable}`) ?? null;
      const grade = getQualityGrade(card, summary);
      const isExperimentDependency = experimentDependencies.some(dependency =>
        sourceMatchesExperimentDependency(card.source, dependency.sourceId),
      );

      return {
        card,
        summary,
        grade,
        isExperimentDependency,
      };
    });
  }, [experimentDependencies, selectedSummaryBySeries, snapshot]);
  const qualityOverview = useMemo(() => {
    const relevantCards = qualityCards.filter(item => item.isExperimentDependency);
    const evaluatedCards = relevantCards.length > 0 ? relevantCards : qualityCards;
    const score = evaluatedCards.length > 0
      ? evaluatedCards.reduce((sum, item) => sum + item.grade.score, 0) / evaluatedCards.length
      : null;

    return {
      score,
      evaluatedCount: evaluatedCards.length,
      dependencyCount: relevantCards.length,
      readyCount: evaluatedCards.filter(item => item.grade.label === 'Ready').length,
      blockedCount: evaluatedCards.filter(item => item.grade.label === 'Blocked').length,
    };
  }, [qualityCards]);
  const heatmapRows = useMemo(() => {
    const cards = snapshot?.variableCards ?? [];
    const cells = snapshot?.heatmapCells ?? [];
    const cellByKey = new Map(cells.map(cell => [`${cell.seriesId}:${cell.dayUtc}`, cell]));

    return cards.map(card => ({
      seriesId: card.seriesId,
      source: card.source,
      variable: card.variable,
      quality: qualityCards.find(item => item.card.seriesId === card.seriesId) ?? null,
      cells: (snapshot?.heatmapDays ?? []).map(day => cellByKey.get(`${card.seriesId}:${day}`) ?? null),
    }));
  }, [qualityCards, snapshot]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Grid2X2 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                Data Quality
              </h2>
              <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                Generated {snapshot ? formatTimestamp(snapshot.generatedAtUtc) : 'Not available'}
              </div>
            </div>
          </div>

          <div className="flex max-w-full flex-wrap items-end gap-2">
            <label className="grid gap-1">
              <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Start UTC</span>
              <input
                type="datetime-local"
                value={range.start}
                onChange={event => onRangeChange({ ...range, start: event.target.value })}
                className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-100 outline-none transition focus:border-cyan-400/60"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Stop UTC</span>
              <input
                type="datetime-local"
                value={range.stop}
                onChange={event => onRangeChange({ ...range, stop: event.target.value })}
                className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-100 outline-none transition focus:border-cyan-400/60"
              />
            </label>
            {snapshot && (
              <button
                type="button"
                onClick={() => downloadCleanTimestampExport(snapshot)}
                className="flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                <span>Clean index</span>
              </button>
            )}
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className="flex h-9 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-xs text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{isLoading ? 'Analyzing' : 'Refresh'}</span>
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {snapshot ? (
          <div className="grid gap-4">
            <section className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/30 p-4 md:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-widest text-cyan-300">
                  Quality gate
                </div>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-300">
                  Scores combine coverage, cadence drift, jitter, gaps, and outlier counts. Modeling sources are prioritized when present in this snapshot.
                </p>
                {qualityOverview.dependencyCount === 0 && (
                  <p className="mt-2 max-w-3xl text-sm leading-relaxed text-amber-100">
                    The modeling pipeline uses historical store sources that are not fully represented in this live telemetry snapshot yet.
                    Store-backed quality checks should be wired before trusting this view for training readiness.
                  </p>
                )}
              </div>
              <div className="grid min-w-[260px] grid-cols-2 gap-2 font-mono text-[10px] uppercase tracking-widest">
                <MetricTile
                  label={qualityOverview.dependencyCount > 0 ? 'Model score' : 'Snapshot score'}
                  value={qualityOverview.score === null ? 'NA' : `${Math.round(qualityOverview.score)}%`}
                />
                <MetricTile label="Series" value={String(qualityOverview.evaluatedCount)} />
                <MetricTile label="Ready" value={String(qualityOverview.readyCount)} />
                <MetricTile label="Blocked" value={String(qualityOverview.blockedCount)} />
              </div>
            </section>

            <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/30 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Database className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                <h3 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                  Coverage heatmap
                </h3>
              </div>

              {heatmapRows.length > 0 && snapshot.heatmapDays.length > 0 ? (
                <div className="overflow-x-auto">
                  <div
                    className="grid min-w-max gap-1"
                    style={{
                      gridTemplateColumns: `190px repeat(${snapshot.heatmapDays.length}, minmax(42px, 1fr))`,
                    }}
                  >
                    <div className="sticky left-0 z-10 rounded border border-slate-800 bg-slate-950 px-2 py-2 font-mono text-[9px] uppercase tracking-widest text-slate-600">
                      Variable
                    </div>
                    {snapshot.heatmapDays.map(day => (
                      <div
                        key={day}
                        className="rounded border border-slate-800 bg-slate-950 px-2 py-2 text-center font-mono text-[9px] uppercase tracking-widest text-slate-500"
                      >
                        {formatDateLabel(day)}
                      </div>
                    ))}
                    {heatmapRows.map(row => (
                      <div
                        key={row.seriesId}
                        className="contents"
                      >
                        <div className="sticky left-0 z-10 min-w-0 rounded border border-slate-800 bg-slate-950 px-2 py-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-xs text-slate-100">{row.variable}</span>
                            {row.quality && (
                              <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest ${row.quality.grade.className}`}>
                                {Math.round(row.quality.grade.score)}%
                              </span>
                            )}
                          </div>
                          <div className="mt-1 truncate font-mono text-[9px] uppercase tracking-widest text-slate-600">
                            {row.source}{row.quality?.isExperimentDependency ? ' · active' : ''}
                          </div>
                        </div>
                        {row.cells.map((cell, index) => (
                          <button
                            key={`${row.seriesId}-${snapshot.heatmapDays[index]}`}
                            type="button"
                            onClick={() => cell && setSelectedCell(cell)}
                            className={`min-h-11 rounded border px-1.5 py-1 text-center font-mono text-[10px] transition ${coverageClassName(cell)} ${
                              cell ? 'hover:border-cyan-300/50' : 'cursor-default'
                            }`}
                            disabled={!cell}
                            title={cell ? `${cell.source} ${cell.variable} ${cell.dayUtc} ${formatPercent(cell.coveragePercent)}` : 'N/A'}
                          >
                            {cell ? formatPercent(cell.coveragePercent) : 'N/A'}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex min-h-40 items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                  No coverage data
                </div>
              )}
            </section>

            <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/30 p-4">
              <div className="mb-3 flex items-center gap-2">
                <CalendarRange className="h-4 w-4 text-amber-300" aria-hidden="true" />
                <h3 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                  Gaps by source
                </h3>
              </div>

              {snapshot.gapCards.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {snapshot.gapCards.map(card => (
                    <article
                      key={card.source}
                      className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/45 p-4"
                    >
                      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
                        <h4 className="truncate text-sm font-semibold text-slate-100">{card.source}</h4>
                        <span className="rounded border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-amber-100">
                          {card.totalGaps} gaps
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <MetricTile label="Median" value={formatDuration(card.medianDurationSeconds)} />
                        <MetricTile label="P95" value={formatDuration(card.p95DurationSeconds)} />
                      </div>
                      <div className="mt-3">
                        <GapHistogram card={card} />
                      </div>
                      <div className="mt-3 grid gap-2">
                        {card.topGaps.map(gap => (
                          <div
                            key={`${gap.variable}-${gap.startUtc}-${gap.stopUtc}`}
                            className="rounded border border-slate-800 bg-slate-950/55 p-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 truncate text-xs text-slate-200">{gap.variable}</div>
                              <div className="font-mono text-[10px] text-amber-100">{formatDuration(gap.durationSeconds)}</div>
                            </div>
                            <div className="mt-1 truncate font-mono text-[9px] text-slate-600">
                              {formatTimestamp(gap.startUtc)} {'>'} {formatTimestamp(gap.stopUtc)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="flex min-h-32 items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                  No gaps detected
                </div>
              )}
            </section>

            <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/30 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Gauge className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                <h3 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                  Outliers and cadence
                </h3>
              </div>

              {snapshot.variableCards.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {qualityCards.map(({ card, summary, grade, isExperimentDependency }) => {
                    const cadenceDiff = card.nominalCadenceSeconds !== null && card.effectiveCadenceSeconds !== null
                      ? Math.abs(card.effectiveCadenceSeconds - card.nominalCadenceSeconds)
                      : null;
                    const cadenceIsAligned = cadenceDiff !== null && card.nominalCadenceSeconds !== null
                      ? cadenceDiff <= Math.max(1, card.nominalCadenceSeconds * 0.1)
                      : false;

                    return (
                      <article
                        key={card.seriesId}
                        className={`min-w-0 rounded-lg border p-4 ${
                          isExperimentDependency
                            ? 'border-cyan-400/40 bg-cyan-400/[0.06]'
                            : 'border-slate-800 bg-slate-950/45'
                        }`}
                      >
                        <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-slate-100">{card.variable}</h4>
                            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                              {card.source} · {card.unit}
                            </div>
                          </div>
                          <span className={`rounded border px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest ${grade.className}`}>
                            {grade.label} {Math.round(grade.score)}%
                          </span>
                        </div>
                        <SeriesSparkline card={card} />
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <MetricTile
                            label="Coverage"
                            value={formatPercent(summary?.coveragePercent ?? null)}
                          />
                          <MetricTile
                            label="Gaps"
                            value={String(summary?.gapsCount ?? 0)}
                          />
                          <MetricTile
                            label="Nominal"
                            value={card.nominalCadenceSeconds === null ? 'Not available' : `${formatNumber(card.nominalCadenceSeconds)} s`}
                          />
                          <MetricTile
                            label="Effective"
                            value={card.effectiveCadenceSeconds === null ? 'Not available' : `${formatNumber(card.effectiveCadenceSeconds)} s`}
                          />
                          <MetricTile
                            label="Jitter"
                            value={card.jitterSeconds === null ? 'Not available' : `${formatNumber(card.jitterSeconds)} s`}
                          />
                          <MetricTile
                            label="Outliers"
                            value={`Z ${card.outliersRobustZScoreCount} · IQR ${card.outliersIqrCount}`}
                          />
                          <MetricTile
                            label="Cadence gate"
                            value={cadenceIsAligned ? 'Aligned' : 'Check'}
                          />
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="flex min-h-32 items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                  No variable data
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50">
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-600">
              {isLoading ? 'Analyzing' : 'Not available'}
            </div>
          </div>
        )}
      </section>

      {selectedCell && (
        <DataQualityDrilldown
          cell={selectedCell}
          onClose={() => setSelectedCell(null)}
        />
      )}
    </main>
  );
}
