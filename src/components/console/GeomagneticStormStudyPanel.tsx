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
  FlaskConical,
  Gauge,
  Loader2,
  Radar,
  RefreshCw,
  ShieldCheck,
  Target,
  Waves,
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

interface BinaryMetric {
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

interface RegressionMetric {
  n: number;
  maeKp: number;
  rmseKp: number;
  biasKp: number;
  correlation: number;
  exactGLevelPct: number;
  withinOneGLevelPct: number;
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
    inputCadenceMinutes: number;
    minimumForecastRowsPerBin: number;
    evaluationWindowSensitivity: Array<{ startUtc: string; eligibleBins: number; g3Bins: number; g3Events: number; eligibleAsFinalTest: boolean }>;
  };
  resolution: { input: string; target: string; independence: string; higherCadenceOption: string; incumbentLimitation: string };
  data: {
    upstream: { provider: string; dataset: string; url: string; role: string; validRows: number; caveat: string; files: Array<{ file: string; sha256: string; bytes: number }> };
    truth: { provider: string; dataset: string; url: string; license: string; rows: number };
    build: { rawRows: number; eligibleBins: number; inputCadenceMinutes: number; targetCadenceHours: number; features: number };
  };
  method: Record<string, string>;
  training: {
    rawFiveMinuteRows: number;
    developmentBins: number;
    developmentG1Bins: number;
    developmentG1Events: number;
    developmentG3Bins: number;
    developmentG3Events: number;
    featureCount: number;
    g1ProbabilityThreshold: number;
    g3ProbabilityThreshold: number;
    g1FeatureImportance: Array<{ feature: string; gainPct: number }>;
    g3FeatureImportance: Array<{ feature: string; gainPct: number }>;
    g1Selection: ModelSelection;
    g3Selection: ModelSelection;
  };
  leadTime: { medianMin: number; p10Min: number; p90Min: number; samples: number };
  kpSources: Array<{ id: string; name: string; kind: string; producer: string; cadence: string; timing: string; role: string; scoredHere: boolean; reason: string; url: string | null }>;
  results: {
    regression: RegressionMetric;
    g1Bin: BinaryMetric;
    g1Event: BinaryMetric;
    g3Bin: BinaryMetric;
    g3Event: BinaryMetric;
    confusionG: number[][];
    yearly: Array<{ year: number; bins: number; g1ObservedEvents: number; g1PrecisionPct: number | null; g1RecallPct: number | null; g3ObservedEvents: number; g3PrecisionPct: number | null; g3RecallPct: number | null; g1BinCsiPct: number | null; g3BinCsiPct: number | null }>;
    baseline: { name: string; regression: RegressionMetric; g1Bin: BinaryMetric; g1Event: BinaryMetric; g3Bin: BinaryMetric; g3Event: BinaryMetric };
  };
  examples: {
    strongestWindow: {
      title: string;
      peakGfzKp: number;
      peakHeliosatKpSameBin: number;
      points: Array<{ t: number; gfzKp: number; heliosatKp: number; heuristicKp: number; g1ProbabilityPct: number; g3ProbabilityPct: number }>;
    };
  };
  limitations: string[];
}

interface ModelSelection {
  params: { id: string; num_leaves: number; min_child_samples: number; positive_weight: number };
  candidates: Array<{ id: string; threshold: number; oofBins: number; oofEvents: BinaryMetric }>;
}

const COLORS = { model: '#22d3ee', truth: '#34d399', baseline: '#64748b', precision: '#a78bfa', recall: '#22d3ee', severe: '#fb7185' };

