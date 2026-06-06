"use client";

import { useMemo, useState } from 'react';
import {
  Download,
  GitBranch,
  RefreshCw,
  Search,
  ShieldCheck,
  Table2,
} from 'lucide-react';
import type {
  FeatureFamily,
  FeatureStats,
  FeatureWorkbenchSnapshot,
} from '@/services/featureEngineeringService';

interface FeatureWorkbenchPanelProps {
  snapshot: FeatureWorkbenchSnapshot | null;
  isLoading: boolean;
  error: string | null;
  selectedFeatureId: string | null;
  onSelectedFeatureChange: (featureId: string) => void;
  onRefresh: () => void;
}

type PreviewMode = 'head' | 'tail' | 'sample';

const FAMILY_LABELS: Record<FeatureFamily, string> = {
  lag: 'Lag features',
  rolling: 'Rolling stats',
  derivative: 'Derivatives',
  candidate: 'Candidate physics',
  spectral: 'Spectral',
  context: 'Context',
};

function formatNumber(value: number | null, maximumFractionDigits = 3) {
  if (value === null) {
    return 'NA';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
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
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function exportFeatureConfig(snapshot: FeatureWorkbenchSnapshot) {
  const payload = {
    featureStore: snapshot.featureStore,
    target: snapshot.target,
    config: snapshot.config,
    featureDefinitions: snapshot.featureDefinitions,
    noLeakageReport: snapshot.noLeakageReport,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = `feature_config_${snapshot.featureStore.configHash}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportPreview(snapshot: FeatureWorkbenchSnapshot) {
  const payload = {
    featureStore: snapshot.featureStore,
    preview: snapshot.preview,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = `features_preview_${snapshot.featureStore.configHash}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Histogram({ stats }: { stats: FeatureStats }) {
  if (stats.histogram.length === 0) {
    return (
      <div className="flex h-36 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No distribution
      </div>
    );
  }

  const width = 320;
  const height = 132;
  const maxCount = Math.max(...stats.histogram.map(bin => bin.count), 1);
  const barWidth = width / stats.histogram.length;

  return (
    <svg
      aria-hidden="true"
      className="h-36 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      {stats.histogram.map((bin, index) => {
        const barHeight = (bin.count / maxCount) * (height - 14);

        return (
          <rect
            key={`${bin.min}-${bin.max}`}
            fill="#22d3ee"
            height={barHeight}
            opacity="0.72"
            width={Math.max(1, barWidth - 1)}
            x={index * barWidth}
            y={height - barHeight - 7}
          />
        );
      })}
    </svg>
  );
}

function FeatureTree({
  snapshot,
  enabledFeatureIds,
  selectedFeatureId,
  onToggleFeature,
  onToggleFamily,
  onSelectedFeatureChange,
}: {
  snapshot: FeatureWorkbenchSnapshot;
  enabledFeatureIds: Set<string>;
  selectedFeatureId: string | null;
  onToggleFeature: (featureId: string) => void;
  onToggleFamily: (family: FeatureFamily) => void;
  onSelectedFeatureChange: (featureId: string) => void;
}) {
  const featuresByFamily = useMemo(() => {
    const grouped = new Map<FeatureFamily, typeof snapshot.featureDefinitions>();

    snapshot.featureDefinitions.forEach(definition => {
      grouped.set(definition.family, [...(grouped.get(definition.family) ?? []), definition]);
    });

    return grouped;
  }, [snapshot]);

  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-3 flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-cyan-300" aria-hidden="true" />
        <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
          Feature tree
        </h2>
      </div>
      <div className="grid gap-3">
        {Array.from(featuresByFamily.entries()).map(([family, definitions]) => {
          const familyEnabled = definitions.some(definition => enabledFeatureIds.has(definition.id));

          return (
            <div key={family} className="rounded-md border border-slate-800 bg-slate-950/45">
              <label className="flex min-w-0 items-center gap-2 border-b border-slate-800 px-3 py-2">
                <input
                  type="checkbox"
                  checked={familyEnabled}
                  onChange={() => onToggleFamily(family)}
                  className="h-4 w-4 accent-cyan-300"
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
                  {FAMILY_LABELS[family]}
                </span>
                <span className="font-mono text-[10px] text-slate-500">
                  {definitions.length}
                </span>
              </label>
              <div className="max-h-48 overflow-y-auto p-2">
                {definitions.map(definition => {
                  const isSelected = selectedFeatureId === definition.id;

                  return (
                    <div
                      key={definition.id}
                      className={`flex min-w-0 items-center gap-2 rounded px-2 py-1.5 ${
                        isSelected ? 'bg-cyan-400/10' : 'hover:bg-slate-800/60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={enabledFeatureIds.has(definition.id)}
                        onChange={() => onToggleFeature(definition.id)}
                        className="h-4 w-4 shrink-0 accent-cyan-300"
                        aria-label={`Toggle ${definition.label}`}
                      />
                      <button
                        type="button"
                        onClick={() => onSelectedFeatureChange(definition.id)}
                        className={`min-w-0 flex-1 truncate text-left font-mono text-[10px] ${
                          isSelected ? 'text-cyan-100' : 'text-slate-400'
                        }`}
                        title={definition.label}
                      >
                        {definition.label}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MatrixPreview({
  snapshot,
  enabledFeatureIds,
}: {
  snapshot: FeatureWorkbenchSnapshot;
  enabledFeatureIds: Set<string>;
}) {
  const [previewMode, setPreviewMode] = useState<PreviewMode>('head');
  const rows = snapshot.preview[previewMode];
  const visibleFeatureIds = snapshot.featureDefinitions
    .map(definition => definition.id)
    .filter(featureId => enabledFeatureIds.has(featureId))
    .slice(0, 14);
  const columns = ['timestampUtc', 'target', 'sampleWeight', ...visibleFeatureIds];

  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Table2 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
              Matrix preview
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {snapshot.featureStore.rowsTotal} rows · {snapshot.featureStore.columnsTotal} columns · {snapshot.featureStore.versionTag}
            </div>
          </div>
        </div>
        <div className="flex overflow-hidden rounded-md border border-slate-700/70 bg-slate-950/60 p-1">
          {(['head', 'tail', 'sample'] as PreviewMode[]).map(mode => (
            <button
              key={mode}
              type="button"
              aria-pressed={previewMode === mode}
              onClick={() => setPreviewMode(mode)}
              className={`h-8 rounded px-3 font-mono text-[10px] uppercase tracking-widest transition ${
                previewMode === mode
                  ? 'bg-cyan-400/15 text-cyan-100'
                  : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-200'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/50">
        <table className="min-w-full border-collapse text-left font-mono text-[10px]">
          <thead>
            <tr className="border-b border-slate-800 text-slate-500">
              {columns.map(column => (
                <th key={column} className="max-w-48 truncate border-r border-slate-800 px-3 py-2 font-normal last:border-r-0" title={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.timestampUtc} className="border-b border-slate-900/80 last:border-b-0">
                {columns.map(column => {
                  const value = column === 'timestampUtc'
                    ? formatTimestamp(row.timestampUtc)
                    : column === 'target'
                      ? formatNumber(row.target)
                      : column === 'sampleWeight'
                        ? formatNumber(row.sampleWeight, 1)
                        : formatNumber(row.values[column] ?? null);

                  return (
                    <td key={`${row.timestampUtc}-${column}`} className="max-w-48 truncate border-r border-slate-900/80 px-3 py-2 text-slate-300 last:border-r-0" title={value}>
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibleFeatureIds.length < enabledFeatureIds.size && (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
          Showing first {visibleFeatureIds.length} selected feature columns.
        </div>
      )}
    </section>
  );
}

function FeatureDiagnostics({
  snapshot,
  selectedFeatureId,
}: {
  snapshot: FeatureWorkbenchSnapshot;
  selectedFeatureId: string | null;
}) {
  const stats = snapshot.featureStats.find(item => item.featureId === selectedFeatureId) ?? snapshot.featureStats[0] ?? null;
  const definition = stats
    ? snapshot.featureDefinitions.find(item => item.id === stats.featureId)
    : null;

  if (!stats || !definition) {
    return (
      <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
        <div className="flex h-72 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
          No feature selected
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-4 flex min-w-0 items-center gap-2">
        <Search className="h-4 w-4 text-cyan-300" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
            Feature diagnostics
          </h2>
          <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500" title={definition.id}>
            {definition.id}
          </div>
        </div>
      </div>

      <div className="grid gap-3">
        <Histogram stats={stats} />
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
            <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">NaN</div>
            <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.nanPercent, 2)}%</div>
          </div>
          <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
            <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Corr target</div>
            <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.targetCorrelation, 4)}</div>
          </div>
          <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
            <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Importance</div>
            <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.tentativeImportance, 4)}</div>
          </div>
          <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
            <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Window</div>
            <div className="mt-1 truncate font-mono text-xs text-slate-100">
              {definition.minSourceOffsetMinutes === Number.NEGATIVE_INFINITY ? 'past' : `${definition.minSourceOffsetMinutes}m`} / {definition.maxSourceOffsetMinutes}m
            </div>
          </div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-950/60 p-3">
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Definition</div>
          <div className="mt-2 grid gap-1 font-mono text-[10px] text-slate-300">
            <div className="truncate">family: {definition.family}</div>
            <div className="truncate">source: {definition.source}.{definition.variable}</div>
            <div className="truncate">operation: {definition.operation}</div>
            <div className="truncate">unit: {definition.unit ?? 'NA'}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function FeatureWorkbenchPanel({
  snapshot,
  isLoading,
  error,
  selectedFeatureId,
  onSelectedFeatureChange,
  onRefresh,
}: FeatureWorkbenchPanelProps) {
  const [enabledFeatureIdList, setEnabledFeatureIdList] = useState<string[] | null>(null);
  const allFeatureIds = useMemo(
    () => snapshot?.featureDefinitions.map(definition => definition.id) ?? [],
    [snapshot],
  );
  const enabledFeatureIds = useMemo(
    () => new Set(enabledFeatureIdList ?? allFeatureIds),
    [allFeatureIds, enabledFeatureIdList],
  );

  const toggleFeature = (featureId: string) => {
    setEnabledFeatureIdList(currentList => {
      const nextSet = new Set(currentList ?? allFeatureIds);

      if (nextSet.has(featureId)) {
        nextSet.delete(featureId);
      } else {
        nextSet.add(featureId);
      }

      return Array.from(nextSet);
    });
  };

  const toggleFamily = (family: FeatureFamily) => {
    if (!snapshot) {
      return;
    }

    const familyFeatureIds = snapshot.featureDefinitions
      .filter(definition => definition.family === family)
      .map(definition => definition.id);

    setEnabledFeatureIdList(currentList => {
      const nextSet = new Set(currentList ?? allFeatureIds);
      const shouldDisable = familyFeatureIds.some(featureId => nextSet.has(featureId));

      familyFeatureIds.forEach(featureId => {
        if (shouldDisable) {
          nextSet.delete(featureId);
        } else {
          nextSet.add(featureId);
        }
      });

      return Array.from(nextSet);
    });
  };

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto pr-1 2xl:grid-cols-[330px_minmax(0,1fr)_330px]">
      <aside className="grid content-start gap-4">
        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300">
                Feature Workbench
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold text-slate-100">
                Causal feature matrix
              </h2>
            </div>
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-cyan-400/30 bg-cyan-400/10 text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
              aria-label="Refresh feature workbench"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
          <div className="grid gap-2">
            <div className={`rounded border p-3 ${
              snapshot?.noLeakageReport.passed
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
                : 'border-rose-400/30 bg-rose-400/10 text-rose-100'
            }`}>
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <span>{snapshot?.noLeakageReport.passed ? 'No leakage passed' : 'No leakage pending'}</span>
              </div>
              <div className="mt-1 font-mono text-[10px] opacity-80">
                {snapshot?.noLeakageReport.featuresChecked ?? 0} features checked
              </div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-950/50 p-3">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Target</div>
              <div className="mt-1 truncate font-mono text-xs text-slate-200">
                {snapshot ? `${snapshot.target.source}.${snapshot.target.variable}` : 'NA'}
              </div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-950/50 p-3">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Config hash</div>
              <div className="mt-1 truncate font-mono text-xs text-slate-200">
                {snapshot?.featureStore.configHash ?? 'NA'}
              </div>
            </div>
            {snapshot && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => exportFeatureConfig(snapshot)}
                  className="flex h-9 flex-1 items-center justify-center gap-2 rounded-md border border-slate-700 bg-slate-950/60 px-2 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Config</span>
                </button>
                <button
                  type="button"
                  onClick={() => exportPreview(snapshot)}
                  className="flex h-9 flex-1 items-center justify-center gap-2 rounded-md border border-slate-700 bg-slate-950/60 px-2 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Preview</span>
                </button>
              </div>
            )}
          </div>
        </section>

        {snapshot && (
          <FeatureTree
            snapshot={snapshot}
            enabledFeatureIds={enabledFeatureIds}
            selectedFeatureId={selectedFeatureId}
            onToggleFeature={toggleFeature}
            onToggleFamily={toggleFamily}
            onSelectedFeatureChange={onSelectedFeatureChange}
          />
        )}
      </aside>

      <section className="min-w-0 space-y-4">
        {snapshot ? (
          <>
            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="rounded border border-slate-800 bg-slate-950/60 p-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Rows</div>
                  <div className="mt-1 truncate font-mono text-sm text-slate-100">{snapshot.featureStore.rowsTotal}</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/60 p-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Features</div>
                  <div className="mt-1 truncate font-mono text-sm text-slate-100">{snapshot.featureDefinitions.length}</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/60 p-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Event rows</div>
                  <div className="mt-1 truncate font-mono text-sm text-slate-100">{snapshot.sampleWeights.eventRows}</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/60 p-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Range</div>
                  <div className="mt-1 truncate font-mono text-xs text-slate-100">
                    {formatTimestamp(snapshot.range.startUtc)}
                  </div>
                </div>
              </div>
              {(error || snapshot.warnings.length > 0) && (
                <div className="mt-3 grid gap-2">
                  {error && (
                    <div className="rounded border border-rose-400/30 bg-rose-400/10 p-2 font-mono text-[10px] uppercase tracking-widest text-rose-100">
                      {error}
                    </div>
                  )}
                  {snapshot.warnings.slice(0, 4).map(warning => (
                    <div key={warning} className="rounded border border-amber-300/30 bg-amber-300/10 p-2 font-mono text-[10px] text-amber-100">
                      {warning}
                    </div>
                  ))}
                </div>
              )}
            </section>
            <MatrixPreview snapshot={snapshot} enabledFeatureIds={enabledFeatureIds} />
          </>
        ) : (
          <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
            {isLoading ? 'Building features' : 'Not available'}
          </div>
        )}
      </section>

      <aside className="grid content-start gap-4">
        {snapshot && (
          <>
            <FeatureDiagnostics snapshot={snapshot} selectedFeatureId={selectedFeatureId} />
            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                Family summary
              </div>
              <div className="grid gap-2">
                {snapshot.familySummaries.map(summary => (
                  <div key={summary.family} className="rounded border border-slate-800 bg-slate-950/50 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm text-slate-200">{FAMILY_LABELS[summary.family]}</div>
                      <div className="font-mono text-[10px] text-slate-500">{summary.enabledFeatures}/{summary.totalFeatures}</div>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-slate-500">
                      NaN {formatNumber(summary.meanNanPercent, 2)}%
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </aside>
    </main>
  );
}
