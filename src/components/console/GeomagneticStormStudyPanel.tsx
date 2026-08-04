"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  FileCheck2,
  Gauge,
  Loader2,
  Radar,
  RefreshCw,
  ShieldCheck,
  Target,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface MetricWithCounts {
  thresholdKp: number;
  tp: number;
  fp: number;
  fn: number;
  tn?: number;
  precisionPct: number | null;
  precisionCi95Pct: number[] | null;
  recallPct: number | null;
  recallCi95Pct: number[] | null;
  falseAlarmRatioPct: number | null;
  falsePositiveRatePct?: number | null;
  specificityPct?: number | null;
  csiPct: number | null;
  tss?: number | null;
  accuracyPct?: number | null;
  baseRatePct?: number | null;
  predictedEvents?: number;
  observedEvents?: number;
  matchingToleranceHours?: number;
}

interface ProductComparison {
  id: string;
  name: string;
  timing: string;
  regression: { n: number; maeKp: number; rmseKp: number; biasKp: number; correlation: number; exactGLevelPct: number; withinOneGLevelPct: number };
  g1Bin: MetricWithCounts;
  g1Event: MetricWithCounts;
}

interface GeomagneticStudy {
  schemaVersion: string;
  generatedAtUtc: string;
  modelVersion: string;
  status: string;
  objective: string;
  scope: {
    developmentStartUtc: string;
    developmentStopUtc: string;
    evaluationStartUtc: string;
    evaluationStopUtc: string;
    developmentBins: number;
    evaluationBins: number;
    nativeTruthCadenceHours: number;
    minimumForecastRowsPerBin: number;
  };
  data: {
    upstream: { provider: string; dataset: string; url: string; role: string; validRows: number; caveat: string; files: Array<{ file: string; sha256: string; bytes: number }> };
    truth: { provider: string; dataset: string; url: string; license: string; rows: number };
    externalBenchmarks: {
      noaaForecast: { provider: string; dataset: string; url: string; selection: string; issuesDownloaded: number; issuesMissing: number; rows: number };
      gfzNowcast: { provider: string; dataset: string; url: string; doi: string; license: string; rows: number };
    };
  };
  method: {
    issueTime: string;
    arrival: string;
    intensity: string;
    truth: string;
    eventDefinition: string;
    eventMatching: string;
    causality: string;
  };
  leadTime: { medianMin: number; p10Min: number; p90Min: number; samples: number };
  results: {
    regression: { n: number; maeKp: number; rmseKp: number; biasKp: number; correlation: number; exactGLevelPct: number; withinOneGLevelPct: number };
    g1Bin: MetricWithCounts;
    g1Event: MetricWithCounts;
    g3Bin: MetricWithCounts;
    g3Event: MetricWithCounts;
    confusionG: number[][];
    thresholds: Array<{ thresholdKp: number; label: string; binPrecisionPct: number | null; binRecallPct: number | null; eventPrecisionPct: number | null; eventRecallPct: number | null; observedEvents: number }>;
    yearly: Array<{ year: number; bins: number; stormBins: number; binPrecisionPct: number | null; binRecallPct: number | null; eventPrecisionPct: number | null; eventRecallPct: number | null; observedEvents: number }>;
    comparisons: ProductComparison[];
  };
  examples: {
    strongestWindow: { title: string; peakGfzKp: number; peakHeliosatKpSameBin: number; points: Array<{ t: number; gfzKp: number; heliosatKp: number; noaaNextDayKp: number | null; gfzNowcastKp: number | null }> };
    matchedObservedG1: Array<{ startUtc: string; endUtc: string; peakKp: number }>;
    missedObservedG1: Array<{ startUtc: string; endUtc: string; peakKp: number }>;
    falseAlarmG1: Array<{ startUtc: string; endUtc: string; peakKp: number }>;
  };
  kpSources: Array<{ id: string; name: string; kind: string; producer: string; cadence: string; timing: string; role: string; scoredHere: boolean; reason: string; url: string | null }>;
  limitations: string[];
}

const HELIOSAT_COLOR = '#22d3ee';
const GFZ_COLOR = '#34d399';
const PRECISION_COLOR = '#a78bfa';
const RECALL_COLOR = '#22d3ee';

