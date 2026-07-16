"use client";

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Compass,
  Database,
  FlaskConical,
  Globe2,
  Loader2,
  Radar,
  Ruler,
  Satellite,
  Sparkles,
  SunMedium,
  TriangleAlert,
} from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { MRU_ASSUMPTIONS, MRU_LIMITATIONS } from '@/services/mruForecastService';
import type { MlModelArtifact } from '@/services/mlModelService';
import type { GoesImpactResult } from '@/services/goesImpactService';
import type { OrbitClassConfig } from '@/services/orbitModels';

interface ModelsOverviewPanelProps {
  onGoToValidation?: () => void;
  onGoToLive?: () => void;
}

function FlowStep({
  index,
  icon: Icon,
  title,
  description,
  isLast = false,
}: {
  index: number;
  icon: typeof Compass;
  title: string;
  description: string;
  isLast?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-cyan-400/25 bg-cyan-400/10 text-cyan-200">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Step {index}</div>
          <div className="truncate text-sm font-medium text-slate-100">{title}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-slate-400">{description}</div>
        </div>
      </div>
      {!isLast && <ArrowRight className="h-4 w-4 shrink-0 text-slate-600" aria-hidden="true" />}
    </div>
  );
}

export function ModelsOverviewPanel({ onGoToValidation, onGoToLive }: ModelsOverviewPanelProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      {/* What we are forecasting */}
      <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-5 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">What we forecast</h2>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300">
          Spacecraft at the <span className="text-cyan-200">L1 point</span> sit ~1.5 million km sunward of Earth and see the
          solar wind <span className="text-cyan-200">before it arrives</span>. The goal is to predict how that solar wind —
          its speed, density and magnetic field — <span className="text-cyan-200">propagates from L1 to Earth</span>, giving
          us a head start before it hits the magnetosphere.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <FlowStep index={1} icon={FlaskConical} title="Train on past events" description="Models learn from historical storms (done offline — no action needed here)." />
          <FlowStep index={2} icon={Ruler} title="Validate" description="Check predictions against what really reached Earth." />
          <FlowStep index={3} icon={Radar} title="Live forecast" description="Apply the models automatically to the current L1 feed." isLast />
        </div>
      </section>

      {/* Model cards */}
      <section className="grid gap-4 lg:grid-cols-2">
        {/* MRU baseline */}
        <article className="flex min-w-0 flex-col rounded-lg border border-cyan-400/30 bg-cyan-400/[0.06] p-5 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-cyan-400/30 bg-cyan-400/10 text-cyan-200">
                <Ruler className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-slate-100">MRU baseline</h3>
                <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Uniform rectilinear motion</div>
              </div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-emerald-200">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Active · no training
            </span>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            The simplest physical model: assume the solar wind travels in a straight line from L1 to Earth at the speed we
            measure at L1, carrying its properties unchanged. Only the <span className="text-cyan-200">arrival time</span> shifts.
          </p>

          <div className="mt-4 rounded-md border border-slate-800 bg-slate-950/60 p-3 text-center font-mono text-sm text-cyan-100">
            arrival lag = L1 distance ÷ solar-wind speed
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-emerald-300/80">Assumptions</div>
              <ul className="space-y-1.5 text-xs leading-relaxed text-slate-400">
                {MRU_ASSUMPTIONS.map(item => (
                  <li key={item} className="flex gap-1.5">
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-emerald-400/60" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-amber-300/80">Limitations</div>
              <ul className="space-y-1.5 text-xs leading-relaxed text-slate-400">
                {MRU_LIMITATIONS.map(item => (
                  <li key={item} className="flex gap-1.5">
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-amber-400/60" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-auto flex flex-wrap gap-2 pt-4">
            {onGoToLive && (
              <button
                type="button"
                onClick={onGoToLive}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-xs text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15"
              >
                <Radar className="h-3.5 w-3.5" aria-hidden="true" />
                See it live
              </button>
            )}
            {onGoToValidation && (
              <button
                type="button"
                onClick={onGoToValidation}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
              >
                <Ruler className="h-3.5 w-3.5" aria-hidden="true" />
                Check accuracy
              </button>
            )}
          </div>
        </article>

        {/* ML model (trainable) */}
        <MlModelCard onGoToValidation={onGoToValidation} />
      </section>

      {/* Second target family: per-orbit impact models (position matters) */}
      <OrbitImpactSection />
    </main>
  );
}

function DataField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
      <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-xs leading-relaxed text-slate-300">{children}</div>
    </div>
  );
}

function PipelineStage({ index, icon: Icon, title, source, children }: { index: number; icon: typeof Radar; title: string; source: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-5 shadow-2xl backdrop-blur-xl">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cyan-400/25 bg-cyan-400/10 text-cyan-200">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-200">{index} · {title}</h2>
        <span className="rounded border border-slate-700 bg-slate-950/60 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-400">{source}</span>
      </div>
      {children}
    </section>
  );
}

// ---- Training-data explorer (server: /api/playground/training-data) ----
interface TrainingPoint { t: number; speed: number | null; density: number | null; bt: number | null; bz: number | null }
interface TrainingDataResponse {
  available: { startUtc: string; stopUtc: string } | null;
  range: { startUtc: string; stopUtc: string } | null;
  counts?: { l1: number; earth: number };
  l1: TrainingPoint[];
  earth: TrainingPoint[];
  warnings: string[];
}

const TRAIN_VARS: Array<{ id: 'speed' | 'density' | 'bt' | 'bz'; label: string; unit: string; color: string }> = [
  { id: 'speed', label: 'Speed', unit: 'km/s', color: '#38bdf8' },
  { id: 'density', label: 'Density', unit: 'n/cc', color: '#fbbf24' },
  { id: 'bt', label: '|B|', unit: 'nT', color: '#34d399' },
  { id: 'bz', label: 'Bz', unit: 'nT', color: '#a5b4fc' },
];

function formatDay(iso: string | null | undefined) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}

function MiniSeriesChart({ title, unit, color, points, varId }: { title: string; unit: string; color: string; points: TrainingPoint[]; varId: 'speed' | 'density' | 'bt' | 'bz' }) {
  const data = points.map(p => ({ t: p.t, v: p[varId] }));
  const has = data.some(d => d.v !== null);
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2">
      <div className="mb-1 flex items-center justify-between font-mono text-[9px] uppercase tracking-widest text-slate-500">
        <span style={{ color }}>{title}</span>
        <span>{unit}</span>
      </div>
      {has ? (
        <ResponsiveContainer width="100%" height={84} minWidth={0} minHeight={84} initialDimension={{ width: 240, height: 84 }}>
          <LineChart data={data} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" fontSize={8} stroke="#475569" tickMargin={3} minTickGap={50} tickFormatter={(v: number) => new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' })} />
            <YAxis fontSize={8} stroke="#475569" width={34} tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }}
              labelFormatter={v => `${new Date(Number(v)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`}
              formatter={(v) => [Number(v).toFixed(2), title]}
            />
            <Line dataKey="v" stroke={color} strokeWidth={1.2} dot={false} connectNulls isAnimationActive={false} type="linear" />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[84px] items-center justify-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No data</div>
      )}
    </div>
  );
}