function pct(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`;
}

function date(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : value;
}

function ci(value: number[] | null) {
  return value?.length === 2 ? `IC 95% ${value[0].toFixed(1)}–${value[1].toFixed(1)}%` : 'IC 95% no disponible';
}

function labelFeature(value: string) {
  return value.replace(/_/g, ' ').replace(/\bmean\b/g, 'media').replace(/\bmax\b/g, 'máx.').replace(/\blag1\b/g, 'retardo 3 h').replace(/\blag2\b/g, 'retardo 6 h');
}

function Section({ index, title, description, children }: { index: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4 sm:p-5">
      <div className="mb-4">
        <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-cyan-300">{index}</div>
        <h2 className="mt-1 text-base font-semibold text-slate-100">{title}</h2>
        {description && <p className="mt-1 max-w-5xl text-[11px] leading-relaxed text-slate-400">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, detail, tone = 'cyan' }: { label: string; value: string; detail: string; tone?: 'cyan' | 'emerald' | 'violet' | 'rose' | 'amber' }) {
  const tones = {
    cyan: 'border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-100',
    emerald: 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-100',
    violet: 'border-violet-400/20 bg-violet-400/[0.06] text-violet-100',
    rose: 'border-rose-400/20 bg-rose-400/[0.06] text-rose-100',
    amber: 'border-amber-400/20 bg-amber-400/[0.06] text-amber-100',
  } as const;
  return <div className={`rounded-xl border p-3 ${tones[tone]}`}><div className="font-mono text-[8px] uppercase tracking-[0.18em] text-slate-500">{label}</div><div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div><p className="mt-2 text-[10px] leading-relaxed text-slate-500">{detail}</p></div>;
}

function CadenceFlow({ study }: { study: GeomagneticStudy }) {
  const items = [
    { icon: Radar, label: 'Entrada observada', value: '5 min', detail: `${study.data.upstream.validRows.toLocaleString('es-ES')} filas OMNI válidas`, tone: 'text-sky-300' },
    { icon: Waves, label: 'Variables físicas', value: `${study.training.featureCount}`, detail: 'IMF, plasma, acoplamientos y memoria causal', tone: 'text-cyan-300' },
    { icon: FlaskConical, label: 'Modelos', value: 'G1 / G3 / Kp', detail: 'Clasificadores de probabilidad + regresor', tone: 'text-violet-300' },
    { icon: Target, label: 'Verdad oficial', value: '3 h', detail: 'Kp planetario definitivo de GFZ', tone: 'text-emerald-300' },
  ];
  return <div className="grid gap-2 xl:grid-cols-4">{items.map((item, index) => { const Icon = item.icon; return <article key={item.label} className="relative rounded-xl border border-slate-800 bg-slate-950/60 p-4"><div className="flex items-start justify-between"><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">{item.label}</div><Icon className={`h-5 w-5 ${item.tone}`} aria-hidden="true" /></div><div className="mt-4 text-xl font-semibold text-slate-100">{item.value}</div><p className="mt-2 text-[10px] leading-relaxed text-slate-500">{item.detail}</p>{index < items.length - 1 && <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 rounded-full bg-slate-950 text-slate-600 xl:block" aria-hidden="true" />}</article>; })}</div>;
}

function WindowSensitivity({ study }: { study: GeomagneticStudy }) {
  const rows = study.scope.evaluationWindowSensitivity;
  const maxEvents = Math.max(1, ...rows.map(row => row.g3Events));
  const finalEvents = rows.find(row => row.eligibleAsFinalTest)?.g3Events ?? study.results.g3Event.observedEvents ?? 0;
  return <div className="rounded-xl border border-slate-800 bg-slate-950/55 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Sensibilidad del corte temporal</div><h3 className="mt-1 text-xs font-semibold text-slate-200">¿Cuántos eventos G3+ ganaríamos moviendo el inicio hacia atrás?</h3></div><span className="rounded border border-cyan-400/20 bg-cyan-400/[0.05] px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-cyan-200">solo tamaño de muestra · no re-score</span></div><div className="mt-4 space-y-2">{rows.map(row => <div key={row.startUtc} className="grid grid-cols-[52px_1fr_70px] items-center gap-3"><div className="font-mono text-[9px] text-slate-400">{date(row.startUtc).slice(0, 4)}+</div><div className="h-2 overflow-hidden rounded-full bg-slate-900"><div className={`h-full rounded-full ${row.eligibleAsFinalTest ? 'bg-cyan-400' : 'bg-slate-600'}`} style={{ width: `${100 * row.g3Events / maxEvents}%` }} /></div><div className="text-right font-mono text-[9px] text-slate-300">{row.g3Events} eventos</div></div>)}</div><p className="mt-4 text-[10px] leading-relaxed text-slate-500">Empezar en 2021 solo añadiría {rows[0].g3Events - finalEvents} episodios G3+ frente a 2024. No compensa rebautizar años ya usados en selección como “test final”; se muestran como validación histórica separada.</p></div>;
}

function ProductTable({ sources }: { sources: GeomagneticStudy['kpSources'] }) {
  return <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[920px] border-collapse text-left text-[10px]"><thead className="bg-slate-950/85 font-mono uppercase tracking-wider text-slate-600"><tr><th className="px-3 py-2 font-medium">Producto</th><th className="px-3 py-2 font-medium">Tipo</th><th className="px-3 py-2 font-medium">Resolución</th><th className="px-3 py-2 font-medium">Antelación / disponibilidad</th><th className="px-3 py-2 font-medium">Papel en este estudio</th></tr></thead><tbody>{sources.map(source => <tr key={source.id} className={`border-t border-slate-800/80 ${source.id === 'heliosat' ? 'bg-cyan-400/[0.04]' : ''}`}><td className="px-3 py-3"><div className="font-medium text-slate-200">{source.url ? <a className="inline-flex items-center gap-1 hover:text-cyan-200" href={source.url} target="_blank" rel="noreferrer">{source.name}<ExternalLink className="h-3 w-3" aria-hidden="true" /></a> : source.name}</div><div className="mt-0.5 text-slate-600">{source.producer}</div></td><td className="px-3 py-3 text-slate-400">{source.kind}</td><td className="px-3 py-3 font-mono text-slate-400">{source.cadence}</td><td className="max-w-64 px-3 py-3 text-slate-400">{source.timing}</td><td className="max-w-72 px-3 py-3"><div className={source.scoredHere ? 'text-emerald-300' : 'text-slate-400'}>{source.scoredHere ? 'Sí' : 'No'} · {source.role}</div><div className="mt-1 text-[9px] leading-relaxed text-slate-600">{source.reason}</div></td></tr>)}</tbody></table></div>;
}

function ImprovementChart({ study }: { study: GeomagneticStudy }) {
  const rows = [
    { metric: 'G1 precisión', anterior: study.results.baseline.g1Event.precisionPct, entrenado: study.results.g1Event.precisionPct },
    { metric: 'G1 recall', anterior: study.results.baseline.g1Event.recallPct, entrenado: study.results.g1Event.recallPct },
    { metric: 'G1 CSI', anterior: study.results.baseline.g1Event.csiPct, entrenado: study.results.g1Event.csiPct },
    { metric: 'G3 precisión', anterior: study.results.baseline.g3Event.precisionPct, entrenado: study.results.g3Event.precisionPct },
    { metric: 'G3 recall', anterior: study.results.baseline.g3Event.recallPct, entrenado: study.results.g3Event.recallPct },
    { metric: 'G3 CSI', anterior: study.results.baseline.g3Event.csiPct, entrenado: study.results.g3Event.csiPct },
  ];
  return <div className="h-80 w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={rows} layout="vertical" margin={{ top: 6, right: 16, left: 16, bottom: 4 }}><CartesianGrid stroke="#1e293b" horizontal={false} /><XAxis type="number" domain={[0, 100]} tickFormatter={value => `${value}%`} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={{ stroke: '#334155' }} tickLine={false} /><YAxis type="category" dataKey="metric" width={82} tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} formatter={value => `${Number(value ?? 0).toFixed(1)}%`} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="anterior" name="Heurística anterior" fill={COLORS.baseline} radius={[0, 3, 3, 0]} /><Bar dataKey="entrenado" name="Modelo entrenado" fill={COLORS.model} radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>;
}

function EventScore({ title, metric, baseline, accent }: { title: string; metric: BinaryMetric; baseline: BinaryMetric; accent: 'cyan' | 'rose' }) {
  const cells = [
    { label: 'Aciertos', value: metric.tp, detail: 'Alerta y evento observado', className: 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' },
    { label: 'Falsos positivos', value: metric.fp, detail: 'Alerta sin evento emparejado', className: 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' },
    { label: 'Falsos negativos', value: metric.fn, detail: 'Evento observado no detectado', className: 'border-rose-400/20 bg-rose-400/[0.06] text-rose-200' },
  ];
  return <article className={`rounded-xl border p-4 ${accent === 'rose' ? 'border-rose-400/25 bg-rose-400/[0.035]' : 'border-cyan-400/20 bg-cyan-400/[0.03]'}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><div className={`font-mono text-[9px] uppercase tracking-widest ${accent === 'rose' ? 'text-rose-300' : 'text-cyan-300'}`}>{title}</div><h3 className="mt-1 text-sm font-semibold text-slate-100">{metric.observedEvents} eventos independientes observados</h3></div><div className="text-right"><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">Umbral congelado</div><div className="mt-1 text-sm text-slate-300">Kp ≥ {metric.thresholdKp}</div></div></div><div className="mt-4 grid grid-cols-3 gap-2">{cells.map(cell => <div key={cell.label} className={`rounded-lg border p-3 ${cell.className}`}><div className="font-mono text-[8px] uppercase tracking-wider text-slate-500">{cell.label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{cell.value}</div><div className="mt-1 text-[8px] text-slate-600">{cell.detail}</div></div>)}</div><div className="mt-3 grid gap-2 sm:grid-cols-3"><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[9px] text-slate-500">Precisión</div><div className="mt-1 text-lg font-semibold text-violet-200">{pct(metric.precisionPct)}</div><div className="text-[8px] text-slate-600">{ci(metric.precisionCi95Pct)}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[9px] text-slate-500">Recall / detección</div><div className="mt-1 text-lg font-semibold text-cyan-200">{pct(metric.recallPct)}</div><div className="text-[8px] text-slate-600">{ci(metric.recallCi95Pct)}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[9px] text-slate-500">CSI</div><div className="mt-1 text-lg font-semibold text-emerald-200">{pct(metric.csiPct)}</div><div className="text-[8px] text-slate-600">Antes: {pct(baseline.csiPct)}</div></div></div></article>;
}

