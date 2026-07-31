"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import {
  AlertTriangle,
  ArrowRight,
  Beaker,
  CalendarDays,
  CheckCircle2,
  Database,
  FileBarChart,
  Gauge,
  ImageIcon,
  Loader2,
  Orbit,
  RefreshCw,
  Satellite,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type {
  LeoArrivalMode,
  LeoArrivalModeResult,
  LeoLagExperiment,
  LeoTransferExperiment,
  LeoValidationMetric,
  LeoValidationResponse,
  LeoValidationScientificArtifact,
  LeoValidationStudy,
} from '@/lib/leo/contracts';

type SplitRoleId = 'train' | 'validation' | 'calibration' | 'test';

interface SplitRole {
  years: number[];
  rows: number | null;
}

const ARRIVAL_MODES: ReadonlyArray<{
  id: LeoArrivalMode;
  shortLabel: string;
  description: string;
  barClass: string;
}> = [
  {
    id: 'omni_reference_aligned',
    shortLabel: 'OMNI reference',
    description: 'Best-case retrospective timing',
    barClass: 'bg-violet-400',
  },
  {
    id: 'mru',
    shortLabel: 'MRU',
    description: 'Ballistic HelioSat propagation',
    barClass: 'bg-sky-400',
  },
  {
    id: 'mru_ml',
    shortLabel: 'MRU + ML',
    description: 'Ballistic propagation with ML timing correction',
    barClass: 'bg-cyan-300',
  },
];