function TrainingColumn({ title, subtitle, points, accent }: { title: string; subtitle: string; points: TrainingPoint[]; accent: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-2">
        <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: accent }}>{title}</div>
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{subtitle}</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {TRAIN_VARS.map(v => (
          <MiniSeriesChart key={v.id} title={v.label} unit={v.unit} color={v.color} points={points} varId={v.id} />
        ))}
      </div>
    </div>
  );
}

const TRAINING_WINDOWS = [7, 14, 30, 90];

function TrainingDataExplorer() {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(14);
  const [source, setSource] = useState<'recent' | 'deep'>('recent');
  const [endDate, setEndDate] = useState(''); // '' = latest available
  const [data, setData] = useState<TrainingDataResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ days: String(days) });
        if (source === 'deep') params.set('source', 'deep');
        if (endDate) params.set('end', `${endDate}T00:00:00Z`);
        const response = await fetch(`/api/playground/training-data?${params.toString()}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) { if (!cancelled) setLoading(false); return; }
        const body = (await response.json()) as TrainingDataResponse;
        if (!cancelled) { setData(body); setLoading(false); }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [open, days, source, endDate]);

  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-900/40">
        <span className="flex items-center gap-2 text-xs font-medium text-slate-200">
          <Chevron className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
          View the input data plots — L1 (ACE) vs near-Earth (OMNI)
        </span>
        {data?.range && <span className="hidden font-mono text-[10px] text-slate-500 sm:block">{formatDay(data.range.startUtc)} → {formatDay(data.range.stopUtc)}</span>}
      </button>
      {open && (
        <div className="border-t border-slate-800 p-3">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* Source: recent quick-look vs deep science archive */}
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Source</span>
            <div className="inline-flex overflow-hidden rounded-md border border-slate-700/60">
              {([['recent', 'Recent · 2017+'], ['deep', 'Deep · 1998+']] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setSource(id); setEndDate(''); }}
                  title={id === 'recent' ? 'ACE quick-look (K0) — covers ~2017 to now' : 'ACE science archive (Level-2) — back to 1998, Bz in GSM'}
                  className={`border-r border-slate-700/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors last:border-r-0 ${source === id ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Window</span>
            <div className="inline-flex overflow-hidden rounded-md border border-slate-700/60">
              {TRAINING_WINDOWS.map(d => (
                <button key={d} type="button" onClick={() => setDays(d)} className={`border-r border-slate-700/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors last:border-r-0 ${days === d ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}>
                  {d}d
                </button>
              ))}
            </div>
            {/* Jump to any window end within the available coverage */}
            <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              End
              <input
                type="date"
                value={endDate}
                min={data?.available ? data.available.startUtc.slice(0, 10) : undefined}
                max={data?.available ? data.available.stopUtc.slice(0, 10) : undefined}
                onChange={e => setEndDate(e.target.value)}
                className="rounded border border-slate-700/60 bg-slate-950/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-200 [color-scheme:dark]"
              />
              {endDate && (
                <button type="button" onClick={() => setEndDate('')} title="Back to latest" className="text-slate-500 hover:text-slate-300">latest</button>
              )}
            </label>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" aria-hidden="true" />}
            {data?.available && (
              <span className="font-mono text-[10px] text-slate-500">
                available: <span className="text-slate-300">{formatDay(data.available.startUtc)} → {formatDay(data.available.stopUtc)}</span>
              </span>
            )}
          </div>
          {loading && !data ? (
            <div className="flex h-32 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Fetching ACE + OMNI…</div>
          ) : data && (data.l1.length > 0 || data.earth.length > 0) ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <TrainingColumn title="L1 · ACE (input → features)" subtitle="upstream monitor, ~1.5M km sunward" points={data.l1} accent="#67e8f9" />
              <TrainingColumn title="Near-Earth · OMNI (target → truth)" subtitle="merged solar wind at the bow shock" points={data.earth} accent="#6ee7b7" />
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">
              {data?.warnings?.length ? data.warnings[0] : 'No data in this window'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DataPipelinePanel({ onGoToValidation, onGoToLive }: ModelsOverviewPanelProps) {
  const [artifact, setArtifact] = useState<MlModelArtifact | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/playground/ml-model', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) { if (!cancelled) setLoading(false); return; }
        const body = (await response.json()) as { artifact: MlModelArtifact | null };
        if (!cancelled) { setArtifact(body.artifact); setLoading(false); }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, []);

  const lags = artifact?.lagsMin ?? [35, 45, 55, 65, 75, 85];
  const densityModel = artifact?.models?.density;
  const densityFeatMean = densityModel ? densityModel.featureMeans.reduce((s, x) => s + x, 0) / densityModel.featureMeans.length : null;
  const densityYMean = densityModel?.yMean ?? null;

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      {/* Pipeline overview */}
      <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-5 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">How the model is trained, validated and served</h2>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300">
          One model learns the <span className="text-cyan-200">L1 → Earth</span> correction from historical pairs of an upstream
          monitor and the merged ground-truth at Earth, then runs automatically on the live feed. Each stage below shows
          <span className="text-cyan-200"> exactly which data</span> it uses.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Train (offline, once)</div>
            <div className="mt-1 text-xs text-slate-300">ACE @ L1 → OMNI @ Earth · 14-day window</div>
          </div>
          <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Validate</div>
            <div className="mt-1 text-xs text-slate-300">Held-out ACE → OMNI on a window you pick</div>
          </div>
          <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Live forecast</div>
            <div className="mt-1 text-xs text-slate-300">DSCOVR @ L1 (now) → predicted Earth values</div>
          </div>
        </div>
      </section>

      {/* 1 · Training data */}
      <PipelineStage index={1} icon={FlaskConical} title="Training data" source={loading ? 'loading…' : artifact ? `${formatUtc(artifact.trainWindow.startUtc)} → ${formatUtc(artifact.trainWindow.stopUtc)}` : 'not trained yet'}>
        <div className="grid gap-3 lg:grid-cols-2">
          <DataField label="Input — L1 monitor (features)">
            <span className="text-cyan-200">ACE</span> via CDAWeb HAPI:
            {artifact?.trainingMode === 'definitive' ? (
              <ul className="mt-1.5 space-y-1 text-slate-400">
                <li>· <span className="font-mono text-slate-300">AC_H0_SWE</span> (Level-2 science) — speed (Vp), density (Np)</li>
                <li>· <span className="font-mono text-slate-300">AC_H0_MFI</span> (Level-2 science) — |B|, Bz in <span className="text-slate-300">GSM</span></li>
              </ul>
            ) : (
              <ul className="mt-1.5 space-y-1 text-slate-400">
                <li>· <span className="font-mono text-slate-300">AC_K0_SWE</span> — speed (Vp), density (Np), temperature (Tpr)</li>
                <li>· <span className="font-mono text-slate-300">AC_K0_MFI</span> — |B| (Magnitude), Bz (from BGSEc)</li>
              </ul>
            )}
          </DataField>
          <DataField label="Target — truth at Earth">
            <span className="text-emerald-200">OMNI</span> via CDAWeb HAPI:
            <ul className="mt-1.5 space-y-1 text-slate-400">
              <li>· <span className="font-mono text-slate-300">OMNI_HRO_1MIN</span> — flow_speed, proton_density, F (|B|), BZ_GSM</li>
              <li>· The multi-spacecraft solar wind already cleaned and time-shifted to Earth&apos;s bow shock.</li>
            </ul>
          </DataField>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <DataField label="Window">
            {artifact?.trainingMode === 'definitive'
              ? <><span className="font-mono">{artifact.windowsUsed ?? artifact.windowsRequested}</span> windows sampled across the full archive (whole solar cycle)</>
              : <><span className="font-mono">14 days</span>, coverage-anchored to the latest data</>}
          </DataField>
          <DataField label="Features per target">L1 value at lags <span className="font-mono">{lags.join('/')}</span> min (≈ transit time)</DataField>
          <DataField label="Train / test split">
            {artifact ? <>chronological <span className="font-mono">{artifact.sampleCount.train.toLocaleString()}</span> train · <span className="font-mono">{artifact.sampleCount.test.toLocaleString()}</span> held-out test</> : 'first 80% train · last 20% test'}
          </DataField>
          <DataField label="Model">standardized ridge per variable (λ <span className="font-mono">{artifact?.lambda ?? 1}</span>), 4 variables</DataField>
        </div>
        <TrainingDataExplorer />
      </PipelineStage>

      {/* 2 · What it learns + results */}
      <PipelineStage index={2} icon={BrainCircuit} title="What it learns + measured results" source={artifact?.overallSkillPct != null ? `skill +${artifact.overallSkillPct.toFixed(0)}% vs MRU` : 'no scores'}>
        <p className="mb-3 max-w-3xl text-xs leading-relaxed text-slate-400">
          For each variable the model fits a weighted combination of the 6 lagged L1 readings to best reproduce the OMNI value,
          learning the effective travel time and an amplitude/timing correction the ballistic MRU baseline cannot. It is scored on
          the held-out test split against MRU (R² = fraction of variance explained; skill = error reduction vs MRU).
        </p>
        <div className="overflow-x-auto rounded-md border border-slate-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/60 font-mono text-[9px] uppercase tracking-widest text-slate-500">
              <tr>
                <th className="px-3 py-2">Variable</th>
                <th className="px-3 py-2">Test R²</th>
                <th className="px-3 py-2">RMSE</th>
                <th className="px-3 py-2">MAE</th>
                <th className="px-3 py-2">Skill vs MRU</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {(artifact?.scores ?? []).map(score => (
                <tr key={score.variableId} className="border-t border-slate-800">
                  <td className="px-3 py-2">{score.label} <span className="text-slate-600">{score.unit}</span></td>
                  <td className="px-3 py-2 font-mono">{formatR2(score.mlR2)}</td>
                  <td className="px-3 py-2 font-mono">{score.mlRmse != null ? score.mlRmse.toFixed(2) : '—'}</td>
                  <td className="px-3 py-2 font-mono">{score.mlMae != null ? score.mlMae.toFixed(2) : '—'}</td>
                  <td className="px-3 py-2 font-mono">{score.skillPct != null ? `${score.skillPct >= 0 ? '+' : ''}${score.skillPct.toFixed(0)}%` : '—'}</td>
                </tr>
              ))}
              {(!artifact || artifact.scores.length === 0) && (
                <tr><td colSpan={5} className="px-3 py-3 text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">{loading ? 'Loading…' : 'Train the model to see results'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          {artifact?.trainingMode === 'definitive'
            ? 'Trained on the full ACE science archive: Bz is now in GSM (matches OMNI) and density is properly calibrated, so all four variables fit well. Density skill vs MRU stays modest because ballistic persistence is already strong for a well-calibrated density.'
            : 'Speed and |B| are where ML clearly beats MRU. Bz is approximate (ACE reports it in GSE, OMNI in GSM — a coordinate mismatch), and density carries an ACE-vs-OMNI calibration offset (see below), so ML adds little there.'}
        </p>
      </PipelineStage>

      {/* 3 · Validation */}
      <PipelineStage index={3} icon={Ruler} title="Validation data" source="held-out, your chosen window">
        <p className="max-w-3xl text-xs leading-relaxed text-slate-400">
          The Validation screen re-runs the <span className="text-slate-300">same ACE → OMNI pairing</span> on a separate window you
          choose (up to 120 days, auto-anchored to real coverage), and scores both MRU and ML against the OMNI truth there — so you can
          check the model on intervals it was never trained on, including specific storms.
        </p>
        {onGoToValidation && (
          <button type="button" onClick={onGoToValidation} className="mt-3 inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100">
            <Ruler className="h-3.5 w-3.5" aria-hidden="true" /> Open validation
          </button>
        )}
      </PipelineStage>

      {/* 4 · Live forecasting */}
      <PipelineStage index={4} icon={Radar} title="Live forecasting" source="SWPC active RTSW · NOAA real-time">
        <p className="max-w-3xl text-xs leading-relaxed text-slate-400">
          On the live feed the trained artifact runs automatically (no action): each L1 parcel is propagated to its Earth-arrival time
          and the model corrects speed / |B| / Bz / density there.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <DataField label="Input now"><span className="text-cyan-200">SWPC active RTSW</span> real-time L1 (one-minute magnetometer/plasma products) + hourly spacecraft ephemeris for the measured L1 distance</DataField>
          <DataField label="Full horizon">missing short-lag features (not measured yet) are carried forward so ML reaches the same lead time as MRU</DataField>
          <DataField label="Anchored to live level">the correction is applied over the live baseline, so a different L1 source can&apos;t inject a calibration offset</DataField>
        </div>
        {onGoToLive && (
          <button type="button" onClick={onGoToLive} className="mt-3 inline-flex h-9 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-xs text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15">
            <Radar className="h-3.5 w-3.5" aria-hidden="true" /> See it live
          </button>
        )}
      </PipelineStage>

      {/* Key honest callout: train source vs live source */}
      <section className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-5">
        <div className="flex items-center gap-2">
          <TriangleAlert className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-amber-200">Does live data have to match the training data?</h2>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300">
          Ideally <span className="text-amber-200">yes — same instrument calibration</span>. Today the artifact is trained on <span className="font-mono text-slate-200">ACE</span> (the longest clean L1+OMNI history)
          while live serving uses the spacecraft SWPC marks active in RTSW. An instrument match is therefore not guaranteed. In particular,
          <span className="text-amber-200"> proton density</span> can carry a source-dependent offset; the ACE training set contains an ACE→OMNI offset
          {densityFeatMean != null && densityYMean != null && (
            <> (<span className="font-mono">{densityFeatMean.toFixed(1)}</span> n/cc at L1 vs <span className="font-mono">{densityYMean.toFixed(1)}</span> n/cc at Earth in training)</>
          )}
          {' '}that must not be treated as a validated correction for every active RTSW spacecraft.
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-300">
          The current implementation limits constant-offset leakage by <span className="text-slate-100">anchoring the ML correction to the live baseline</span>.
          Cross-spacecraft calibration and held-out transfer validation remain required before operational use.
        </p>
      </section>
    </main>
  );
}

function formatUtc(iso: string | null | undefined) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
}

function MlModelCard({ onGoToValidation }: { onGoToValidation?: () => void }) {
  const [artifact, setArtifact] = useState<MlModelArtifact | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTraining, setIsTraining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/playground/ml-model', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Status request failed (${response.status})`);
      }
      const body = (await response.json()) as { artifact: MlModelArtifact | null };
      setArtifact(body.artifact);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load model status');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadStatus();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadStatus]);

  const train = useCallback(async () => {
    setIsTraining(true);
    setError(null);
    try {
      const response = await fetch('/api/playground/ml-model', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const body = (await response.json()) as { artifact: MlModelArtifact | null; error?: string };
      if (!response.ok || body.error) {
        throw new Error(body.error || `Training failed (${response.status})`);
      }
      setArtifact(body.artifact);
    } catch (trainError) {
      setError(trainError instanceof Error ? trainError.message : 'Training failed');
    } finally {
      setIsTraining(false);
    }
  }, []);

  const trained = artifact !== null;

  return (
    <article className="flex min-w-0 flex-col rounded-lg border border-slate-700/50 bg-slate-900/30 p-5 shadow-2xl backdrop-blur-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-purple-400/25 bg-purple-400/10 text-purple-200">
            <BrainCircuit className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-100">ML model</h3>
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Learned correction (ridge)</div>
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${
            trained ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-slate-700 bg-slate-800/60 text-slate-400'
          }`}
        >
          {trained ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />}
          {trained ? 'Trained' : 'Not trained'}
        </span>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-slate-300">
        A model trained on past events to learn the corrections the MRU baseline misses. It is{' '}
        <span className="text-purple-200">trained once, offline</span>, then served automatically. The MRU baseline is
        always the yardstick it must beat.
      </p>

      {/* Train / retrain */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={train}
          disabled={isTraining}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-purple-400/30 bg-purple-400/10 px-3 text-xs text-purple-100 transition hover:border-purple-300/60 hover:bg-purple-400/15 disabled:cursor-wait disabled:text-slate-500"
        >
          {isTraining ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
          {isTraining ? 'Training…' : trained ? 'Retrain model' : 'Train model'}
        </button>
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
          {isTraining ? 'Sampling the full ACE science archive (1998+) and fitting — a few minutes…' : 'Offline · full ACE science archive 1998+ · no live impact'}
        </span>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {isLoading ? (
        <div className="mt-4 rounded-md border border-dashed border-slate-700 bg-slate-950/40 p-4 font-mono text-[10px] uppercase tracking-widest text-slate-600">
          Loading model status…
        </div>
      ) : artifact ? (
        <div className="mt-4 grid gap-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-purple-400/25 bg-purple-400/[0.06] p-2.5">
              <div className="font-mono text-[9px] uppercase tracking-widest text-purple-300/80">Overall R²</div>
              <div className="font-mono text-lg text-purple-100">{artifact.overallR2 !== null ? artifact.overallR2.toFixed(2) : '—'}</div>
            </div>
            <div className="rounded-md border border-purple-400/25 bg-purple-400/[0.06] p-2.5">
              <div className="font-mono text-[9px] uppercase tracking-widest text-purple-300/80">Skill vs MRU</div>
              <div className="font-mono text-lg text-purple-100">
                {artifact.overallSkillPct !== null ? `${artifact.overallSkillPct >= 0 ? '+' : ''}${artifact.overallSkillPct.toFixed(0)}%` : '—'}
              </div>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2.5">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Test points</div>
              <div className="font-mono text-lg text-slate-100">{artifact.sampleCount.test.toLocaleString('en-US')}</div>
            </div>
          </div>

          <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
            <div className="mb-2 grid grid-cols-3 gap-2 font-mono text-[9px] uppercase tracking-widest text-slate-600">
              <span>Variable</span>
              <span className="text-right">ML R²</span>
              <span className="text-right">Skill vs MRU</span>
            </div>
            {artifact.scores.map(score => (
              <div key={score.variableId} className="grid grid-cols-3 gap-2 border-t border-slate-800/70 py-1.5 font-mono text-[11px]">
                <span className="truncate text-slate-300">{score.label}</span>
                <span className="text-right text-slate-100">{score.mlR2 !== null ? score.mlR2.toFixed(2) : '—'}</span>
                <span className={`text-right ${score.skillPct !== null && score.skillPct >= 0 ? 'text-emerald-200' : 'text-slate-400'}`}>
                  {score.skillPct !== null ? `${score.skillPct >= 0 ? '+' : ''}${score.skillPct.toFixed(0)}%` : '—'}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-slate-500">
            <span>Trained {formatUtc(artifact.trainedAtUtc)}</span>
            <span>on {formatUtc(artifact.trainWindow.startUtc)} → {formatUtc(artifact.trainWindow.stopUtc)}</span>
          </div>
          {artifact.trainingMode === 'definitive' && (
            <div className="font-mono text-[10px] text-purple-300/70">
              Definitive · {artifact.source} · {artifact.windowsUsed ?? artifact.windowsRequested} windows across the solar cycle · {artifact.sampleCount.train.toLocaleString()} training samples
            </div>
          )}

          {onGoToValidation && (
            <button
              type="button"
              onClick={onGoToValidation}
              className="inline-flex h-9 w-fit items-center gap-2 rounded-md border border-slate-700 px-3 text-xs text-slate-300 transition hover:border-purple-400/40 hover:text-purple-100"
            >
              <Ruler className="h-3.5 w-3.5" aria-hidden="true" />
              See ML vs MRU in Validation
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-dashed border-slate-700 bg-slate-950/40 p-4 text-sm text-slate-500">
          Not trained yet. Press <span className="text-purple-200">Train model</span> — it fits offline on real ACE + OMNI
          data and then appears automatically in Live Forecast and Validation, scored against the MRU baseline.
        </div>
      )}
    </article>
  );
}

function formatR2(value: number | null) {
  return value === null ? '—' : value.toFixed(2);
}


interface OrbitImpactData {
  orbits: OrbitClassConfig[];
  geoResult: GoesImpactResult | null;
}

function OrbitAblation({ result }: { result: GoesImpactResult }) {
  const positionGood = result.positionSkillPct !== null && result.positionSkillPct > 0;
  return (
    <div className="mt-3 grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2.5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Solar wind only</div>
          <div className="mt-1 font-mono text-xs text-slate-200">R² {formatR2(result.withoutPosition.r2)} · RMSE {result.withoutPosition.rmse?.toFixed(1) ?? '—'} {result.unit}</div>
        </div>
        <div className="rounded-md border border-amber-300/30 bg-amber-300/[0.07] p-2.5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-amber-300/80">+ Position</div>
          <div className="mt-1 font-mono text-xs text-amber-100">R² {formatR2(result.withPosition.r2)} · RMSE {result.withPosition.rmse?.toFixed(1) ?? '—'} {result.unit}</div>
        </div>
      </div>
      <div className={`rounded-md border px-2.5 py-2 text-xs ${positionGood ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-100' : 'border-slate-800 bg-slate-950/50 text-slate-300'}`}>
        Satellite position adds{' '}
        <span className="font-semibold">{result.positionSkillPct !== null ? `${result.positionSkillPct >= 0 ? '+' : ''}${result.positionSkillPct.toFixed(0)}%` : '—'}</span>
        {' '}skill (R² {formatR2(result.withoutPosition.r2)} → {formatR2(result.withPosition.r2)}).
      </div>
      <div className="font-mono text-[10px] text-slate-500">
        {result.dataMonths} months · {result.sampleCount.test.toLocaleString('en-US')} test pts · lags {result.featureLagsMin.join('/')} min
      </div>
    </div>
  );
}

function OrbitCard({ orbit, geoResult, isRunning, onTrain }: { orbit: OrbitClassConfig; geoResult: GoesImpactResult | null; isRunning: boolean; onTrain: () => void }) {
  const wired = orbit.dataSource.status === 'wired';
  return (
    <article className={`flex min-w-0 flex-col rounded-lg border p-4 ${wired ? 'border-amber-300/25 bg-amber-300/[0.04]' : 'border-slate-800 bg-slate-950/40'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Satellite className={`h-4 w-4 shrink-0 ${wired ? 'text-amber-200' : 'text-slate-500'}`} aria-hidden="true" />
            <h4 className="truncate text-sm font-semibold text-slate-100">{orbit.id} · {orbit.label}</h4>
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">{orbit.altitudeLabel}</div>
        </div>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${wired ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-slate-700 bg-slate-800/60 text-slate-400'}`}>
          {wired ? 'Wired' : 'Data ready'}
        </span>
      </div>

      <dl className="mt-3 grid gap-1.5 text-xs">
        <div><dt className="inline font-mono text-[9px] uppercase tracking-widest text-slate-600">Predicts </dt><dd className="inline text-slate-300">{orbit.predicts}</dd></div>
        <div className="flex items-start gap-1.5"><SunMedium className="mt-0.5 h-3 w-3 shrink-0 text-amber-300/70" aria-hidden="true" /><span className="text-slate-400">Position: <span className="text-slate-200">{orbit.positionFeature}</span></span></div>
        <div className="text-[11px] text-slate-500">{orbit.hazard}</div>
      </dl>

      {wired ? (
        <>
          {geoResult ? <OrbitAblation result={geoResult} /> : (
            <div className="mt-3 rounded-md border border-dashed border-slate-700 bg-slate-950/40 p-3 text-xs text-slate-500">Not trained yet — press Train.</div>
          )}
          <button
            type="button"
            onClick={onTrain}
            disabled={isRunning}
            className="mt-3 inline-flex h-8 w-fit items-center gap-2 rounded-md border border-amber-300/30 bg-amber-300/10 px-2.5 text-xs text-amber-100 transition hover:border-amber-200/60 hover:bg-amber-300/15 disabled:cursor-wait disabled:text-slate-500"
          >
            {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <SunMedium className="h-3.5 w-3.5" aria-hidden="true" />}
            {isRunning ? 'Training…' : geoResult ? 'Re-train' : 'Train'}
          </button>
        </>
      ) : (
        <div className="mt-auto pt-3 font-mono text-[10px] text-slate-500">
          <div>Source: <span className="text-slate-300">{orbit.dataSource.name}</span></div>
          <div>{orbit.dataSource.datasetId} · {orbit.dataSource.coverage}</div>
          <div className="mt-1 text-slate-600">Identified — wiring next.</div>
        </div>
      )}
    </article>
  );
}

function OrbitImpactSection() {
  const [data, setData] = useState<OrbitImpactData | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/playground/goes-impact', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (response.ok) {
        setData((await response.json()) as OrbitImpactData);
      }
    } catch {
      /* show run button */
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const trainGeo = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    try {
      const response = await fetch('/api/playground/goes-impact', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const body = (await response.json()) as OrbitImpactData & { error?: string };
      if (!response.ok || body.error) {
        throw new Error(body.error || `Training failed (${response.status})`);
      }
      setData({ orbits: body.orbits, geoResult: body.geoResult });
    } catch (trainError) {
      setError(trainError instanceof Error ? trainError.message : 'Training failed');
    } finally {
      setIsRunning(false);
    }
  }, []);

  const orbits = data?.orbits ?? [];

  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-5 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center gap-2">
        <Globe2 className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Per-orbit impact models</h2>
        <span className="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-400">experimental</span>
      </div>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-300">
        A second family of targets for a <span className="text-amber-200">per-satellite service</span>: predict the radiation/field
        environment AT a satellite, where its <span className="text-amber-200">orbit and position</span> dominate. Each orbit class gets
        its own model. GEO is wired (trained on ~1 year, with a position ablation); LEO and MEO have their data identified and are next.
      </p>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {orbits.map(orbit => (
          <OrbitCard key={orbit.id} orbit={orbit} geoResult={data?.geoResult ?? null} isRunning={isRunning && orbit.dataSource.status === 'wired'} onTrain={trainGeo} />
        ))}
      </div>
    </section>
  );
}