function fmtPct(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`;
}

function fmtDate(value: string) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : value;
}

function fmtCi(value: number[] | null) {
  return value && value.length === 2 ? `95% CI ${value[0].toFixed(1)}–${value[1].toFixed(1)}%` : '95% CI unavailable';
}

function ReportSection({ eyebrow, title, description, children }: { eyebrow: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4 sm:p-5">
      <div className="mb-4">
        <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-cyan-300">{eyebrow}</div>
        <h2 className="mt-1 text-base font-semibold text-slate-100">{title}</h2>
        {description && <p className="mt-1 max-w-5xl text-[11px] leading-relaxed text-slate-400">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function FindingCard({ label, value, detail, tone = 'cyan' }: { label: string; value: string; detail: string; tone?: 'cyan' | 'violet' | 'amber' | 'emerald' }) {
  const tones = {
    cyan: 'border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-100',
    violet: 'border-violet-400/20 bg-violet-400/[0.06] text-violet-100',
    amber: 'border-amber-400/20 bg-amber-400/[0.06] text-amber-100',
    emerald: 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-100',
  } as const;
  return (
    <div className={`rounded-xl border p-3 ${tones[tone]}`}>
      <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{detail}</p>
    </div>
  );
}

function StudyFlow({ study }: { study: GeomagneticStudy }) {
  const steps = [
    { number: '01', title: 'Observe upstream', body: 'Take speed, Bz and spacecraft position from the L1 parcel record.', detail: `${study.data.upstream.validRows.toLocaleString()} valid 5 min rows`, icon: Radar, color: 'text-sky-300' },
    { number: '02', title: 'Issue causally', body: 'Reconstruct the time when the parcel was known at L1; no future Kp enters the forecast.', detail: 'features available at issue time', icon: Clock3, color: 'text-cyan-300' },
    { number: '03', title: 'Forecast arrival + Kp', body: 'Apply MRU timing and the frozen V × southward-Bz coupling heuristic.', detail: `median warning ${study.leadTime.medianMin.toFixed(0)} min`, icon: Gauge, color: 'text-violet-300' },
    { number: '04', title: 'Score against Earth', body: 'Compare the predicted three-hour bin with GFZ definitive planetary Kp.', detail: `${study.scope.evaluationBins.toLocaleString()} held-out bins`, icon: Target, color: 'text-emerald-300' },
  ];
  return (
    <div className="grid gap-2 xl:grid-cols-4">
      {steps.map((step, index) => {
        const Icon = step.icon;
        return (
          <article key={step.number} className="relative flex min-h-44 flex-col rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between"><span className="font-mono text-[9px] tracking-[0.2em] text-slate-600">STEP {step.number}</span><Icon className={`h-5 w-5 ${step.color}`} aria-hidden="true" /></div>
            <h3 className="mt-4 text-sm font-semibold text-slate-100">{step.title}</h3>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{step.body}</p>
            <p className="mt-auto pt-4 font-mono text-[8px] uppercase tracking-wider text-slate-600">{step.detail}</p>
            {index < steps.length - 1 && <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 rounded-full bg-slate-950 text-slate-600 xl:block" aria-hidden="true" />}
          </article>
        );
      })}
    </div>
  );
}

function KpSourceComparison({ study }: { study: GeomagneticStudy }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 lg:grid-cols-5">
        {study.kpSources.map((source, index) => (
          <div key={source.id} className={`relative rounded-xl border p-3 ${source.scoredHere ? 'border-cyan-400/25 bg-cyan-400/[0.05]' : 'border-slate-800 bg-slate-950/55'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="font-mono text-[8px] uppercase tracking-widest text-slate-500">{source.kind}</div>
              {source.scoredHere && <FileCheck2 className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />}
            </div>
            <h3 className="mt-2 text-xs font-semibold text-slate-100">{source.name}</h3>
            <p className="mt-2 min-h-12 text-[10px] leading-relaxed text-slate-400">{source.timing}</p>
            <div className="mt-3 border-t border-slate-800 pt-2 font-mono text-[8px] uppercase tracking-wider text-slate-600">{source.role}</div>
            {index < study.kpSources.length - 1 && <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 rounded-full bg-slate-950 text-slate-700 lg:block" aria-hidden="true" />}
          </div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[850px] border-collapse text-left text-[10px]">
          <thead className="bg-slate-950/80 font-mono uppercase tracking-wider text-slate-600"><tr><th className="px-3 py-2 font-medium">Product</th><th className="px-3 py-2 font-medium">Producer</th><th className="px-3 py-2 font-medium">Cadence</th><th className="px-3 py-2 font-medium">Timing</th><th className="px-3 py-2 font-medium">Used in this score?</th></tr></thead>
          <tbody>{study.kpSources.map(source => <tr key={source.id} className="border-t border-slate-800/80 text-slate-400"><td className="px-3 py-2 text-slate-200">{source.url ? <a href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-cyan-200">{source.name}<ExternalLink className="h-3 w-3" aria-hidden="true" /></a> : source.name}</td><td className="px-3 py-2">{source.producer}</td><td className="px-3 py-2 font-mono">{source.cadence}</td><td className="px-3 py-2">{source.timing}</td><td className="px-3 py-2">{source.scoredHere ? <span className="text-emerald-300">Yes · {source.reason}</span> : <span className="text-amber-200/80">No · {source.reason}</span>}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500"><strong className="text-slate-300">Important:</strong> NOAA estimated Kp and GFZ nowcast are observations/nowcasts, not forecasts with positive lead time. The two true forecasts in this comparison are NOAA&apos;s multi-day operational product and HelioSat&apos;s short L1-to-Earth warning.</p>
    </div>
  );
}

function BenchmarkComparison({ study }: { study: GeomagneticStudy }) {
  const names: Record<string, string> = {
    noaa_next_day: 'NOAA next day',
    noaa_two_day: 'NOAA two day',
    heliosat: 'HelioSat',
    gfz_nowcast: 'GFZ nowcast',
  };
  const chartData = study.results.comparisons.map(product => ({
    ...product,
    shortName: names[product.id] ?? product.name,
    precision: product.g1Event.precisionPct,
    recall: product.g1Event.recallPct,
  }));
  const noaa = study.data.externalBenchmarks.noaaForecast;

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="rounded-xl border border-slate-800 bg-slate-950/55 p-3">
        <div className="px-1 pb-2">
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">G1+ event comparison</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">GFZ nowcast is shown as a revision ceiling, not a forecast: it has no positive warning time.</p>
        </div>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 10, left: 18, bottom: 4 }}>
              <CartesianGrid stroke="#1e293b" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={{ stroke: '#334155' }} tickLine={false} tickFormatter={value => `${value}%`} />
              <YAxis type="category" dataKey="shortName" width={86} tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="precision" name="Event precision" fill={PRECISION_COLOR} radius={[0, 3, 3, 0]} />
              <Bar dataKey="recall" name="Event recall" fill={RECALL_COLOR} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/55">
        <table className="w-full min-w-[670px] border-collapse text-left text-[10px]">
          <thead className="bg-slate-950/80 font-mono uppercase tracking-wider text-slate-600"><tr><th className="px-3 py-2 font-medium">Product</th><th className="px-3 py-2 font-medium">Timing</th><th className="px-3 py-2 text-right font-medium">N</th><th className="px-3 py-2 text-right font-medium">MAE Kp</th><th className="px-3 py-2 text-right font-medium">Corr.</th><th className="px-3 py-2 text-right font-medium">G1 precision</th><th className="px-3 py-2 text-right font-medium">G1 recall</th></tr></thead>
          <tbody>{study.results.comparisons.map(product => <tr key={product.id} className={`border-t border-slate-800/80 ${product.id === 'heliosat' ? 'bg-cyan-400/[0.04]' : ''}`}><td className="px-3 py-2 font-medium text-slate-200">{product.name}</td><td className="max-w-44 px-3 py-2 text-slate-500">{product.timing}</td><td className="px-3 py-2 text-right font-mono text-slate-400">{product.regression.n.toLocaleString()}</td><td className="px-3 py-2 text-right font-mono text-slate-300">{product.regression.maeKp.toFixed(2)}</td><td className="px-3 py-2 text-right font-mono text-slate-300">{product.regression.correlation.toFixed(3)}</td><td className="px-3 py-2 text-right font-mono text-violet-200">{fmtPct(product.g1Event.precisionPct)}</td><td className="px-3 py-2 text-right font-mono text-cyan-200">{fmtPct(product.g1Event.recallPct)}</td></tr>)}</tbody>
        </table>
        <div className="border-t border-slate-800 px-3 py-2 text-[9px] leading-relaxed text-slate-600">NOAA sample: {noaa.issuesDownloaded} immutable 0030 UTC products ({noaa.issuesMissing} missing), one forecast per target bin. Longer lead is intrinsically harder; this table compares operational trade-offs, not interchangeable products.</div>
      </div>
    </div>
  );
}

function EventScore({ metrics, label }: { metrics: MetricWithCounts; label: string }) {
  return (
    <div className="grid gap-3 xl:grid-cols-[1.05fr_0.95fr]">
      <div className="rounded-xl border border-slate-800 bg-slate-950/55 p-4">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{label} · event matching</div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-3"><div className="text-2xl font-semibold text-emerald-200">{metrics.tp}</div><div className="mt-1 font-mono text-[8px] uppercase tracking-wider text-slate-500">true positives</div></div>
          <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3"><div className="text-2xl font-semibold text-amber-200">{metrics.fp}</div><div className="mt-1 font-mono text-[8px] uppercase tracking-wider text-slate-500">false positives</div></div>
          <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-3"><div className="text-2xl font-semibold text-rose-200">{metrics.fn}</div><div className="mt-1 font-mono text-[8px] uppercase tracking-wider text-slate-500">false negatives</div></div>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-slate-500">A storm episode is one or more contiguous Kp bins at or above {metrics.thresholdKp}. Matching is one-to-one with a predeclared ±{metrics.matchingToleranceHours} h tolerance.</p>
      </div>
      <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/55 p-4">
        {[
          { label: 'Precision · alarms that happened', value: metrics.precisionPct, ci: metrics.precisionCi95Pct, color: PRECISION_COLOR },
          { label: 'Recall · real storms detected', value: metrics.recallPct, ci: metrics.recallCi95Pct, color: RECALL_COLOR },
          { label: 'False alarm ratio', value: metrics.falseAlarmRatioPct, ci: null, color: '#fbbf24' },
        ].map(row => <div key={row.label}><div className="flex items-end justify-between gap-3"><div><div className="text-[10px] text-slate-300">{row.label}</div><div className="font-mono text-[8px] text-slate-600">{row.ci ? fmtCi(row.ci) : `${metrics.fp} / ${(metrics.tp + metrics.fp).toLocaleString()} forecast episodes`}</div></div><div className="font-mono text-lg font-semibold text-slate-100">{fmtPct(row.value)}</div></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-900"><div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, row.value ?? 0))}%`, backgroundColor: row.color }} /></div></div>)}
      </div>
    </div>
  );
}

function BinConfusion({ metrics }: { metrics: MetricWithCounts }) {
  const total = metrics.tp + metrics.fp + metrics.fn + (metrics.tn ?? 0);
  const cell = (label: string, count: number, style: string, help: string) => <div className={`rounded-xl border p-3 ${style}`}><div className="font-mono text-[8px] uppercase tracking-wider text-slate-500">{label}</div><div className="mt-1 text-xl font-semibold text-slate-100">{count.toLocaleString()}</div><div className="mt-1 text-[9px] text-slate-600">{fmtPct(total ? count / total * 100 : null)} · {help}</div></div>;
  return (
    <div>
      <div className="grid grid-cols-[4.5rem_repeat(2,minmax(0,1fr))] gap-2 text-center">
        <div /><div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">Observed storm</div><div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">Observed quiet</div>
        <div className="flex items-center justify-end pr-2 font-mono text-[8px] uppercase tracking-wider text-slate-600">Forecast storm</div>{cell('TP', metrics.tp, 'border-emerald-400/25 bg-emerald-400/[0.06]', 'correct alert')}{cell('FP', metrics.fp, 'border-amber-400/25 bg-amber-400/[0.06]', 'false alarm')}
        <div className="flex items-center justify-end pr-2 font-mono text-[8px] uppercase tracking-wider text-slate-600">Forecast quiet</div>{cell('FN', metrics.fn, 'border-rose-400/25 bg-rose-400/[0.06]', 'missed bin')}{cell('TN', metrics.tn ?? 0, 'border-slate-700 bg-slate-900/55', 'correct quiet')}
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-slate-500">The apparent {fmtPct(metrics.accuracyPct)} accuracy is dominated by quiet intervals: only {fmtPct(metrics.baseRatePct)} of the held-out bins were G1+. Precision, recall, false alarms and TSS ({metrics.tss?.toFixed(3) ?? '—'}) are the meaningful scores.</p>
    </div>
  );
}

function ThresholdChart({ study }: { study: GeomagneticStudy }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%"><BarChart data={study.results.thresholds} margin={{ top: 8, right: 8, left: -16, bottom: 4 }}><CartesianGrid stroke="#1e293b" vertical={false} /><XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={{ stroke: '#334155' }} tickLine={false} /><YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={value => `${value}%`} /><Tooltip contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name === 'eventPrecisionPct' ? 'Event precision' : 'Event recall']} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="eventPrecisionPct" name="Event precision" fill={PRECISION_COLOR} radius={[3, 3, 0, 0]} /><Bar dataKey="eventRecallPct" name="Event recall" fill={RECALL_COLOR} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer>
    </div>
  );
}

function KpExampleChart({ study }: { study: GeomagneticStudy }) {
  const points = useMemo(() => study.examples.strongestWindow.points.map(point => ({ ...point, label: new Date(point.t).toLocaleString('en-GB', { timeZone: 'UTC', month: 'short', day: '2-digit', hour: '2-digit' }) })), [study]);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-sm font-semibold text-slate-100">{study.examples.strongestWindow.title}</h3><p className="mt-1 text-[10px] text-slate-500">Same predicted-arrival three-hour bins · GFZ peak {study.examples.strongestWindow.peakGfzKp.toFixed(2)} · HelioSat {study.examples.strongestWindow.peakHeliosatKpSameBin.toFixed(2)}</p></div><div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">illustrative held-out episode</div></div>
      <div className="h-72 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{ top: 8, right: 8, left: -18, bottom: 4 }}><CartesianGrid stroke="#1e293b" vertical={false} /><XAxis dataKey="label" minTickGap={45} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={{ stroke: '#334155' }} tickLine={false} /><YAxis domain={[0, 9]} ticks={[0, 3, 5, 7, 9]} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} /><Legend wrapperStyle={{ fontSize: 10 }} /><ReferenceLine y={5} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: 'G1', fill: '#f59e0b', fontSize: 9 }} /><ReferenceLine y={7} stroke="#f87171" strokeDasharray="4 4" label={{ value: 'G3', fill: '#f87171', fontSize: 9 }} /><Line type="monotone" dataKey="gfzKp" name="GFZ definitive" stroke={GFZ_COLOR} strokeWidth={2.5} dot={{ r: 2 }} connectNulls /><Line type="monotone" dataKey="gfzNowcastKp" name="GFZ nowcast" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="2 3" dot={false} connectNulls /><Line type="monotone" dataKey="noaaNextDayKp" name="NOAA next day" stroke="#fbbf24" strokeWidth={1.5} strokeDasharray="7 3" dot={false} connectNulls /><Line type="monotone" dataKey="heliosatKp" name="HelioSat estimate" stroke={HELIOSAT_COLOR} strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls /></LineChart></ResponsiveContainer></div>
    </div>
  );
}

function GLevelMatrix({ matrix }: { matrix: number[][] }) {
  const max = Math.max(1, ...matrix.flat());
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[470px] grid-cols-[4.8rem_repeat(6,minmax(3.2rem,1fr))] gap-1 text-center">
        <div /><div className="col-span-6 pb-1 font-mono text-[8px] uppercase tracking-wider text-slate-600">Forecast G level</div>
        <div />{[0, 1, 2, 3, 4, 5].map(level => <div key={level} className="font-mono text-[9px] text-slate-500">G{level}</div>)}
        {matrix.map((row, observed) => <div key={observed} className="contents"><div className="flex items-center justify-end pr-2 font-mono text-[9px] text-slate-500">Observed G{observed}</div>{row.map((count, predicted) => { const intensity = Math.sqrt(count / max); return <div key={predicted} title={`Observed G${observed}, forecast G${predicted}: ${count} bins`} className={`rounded border px-1 py-3 font-mono text-[10px] ${observed === predicted ? 'border-emerald-400/25 text-emerald-100' : 'border-slate-800 text-slate-300'}`} style={{ backgroundColor: observed === predicted ? `rgba(52,211,153,${0.05 + intensity * 0.25})` : `rgba(251,146,60,${0.03 + intensity * 0.22})` }}>{count.toLocaleString()}</div>; })}</div>)}
      </div>
    </div>
  );
}