function FeatureChart({ study }: { study: GeomagneticStudy }) {
  const data = study.training.g3FeatureImportance.slice(0, 10).map(item => ({ ...item, label: labelFeature(item.feature) })).reverse();
  return <div className="h-72 w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 20, bottom: 4 }}><CartesianGrid stroke="#1e293b" horizontal={false} /><XAxis type="number" tickFormatter={value => `${value}%`} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={{ stroke: '#334155' }} tickLine={false} /><YAxis type="category" dataKey="label" width={108} tick={{ fill: '#94a3b8', fontSize: 8 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} formatter={value => [`${Number(value ?? 0).toFixed(1)}%`, 'Ganancia relativa']} /><Bar dataKey="gainPct" fill={COLORS.severe} radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>;
}

function YearChart({ study }: { study: GeomagneticStudy }) {
  return <div className="h-72 w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={study.results.yearly} margin={{ top: 8, right: 14, left: -10, bottom: 4 }}><CartesianGrid stroke="#1e293b" vertical={false} /><XAxis dataKey="year" tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={{ stroke: '#334155' }} tickLine={false} /><YAxis domain={[0, 100]} tickFormatter={value => `${value}%`} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} formatter={(value, name) => [`${Number(value ?? 0).toFixed(1)}%`, name]} labelFormatter={(_, payload) => payload?.[0]?.payload ? `${payload[0].payload.year} · ${payload[0].payload.g3ObservedEvents} eventos G3+` : ''} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="g3PrecisionPct" name="Precisión G3+" fill={COLORS.precision} radius={[3, 3, 0, 0]} /><Bar dataKey="g3RecallPct" name="Recall G3+" fill={COLORS.severe} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></div>;
}

