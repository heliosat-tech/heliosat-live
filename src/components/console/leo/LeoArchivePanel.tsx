"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, CloudLightning, Database, ExternalLink, FileCheck2, HardDrive, Loader2, RefreshCw, Satellite, ShieldAlert } from 'lucide-react';
import type {
  LeoArchiveDataset,
  LeoAvailabilityStatus,
  LeoCoveragePhase,
  LeoInventoryResponse,
  LeoProcessingStatus,
} from '@/lib/leo/contracts';

const PHASES: Array<{ key: LeoCoveragePhase; label: string; color: string }> = [
  { key: 'raw', label: 'raw', color: 'bg-sky-400/70' },
  { key: 'processed', label: 'processed', color: 'bg-cyan-400/70' },
  { key: 'joined', label: 'joined', color: 'bg-violet-400/70' },
  { key: 'train', label: 'train', color: 'bg-emerald-400/70' },
  { key: 'validation', label: 'validation', color: 'bg-amber-400/70' },
  { key: 'test', label: 'test', color: 'bg-rose-400/70' },
];

function fmtNumber(value: number | null): string {
  return value === null ? '—' : Math.round(value).toLocaleString('en-US');
}

function fmtBytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(2)} GiB`;
}

function fmtUtc(value: string | null, dateOnly = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return dateOnly ? value.slice(0, 10) : value.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function statusClass(status: LeoAvailabilityStatus | LeoProcessingStatus): string {
  if (status === 'available' || status === 'complete') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
  if (status === 'partial' || status === 'pending') return 'border-amber-400/30 bg-amber-400/10 text-amber-200';
  if (status === 'error') return 'border-rose-400/30 bg-rose-400/10 text-rose-200';
  return 'border-slate-700 bg-slate-900/70 text-slate-500';
}

function StatusChip({ status }: { status: LeoAvailabilityStatus | LeoProcessingStatus }) {
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest ${statusClass(status)}`}>{status}</span>;
}