function Conclusion({ study }: { study: GeomagneticStudy }) {
  const g1 = study.results.g1Event;
  const regression = study.results.regression;
  return (
    <div className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr]">
      <div className="rounded-xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/[0.08] to-slate-950/30 p-4">
        <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" aria-hidden="true" /><div><h3 className="text-sm font-semibold text-cyan-100">The current model is useful as a short-lead screening signal, not yet as a calibrated operational alarm.</h3><p className="mt-2 text-[11px] leading-relaxed text-slate-300">On held-out 2025–2026 data it detected {g1.tp} of {g1.observedEvents} G1+ storm episodes, with a median {study.leadTime.medianMin.toFixed(0)} minute warning. It also produced {g1.fp} false-alarm episodes and missed {g1.fn}. The positive Kp bias of {regression.biasKp >= 0 ? '+' : ''}{regression.biasKp.toFixed(2)} explains part of the false-alarm burden.</p><p className="mt-2 text-[10px] leading-relaxed text-slate-500">Recommended next model step: calibrate the intensity mapping on development years, emit probabilities for G1+/G3+, choose the decision threshold by operational cost, and preserve immutable issue-time predictions for forward validation.</p></div></div>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-950/55 p-4"><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Before external claims</div><ul className="mt-3 space-y-2 text-[10px] leading-relaxed text-slate-400"><li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" />Freeze this protocol and model version.</li><li className="flex gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />Add a sensitivity run for NOAA&apos;s 1230 UTC update and alternative event tolerances.</li><li className="flex gap-2"><Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden="true" />Continue collecting live forecasts; report retrospective and forward skill separately.</li></ul></div>
    </div>
  );
}