function fmtUtc(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  return value.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function fmtPercent(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function fmtDecimal(value: number | null, digits = 3): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

function fmtMetric(metric: LeoValidationMetric | null): string {
  if (!metric) return '—';
  if (metric.unit === 'fraction') return fmtPercent(metric.value, 2);
  const value = Math.abs(metric.value) !== 0 && (Math.abs(metric.value) < 0.001 || Math.abs(metric.value) >= 10_000)
    ? metric.value.toExponential(3)
    : metric.value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function splitRole(split: Record<string, unknown> | null, role: SplitRoleId): SplitRole {
  const roles = asRecord(split?.roles);
  const value = asRecord(roles?.[role]);
  const years = Array.isArray(value?.calendar_years)
    ? value.calendar_years.filter((year): year is number => typeof year === 'number' && Number.isInteger(year))
    : [];
  return {
    years,
    rows: typeof value?.rows === 'number' && Number.isFinite(value.rows) ? value.rows : null,
  };
}

function allMetrics(result: LeoArrivalModeResult): LeoValidationMetric[] {
  return [
    ...result.metrics,
    ...result.models.flatMap(model => model.metrics),
  ];
}

function metricFor(result: LeoArrivalModeResult, key: string): LeoValidationMetric | null {
  return allMetrics(result).find(metric => metric.key === key) ?? null;
}

function StatusBadge({ value }: { value: string }) {
  const style = value === 'available' || value === 'calibrated' || value === 'identical'
    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
    : value === 'partial' || value === 'uncalibrated' || value === 'unverified'
      ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
      : value === 'error'
        ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
        : 'border-slate-700 bg-slate-900/70 text-slate-500';
  return <span className={`rounded border px-2 py-1 font-mono text-[8px] uppercase tracking-widest ${style}`}>{value.replaceAll('_', ' ')}</span>;
}

function StudyFlow({ study }: { study: LeoValidationStudy }) {
  const spacecraft = study.coverage_summary.spacecraft_ids.length
    ? study.coverage_summary.spacecraft_ids.join(' · ')
    : 'Swarm A/B/C · GRACE-FO 1';

  const steps = [
    {
      number: '01',
      title: 'Observe density',
      body: 'Use official ESA/VirES density products measured along real LEO orbits.',
      detail: spacecraft,
      icon: Satellite,
      accent: 'text-sky-300',
    },
    {
      number: '02',
      title: 'Build a physical baseline',
      body: 'NRLMSIS 2.1 estimates the density expected from location, altitude, solar flux and geomagnetic activity.',
      detail: 'This is the no-ML reference (M0)',
      icon: Orbit,
      accent: 'text-amber-300',
    },
    {
      number: '03',
      title: 'Learn the correction',
      body: 'M3 learns the remaining log-density error from orbital context and propagated L1 solar-wind forcing.',
      detail: 'No spacecraft identity is used',
      icon: Sparkles,
      accent: 'text-violet-300',
    },
    {
      number: '04',
      title: 'Test on unseen time',
      body: 'Predicted density is compared with observations from a later year that was never used to fit the model.',
      detail: 'Chronological holdout, not a random row split',
      icon: CheckCircle2,
      accent: 'text-emerald-300',
    },
  ];

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4 sm:p-5">
      <div>
        <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-cyan-300">How the study works</div>
        <h2 className="mt-1 text-base font-semibold text-slate-100">One question, four steps</h2>
        <p className="mt-1 max-w-4xl text-[11px] leading-relaxed text-slate-400">Can upstream solar-wind information improve the physical estimate of thermospheric density?</p>
      </div>

      <div className="mt-4 grid gap-2 xl:grid-cols-4">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <div key={step.number} className="relative flex min-h-44 flex-col rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] tracking-[0.2em] text-slate-600">STEP {step.number}</span>
                <Icon className={`h-5 w-5 ${step.accent}`} aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-sm font-semibold text-slate-100">{step.title}</h3>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{step.body}</p>
              <p className="mt-auto pt-4 font-mono text-[8px] uppercase leading-relaxed tracking-wider text-slate-600">{step.detail}</p>
              {index < steps.length - 1 && <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 rounded-full bg-slate-950 text-slate-600 xl:block" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ChronologicalSplit({ study }: { study: LeoValidationStudy }) {
  const testYears = splitRole(study.split, 'test').years;
  const roles: ReadonlyArray<{
    id: SplitRoleId;
    label: string;
    purpose: string;
    tone: string;
  }> = [
    { id: 'train', label: 'Train', purpose: 'Learn the correction', tone: 'border-violet-400/30 bg-violet-400/[0.08]' },
    { id: 'validation', label: 'Validate', purpose: 'Choose settings', tone: 'border-sky-400/30 bg-sky-400/[0.08]' },
    { id: 'calibration', label: 'Calibrate', purpose: 'Set uncertainty range', tone: 'border-amber-400/30 bg-amber-400/[0.08]' },
    { id: 'test', label: 'Final test', purpose: 'Measure performance once', tone: 'border-emerald-400/30 bg-emerald-400/[0.08]' },
  ];

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-slate-100">Time is kept in order</h2>
          <p className="mt-1 max-w-4xl text-[11px] leading-relaxed text-slate-400">The model cannot learn from its future. Each calendar period has one job, and the {testYears.join('–') || 'final'} test period stays untouched until the end.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {roles.map(role => {
          const value = splitRole(study.split, role.id);
          return (
            <article key={role.id} className={`rounded-xl border p-3 ${role.tone}`}>
              <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-slate-500">{role.label}</div>
              <div className="mt-1 text-lg font-semibold text-slate-100">{value.years.join('–') || 'Not recorded'}</div>
              <div className="mt-1 text-[10px] text-slate-400">{role.purpose}</div>
              <div className="mt-3 font-mono text-[8px] text-slate-600">{value.rows === null ? 'Rows not recorded' : `${value.rows.toLocaleString('en-US')} matched rows`}</div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ArrivalComparison({ study }: { study: LeoValidationStudy }) {
  const testYears = splitRole(study.split, 'test').years;
  const values = ARRIVAL_MODES.map(mode => ({
    ...mode,
    metric: metricFor(study.arrival_modes[mode.id], 'median_absolute_relative_error'),
  }));
  const mru = values.find(value => value.id === 'mru')?.metric?.value ?? null;
  const ml = values.find(value => value.id === 'mru_ml')?.metric?.value ?? null;
  const deltaPoints = mru !== null && ml !== null ? (mru - ml) * 100 : null;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-cyan-300">Timing sensitivity</div>
          <h2 className="mt-1 text-base font-semibold text-slate-100">Does L1-to-Earth timing change the density result?</h2>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-400">Typical absolute density error on the same held-out {testYears.join('–') || 'test'} rows. Lower is better.</p>
        </div>
        <StatusBadge value={study.arrival_comparability.status} />
      </div>

      <div className="mt-5 space-y-4">
        {values.map(value => {
          const width = value.metric ? Math.min(100, Math.max(2, (value.metric.value / 0.25) * 100)) : 0;
          return (
            <div key={value.id} className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)_4.5rem] sm:items-center">
              <div>
                <div className="text-[11px] font-medium text-slate-200">{value.shortLabel}</div>
                <div className="text-[9px] text-slate-600">{value.description}</div>
              </div>
              <div className="h-3 overflow-hidden rounded-full border border-slate-800 bg-slate-900" aria-hidden="true">
                <div className={`h-full rounded-full ${value.barClass}`} style={{ width: `${width}%` }} />
              </div>
              <div className="text-right font-mono text-sm font-semibold text-slate-100">{fmtPercent(value.metric?.value ?? null, 2)}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 text-right font-mono text-[8px] uppercase tracking-wider text-slate-600">common scale: 0–25% error</div>

      <div className="mt-5 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
          <div>
            <h3 className="text-sm font-semibold text-cyan-100">The timing correction helps only slightly in this study</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
              {deltaPoints === null
                ? 'The saved study does not contain enough comparable metrics to quantify the difference.'
                : `MRU + ML reduces the typical error by ${deltaPoints.toFixed(2)} percentage points versus ballistic MRU and stays close to the optimistic retrospective OMNI reference.`}
            </p>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">Interpretation: most of the density skill comes from the atmosphere baseline and density correction. The choice between these three arrival timelines has a modest effect on the final density error.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function HeadlineResults({ study }: { study: LeoValidationStudy }) {
  const selected = study.arrival_modes.mru_ml;
  const error = metricFor(selected, 'median_absolute_relative_error');
  const correlation = metricFor(selected, 'correlation_log10_rho') ?? metricFor(selected, 'correlation_density');
  const skill = metricFor(selected, 'rmse_skill_vs_m0');
  const test = splitRole(study.split, 'test');
  const empiricalCoverage = study.uncertainty_calibration.empirical_coverage;
  const nominalCoverage = study.uncertainty_calibration.nominal_coverage;

  const cards = [
    {
      label: 'Typical density error',
      value: fmtPercent(error?.value ?? null, 1),
      help: 'Median absolute relative error. Half of the tested samples are better than this value and half are worse.',
    },
    {
      label: 'Variation tracked',
      value: fmtDecimal(correlation?.value ?? null, 3),
      help: 'Correlation in log density. Values near 1 mean that rises and falls are followed well.',
    },
    {
      label: 'Gain over NRLMSIS',
      value: fmtPercent(skill?.value ?? null, 1),
      help: 'Reduction in RMSE versus the physical baseline on exactly the same rows.',
    },
    {
      label: 'Uncertainty check',
      value: fmtPercent(empiricalCoverage, 1),
      help: nominalCoverage === null
        ? 'Observed coverage of the saved prediction interval.'
        : `${fmtPercent(nominalCoverage, 0)} target interval, calibrated before the final test.`,
    },
  ];

  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-400/[0.07] via-slate-950/40 to-cyan-400/[0.04]">
      <div className="border-b border-emerald-400/15 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-emerald-300">Main result</div>
            <h2 className="mt-1 max-w-4xl text-lg font-semibold text-slate-50">The model follows thermospheric density well, but the improvement over the physical baseline is modest.</h2>
            <p className="mt-2 max-w-4xl text-[11px] leading-relaxed text-slate-400">These numbers use the HelioSat MRU + ML timeline and only the final {test.years.join('–') || 'held-out'} test period{test.rows === null ? '.' : ` (${test.rows.toLocaleString('en-US')} matched observations).`}</p>
          </div>
          <span className="rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-emerald-200">density evaluated</span>
        </div>
      </div>
      <div className="grid gap-px bg-slate-800/70 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(card => (
          <article key={card.label} className="bg-slate-950/80 p-4">
            <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-slate-500">{card.label}</div>
            <div className="mt-2 text-2xl font-semibold text-slate-100">{card.value}</div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{card.help}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function DensityToDrag() {
  return (
    <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.04] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Gauge className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-amber-300">Density → drag</div>
            <h2 className="mt-1 text-base font-semibold text-slate-100">Drag is a downstream calculation, not a result of this validation</h2>
            <p className="mt-1 max-w-4xl text-[11px] leading-relaxed text-slate-400">Density tells us how much atmosphere the satellite encounters. To estimate drag, we still need its air-relative speed and an assumed ballistic coefficient.</p>
          </div>
        </div>
        <span className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-amber-200">drag evaluation pending</span>
      </div>

      <div className="mt-4 grid gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:items-stretch">
        <article className="rounded-xl border border-slate-800 bg-slate-950/55 p-3">
          <div className="font-mono text-[8px] uppercase tracking-wider text-cyan-300">1 · Inputs</div>
          <div className="mt-2 text-sm font-semibold text-slate-100">Density + trajectory + B</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Predicted ρ, SGP4 state and a declared generic ballistic coefficient.</p>
        </article>
        <ArrowRight className="mx-auto h-5 w-5 self-center rotate-90 text-slate-600 lg:rotate-0" aria-hidden="true" />
        <article className="rounded-xl border border-slate-800 bg-slate-950/55 p-3">
          <div className="font-mono text-[8px] uppercase tracking-wider text-amber-300">2 · Acceleration</div>
          <div className="mt-2 font-mono text-sm font-semibold text-slate-100">|aᵈ| = ½ ρ B |vᵣₑₗ|²</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Denser air or higher relative speed produces more drag.</p>
        </article>
        <ArrowRight className="mx-auto h-5 w-5 self-center rotate-90 text-slate-600 lg:rotate-0" aria-hidden="true" />
        <article className="rounded-xl border border-slate-800 bg-slate-950/55 p-3">
          <div className="font-mono text-[8px] uppercase tracking-wider text-violet-300">3 · Integrate</div>
          <div className="mt-2 text-sm font-semibold text-slate-100">Δv and along-track shift</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Add the small acceleration over time to estimate first-order orbital impact.</p>
        </article>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/20 bg-slate-950/40 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
        <p className="text-[10px] leading-relaxed text-amber-100/75">The selected study artifact validates density only. It does not publish a validated drag-loss, Δv or orbit-error metric, so those outputs must remain labelled as sensitivity scenarios.</p>
      </div>
    </section>
  );
}

function ArtifactCard({ artifact }: { artifact: LeoValidationScientificArtifact }) {
  return (
    <figure className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/50">
      <div className="border-b border-slate-800 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold text-slate-200">{artifact.title}</h3>
          <span className="shrink-0 font-mono text-[7px] uppercase tracking-widest text-violet-300">retrospective</span>
        </div>
      </div>
      <div className="bg-white/[0.02] p-2">
        <Image src={artifact.url} alt={artifact.title} width={1400} height={800} unoptimized className="h-auto w-full rounded border border-slate-800 object-contain" />
      </div>
      <figcaption className="border-t border-slate-800 px-3 py-2.5 text-[10px] leading-relaxed text-slate-500">{artifact.interpretation}</figcaption>
    </figure>
  );
}

function selectKeyArtifacts(artifacts: LeoValidationScientificArtifact[]): LeoValidationScientificArtifact[] {
  const overview = artifacts.find(artifact => artifact.category === 'overview');
  const comparison = artifacts.find(artifact => artifact.title.toLowerCase().includes('reference aligned versus end to end'))
    ?? artifacts.find(artifact => artifact.category === 'performance');
  return [overview, comparison].filter((artifact, index, values): artifact is LeoValidationScientificArtifact => Boolean(artifact) && values.indexOf(artifact) === index);
}

function VisualEvidence({ artifacts }: { artifacts: LeoValidationScientificArtifact[] }) {
  const selected = useMemo(() => selectKeyArtifacts(artifacts), [artifacts]);

  if (!selected.length) return null;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-slate-100">Two plots worth looking at</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">The first checks the physical baseline. The second checks how much arrival-time handling changes the held-out result.</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">{selected.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} />)}</div>
    </section>
  );
}

function ClaimBoundary({ study }: { study: LeoValidationStudy }) {
  const generalization = study.transfer_experiments.find(experiment => experiment.kind === 'cross_mission' && experiment.status === 'available');
  const generalizationError = generalization ? metricFromExperiment(generalization, 'median_absolute_relative_error') : null;

  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <article className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4 sm:p-5">
        <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-300" aria-hidden="true" /><h2 className="text-sm font-semibold text-emerald-100">What this study supports</h2></div>
        <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-slate-400">
          <li>• Density was evaluated on a later, unseen calendar period.</li>
          <li>• The same model covers Swarm A/B/C and GRACE-FO 1 without a spacecraft-ID shortcut.</li>
          <li>• The saved uncertainty range was calibrated before the final test.</li>
          {generalizationError && <li>• Swarm → GRACE-FO transfer was tested separately ({fmtPercent(generalizationError.value, 1)} typical error).</li>}
        </ul>
      </article>
      <article className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-4 sm:p-5">
        <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-amber-300" aria-hidden="true" /><h2 className="text-sm font-semibold text-amber-100">What it does not support yet</h2></div>
        <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-slate-400">
          <li>• It is not proof of an operational, real-time forecast.</li>
          <li>• It does not validate drag, Δv or orbit position error.</li>
          <li>• The 606 observed days are staged and storm-enriched, not continuous climatology.</li>
          <li>• OMNI reference alignment is retrospective and cannot be used as a live input.</li>
        </ul>
      </article>
    </section>
  );
}

function metricFromExperiment(experiment: LeoTransferExperiment, key: string): LeoValidationMetric | null {
  return experiment.metrics.find(metric => metric.key === key) ?? null;
}

function TechnicalAppendix({ study }: { study: LeoValidationStudy }) {
  const crossMission = study.transfer_experiments.filter(experiment => experiment.kind === 'cross_mission');
  const fixedLags = study.lag_experiments.filter(experiment => experiment.kind === 'fixed_lag' && experiment.status === 'available');
  const keyPlotIds = new Set(selectKeyArtifacts(study.scientific_artifacts).map(artifact => artifact.id));
  const extraPlots = study.scientific_artifacts.filter(artifact => artifact.category !== 'event' && !keyPlotIds.has(artifact.id));

  return (
    <details className="group rounded-2xl border border-slate-800 bg-slate-950/30">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <Database className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold text-slate-200">Technical appendix</h2>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Versions, secondary checks, lag experiments, lineage and full limitations.</p>
          </div>
        </div>
        <span className="font-mono text-[8px] uppercase tracking-widest text-slate-500 group-open:text-cyan-300">open details</span>
      </summary>

      <div className="space-y-4 border-t border-slate-800 p-4 sm:p-5">
        <section>
          <h3 className="font-mono text-[9px] uppercase tracking-[0.18em] text-slate-400">Study identity</h3>
          <dl className="mt-3 grid gap-3 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
            <div><dt className="text-slate-600">Run</dt><dd className="mt-1 break-all text-slate-300">{study.run_id}</dd></div>
            <div><dt className="text-slate-600">Study / dataset</dt><dd className="mt-1 break-all text-slate-300">{study.study_version ?? '—'} / {study.dataset_version ?? '—'}</dd></div>
            <div><dt className="text-slate-600">Feature schema</dt><dd className="mt-1 break-all text-slate-300">{study.feature_schema_version ?? '—'}</dd></div>
            <div><dt className="text-slate-600">Generated UTC</dt><dd className="mt-1 text-slate-300">{fmtUtc(study.generated_at_utc)}</dd></div>
          </dl>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <h3 className="font-mono text-[9px] uppercase tracking-[0.18em] text-slate-400">Data represented</h3>
          <dl className="mt-3 grid gap-3 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
            <div><dt className="text-slate-600">Effective days</dt><dd className="mt-1 text-slate-300">{study.coverage_summary.effective_observation_days?.toLocaleString('en-US') ?? '—'}</dd></div>
            <div><dt className="text-slate-600">Spacecraft</dt><dd className="mt-1 text-slate-300">{study.coverage_summary.spacecraft_ids.join(', ') || '—'}</dd></div>
            <div><dt className="text-slate-600">Storm events</dt><dd className="mt-1 text-slate-300">{study.coverage_summary.storm_events.total ?? '—'} total · {study.coverage_summary.storm_events.moderate ?? '—'} moderate · {study.coverage_summary.storm_events.severe ?? '—'} severe</dd></div>
            <div><dt className="text-slate-600">Coverage</dt><dd className="mt-1 text-slate-300">{fmtUtc(study.coverage_summary.start_utc)} → {fmtUtc(study.coverage_summary.end_utc)}</dd></div>
          </dl>
        </section>

        <section>
          <h3 className="font-mono text-[9px] uppercase tracking-[0.18em] text-slate-400">Comparable arrival-mode metrics</h3>
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full min-w-[42rem] border-collapse text-left text-[10px]">
              <thead><tr className="bg-slate-950/80 font-mono text-[8px] uppercase tracking-widest text-slate-600"><th className="px-3 py-2">Metric</th>{ARRIVAL_MODES.map(mode => <th key={mode.id} className="px-3 py-2 text-right">{mode.shortLabel}</th>)}</tr></thead>
              <tbody>{[
                ['median_absolute_relative_error', 'Typical absolute error'],
                ['correlation_log10_rho', 'Correlation'],
                ['rmse_skill_vs_m0', 'RMSE gain over NRLMSIS'],
                ['median_density_ratio', 'Median predicted / observed'],
              ].map(([key, label]) => (
                <tr key={key} className="border-t border-slate-800 text-slate-300">
                  <td className="px-3 py-2 text-slate-400">{label}</td>
                  {ARRIVAL_MODES.map(mode => <td key={mode.id} className="px-3 py-2 text-right font-mono">{fmtMetric(metricFor(study.arrival_modes[mode.id], key))}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        {(crossMission.length > 0 || fixedLags.length > 0) && (
          <section className="grid gap-3 lg:grid-cols-2">
            <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <h3 className="text-[11px] font-semibold text-slate-300">Cross-mission check</h3>
              {crossMission.length ? <div className="mt-2 space-y-2">{crossMission.map(experiment => <div key={experiment.id} className="flex items-center justify-between gap-3 text-[10px]"><span className="text-slate-500">{experiment.label}</span><span className="font-mono text-slate-300">{fmtMetric(metricFromExperiment(experiment, 'median_absolute_relative_error'))}</span></div>)}</div> : <p className="mt-2 text-[10px] text-slate-600">Not published.</p>}
            </article>
            <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <h3 className="text-[11px] font-semibold text-slate-300">Response-lag diagnostics</h3>
              {fixedLags.length ? <div className="mt-2 space-y-2">{fixedLags.map(experiment => <div key={experiment.id} className="flex items-center justify-between gap-3 text-[10px]"><span className="text-slate-500">{cleanLagLabel(experiment)}</span><span className="font-mono text-slate-300">{experiment.best_lag_hours === null ? '—' : `${experiment.best_lag_hours} h`}</span></div>)}</div> : <p className="mt-2 text-[10px] text-slate-600">Not published.</p>}
              <p className="mt-3 text-[9px] leading-relaxed text-slate-600">These are retrospective response diagnostics, not guaranteed operational delay times.</p>
            </article>
          </section>
        )}

        {study.lineage && (
          <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <h3 className="font-mono text-[9px] uppercase tracking-[0.18em] text-slate-400">Lineage summary</h3>
            <dl className="mt-3 grid gap-3 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
              <div><dt className="text-slate-600">Density evidence</dt><dd className="mt-1 text-slate-300">{study.lineage.density_evidence_class ?? '—'}</dd></div>
              <div><dt className="text-slate-600">Selected rows</dt><dd className="mt-1 text-slate-300">{study.lineage.selected_rows?.toLocaleString('en-US') ?? '—'}</dd></div>
              <div><dt className="text-slate-600">Baseline</dt><dd className="mt-1 text-slate-300">{study.lineage.baseline_models.join(', ') || '—'} {study.lineage.baseline_versions.join(', ')}</dd></div>
              <div><dt className="text-slate-600">Driver source</dt><dd className="mt-1 text-slate-300">{study.lineage.driver_source ?? '—'} · {study.lineage.driver_evidence_class ?? '—'}</dd></div>
            </dl>
          </section>
        )}

        {extraPlots.length > 0 && (
          <details className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
            <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-widest text-slate-400">More saved diagnostic plots · {extraPlots.length}</summary>
            <div className="mt-3 grid gap-3 xl:grid-cols-2">{extraPlots.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} />)}</div>
          </details>
        )}

        <section className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-3">
          <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden="true" /><h3 className="text-[11px] font-semibold text-amber-100">Recorded limitations</h3></div>
          {study.limitations.length ? <ul className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-slate-500">{study.limitations.map(item => <li key={item}>• {item}</li>)}</ul> : <p className="mt-2 text-[10px] text-slate-600">No limitations were recorded in the artifact.</p>}
        </section>
      </div>
    </details>
  );
}

function cleanLagLabel(experiment: LeoLagExperiment): string {
  return experiment.label.replace('Fixed lag: ', '').replaceAll('_', ' ');
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

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Beaker className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" aria-hidden="true" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold text-slate-50">Thermospheric density study</h1>
                <span className="rounded border border-violet-400/30 bg-violet-400/10 px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-violet-200">retrospective research</span>
                {response && <StatusBadge value={response.status} />}
              </div>
              <p className="mt-2 max-w-4xl text-[12px] leading-relaxed text-slate-400">A guided reading of what was measured, what the model learned, how it was tested and what the result means. Density evidence and drag scenarios are kept separate.</p>
            </div>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1.5 rounded border border-slate-700/70 px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-400 transition hover:border-cyan-400/30 hover:text-cyan-200 disabled:cursor-wait">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
            refresh
          </button>
        </div>
      </header>

      {loading && !response ? (
        <div className="flex h-48 items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/30 font-mono text-[10px] uppercase tracking-widest text-slate-600"><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> reading versioned study…</div>
      ) : requestError && !response ? (
        <div className="flex h-40 items-center justify-center rounded-2xl border border-rose-400/25 bg-rose-400/[0.05] px-5 text-center font-mono text-[10px] uppercase tracking-widest text-rose-200/80">{requestError}</div>
      ) : !study ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/30 p-8 text-center">
          <FileBarChart className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
          <h2 className="mt-3 text-sm font-semibold text-slate-300">No validated LEO study is available</h2>
          <p className="mx-auto mt-2 max-w-2xl text-[11px] leading-relaxed text-slate-500">This page only reports saved, versioned study artifacts. It does not invent metrics from partial samples.</p>
          {(response?.warnings.length ?? 0) > 0 && <div className="mx-auto mt-4 max-w-3xl rounded border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[10px] text-amber-100/75">{response?.warnings.join(' · ')}</div>}
        </div>
      ) : (
        <>
          <StudyFlow study={study} />
          <ChronologicalSplit study={study} />
          <HeadlineResults study={study} />
          <ArrivalComparison study={study} />
          <DensityToDrag />
          <ClaimBoundary study={study} />
          <VisualEvidence artifacts={study.scientific_artifacts} />
          <TechnicalAppendix study={study} />
        </>
      )}

      {(response?.errors.length ?? 0) > 0 && <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2 text-[11px] text-rose-100/80">{response?.errors.join(' · ')}</div>}
      {(response?.warnings.length ?? 0) > 0 && study && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">{response?.warnings.join(' · ')}</div>}
      {(study?.warnings.length ?? 0) > 0 && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">Study warnings: {study?.warnings.join(' · ')}</div>}
      {requestError && response && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">Refresh failed; showing the previous study. {requestError}</div>}
    </section>
  );
}
