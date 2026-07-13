"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { AlertTriangle, Beaker, Database, FileBarChart, GitCompareArrows, ImageIcon, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type {
  LeoArrivalComparability,
  LeoArrivalMode,
  LeoArrivalModeResult,
  LeoLagExperiment,
  LeoStudyMode,
  LeoTransferExperiment,
  LeoValidationArtifactCategory,
  LeoValidationEventStudy,
  LeoValidationLineage,
  LeoValidationMetric,
  LeoValidationModeResult,
  LeoValidationRegimeDimension,
  LeoValidationResponse,
  LeoValidationScientificArtifact,
} from '@/lib/leo/contracts';

function fmtUtc(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return value.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function uncertaintyYearDescription(split: Record<string, unknown> | null): string {
  const roles = split?.roles !== null && typeof split?.roles === 'object' && !Array.isArray(split.roles)
    ? split.roles as Record<string, unknown>
    : null;
  const yearsFor = (role: string): number[] => {
    const value = roles?.[role];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const years = (value as Record<string, unknown>).calendar_years;
    return Array.isArray(years) ? years.filter((year): year is number => typeof year === 'number' && Number.isInteger(year)) : [];
  };
  const calibration = yearsFor('calibration');
  const test = yearsFor('test');
  if (calibration.length && test.length) {
    return `Residual quantiles were calibrated on the ${calibration.join(', ')} calibration split; interval coverage was evaluated on the separate ${test.join(', ')} test split.`;
  }
  return 'Calibration and test periods are reported separately below when present in the study artifact.';
}

function fmtMetric(metric: LeoValidationMetric): string {
  const abs = Math.abs(metric.value);
  const value = abs !== 0 && (abs < 0.001 || abs >= 10_000) ? metric.value.toExponential(3) : metric.value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function StatusBadge({ value }: { value: string }) {
  const style = value === 'available' || value === 'calibrated' || value === 'identical'
    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
    : value === 'partial' || value === 'uncalibrated' || value === 'unverified'
      ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
      : value === 'error'
        ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
        : 'border-slate-700 bg-slate-900/70 text-slate-500';
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest ${style}`}>{value}</span>;
}

function MetricCard({ metric, datasetVersion }: { metric: LeoValidationMetric; datasetVersion: string | null }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">{metric.label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-100">{fmtMetric(metric)}</div>
      <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[8px] text-slate-500">
        <span>model {metric.model_id ?? 'not recorded'}</span>
        {metric.sample_count !== null && <span>n={metric.sample_count.toLocaleString('en-US')}</span>}
        {metric.confidence_interval && <span>{metric.confidence_interval.level_pct}% CI [{metric.confidence_interval.low.toPrecision(3)}, {metric.confidence_interval.high.toPrecision(3)}]</span>}
      </div>
      {metric.confidence_interval && <div className="mt-1 font-mono text-[7px] leading-relaxed text-slate-600">{metric.confidence_interval.method ?? 'CI method not recorded'}{metric.confidence_interval.block_count === null ? '' : ` · ${metric.confidence_interval.block_count} blocks`}{metric.confidence_interval.resamples === null ? '' : ` · ${metric.confidence_interval.resamples} resamples`}{metric.confidence_interval.random_seed === null ? '' : ` · seed ${metric.confidence_interval.random_seed}`}</div>}
      <div className="mt-1 font-mono text-[7px] leading-relaxed text-slate-600">dataset {datasetVersion ?? 'not recorded'} · chronological held-out test</div>
    </div>
  );
}

function ModePanel({ result, datasetVersion }: { result: LeoValidationModeResult; datasetVersion: string | null }) {
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">{result.label}</h3>
          <p className="mt-1 font-mono text-[8px] uppercase tracking-widest text-slate-500">retrospective · held-out results only</p>
        </div>
        <StatusBadge value={result.status} />
      </div>

      {result.metrics.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{result.metrics.map(metric => <MetricCard key={`${metric.key}-${metric.model_id ?? 'all'}`} metric={metric} datasetVersion={datasetVersion} />)}</div>
      ) : <div className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No mode-level metrics published</div>}

      {result.models.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800"><div className="border-b border-slate-800 bg-slate-950/50 px-3 py-2 font-mono text-[7px] text-slate-600">dataset {datasetVersion ?? 'not recorded'} · chronological held-out test · model identified per row</div>
          <table className="w-full min-w-[36rem] border-collapse text-left text-[10px]">
            <thead><tr className="bg-slate-950/70 font-mono text-[8px] uppercase tracking-widest text-slate-600"><th className="px-3 py-2">model</th><th className="px-3 py-2">feature group</th><th className="px-3 py-2">scientific role</th><th className="px-3 py-2">status</th><th className="px-3 py-2">held-out metrics</th></tr></thead>
            <tbody>{result.models.map(model => (
              <tr key={model.id} className="border-t border-slate-800 align-top">
                <td className="px-3 py-2"><div className="font-semibold text-slate-200">{model.id}</div><div className="text-slate-500">{model.label}</div></td>
                <td className="px-3 py-2 text-slate-400">{model.feature_group ?? '—'}</td>
                <td className="px-3 py-2"><div className="flex flex-col items-start gap-1"><span className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[7px] uppercase text-slate-400">{model.role.replaceAll('_', ' ')}</span><span className={`font-mono text-[7px] ${model.uses_mission_identity === false ? 'text-emerald-300' : model.uses_mission_identity === true ? 'text-rose-300' : 'text-slate-600'}`}>{model.uses_mission_identity === false ? 'identity-free' : model.uses_mission_identity === true ? 'uses mission identity' : 'identity use unverified'}</span><span className="font-mono text-[7px] text-slate-600">{model.causality.replaceAll('_', ' ')}</span></div></td>
                <td className="px-3 py-2"><StatusBadge value={model.status} /></td>
                <td className="px-3 py-2"><div className="flex flex-wrap gap-1.5">{model.metrics.length ? model.metrics.map(metric => <span key={metric.key} className="rounded border border-slate-800 bg-slate-950/60 px-1.5 py-1 font-mono text-[8px] text-slate-300" title={`${metric.label}${metric.sample_count !== null ? ` · n=${metric.sample_count}` : ''}`}>{metric.key}: {fmtMetric(metric)}</span>) : <span className="text-slate-600">none published</span>}</div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {result.split && <details className="mt-3 rounded-lg border border-slate-800/80 px-3 py-2"><summary className="cursor-pointer font-mono text-[9px] uppercase tracking-widest text-slate-400">chronological split metadata</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] leading-relaxed text-slate-500">{JSON.stringify(result.split, null, 2)}</pre></details>}
      {result.warnings.length > 0 && <div className="mt-3 rounded border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[10px] text-amber-100/75">{result.warnings.join(' · ')}</div>}
    </article>
  );
}

const ARTIFACT_CATEGORIES: ReadonlyArray<{ id: Exclude<LeoValidationArtifactCategory, 'event'>; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'performance', label: 'Performance' },
  { id: 'regime', label: 'Regime diagnostics' },
  { id: 'lag_response', label: 'Lag response' },
  { id: 'interpretation', label: 'Model interpretation' },
];

function ArtifactCard({ artifact }: { artifact: LeoValidationScientificArtifact }) {
  return (
    <article className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/35">
      <div className="border-b border-slate-800 bg-slate-950/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-200">{artifact.title}</h3>
          <span className="rounded border border-violet-400/25 bg-violet-400/[0.07] px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-widest text-violet-200">retrospective plot</span>
        </div>
      </div>
      <div className="bg-white/[0.02] p-2">
        <Image
          src={artifact.url}
          alt={artifact.title}
          width={1400}
          height={800}
          unoptimized
          className="h-auto w-full rounded-md border border-slate-800 object-contain"
        />
      </div>
      <p className="border-t border-slate-800 px-3 py-2 text-[10px] leading-relaxed text-slate-400">{artifact.interpretation}</p>
      {artifact.interpretation_details && <details className="border-t border-slate-800 px-3 py-2"><summary className="cursor-pointer font-mono text-[8px] uppercase tracking-widest text-slate-500">saved interpretation data · top {artifact.interpretation_details.top_features.length} features</summary><p className="mt-2 text-[9px] text-slate-600">{artifact.interpretation_details.method ?? 'Saved feature-importance method'}{artifact.interpretation_details.random_seed === null ? '' : ` · seed ${artifact.interpretation_details.random_seed}`}</p><div className="mt-2 overflow-x-auto"><table className="w-full min-w-[24rem] border-collapse font-mono text-[8px]"><thead><tr className="text-slate-600"><th className="pb-1 text-left">feature</th><th className="pb-1 text-right">held-out MAE increase</th></tr></thead><tbody>{artifact.interpretation_details.top_features.map(record => <tr key={record.feature} className="border-t border-slate-800/70 text-slate-400"><td className="max-w-xs break-all py-1 pr-2">{record.feature}</td><td className="py-1 text-right">{record.mae_increase.toExponential(3)}</td></tr>)}</tbody></table></div></details>}
    </article>
  );
}

function ScientificPlotGallery({ artifacts }: { artifacts: LeoValidationScientificArtifact[] }) {
  const availableCategories = ARTIFACT_CATEGORIES.filter(category => artifacts.some(artifact => artifact.category === category.id));
  const [requestedCategory, setRequestedCategory] = useState<Exclude<LeoValidationArtifactCategory, 'event'>>('overview');
  const selectedCategory = availableCategories.some(category => category.id === requestedCategory)
    ? requestedCategory
    : availableCategories[0]?.id ?? 'overview';
  const visible = artifacts.filter(artifact => artifact.category === selectedCategory);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/25 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2"><ImageIcon className="mt-0.5 h-4 w-4 text-violet-300" aria-hidden="true" /><div><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Scientific plots and interpretation</h2><p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-500">Only PNG plots declared by the selected versioned study and verified inside its run directory are served. Model files, Parquet predictions and local paths are not exposed.</p></div></div>
        <span className="font-mono text-[8px] uppercase tracking-widest text-slate-600">{artifacts.length} verified plots</span>
      </div>
      {availableCategories.length ? (
        <>
          <div className="mt-3 flex flex-wrap gap-1" role="tablist" aria-label="Scientific plot category">
            {availableCategories.map(category => (
              <button key={category.id} type="button" role="tab" aria-selected={selectedCategory === category.id} onClick={() => setRequestedCategory(category.id)} className={`rounded border px-2 py-1 font-mono text-[8px] uppercase tracking-widest transition ${selectedCategory === category.id ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`}>{category.label} · {artifacts.filter(artifact => artifact.category === category.id).length}</button>
            ))}
          </div>
          <div className="mt-4 grid gap-3 xl:grid-cols-2">{visible.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} />)}</div>
        </>
      ) : <div className="mt-4 rounded-lg border border-dashed border-slate-800 px-3 py-6 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No verified scientific plot is available</div>}
    </section>
  );
}

function fmtOptional(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function EventStudies({ events, artifacts }: { events: LeoValidationEventStudy[]; artifacts: LeoValidationScientificArtifact[] }) {
  const [requestedEventId, setRequestedEventId] = useState(events[0]?.id ?? '');
  const event = events.find(candidate => candidate.id === requestedEventId) ?? events[0] ?? null;
  const plot = event?.plot_artifact_id ? artifacts.find(artifact => artifact.id === event.plot_artifact_id) ?? null : null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/25 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Event studies</h2><p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-500">Retrospective event definitions and whole-event holdout metrics are shown only when recorded by the saved study. Missing onset or recovery thresholds remain unavailable.</p></div>
        {events.length > 0 && <label className="font-mono text-[8px] uppercase tracking-widest text-slate-600">storm event<select value={event?.id ?? ''} onChange={e => setRequestedEventId(e.target.value)} className="mt-1 block h-8 max-w-full rounded border border-slate-700 bg-slate-950 px-2 text-[9px] normal-case tracking-normal text-slate-300">{events.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
      </div>
      {!event ? <div className="mt-4 rounded-lg border border-dashed border-slate-800 px-3 py-6 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No retrospective event window was published</div> : (
        <>
          <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/45 p-3 text-[10px]"><div className="font-mono text-[8px] uppercase tracking-widest text-violet-200">{event.evidence_class}</div><div className="mt-1 text-slate-300">{fmtUtc(event.start_utc)} → {fmtUtc(event.end_utc)}</div><p className="mt-1 text-slate-500">{event.definition}</p></div>
          {plot ? <div className="mt-3"><ArtifactCard artifact={plot} /></div> : <div className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center text-[10px] text-slate-600">No verified plot was saved for this event.</div>}
          <div className="mt-3 grid gap-3 xl:grid-cols-2">{(['reference_aligned', 'heliosat_predicted_arrival'] as const).map(mode => {
            const result = event.mode_results[mode];
            return <article key={mode} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"><div className="flex items-center justify-between gap-2"><h3 className="text-[10px] font-semibold text-slate-300">{mode === 'reference_aligned' ? 'Reference aligned' : event.prediction_mode_label}</h3><StatusBadge value={result.status} /></div><dl className="mt-3 grid grid-cols-2 gap-2 text-[9px]"><div><dt className="font-mono uppercase tracking-widest text-slate-600">peak density abs. rel. error</dt><dd className="mt-0.5 text-slate-300">{result.peak_density_absolute_relative_error === null ? 'Unavailable' : `${fmtOptional(result.peak_density_absolute_relative_error * 100, 2)}%`}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">peak timing MAE</dt><dd className="mt-0.5 text-slate-300">{result.peak_timing_mae_min === null ? 'Unavailable' : `${fmtOptional(result.peak_timing_mae_min, 1)} min`}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">onset timing MAE</dt><dd className="mt-0.5 text-slate-300">{result.onset_timing_mae_min === null ? 'Unavailable' : `${fmtOptional(result.onset_timing_mae_min, 1)} min`}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">recovery timing MAE</dt><dd className="mt-0.5 text-slate-300">{result.recovery_timing_mae_min === null ? 'Unavailable' : `${fmtOptional(result.recovery_timing_mae_min, 1)} min`}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">rows</dt><dd className="mt-0.5 text-slate-300">{result.sample_count?.toLocaleString('en-US') ?? 'Unavailable'}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">spacecraft</dt><dd className="mt-0.5 text-slate-300">{result.spacecraft_count ?? 'Unavailable'}</dd></div></dl>{result.reason && <p className="mt-2 text-[9px] leading-relaxed text-amber-100/60">{result.reason}</p>}</article>;
          })}</div>
        </>
      )}
    </section>
  );
}

function RegimeAnalysis({ regimes }: { regimes: Record<LeoStudyMode, LeoValidationRegimeDimension[]> }) {
  const [mode, setMode] = useState<LeoStudyMode>('heliosat_predicted_arrival');
  const [requestedDimension, setRequestedDimension] = useState<LeoValidationRegimeDimension['id']>('geomagnetic_regime');
  const dimensions = regimes[mode];
  const dimension = dimensions.find(item => item.id === requestedDimension) ?? dimensions[0] ?? null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/25 p-4">
      <div><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Regime analysis</h2><p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-500">Chronological held-out M3 metrics. Only regimes actually present in the pilot are listed; absent moderate or severe-storm rows are not synthesized.</p></div>
      <div className="mt-3 flex flex-wrap gap-3">
        <label className="font-mono text-[8px] uppercase tracking-widest text-slate-600">timeline mode<select value={mode} onChange={e => setMode(e.target.value === 'reference_aligned' ? 'reference_aligned' : 'heliosat_predicted_arrival')} className="mt-1 block h-8 rounded border border-slate-700 bg-slate-950 px-2 text-[9px] normal-case tracking-normal text-slate-300"><option value="heliosat_predicted_arrival">HelioSat predicted arrival</option><option value="reference_aligned">Reference aligned</option></select></label>
        <label className="font-mono text-[8px] uppercase tracking-widest text-slate-600">breakdown<select value={dimension?.id ?? ''} onChange={e => setRequestedDimension(e.target.value as LeoValidationRegimeDimension['id'])} disabled={!dimensions.length} className="mt-1 block h-8 rounded border border-slate-700 bg-slate-950 px-2 text-[9px] normal-case tracking-normal text-slate-300 disabled:text-slate-600">{dimensions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      </div>
      {dimension ? <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800"><table className="w-full min-w-[48rem] border-collapse text-left text-[9px]"><thead><tr className="bg-slate-950/70 font-mono text-[8px] uppercase tracking-widest text-slate-600"><th className="px-3 py-2">{dimension.label}</th><th className="px-3 py-2 text-right">n</th><th className="px-3 py-2 text-right">MAE dex</th><th className="px-3 py-2 text-right">RMSE dex</th><th className="px-3 py-2 text-right">median abs. rel.</th><th className="px-3 py-2 text-right">bias dex</th><th className="px-3 py-2 text-right">correlation</th><th className="px-3 py-2 text-right">RMSE skill vs M0</th></tr></thead><tbody>{dimension.groups.map(group => <tr key={group.id} className="border-t border-slate-800 text-slate-300"><td className="px-3 py-2"><span className="font-semibold text-slate-200">{group.label}</span> <StatusBadge value={group.status} /></td><td className="px-3 py-2 text-right">{group.sample_count?.toLocaleString('en-US') ?? '—'}</td><td className="px-3 py-2 text-right">{fmtOptional(group.mae_log10_rho)}</td><td className="px-3 py-2 text-right">{fmtOptional(group.rmse_log10_rho)}</td><td className="px-3 py-2 text-right">{group.median_absolute_relative_error === null ? '—' : `${fmtOptional(group.median_absolute_relative_error * 100, 2)}%`}</td><td className="px-3 py-2 text-right">{fmtOptional(group.bias_log10_rho)}</td><td className="px-3 py-2 text-right">{fmtOptional(group.correlation_log10_rho)}</td><td className="px-3 py-2 text-right">{group.rmse_skill_vs_m0 === null ? '—' : `${fmtOptional(group.rmse_skill_vs_m0 * 100, 2)}%`}</td></tr>)}</tbody></table></div> : <div className="mt-4 rounded-lg border border-dashed border-slate-800 px-3 py-6 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No normalized regime breakdown is available</div>}
    </section>
  );
}

function LineagePanel({ lineage }: { lineage: LeoValidationLineage }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
      <div className="flex items-center gap-2"><Database className="h-4 w-4 text-cyan-300" aria-hidden="true" /><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Sanitized data lineage</h2></div>
      <p className="mt-1 text-[9px] text-slate-600">Counts, coverage, models and checksums only; local filenames and raw records are intentionally omitted.</p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-[9px] sm:grid-cols-3">
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">density coverage</dt><dd className="mt-1 text-slate-300">{fmtUtc(lineage.density_coverage_start_utc)} → {fmtUtc(lineage.density_coverage_end_utc)}</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">density rows</dt><dd className="mt-1 text-slate-300">{lineage.selected_rows?.toLocaleString('en-US') ?? '—'} selected / {lineage.input_rows?.toLocaleString('en-US') ?? '—'} input</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">quality rejects</dt><dd className="mt-1 text-slate-300">{lineage.quality_rejected_rows ?? '—'} quality · {lineage.baseline_rejected_rows ?? '—'} baseline</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">density sources</dt><dd className="mt-1 text-slate-300">{lineage.density_source_file_count} files · {lineage.density_checksum_count} checksums</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">baseline</dt><dd className="mt-1 text-slate-300">{lineage.baseline_models.join(', ') || '—'}{lineage.baseline_versions.length ? ` · ${lineage.baseline_versions.join(', ')}` : ''}</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">driver source</dt><dd className="mt-1 text-slate-300">{lineage.driver_source ?? '—'} · {lineage.driver_source_file_count} files / {lineage.driver_checksum_count} checksums</dd></div>
        <div><dt className="font-mono uppercase tracking-widest text-slate-600">driver coverage</dt><dd className="mt-1 text-slate-300">{fmtUtc(lineage.driver_coverage_start_utc)} → {fmtUtc(lineage.driver_coverage_end_utc)}</dd></div>
        <div className="sm:col-span-2"><dt className="font-mono uppercase tracking-widest text-slate-600">manifest SHA-256</dt><dd className="mt-1 break-all font-mono text-slate-400">{lineage.manifest_checksum_sha256 ?? '—'}</dd></div>
      </dl>
    </section>
  );
}

interface ComparisonRow {
  id: string;
  label: string;
  metrics: Partial<Record<LeoArrivalMode, LeoValidationMetric>>;
}

function flattenMetrics(mode: LeoValidationModeResult | LeoArrivalModeResult): LeoValidationMetric[] {
  return [...mode.metrics, ...mode.models.flatMap(model => model.metrics.map(metric => ({ ...metric, model_id: metric.model_id ?? model.id })))];
}

function comparisonRows(modes: Record<LeoArrivalMode, LeoArrivalModeResult>): ComparisonRow[] {
  const rows = new Map<string, ComparisonRow>();
  for (const mode of ['omni_reference_aligned', 'mru', 'mru_ml'] as const) {
    for (const metric of flattenMetrics(modes[mode])) {
      const id = `${metric.model_id ?? 'all'}:${metric.key}`;
      const row = rows.get(id) ?? { id, label: metric.label, metrics: {} };
      row.metrics[mode] = metric;
      rows.set(id, row);
    }
  }
  return [...rows.values()].filter(row => Object.keys(row.metrics).length >= 2);
}

function GeneralizationStudies({ experiments }: { experiments: LeoTransferExperiment[] }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/25 p-4">
      <div><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Mission-agnostic generalization</h2><p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-500">Leave-one-spacecraft-out and whole-mission holdouts. Diagnostic models and unavailable experiments remain explicit and are not promoted as deployable skill.</p></div>
      {experiments.length ? <div className="mt-3 overflow-x-auto rounded-lg border border-slate-800"><table className="w-full min-w-[58rem] border-collapse text-left text-[9px]"><thead><tr className="bg-slate-950/70 font-mono text-[8px] uppercase tracking-widest text-slate-600"><th className="px-3 py-2">experiment</th><th className="px-3 py-2">arrival</th><th className="px-3 py-2">holdout</th><th className="px-3 py-2">training corpus</th><th className="px-3 py-2">role / status</th><th className="px-3 py-2">metrics</th></tr></thead><tbody>{experiments.map(experiment => <tr key={experiment.id} className="border-t border-slate-800 align-top text-slate-300"><td className="px-3 py-2"><div className="font-semibold text-slate-200">{experiment.label}</div><div className="font-mono text-[7px] text-slate-600">{experiment.kind.replaceAll('_', ' ')}</div></td><td className="px-3 py-2 font-mono text-[8px]">{experiment.arrival_mode.replaceAll('_', ' ')}</td><td className="px-3 py-2">{experiment.held_out_spacecraft_id ?? experiment.held_out_mission ?? '—'}<div className="text-slate-600">n={experiment.test_rows?.toLocaleString('en-US') ?? '—'}</div></td><td className="px-3 py-2">{experiment.train_spacecraft_ids.join(', ') || experiment.train_missions.join(', ') || '—'}</td><td className="px-3 py-2"><div className="mb-1 font-mono text-[7px] text-slate-500">{experiment.role.replaceAll('_', ' ')}</div><StatusBadge value={experiment.status} />{experiment.reason && <div className="mt-1 max-w-xs text-amber-100/60">{experiment.reason}</div>}</td><td className="px-3 py-2"><div className="flex flex-wrap gap-1">{experiment.metrics.length ? experiment.metrics.map(metric => <span key={`${metric.model_id}-${metric.key}`} className="rounded border border-slate-800 px-1.5 py-1 font-mono text-[8px]">{metric.key}: {fmtMetric(metric)}</span>) : <span className="text-slate-600">not published</span>}</div></td></tr>)}</tbody></table></div> : <div className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No LOSO or cross-mission experiment was published</div>}
    </section>
  );
}

function ArrivalModePanel({ result, datasetVersion }: { result: LeoArrivalModeResult; datasetVersion: string | null }) {
  const headline = result.metrics.length ? result.metrics : result.models.find(model => model.id.toUpperCase() === 'M3')?.metrics ?? [];
  return <article className="rounded-xl border border-slate-800 bg-slate-950/35 p-4"><div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-semibold text-slate-100">{result.label}</h3><p className="mt-1 font-mono text-[8px] uppercase tracking-widest text-slate-600">{result.mode.replaceAll('_', ' ')} · retrospective</p></div><StatusBadge value={result.status} /></div>{headline.length ? <div className="mt-3 grid gap-2">{headline.slice(0, 4).map(metric => <MetricCard key={`${metric.model_id}-${metric.key}`} metric={metric} datasetVersion={datasetVersion} />)}</div> : <div className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">Unavailable</div>}{result.warnings.length > 0 && <p className="mt-3 text-[9px] leading-relaxed text-amber-100/65">{result.warnings.join(' · ')}</p>}</article>;
}

function LagStudies({ experiments }: { experiments: LeoLagExperiment[] }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/25 p-4">
      <div><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Causal lag experiments</h2><p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-500">Fixed, distributed and regime-stratified response experiments between bow-shock arrival and density. Missing studies remain unavailable.</p></div>
      {experiments.length ? <div className="mt-3 grid gap-2 lg:grid-cols-2">{experiments.map(experiment => <article key={experiment.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"><div className="flex items-start justify-between gap-2"><div><h3 className="text-[10px] font-semibold text-slate-200">{experiment.label}</h3><p className="mt-1 font-mono text-[7px] uppercase text-slate-600">{experiment.kind.replaceAll('_', ' ')}{experiment.arrival_mode ? ` · ${experiment.arrival_mode.replaceAll('_', ' ')}` : ''}</p></div><StatusBadge value={experiment.status} /></div><dl className="mt-2 grid grid-cols-2 gap-2 text-[9px]"><div><dt className="font-mono uppercase text-slate-600">lag grid</dt><dd className="text-slate-300">{experiment.lag_min_hours ?? '—'}–{experiment.lag_max_hours ?? '—'} h · {experiment.lag_step_minutes ?? '—'} min</dd></div><div><dt className="font-mono uppercase text-slate-600">best lag</dt><dd className="text-slate-300">{experiment.best_lag_hours === null ? '—' : `${experiment.best_lag_hours} h`}</dd></div><div><dt className="font-mono uppercase text-slate-600">stratification</dt><dd className="text-slate-300">{experiment.stratification?.replaceAll('_', ' ') ?? 'global'}</dd></div><div><dt className="font-mono uppercase text-slate-600">metric</dt><dd className="text-slate-300">{experiment.metric ? fmtMetric(experiment.metric) : '—'}</dd></div></dl>{experiment.reason && <p className="mt-2 text-[9px] text-amber-100/60">{experiment.reason}</p>}</article>)}</div> : <div className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No structured 0–12 hour lag experiment was published</div>}
    </section>
  );
}

function ComparabilityBadge({ comparison }: { comparison: LeoArrivalComparability }) {
  return <StatusBadge value={comparison.status === 'identical' ? 'available' : comparison.status === 'mismatch' ? 'error' : 'unavailable'} />;
}

export function LeoValidationPanel() {
  const [response, setResponse] = useState<LeoValidationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setRequestError(null);
    try {
      const result = await fetch('/api/console/leo/validation', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!result.ok) throw new Error(result.status === 403 ? 'Admin access is required.' : 'Validation summary request failed.');
      setResponse((await result.json()) as LeoValidationResponse);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Validation summary request failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const study = response?.study ?? null;
  const comparisons = useMemo(() => study ? comparisonRows(study.arrival_modes) : [], [study]);

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Beaker className="mt-0.5 h-5 w-5 text-violet-300" aria-hidden="true" />
            <div>
              <div className="flex flex-wrap items-center gap-2"><h1 className="text-lg font-semibold text-slate-100">Thermospheric density and drag study</h1><span className="rounded border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 font-mono text-[8px] uppercase tracking-widest text-violet-200">retrospective research</span>{study && <span className="rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 font-mono text-[8px] uppercase tracking-widest text-cyan-100">{study.research_stage.replaceAll('_', ' ')}</span>}{response && <StatusBadge value={response.status} />}</div>
              <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-500">Tests whether causal solar-wind forcing propagated by HelioSat improves an empirical atmosphere baseline on held-out density observations. OMNI reference, MRU and MRU plus ML remain separate and are compared only when their fingerprints prove identical inputs.</p>
            </div>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1.5 rounded border border-slate-700/70 px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-400 transition hover:text-cyan-200 disabled:cursor-wait">{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} refresh study</button>
        </div>
      </header>

      {loading && !response ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/30 font-mono text-[10px] uppercase tracking-widest text-slate-600"><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> reading versioned study artifact…</div>
      ) : requestError && !response ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-rose-400/25 bg-rose-400/[0.05] px-5 text-center font-mono text-[10px] uppercase tracking-widest text-rose-200/80">{requestError}</div>
      ) : !study ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 p-8 text-center">
          <FileBarChart className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
          <h2 className="mt-3 text-sm font-semibold text-slate-300">No validated LEO study artifact is available</h2>
          <p className="mx-auto mt-2 max-w-2xl text-[11px] leading-relaxed text-slate-500">The page only reports a versioned <span className="font-mono text-slate-400">study-summary.v1.json</span> under <span className="font-mono text-slate-400">{response?.artifact_root ?? 'data/model-runs/leo-density'}</span>. It will not calculate placeholder metrics from the small ingestion sample or reinterpret fixtures as scientific results.</p>
          {(response?.warnings.length ?? 0) > 0 && <div className="mx-auto mt-4 max-w-3xl rounded border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[10px] text-amber-100/75">{response?.warnings.join(' · ')}</div>}
        </div>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4 lg:col-span-2">
              <div className="flex items-center gap-2"><Database className="h-4 w-4 text-cyan-300" aria-hidden="true" /><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Study overview and lineage</h2></div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-[10px] sm:grid-cols-3">
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">run</dt><dd className="mt-1 break-all text-slate-300">{study.run_id}</dd></div>
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">study version</dt><dd className="mt-1 text-slate-300">{study.study_version ?? '—'}</dd></div>
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">generated UTC</dt><dd className="mt-1 text-slate-300">{fmtUtc(study.generated_at_utc)}</dd></div>
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">dataset version</dt><dd className="mt-1 break-all text-slate-300">{study.dataset_version ?? '—'}</dd></div>
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">feature schema</dt><dd className="mt-1 break-all text-slate-300">{study.feature_schema_version ?? '—'}</dd></div>
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">missions</dt><dd className="mt-1 text-slate-300">{study.missions.length ? study.missions.join(', ') : '—'}</dd></div>
              </dl>
              <dl className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[9px] sm:grid-cols-4">
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">effective days</dt><dd className="mt-1 text-base font-semibold text-slate-200">{study.coverage_summary.effective_observation_days ?? '—'}</dd></div>
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">calendar years</dt><dd className="mt-1 text-slate-300">{study.coverage_summary.calendar_years.join(', ') || '—'}</dd></div>
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">storms</dt><dd className="mt-1 text-slate-300">{study.coverage_summary.storm_events.total ?? '—'} total · {study.coverage_summary.storm_events.moderate ?? '—'} moderate · {study.coverage_summary.storm_events.severe ?? '—'} severe</dd></div>
                <div><dt className="font-mono uppercase tracking-widest text-slate-600">spacecraft</dt><dd className="mt-1 text-slate-300">{study.coverage_summary.spacecraft_count ?? '—'}{study.coverage_summary.spacecraft_ids.length ? ` · ${study.coverage_summary.spacecraft_ids.join(', ')}` : ''}</dd></div>
              </dl>
              {study.split && <details className="mt-3 rounded-lg border border-slate-800 px-3 py-2"><summary className="cursor-pointer font-mono text-[9px] uppercase tracking-widest text-slate-400">global split and holdout metadata</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-slate-500">{JSON.stringify(study.split, null, 2)}</pre></details>}
            </div>
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4"><ShieldCheck className="h-4 w-4 text-amber-300" aria-hidden="true" /><h2 className="mt-2 text-xs font-semibold uppercase tracking-widest text-amber-100/90">Scientific boundary</h2><p className="mt-2 text-[10px] leading-relaxed text-slate-400">Retrospective held-out evidence is not an operational forecast. No metric is promoted to the public dashboard, and contemporaneous diagnostic inputs must not be treated as issuance-safe features.</p></div>
          </div>

          <section><div className="mb-2"><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Arrival-mode studies</h2><p className="mt-1 text-[10px] text-slate-500">OMNI reference alignment, ballistic MRU and MRU plus rebuilt ML are never merged or silently substituted.</p></div><div className="grid gap-3 xl:grid-cols-3">{(['omni_reference_aligned', 'mru', 'mru_ml'] as const).map(mode => <ArrivalModePanel key={mode} result={study.arrival_modes[mode]} datasetVersion={study.dataset_version} />)}</div></section>

          <details className="rounded-xl border border-slate-800 bg-slate-950/25 p-4"><summary className="cursor-pointer font-mono text-[9px] uppercase tracking-widest text-slate-400">Legacy pilot mode contract</summary><div className="mt-3 grid gap-3 xl:grid-cols-2"><ModePanel result={study.modes.reference_aligned} datasetVersion={study.dataset_version} /><ModePanel result={study.modes.heliosat_predicted_arrival} datasetVersion={study.dataset_version} /></div></details>

          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
            <div className="flex flex-wrap items-center gap-2"><GitCompareArrows className="h-4 w-4 text-cyan-300" aria-hidden="true" /><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Arrival-mode comparison</h2><ComparabilityBadge comparison={study.arrival_comparability} /></div>
            <p className="mt-1 text-[10px] text-slate-500">Deltas are enabled only when the artifact proves identical matched rows, chronological split and hyperparameters.</p>
            {study.arrival_comparability.status !== 'identical' && <div className="mt-2 rounded border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[9px] text-amber-100/70">Comparison delta withheld. {study.arrival_comparability.reasons.join(' · ') || 'Comparison fingerprints are unverified.'}</div>}
            {comparisons.length ? <div className="mt-3 overflow-x-auto rounded-lg border border-slate-800"><table className="w-full min-w-[48rem] border-collapse font-mono text-[9px]"><thead><tr className="bg-slate-950/70 uppercase tracking-widest text-slate-600"><th className="px-3 py-2 text-left">metric / model</th><th className="px-3 py-2 text-right">OMNI reference</th><th className="px-3 py-2 text-right">MRU</th><th className="px-3 py-2 text-right">MRU + ML</th><th className="px-3 py-2 text-right">MRU+ML − OMNI</th></tr></thead><tbody>{comparisons.map(row => { const reference = row.metrics.omni_reference_aligned; const ml = row.metrics.mru_ml; return <tr key={row.id} className="border-t border-slate-800 text-slate-300"><td className="px-3 py-2 text-slate-200">{row.label}<span className="ml-1 text-slate-600">{reference?.model_id ?? row.metrics.mru?.model_id ?? ml?.model_id ?? 'all'}</span></td>{(['omni_reference_aligned', 'mru', 'mru_ml'] as const).map(mode => <td key={mode} className="px-3 py-2 text-right">{row.metrics[mode] ? fmtMetric(row.metrics[mode]) : '—'}</td>)}<td className="px-3 py-2 text-right text-cyan-200">{study.arrival_comparability.status === 'identical' && reference && ml ? `${(ml.value - reference.value).toLocaleString('en-US', { maximumFractionDigits: 4 })}${reference.unit ? ` ${reference.unit}` : ''}` : '—'}</td></tr>; })}</tbody></table></div> : <div className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No identically keyed metrics are available across arrival modes</div>}
            <details className="mt-3 rounded border border-slate-800 px-3 py-2"><summary className="cursor-pointer font-mono text-[8px] uppercase text-slate-500">comparison fingerprints</summary><pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[8px] text-slate-600">{JSON.stringify(study.arrival_comparability, null, 2)}</pre></details>
          </div>

          <GeneralizationStudies experiments={study.transfer_experiments} />
          <LagStudies experiments={study.lag_experiments} />

          <section className="rounded-xl border border-slate-800 bg-slate-950/25 p-4"><div className="flex items-center justify-between gap-2"><div><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Prediction-interval calibration</h2><p className="mt-1 text-[10px] text-slate-500">{uncertaintyYearDescription(study.split)}</p></div><StatusBadge value={study.uncertainty_calibration.status} /></div><dl className="mt-3 grid grid-cols-2 gap-2 text-[9px] sm:grid-cols-4"><div><dt className="font-mono uppercase text-slate-600">method / blocks</dt><dd className="text-slate-300">{study.uncertainty_calibration.method ?? '—'} · {study.uncertainty_calibration.block_count ?? '—'}</dd></div><div><dt className="font-mono uppercase text-slate-600">nominal / empirical</dt><dd className="text-slate-300">{study.uncertainty_calibration.nominal_coverage ?? '—'} / {study.uncertainty_calibration.empirical_coverage ?? '—'}</dd></div><div><dt className="font-mono uppercase text-slate-600">p10 / p50 / p90 coverage</dt><dd className="text-slate-300">{study.uncertainty_calibration.p10_coverage ?? '—'} / {study.uncertainty_calibration.p50_coverage ?? '—'} / {study.uncertainty_calibration.p90_coverage ?? '—'}</dd></div><div><dt className="font-mono uppercase text-slate-600">calibration period</dt><dd className="text-slate-300">{fmtUtc(study.uncertainty_calibration.calibration_start_utc)} → {fmtUtc(study.uncertainty_calibration.calibration_end_utc)}</dd></div></dl>{study.uncertainty_calibration.reason && <p className="mt-2 text-[9px] text-amber-100/60">{study.uncertainty_calibration.reason}</p>}</section>

          <EventStudies events={study.events} artifacts={study.scientific_artifacts} />
          <RegimeAnalysis regimes={study.regimes} />
          <ScientificPlotGallery artifacts={study.scientific_artifacts.filter(artifact => artifact.category !== 'event')} />

          {study.lineage && <LineagePanel lineage={study.lineage} />}

          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4"><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden="true" /><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Limitations</h2></div>{study.limitations.length ? <ul className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-slate-400">{study.limitations.map(item => <li key={item}>• {item}</li>)}</ul> : <p className="mt-2 text-[10px] text-slate-600">No limitations were recorded in the artifact.</p>}</div>
        </>
      )}

      {(response?.errors.length ?? 0) > 0 && <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2 text-[11px] text-rose-100/80">{response?.errors.join(' · ')}</div>}
      {(response?.warnings.length ?? 0) > 0 && study && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">{response?.warnings.join(' · ')}</div>}
      {(study?.warnings.length ?? 0) > 0 && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">Study warnings: {study?.warnings.join(' · ')}</div>}
      {requestError && response && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">Refresh failed; showing the previous study. {requestError}</div>}
    </section>
  );
}