export function GeomagneticStormStudyPanel() {
  const [study, setStudy] = useState<GeomagneticStudy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/console/geomagnetic-study', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const body = await response.json() as { study: GeomagneticStudy | null; error?: string };
      if (!response.ok || !body.study) throw new Error(body.error ?? 'Could not load the geomagnetic-storm study.');
      setStudy(body.study);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the geomagnetic-storm study.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { const timeout = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timeout); }, [load]);

  if (loading && !study) return <div className="flex h-72 items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/35 font-mono text-[10px] uppercase tracking-widest text-slate-500"><Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden="true" />Loading technical report</div>;
  if (!study) return <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5"><div className="flex items-start gap-3"><AlertTriangle className="h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" /><div><h2 className="text-sm font-semibold text-amber-100">Study artifact unavailable</h2><p className="mt-1 text-[11px] text-amber-100/70">{error}</p><button type="button" onClick={() => void load()} className="mt-3 inline-flex items-center gap-2 rounded-md border border-amber-400/30 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-amber-100"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Retry</button></div></div></div>;

  const g1 = study.results.g1Event;
  return (
    <article className="flex flex-col gap-4">
      <section className="overflow-hidden rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-400/[0.08] via-slate-950/50 to-violet-400/[0.05]">
        <div className="border-b border-cyan-400/15 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-mono text-[9px] uppercase tracking-[0.24em] text-cyan-300">Technical validation report · {study.modelVersion}</div><h1 className="mt-2 max-w-4xl text-xl font-semibold text-slate-50">Can HelioSat detect geomagnetic storm episodes before they reach Earth?</h1><p className="mt-2 max-w-5xl text-[11px] leading-relaxed text-slate-300">{study.objective}</p></div><div className="flex flex-wrap gap-2"><span className="rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-emerald-200">held-out 2025–2026</span><span className="rounded border border-slate-700 bg-slate-900/70 px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-slate-400">generated {fmtDate(study.generatedAtUtc)}</span></div></div>
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-4"><FindingCard label="Median warning" value={`${study.leadTime.medianMin.toFixed(0)} min`} detail={`10th–90th percentile: ${study.leadTime.p10Min.toFixed(1)}–${study.leadTime.p90Min.toFixed(1)} min.`} tone="cyan" /><FindingCard label="G1+ event recall" value={fmtPct(g1.recallPct)} detail={`${g1.tp} detected, ${g1.fn} missed · ${fmtCi(g1.recallCi95Pct)}.`} tone="emerald" /><FindingCard label="G1+ event precision" value={fmtPct(g1.precisionPct)} detail={`${g1.tp} correct alarms, ${g1.fp} false alarms · ${fmtCi(g1.precisionCi95Pct)}.`} tone="violet" /><FindingCard label="Kp bias" value={`${study.results.regression.biasKp >= 0 ? '+' : ''}${study.results.regression.biasKp.toFixed(2)}`} detail={`HelioSat tends to overestimate severity; MAE ${study.results.regression.maeKp.toFixed(2)} Kp.`} tone="amber" /></div>
      </section>

      <ReportSection eyebrow="01 · Objective and protocol" title="A causal replay, scored only on later unseen time" description="The forecast is reconstructed using only measurements available when the parcel was at L1. The headline result uses 2025 through April 2026; 2021–2024 is treated as the development/reference period."><StudyFlow study={study} /><div className="mt-3 grid gap-2 md:grid-cols-2"><div className="rounded-xl border border-slate-800 bg-slate-950/55 p-3"><div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">Development/reference</div><div className="mt-1 text-sm font-semibold text-slate-100">{fmtDate(study.scope.developmentStartUtc)} → {fmtDate(study.scope.developmentStopUtc)}</div><div className="mt-1 text-[10px] text-slate-500">{study.scope.developmentBins.toLocaleString()} valid 3 h bins · not part of the headline score</div></div><div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-3"><div className="font-mono text-[8px] uppercase tracking-wider text-emerald-300/70">Held-out evaluation</div><div className="mt-1 text-sm font-semibold text-slate-100">{fmtDate(study.scope.evaluationStartUtc)} → {fmtDate(study.scope.evaluationStopUtc)}</div><div className="mt-1 text-[10px] text-slate-500">{study.scope.evaluationBins.toLocaleString()} valid 3 h bins · all results below</div></div></div></ReportSection>

      <ReportSection eyebrow="02 · Data lineage" title="What data is used at each stage" description="The upstream record builds the forecast; the independent ground-response index supplies the target. Each source has a single declared role."><div className="grid gap-3 lg:grid-cols-2"><div className="rounded-xl border border-sky-400/20 bg-sky-400/[0.05] p-4"><div className="flex items-start justify-between"><div><div className="font-mono text-[8px] uppercase tracking-wider text-sky-300">Forecast input</div><h3 className="mt-1 text-sm font-semibold text-slate-100">{study.data.upstream.dataset}</h3></div><Radar className="h-5 w-5 text-sky-300" aria-hidden="true" /></div><p className="mt-3 text-[10px] leading-relaxed text-slate-400">{study.data.upstream.role}</p><div className="mt-3 font-mono text-[9px] text-slate-500">{study.data.upstream.validRows.toLocaleString()} valid rows · {study.data.upstream.files.length} checksum-pinned yearly files</div><p className="mt-2 text-[9px] leading-relaxed text-amber-200/70">Caveat: {study.data.upstream.caveat}</p></div><div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4"><div className="flex items-start justify-between"><div><div className="font-mono text-[8px] uppercase tracking-wider text-emerald-300">Validation truth</div><h3 className="mt-1 text-sm font-semibold text-slate-100">{study.data.truth.dataset}</h3></div><Database className="h-5 w-5 text-emerald-300" aria-hidden="true" /></div><p className="mt-3 text-[10px] leading-relaxed text-slate-400">Planetary response derived from the official ground-magnetometer network. Only rows marked definitive are accepted.</p><div className="mt-3 font-mono text-[9px] text-slate-500">{study.data.truth.rows.toLocaleString()} source bins · {study.data.truth.license}</div><a href={study.data.truth.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[9px] text-emerald-300/80 hover:text-emerald-200">Open exact GFZ query <ExternalLink className="h-3 w-3" aria-hidden="true" /></a></div></div><div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/55 p-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{Object.entries(study.method).map(([key, value]) => <div key={key}><div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">{key.replace(/([A-Z])/g, ' $1')}</div><p className="mt-1 text-[10px] leading-relaxed text-slate-400">{value}</p></div>)}</div></div></ReportSection>

      <div className="-mt-2 px-2 text-[9px] text-slate-600">Upstream definition: <a href={study.data.upstream.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300/80 hover:text-sky-200">NASA/SPDF High Resolution OMNI documentation <ExternalLink className="h-3 w-3" aria-hidden="true" /></a></div>

      <ReportSection eyebrow="03 · Kp products" title="Forecast, nowcast and definitive Kp are different products" description="This comparison prevents a common category error: availability after an interval is not forecast lead. NOAA issued forecasts, archived GFZ nowcast values and HelioSat are all evaluated against the same GFZ definitive target."><KpSourceComparison study={study} /><BenchmarkComparison study={study} /></ReportSection>

      <ReportSection eyebrow="04 · Headline result" title="G1+ storm episodes: what was detected, falsely alerted and missed" description={`Primary event-level result on ${g1.observedEvents} observed G1+ episodes. This is the clearest answer to the investor question; the confidence intervals show the sampling uncertainty.`}><EventScore metrics={g1} label="G1+" /><div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/55 p-4"><div className="mb-3"><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Secondary diagnostic · every 3 h bin</div><p className="mt-1 text-[10px] text-slate-500">Useful for calibration and continuous monitoring, but consecutive bins are not independent storm events.</p></div><BinConfusion metrics={study.results.g1Bin} /></div></ReportSection>

      <ReportSection eyebrow="05 · Sensitivity and severity" title="Performance changes with the alert threshold" description="Precision and recall move differently as the minimum storm level rises. Severe-event results use much smaller samples and must be interpreted cautiously."><div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]"><div className="rounded-xl border border-slate-800 bg-slate-950/55 p-3"><ThresholdChart study={study} /></div><div className="rounded-xl border border-slate-800 bg-slate-950/55 p-4"><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Continuous Kp estimate</div><div className="mt-4 grid grid-cols-2 gap-2"><FindingCard label="MAE" value={study.results.regression.maeKp.toFixed(2)} detail="Mean absolute Kp error per 3 h bin." /><FindingCard label="Correlation" value={study.results.regression.correlation.toFixed(3)} detail="Tracks the overall rise and fall of Kp." tone="emerald" /><FindingCard label="G exact" value={fmtPct(study.results.regression.exactGLevelPct)} detail="Inflated by the large number of G0 bins." tone="violet" /><FindingCard label="G3+ recall" value={fmtPct(study.results.g3Event.recallPct)} detail={`${study.results.g3Event.tp}/${study.results.g3Event.observedEvents} severe episodes; ${fmtCi(study.results.g3Event.recallCi95Pct)}.`} tone="amber" /></div></div></div><div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/55 p-4"><div className="mb-3"><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Ordinal confusion · all held-out bins</div><p className="mt-1 text-[10px] text-slate-500">Rows are observed G level; columns are HelioSat. The diagonal is correct classification.</p></div><GLevelMatrix matrix={study.results.confusionG} /></div></ReportSection>

      <ReportSection eyebrow="06 · Worked result" title="How NOAA, GFZ and HelioSat compare during a strong held-out episode" description="The next-day NOAA forecast, short-lead HelioSat estimate, GFZ provisional nowcast and GFZ definitive value are aligned to the same three-hour bins. The episode is illustrative; aggregate metrics use the full held-out set."><KpExampleChart study={study} /></ReportSection>

      <ReportSection eyebrow="07 · Interpretation" title="Conclusion and what remains before an external performance claim"><Conclusion study={study} /><div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4"><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden="true" /><h3 className="text-xs font-semibold uppercase tracking-wider text-amber-100">Study limitations</h3></div><ul className="mt-3 grid gap-2 text-[10px] leading-relaxed text-slate-400 lg:grid-cols-2">{study.limitations.map(limitation => <li key={limitation} className="flex gap-2"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/70" />{limitation}</li>)}</ul></div></ReportSection>

      <footer className="flex flex-wrap items-center justify-between gap-2 px-1 font-mono text-[8px] uppercase tracking-wider text-slate-700"><span>{study.schemaVersion} · {study.modelVersion}</span><span>{study.results.regression.n.toLocaleString()} scored bins · generated {study.generatedAtUtc}</span></footer>
    </article>
  );
}