function EpisodeChart({ study }: { study: GeomagneticStudy }) {
  const data = useMemo(() => study.examples.strongestWindow.points.map(point => ({ ...point, label: new Date(point.t).toLocaleDateString('es-ES', { month: 'short', day: '2-digit', timeZone: 'UTC' }) })), [study]);
  return <div><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{study.examples.strongestWindow.title}</div><p className="mt-1 text-[10px] text-slate-500">Pico definitivo {study.examples.strongestWindow.peakGfzKp.toFixed(1)} · candidato {study.examples.strongestWindow.peakHeliosatKpSameBin.toFixed(2)}</p></div><div className="rounded border border-rose-400/20 bg-rose-400/[0.06] px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-rose-200">held-out · no visto al entrenar</div></div><div className="h-80 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 8, right: 12, left: -14, bottom: 4 }}><CartesianGrid stroke="#1e293b" vertical={false} /><XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={value => new Date(value).toLocaleDateString('es-ES', { month: 'short', day: '2-digit', timeZone: 'UTC' })} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={{ stroke: '#334155' }} tickLine={false} /><YAxis domain={[0, 9]} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} labelFormatter={value => new Date(Number(value)).toLocaleString('es-ES', { timeZone: 'UTC' })} formatter={(value, name) => [Number(value ?? 0).toFixed(2), name]} /><Legend wrapperStyle={{ fontSize: 10 }} /><ReferenceLine y={7} stroke="#fb7185" strokeDasharray="4 4" label={{ value: 'G3', fill: '#fb7185', fontSize: 9 }} /><Line type="monotone" dataKey="gfzKp" name="GFZ definitivo" stroke={COLORS.truth} strokeWidth={2.4} dot={false} connectNulls={false} /><Line type="monotone" dataKey="heliosatKp" name="HelioSat entrenado" stroke={COLORS.model} strokeWidth={2.2} dot={false} connectNulls={false} /><Line type="monotone" dataKey="heuristicKp" name="Heurística anterior" stroke={COLORS.baseline} strokeWidth={1.4} strokeDasharray="4 3" dot={false} connectNulls={false} /></LineChart></ResponsiveContainer></div></div>;
}

function GMatrix({ matrix }: { matrix: number[][] }) {
  const max = Math.max(1, ...matrix.flat());
  return <div className="inline-grid grid-cols-7 gap-1 text-center font-mono text-[8px]"><div /><div className="py-1 text-slate-600">G0</div>{[1, 2, 3, 4, 5].map(level => <div key={level} className="py-1 text-slate-600">G{level}</div>)}{matrix.map((row, observed) => <div key={observed} className="contents"><div className="flex items-center justify-end pr-1 text-slate-600">G{observed}</div>{row.map((count, predicted) => { const intensity = Math.sqrt(count / max); return <div key={`${observed}-${predicted}`} className={`min-w-10 rounded border px-2 py-2 ${observed === predicted ? 'border-emerald-400/20 text-emerald-100' : 'border-orange-400/10 text-slate-400'}`} style={{ backgroundColor: observed === predicted ? `rgba(52,211,153,${0.04 + intensity * 0.24})` : `rgba(251,146,60,${0.02 + intensity * 0.22})` }}>{count}</div>; })}</div>)}</div>;
}