function CoverageTimeline({ dataset, minMs, maxMs }: { dataset: LeoArchiveDataset; minMs: number; maxMs: number }) {
  const span = Math.max(1, maxMs - minMs);
  return (
    <div className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1">
      {PHASES.map(phase => {
        const range = dataset.coverage[phase.key];
        const start = range.start_utc ? Date.parse(range.start_utc) : NaN;
        const end = range.end_utc ? Date.parse(range.end_utc) : NaN;
        const available = Number.isFinite(start) && Number.isFinite(end);
        const left = available ? Math.max(0, Math.min(100, (start - minMs) / span * 100)) : 0;
        const width = available ? Math.max(0.8, Math.min(100 - left, (end - start) / span * 100)) : 0;
        return (
          <div key={phase.key} className="contents">
            <span className="self-center font-mono text-[8px] uppercase tracking-widest text-slate-600">{phase.label}</span>
            <div className="relative h-2.5 overflow-hidden rounded-sm bg-slate-900/80" title={available ? `${fmtUtc(range.start_utc)} → ${fmtUtc(range.end_utc)}` : `${phase.label}: unavailable`}>
              {available && <span className={`absolute inset-y-0 rounded-sm ${phase.color}`} style={{ left: `${left}%`, width: `${width}%` }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function InventoryCard({ dataset, minMs, maxMs }: { dataset: LeoArchiveDataset; minMs: number; maxMs: number }) {
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">{dataset.display_name}</h3>
            <StatusChip status={dataset.status} />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{dataset.status_message}</p>
        </div>
        <span className="rounded border border-sky-400/25 bg-sky-400/[0.07] px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-sky-200">official observed product</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {dataset.product_ids.length ? dataset.product_ids.map(product => (
          <span key={product} className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[9px] text-slate-300">{product}</span>
        )) : <span className="font-mono text-[9px] text-slate-600">No verified official product ID</span>}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[10px] sm:grid-cols-4">
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">coverage</dt><dd className="mt-0.5 text-slate-300">{fmtUtc(dataset.coverage.processed.start_utc, true)} → {fmtUtc(dataset.coverage.processed.end_utc, true)}</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">cadence</dt><dd className="mt-0.5 text-slate-300">{dataset.native_cadence ?? '—'} raw · {dataset.processed_cadence ?? '—'} processed</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">rows</dt><dd className="mt-0.5 text-slate-300">{fmtNumber(dataset.row_count_raw)} raw · {fmtNumber(dataset.row_count_processed)} processed</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">local size</dt><dd className="mt-0.5 text-slate-300">{fmtBytes(dataset.storage_bytes)}</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">files</dt><dd className="mt-0.5 text-slate-300">{dataset.raw_files} raw · {dataset.processed_files} Parquet</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">quality flags</dt><dd className="mt-0.5 text-slate-300">{dataset.quality_pass_pct === null ? 'not reported' : `${dataset.quality_pass_pct.toFixed(1)}% nominal`}</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">last ingestion</dt><dd className="mt-0.5 text-slate-300">{fmtUtc(dataset.last_ingestion_utc)}</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">pipeline</dt><dd className="mt-0.5 flex flex-wrap items-center gap-1"><span className="text-slate-500">process</span><StatusChip status={dataset.processing_status} /><span className="text-slate-500">baseline</span><StatusChip status={dataset.baseline_status} /><span className="text-slate-500">L1 join</span><StatusChip status={dataset.driver_join_status} /></dd></div>
      </dl>

      <div className="mt-4 rounded-lg border border-slate-800/80 bg-slate-950/50 p-3">
        <CoverageTimeline dataset={dataset} minMs={minMs} maxMs={maxMs} />
      </div>

      {dataset.lineage.length > 0 && (
        <details className="mt-3 rounded-md border border-slate-800/80 bg-slate-950/30 px-3 py-2">
          <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-widest text-slate-400">data lineage · {dataset.lineage.length} source item{dataset.lineage.length === 1 ? '' : 's'}</summary>
          <div className="mt-2 flex flex-col gap-2">
            {dataset.lineage.map((lineage, index) => (
              <div key={`${lineage.source_product}-${index}`} className="border-t border-slate-800/60 pt-2 font-mono text-[9px] leading-relaxed text-slate-500 first:border-0 first:pt-0">
                <div className="text-slate-300">{lineage.source_product}{lineage.source_version ? ` · ${lineage.source_version}` : ''}</div>
                <div className="break-all">raw: {lineage.source_file ?? '—'}</div>
                <div className="break-all">sha256: {lineage.checksum_sha256 ?? '—'}</div>
                {lineage.processed_files.map(file => <div key={file} className="break-all">processed: {file}</div>)}
              </div>
            ))}
          </div>
        </details>
      )}

      {dataset.errors.length > 0 && <div className="mt-3 rounded border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2 text-[10px] text-rose-200">{dataset.errors.join(' · ')}</div>}
    </article>
  );
}

export function LeoArchivePanel() {
  const [inventory, setInventory] = useState<LeoInventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setRequestError(null);
    try {
      const response = await fetch('/api/console/leo/inventory', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(response.status === 403 ? 'Admin access is required.' : 'Inventory request failed.');
      setInventory((await response.json()) as LeoInventoryResponse);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Inventory request failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const timeline = useMemo(() => {
    const values = inventory?.datasets.flatMap(dataset => PHASES.flatMap(phase => {
      const range = dataset.coverage[phase.key];
      return [range.start_utc, range.end_utc].filter((value): value is string => value !== null).map(Date.parse).filter(Number.isFinite);
    })) ?? [];
    if (!values.length) return { min: Date.UTC(2014, 0, 1), max: Date.UTC(2026, 11, 31) };
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? { min: min - 30_000, max: max + 30_000 } : { min, max };
  }, [inventory]);

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Database className="mt-0.5 h-5 w-5 text-cyan-300" aria-hidden="true" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold text-slate-100">Thermosphere and LEO archive</h1>
                <span className="rounded border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 font-mono text-[8px] uppercase tracking-widest text-sky-200">observed · retrospective products</span>
                {inventory && <span className="rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 font-mono text-[8px] uppercase tracking-widest text-cyan-100">{inventory.research_stage.replaceAll('_', ' ')}</span>}
              </div>
              <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-500">Official Swarm and GRACE-FO density products stored separately as immutable raw responses and one-minute processed Parquet. Missing missions remain explicit; zero rows never stand in for observations.</p>
            </div>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1.5 rounded border border-slate-700/70 px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-400 transition hover:text-cyan-200 disabled:cursor-wait">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} refresh inventory
          </button>
        </div>

        {inventory && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><FileCheck2 className="mb-1 h-4 w-4 text-emerald-300" aria-hidden="true" /><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">manifest</div><div className="mt-1 break-all text-[10px] text-slate-300">{inventory.manifest.path}</div><div className="mt-1"><StatusChip status={inventory.manifest.status} /></div></div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><HardDrive className="mb-1 h-4 w-4 text-cyan-300" aria-hidden="true" /><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">local observed record</div><div className="mt-1 text-[10px] text-slate-300">{inventory.datasets.filter(dataset => dataset.status === 'available').length} / {inventory.datasets.length} spacecraft available</div><div className="mt-1 text-[9px] text-slate-500">generated {fmtUtc(inventory.generated_at_utc)}</div></div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><CalendarDays className="mb-1 h-4 w-4 text-violet-300" aria-hidden="true" /><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">effective coverage</div><div className="mt-1 text-base font-semibold text-slate-200">{fmtNumber(inventory.coverage_summary.effective_observation_days)} days</div><div className="mt-1 text-[9px] text-slate-500">explicit processed-day count; gaps are not filled</div></div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><CalendarDays className="mb-1 h-4 w-4 text-sky-300" aria-hidden="true" /><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">calendar years</div><div className="mt-1 text-base font-semibold text-slate-200">{inventory.coverage_summary.calendar_years.length ? inventory.coverage_summary.calendar_years.join(', ') : '—'}</div><div className="mt-1 text-[9px] text-slate-500">years explicitly represented</div></div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><CloudLightning className="mb-1 h-4 w-4 text-amber-300" aria-hidden="true" /><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">storm events</div><div className="mt-1 text-base font-semibold text-slate-200">{fmtNumber(inventory.coverage_summary.storm_events.total)}</div><div className="mt-1 text-[9px] text-slate-500">{fmtNumber(inventory.coverage_summary.storm_events.moderate)} moderate · {fmtNumber(inventory.coverage_summary.storm_events.severe)} severe</div></div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><Satellite className="mb-1 h-4 w-4 text-emerald-300" aria-hidden="true" /><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">spacecraft / missions</div><div className="mt-1 text-base font-semibold text-slate-200">{fmtNumber(inventory.coverage_summary.spacecraft_count)} / {fmtNumber(inventory.coverage_summary.mission_count)}</div><div className="mt-1 text-[9px] text-slate-500">effective observed corpus</div></div>
            <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.04] p-3"><ShieldAlert className="mb-1 h-4 w-4 text-amber-300" aria-hidden="true" /><div className="font-mono text-[8px] uppercase tracking-widest text-amber-200/80">license boundary</div><div className="mt-1 text-[10px] leading-relaxed text-slate-400">{inventory.source.licensing_status}</div></div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-slate-500">
          <a href="https://vires.services/hapi/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-cyan-200">ESA VirES HAPI <ExternalLink className="h-3 w-3" aria-hidden="true" /></a>
          <span>{inventory?.source.attribution ?? 'Data provided by the European Space Agency.'}</span>
          <a href="https://vires.services/data_terms" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-cyan-200">data terms <ExternalLink className="h-3 w-3" aria-hidden="true" /></a>
        </div>
      </header>

      {loading && !inventory ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/30 font-mono text-[10px] uppercase tracking-widest text-slate-600"><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> reading local manifest…</div>
      ) : requestError && !inventory ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-rose-400/25 bg-rose-400/[0.05] px-5 text-center font-mono text-[10px] uppercase tracking-widest text-rose-200/80">{requestError}</div>
      ) : inventory ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {inventory.datasets.map(dataset => <InventoryCard key={dataset.id} dataset={dataset} minMs={timeline.min} maxMs={timeline.max} />)}
        </div>
      ) : null}

      {(inventory?.warnings.length ?? 0) > 0 && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">{inventory?.warnings.join(' · ')}</div>}
      {(inventory?.errors.length ?? 0) > 0 && <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2 text-[11px] text-rose-100/80">{inventory?.errors.join(' · ')}</div>}
      {requestError && inventory && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">Refresh failed; showing the previous inventory. {requestError}</div>}
    </section>
  );
}