function ModelSelectionTable({ study }: { study: GeomagneticStudy }) {
  const selected = study.training.g3Selection.params.id;
  return <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[620px] border-collapse text-left text-[10px]"><thead className="bg-slate-950/85 font-mono uppercase tracking-wider text-slate-600"><tr><th className="px-3 py-2 font-medium">Candidato G3</th><th className="px-3 py-2 text-right font-medium">Umbral</th><th className="px-3 py-2 text-right font-medium">Eventos OOF</th><th className="px-3 py-2 text-right font-medium">Precisión</th><th className="px-3 py-2 text-right font-medium">Recall</th><th className="px-3 py-2 text-right font-medium">CSI</th></tr></thead><tbody>{study.training.g3Selection.candidates.map(candidate => <tr key={candidate.id} className={`border-t border-slate-800/80 ${candidate.id === selected ? 'bg-cyan-400/[0.05]' : ''}`}><td className="px-3 py-2 text-slate-300">{candidate.id === selected && <FileCheck2 className="mr-1 inline h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />}{candidate.id}</td><td className="px-3 py-2 text-right font-mono text-slate-400">{candidate.threshold.toFixed(2)}</td><td className="px-3 py-2 text-right font-mono text-slate-400">{candidate.oofEvents.observedEvents}</td><td className="px-3 py-2 text-right font-mono text-violet-200">{pct(candidate.oofEvents.precisionPct)}</td><td className="px-3 py-2 text-right font-mono text-cyan-200">{pct(candidate.oofEvents.recallPct)}</td><td className="px-3 py-2 text-right font-mono text-emerald-200">{pct(candidate.oofEvents.csiPct)}</td></tr>)}</tbody></table></div>;
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
      if (!response.ok || !body.study) throw new Error(body.error ?? 'No se pudo cargar el estudio geomagnético.');
      setStudy(body.study);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudo cargar el estudio geomagnético.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  if (loading && !study) return <div className="flex h-72 items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/35 font-mono text-[10px] uppercase tracking-widest text-slate-500"><Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden="true" />Cargando informe técnico</div>;
  if (!study) return <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5"><div className="flex items-start gap-3"><AlertTriangle className="h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" /><div><h2 className="text-sm font-semibold text-amber-100">Informe no disponible</h2><p className="mt-1 text-[11px] text-amber-100/70">{error}</p><button type="button" onClick={() => void load()} className="mt-3 inline-flex items-center gap-2 rounded-md border border-amber-400/30 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-amber-100"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Reintentar</button></div></div></div>;

  const g3 = study.results.g3Event;
  const oldG3 = study.results.baseline.g3Event;
  const selectedG3Oof = study.training.g3Selection.candidates.find(candidate => candidate.id === study.training.g3Selection.params.id)?.oofEvents;
  const totalChronologicalG3 = (selectedG3Oof?.observedEvents ?? 0) + (g3.observedEvents ?? 0);
  const g3RecallGain = (g3.recallPct ?? 0) - (oldG3.recallPct ?? 0);
  const g3CsiGain = (g3.csiPct ?? 0) - (oldG3.csiPct ?? 0);

  return <article className="flex flex-col gap-4">
    <section className="overflow-hidden rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-400/[0.08] via-slate-950/55 to-rose-400/[0.05]">
      <div className="border-b border-cyan-400/15 p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-mono text-[9px] uppercase tracking-[0.24em] text-cyan-300">Informe técnico · {study.modelVersion}</div><h1 className="mt-2 max-w-4xl text-xl font-semibold text-slate-50">Pronóstico de tormentas geomagnéticas: reentrenamiento y validación G3+</h1><p className="mt-2 max-w-5xl text-[11px] leading-relaxed text-slate-300">{study.objective}</p></div><div className="flex flex-wrap gap-2"><span className="rounded border border-rose-400/30 bg-rose-400/10 px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-rose-200">held-out desde 2024</span><span className="rounded border border-amber-400/25 bg-amber-400/[0.07] px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-amber-200">candidato · no live</span></div></div></div>
      <div className="grid gap-2 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-5"><Stat label="Histórico de entrada" value="31.3 años" detail={`${study.training.rawFiveMinuteRows.toLocaleString('es-ES')} observaciones válidas de 5 min.`} /><Stat label="Evidencia temporal G3+" value={`${totalChronologicalG3} eventos`} detail={`${selectedG3Oof?.observedEvents ?? 0} en validación cronológica + ${g3.observedEvents ?? 0} en test final; no se mezclan los scores.`} tone="violet" /><Stat label="Eventos G3+ held-out" value={String(g3.observedEvents ?? 0)} detail="Desde 2024; nunca usados para elegir modelo o umbral." tone="rose" /><Stat label="Precisión G3+" value={pct(g3.precisionPct)} detail={`${g3.tp} aciertos y ${g3.fp} falsas alarmas · ${ci(g3.precisionCi95Pct)}.`} tone="emerald" /><Stat label="Recall G3+" value={pct(g3.recallPct)} detail={`${g3.tp} detectados y ${g3.fn} perdidos · +${g3RecallGain.toFixed(1)} pp frente a antes.`} tone="amber" /></div>
    </section>

    <Section index="01 · Qué hacemos y por qué" title="Convertir medidas de viento solar en una alerta probabilística antes de la respuesta terrestre" description="El sistema observa el plasma y el campo magnético en L1, estima su llegada a la Tierra y predice tanto Kp continuo como la probabilidad de superar G1 y G3. La métrica principal se calcula por episodios de tormenta, que es la unidad relevante para un cliente que decide si activar una operación.">
      <CadenceFlow study={study} />
      <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.055] p-4"><div className="flex gap-3"><Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" /><div><div className="font-mono text-[8px] uppercase tracking-widest text-amber-300/70">Limitación estructural del incumbente Kp</div><h3 className="mt-1 text-xs font-semibold text-amber-100">La verdad oficial agrega tres horas completas aunque los inputs lleguen cada cinco minutos</h3><p className="mt-1 text-[10px] leading-relaxed text-slate-400">{study.resolution.incumbentLimitation} {study.resolution.independence} Los datos de 5 minutos sí mejoran las variables, pero no pueden crear una etiqueta Kp por minuto.</p><p className="mt-2 text-[10px] leading-relaxed text-slate-500"><span className="text-slate-300">Roadmap recomendado:</span> conservar Kp/G3 para compatibilidad comercial y añadir en paralelo GFZ Hp30 como objetivo de 30 minutos para evaluar onset, duración y picos con mayor precisión.</p></div></div></div>
    </Section>

    <Section index="02 · Datos y separación temporal" title="Más historia para aprender; 2024+ permanece completamente fuera del entrenamiento" description="La ampliación no mezcla pasado y futuro. Los hiperparámetros y umbrales se eligen con validación cronológica expandible hasta 2023; solo después se abre el periodo held-out de 2024–abril de 2026.">
      <div className="grid gap-3 lg:grid-cols-2"><div className="rounded-xl border border-sky-400/20 bg-sky-400/[0.05] p-4"><div className="flex items-start justify-between"><div><div className="font-mono text-[8px] uppercase tracking-wider text-sky-300">Entrada del pronóstico</div><h3 className="mt-1 text-sm font-semibold text-slate-100">{study.data.upstream.dataset}</h3></div><Radar className="h-5 w-5 text-sky-300" aria-hidden="true" /></div><p className="mt-3 text-[10px] leading-relaxed text-slate-400">{study.data.upstream.role}</p><div className="mt-3 font-mono text-[9px] text-slate-500">{study.data.upstream.validRows.toLocaleString('es-ES')} filas · {study.data.upstream.files.length} ficheros anuales con SHA-256</div><a href={study.data.upstream.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[9px] text-sky-300/80 hover:text-sky-200">Documentación NASA/SPDF <ExternalLink className="h-3 w-3" aria-hidden="true" /></a></div><div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4"><div className="flex items-start justify-between"><div><div className="font-mono text-[8px] uppercase tracking-wider text-emerald-300">Verdad de validación</div><h3 className="mt-1 text-sm font-semibold text-slate-100">{study.data.truth.dataset}</h3></div><Database className="h-5 w-5 text-emerald-300" aria-hidden="true" /></div><p className="mt-3 text-[10px] leading-relaxed text-slate-400">Respuesta planetaria calculada por GFZ a partir de observatorios geomagnéticos terrestres. Solo se admiten valores definitivos.</p><div className="mt-3 font-mono text-[9px] text-slate-500">{study.data.truth.rows.toLocaleString('es-ES')} intervalos fuente · {study.data.truth.license}</div><a href={study.data.truth.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[9px] text-emerald-300/80 hover:text-emerald-200">Abrir consulta GFZ exacta <ExternalLink className="h-3 w-3" aria-hidden="true" /></a></div></div>
      <div className="mt-3 grid gap-2 md:grid-cols-2"><div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"><div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">Desarrollo · cerrado antes de 2024</div><div className="mt-1 text-sm font-semibold text-slate-100">{date(study.scope.developmentStartUtc)} → 2023-12-31</div><div className="mt-2 text-[10px] text-slate-500">{study.scope.developmentBins.toLocaleString('es-ES')} bins · {study.training.developmentG1Events} eventos G1+ · {study.training.developmentG3Events} eventos G3+</div></div><div className="rounded-xl border border-rose-400/20 bg-rose-400/[0.05] p-4"><div className="font-mono text-[8px] uppercase tracking-wider text-rose-300/80">Evaluación held-out · una sola apertura</div><div className="mt-1 text-sm font-semibold text-slate-100">{date(study.scope.evaluationStartUtc)} → 2026-04-30</div><div className="mt-2 text-[10px] text-slate-500">{study.scope.evaluationBins.toLocaleString('es-ES')} bins · {study.results.g1Event.observedEvents} eventos G1+ · {study.results.g3Event.observedEvents} eventos G3+</div></div></div>
      <div className="mt-3"><WindowSensitivity study={study} /></div>
      <div className="mt-3 rounded-xl border border-amber-400/15 bg-amber-400/[0.035] p-3 text-[9px] leading-relaxed text-amber-100/65">Limitación de causalidad: {study.data.upstream.caveat} Por eso este resultado es retrospectivo y debe confirmarse con predicciones live inmutables.</div>
    </Section>

    <Section index="03 · Productos Kp" title="NOAA forecast, NOAA estimated, GFZ nowcast, GFZ definitive y HelioSat no significan lo mismo" description="La comparación de productos separa pronóstico, nowcast y verdad final. No atribuimos antelación a una estimación publicada cuando la respuesta terrestre ya está ocurriendo."><ProductTable sources={study.kpSources} /><p className="mt-3 text-[9px] leading-relaxed text-slate-600">Esta versión ampliada puntúa el candidato HelioSat contra GFZ definitivo. La comparación numérica con NOAA debe repetirse sobre un archivo de emisiones NOAA congelado, en exactamente los mismos bins de 2024+, sin confundirlo con NOAA estimated Kp ni con GFZ nowcast.</p></Section>

    <Section index="04 · Resultado frente al sistema anterior" title="El entrenamiento mejora sobre todo la detección de tormentas severas" description={`La heurística anterior no había aprendido de casos históricos. En el mismo held-out, el nuevo candidato eleva el CSI G3+ en ${g3CsiGain.toFixed(1)} puntos y encuentra ${g3.tp - oldG3.tp} tormentas severas adicionales, a la vez que reduce las falsas alarmas de ${oldG3.fp} a ${g3.fp}.`}>
      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]"><div className="rounded-xl border border-slate-800 bg-slate-950/55 p-3"><ImprovementChart study={study} /></div><div className="grid grid-cols-2 gap-2"><Stat label="MAE Kp nuevo" value={study.results.regression.maeKp.toFixed(2)} detail={`Antes ${study.results.baseline.regression.maeKp.toFixed(2)} Kp.`} /><Stat label="Correlación" value={study.results.regression.correlation.toFixed(3)} detail={`Antes ${study.results.baseline.regression.correlation.toFixed(3)}.`} tone="emerald" /><Stat label="Sesgo Kp" value={`${study.results.regression.biasKp >= 0 ? '+' : ''}${study.results.regression.biasKp.toFixed(2)}`} detail={`Antes +${study.results.baseline.regression.biasKp.toFixed(2)}; menor sobreestimación.`} tone="violet" /><Stat label="Tránsito L1 → Tierra" value={`${study.leadTime.medianMin.toFixed(0)} min`} detail={`Antelación de la parcela, no del inicio Kp · P10–P90: ${study.leadTime.p10Min.toFixed(1)}–${study.leadTime.p90Min.toFixed(1)} min.`} tone="amber" /></div></div>
    </Section>

    <Section index="05 · Estadísticas de eventos" title="G3+ es la métrica cliente; G1+ aporta volumen y contexto" description="Un acierto requiere emparejar una alerta y un episodio observado de forma uno-a-uno con tolerancia predeclarada de ±3 horas. Precisión responde “¿cuántas alertas fueron reales?”; recall responde “¿cuántas tormentas encontramos?”.">
      <div className="grid gap-3 xl:grid-cols-2"><EventScore title="Primaria · tormentas G3+" metric={study.results.g3Event} baseline={study.results.baseline.g3Event} accent="rose" /><EventScore title="Secundaria · tormentas G1+" metric={study.results.g1Event} baseline={study.results.baseline.g1Event} accent="cyan" /></div>
      <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.04] p-4"><div className="flex gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" aria-hidden="true" /><div><h3 className="text-xs font-semibold text-rose-100">El resultado G3+ mejora, pero todavía no es una garantía operacional</h3><p className="mt-1 text-[10px] leading-relaxed text-slate-400">Solo hay {g3.observedEvents} episodios G3+ independientes en el held-out. Por eso la precisión de {pct(g3.precisionPct)} tiene {ci(g3.precisionCi95Pct)} y el recall de {pct(g3.recallPct)} tiene {ci(g3.recallCi95Pct)}. Los intervalos, no solo el valor central, deben aparecer en cualquier material para inversores o clientes.</p></div></div></div>
    </Section>

    <Section index="06 · Qué ha aprendido y estabilidad" title="Acoplamiento eléctrico intenso y memoria previa dominan el modelo G3+" description="La importancia mide cuánto reduce el error cada variable dentro de los árboles; no demuestra causalidad. La estabilidad anual revela cuánto puede variar una métrica severa cuando cada año contiene pocos eventos.">
      <div className="grid gap-4 xl:grid-cols-2"><div className="rounded-xl border border-slate-800 bg-slate-950/55 p-3"><div className="px-1"><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Importancia G3+ · ganancia relativa</div><p className="mt-1 text-[9px] text-slate-600">Top 10 de {study.training.featureCount} variables.</p></div><FeatureChart study={study} /></div><div className="rounded-xl border border-slate-800 bg-slate-950/55 p-3"><div className="px-1"><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Held-out por año</div><p className="mt-1 text-[9px] text-slate-600">2026 es parcial hasta abril; consulta el número de eventos en el tooltip.</p></div><YearChart study={study} /></div></div>
      <div className="mt-4"><div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-slate-500">Selección G3+ antes de abrir el held-out</div><ModelSelectionTable study={study} /></div>
    </Section>

    <Section index="07 · Caso real held-out" title="La tormenta de mayo de 2024, vista sin haberla usado para entrenar" description="El gráfico alinea el Kp definitivo, la nueva estimación y la heurística anterior en los mismos intervalos oficiales. Es un ejemplo visual; las métricas agregadas anteriores usan todo el held-out."><EpisodeChart study={study} /></Section>

    <Section index="08 · Diagnóstico y conclusión" title="El candidato ya es mucho más útil, pero el siguiente salto debe venir de validación live y mejor cobertura severa">
      <div className="grid gap-3 xl:grid-cols-[1.1fr_0.9fr]"><div className="rounded-xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/[0.08] to-slate-950/30 p-4"><div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" aria-hidden="true" /><div><h3 className="text-sm font-semibold text-cyan-100">Resultado: candidato válido para shadow mode, todavía no para prometer un SLA.</h3><p className="mt-2 text-[11px] leading-relaxed text-slate-300">Sobre datos nunca vistos desde 2024, detecta {g3.tp} de {g3.observedEvents} episodios G3+, con {g3.fp} falsos positivos. La mejora sobre la heurística es material: recall {pct(oldG3.recallPct)} → {pct(g3.recallPct)}, precisión {pct(oldG3.precisionPct)} → {pct(g3.precisionPct)} y CSI {pct(oldG3.csiPct)} → {pct(g3.csiPct)}.</p><p className="mt-2 text-[10px] leading-relaxed text-slate-500">La recomendación es desplegar el candidato en paralelo sin conducir alertas de cliente, congelar cada emisión live y revalidar cuando haya acumulado suficiente actividad solar. Hp30 puede añadirse como estudio separado para temporización a 30 minutos.</p></div></div></div><div className="rounded-xl border border-slate-800 bg-slate-950/55 p-4"><div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Antes de una afirmación comercial</div><ul className="mt-3 space-y-2 text-[10px] leading-relaxed text-slate-400"><li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" />Congelar modelo, features y umbrales actuales.</li><li className="flex gap-2"><Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden="true" />Elegir umbral final según coste cliente de FP frente a FN.</li><li className="flex gap-2"><Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" aria-hidden="true" />Guardar predicciones issue-time live e inmutables.</li><li className="flex gap-2"><Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" aria-hidden="true" />Reportar siempre N de eventos e intervalos de confianza.</li></ul></div></div>
      <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4"><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden="true" /><h3 className="text-xs font-semibold uppercase tracking-wider text-amber-100">Limitaciones declaradas</h3></div><ul className="mt-3 grid gap-2 text-[10px] leading-relaxed text-slate-400 lg:grid-cols-2">{study.limitations.map(item => <li key={item} className="flex gap-2"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/70" />{item}</li>)}</ul></div>
    </Section>

    <Section index="Anexo · Diagnóstico continuo" title="Matriz ordinal G0–G5" description="Cada fila es el nivel observado y cada columna el estimado. La alta exactitud total está dominada por G0; para el caso de negocio deben priorizarse las estadísticas de eventos G3+."><GMatrix matrix={study.results.confusionG} /></Section>

    <footer className="flex flex-wrap items-center justify-between gap-2 px-1 font-mono text-[8px] uppercase tracking-wider text-slate-700"><span>{study.schemaVersion} · {study.modelVersion}</span><span>{study.results.regression.n.toLocaleString('es-ES')} bins held-out · generado {study.generatedAtUtc}</span></footer>
  </article>;
}
