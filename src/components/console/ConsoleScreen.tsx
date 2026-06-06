"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Clock3, Database, Download, Eye, EyeOff, Gauge, History, Info, Layers, LineChart as LineChartIcon, Loader2, MoreVertical, RefreshCw, Timer, Wind } from 'lucide-react';
import { TrainingDataPanel } from './TrainingDataPanel';
import { Brush, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// ---- Server payload (mirror of /api/console) ----
interface DangerDto { level: number; code: string; label: string; estKp: number; fraction: number }
interface CurrentDto {
  sampleTimeUtc: string | null;
  speedKmS: number | null;
  densityPerCm3: number | null;
  bzNt: number | null;
  btNt: number | null;
  l1DistanceKm: number;
  distanceIsMeasured: boolean;
  lagMinutes: number | null;
  arrivalUtc: string | null;
  danger: DangerDto;
}
interface ScaleVal { level: number; code: string; label: string }
interface ScalesDto { g: ScaleVal; s: ScaleVal; r: ScaleVal; latestKp: number | null }
// The console is split into three tabs (left rail): the live forecast, the local
// training-data inventory, and the historical validation studies.
type ConsoleView = 'realtime' | 'training' | 'validation';
type ForecastCadence = 'all' | '10m' | '1h' | '6h' | '1d';
const CADENCE_OPTIONS: Array<{ key: ForecastCadence; label: string }> = [
  { key: 'all', label: 'All' },
  { key: '10m', label: '10 min' },
  { key: '1h', label: '1 h' },
  { key: '6h', label: '6 h' },
  { key: '1d', label: '1 day' },
];
interface ForecastRowDto {
  id: string;
  sampleTimeUtc: string;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
  forecast: { arrivalUtc: string; lagMinutes: number; gLevel: number; gCode: string; estKp: number } | null;
  verification: { status: 'pending' | 'verified' | 'unverifiable'; observedGLevel: number | null; observedGCode: string | null; observedMaxKp: number | null; rating: { score: number; label: string } | null };
}
interface SeriesPoint { t: number; speed: number | null; density: number | null; bt: number | null; bz: number | null }
interface GPoint { t: number; level: number }
interface GeoPlotDto {
  id: string;
  spacecraft: string;
  title: string;
  unit: string;
  color: string;
  points: Array<{ t: number; value: number | null }>;
}
interface SeriesDto {
  window: string;
  source: 'live' | 'compare' | 'omni';
  startMs: number;
  endMs: number;
  l1: SeriesPoint[];
  mru: SeriesPoint[];
  nearEarth: SeriesPoint[];
  gForecast: GPoint[];
  gObserved: GPoint[];
  geo: Array<{ t: number; hp: number | null; total: number | null }>;
  geoSat: number | null;
  geoSource?: 'swpc' | 'archive';
  geoPlots?: GeoPlotDto[];
  cached?: boolean;
  stale?: boolean;
  cacheAgeMs?: number;
}
interface ConsoleResponse {
  generatedAtUtc: string;
  current: CurrentDto | null;
  scales: ScalesDto | null;
  cadence: ForecastCadence;
  forecasts: ForecastRowDto[];
  summary: { total: number; verified: number; pending: number; hits: number; avgRating: number | null };
  feedDegraded: boolean;
  warnings: string[];
}

// Danger palette: green (quiet) -> red (extreme), indexed by NOAA G level 0..5.
const DANGER = [
  { word: 'QUIET', text: 'text-emerald-300', chip: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200', dot: '#34d399', glow: 'rgba(52,211,153,0.10)' },
  { word: 'MINOR', text: 'text-lime-300', chip: 'border-lime-400/40 bg-lime-400/10 text-lime-200', dot: '#a3e635', glow: 'rgba(163,230,53,0.12)' },
  { word: 'MODERATE', text: 'text-amber-300', chip: 'border-amber-400/40 bg-amber-400/10 text-amber-200', dot: '#fbbf24', glow: 'rgba(251,191,36,0.14)' },
  { word: 'STRONG', text: 'text-orange-300', chip: 'border-orange-400/40 bg-orange-400/10 text-orange-200', dot: '#fb923c', glow: 'rgba(251,146,60,0.16)' },
  { word: 'SEVERE', text: 'text-red-300', chip: 'border-red-400/40 bg-red-400/10 text-red-200', dot: '#f87171', glow: 'rgba(248,113,113,0.18)' },
  { word: 'EXTREME', text: 'text-fuchsia-300', chip: 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200', dot: '#e879f9', glow: 'rgba(232,121,249,0.20)' },
] as const;

function dangerStyle(level: number) {
  return DANGER[Math.max(0, Math.min(5, level))];
}

/** Display timezone for all times in the console (chosen via the header clock). */
const TimeZoneContext = createContext<{ timeZone: string; label: string }>({ timeZone: 'UTC', label: 'UTC' });

function fmtClock(iso: string | null, timeZone = 'UTC') {
  if (!iso) return '--:--';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '--:--';
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
}
function fmtDateTime(iso: string, timeZone = 'UTC') {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
}
function fmtNum(v: number | null, digits = 1) {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

function GTag({ level, code }: { level: number; code: string }) {
  const s = dangerStyle(level);
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${s.chip}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {level === 0 ? 'G0 quiet' : code}
    </span>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2.5">
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono text-base text-slate-100">
        {value}
        {unit && <span className="ml-1 text-[10px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

function DangerHero({ current }: { current: CurrentDto }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const d = current.danger;
  const style = dangerStyle(d.level);
  const headline = d.level === 0
    ? 'Quiet — northward/weak field, nominal wind'
    : `${d.code} ${style.word.toLowerCase()} geomagnetic storm expected`;
  return (
    <section
      className={`rounded-xl border p-5 shadow-2xl ${style.chip.split(' ')[0]}`}
      style={{ background: `radial-gradient(120% 140% at 0% 0%, ${style.glow}, rgba(2,6,23,0.6) 60%)` }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-400">Main forecast · 30-min L1 average</div>
          <div className={`mt-1 flex items-baseline gap-3 ${style.text}`}>
            <span className="font-mono text-4xl font-semibold tracking-wider">{d.level === 0 ? 'G0' : d.code}</span>
            <span className="text-xl font-semibold uppercase tracking-widest">{style.word}</span>
          </div>
          <p className="mt-1 max-w-xl text-sm text-slate-300">{headline}</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-400">Avg. parcel reaches Earth</div>
          <div className="font-mono text-2xl font-semibold text-slate-100">
            {current.lagMinutes !== null ? `${current.lagMinutes} min` : '—'}
          </div>
          <div className="font-mono text-xs text-cyan-200">{current.arrivalUtc ? `${fmtClock(current.arrivalUtc, timeZone)} ${tzLabel}` : '—'}</div>
        </div>
      </div>

      {/* Danger gradient bar */}
      <div className="mt-4">
        <div className="relative h-3 w-full overflow-hidden rounded-full border border-slate-700/60" style={{ background: 'linear-gradient(90deg,#34d399 0%,#a3e635 20%,#fbbf24 45%,#fb923c 65%,#f87171 82%,#e879f9 100%)' }}>
          <div className="absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `calc(${(d.fraction * 100).toFixed(1)}% - 2px)` }} />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[8px] uppercase tracking-widest text-slate-600">
          <span>Quiet</span><span>G1</span><span>G2</span><span>G3</span><span>G4</span><span>G5</span>
        </div>
      </div>

      <p className="mt-3 max-w-3xl text-[10px] leading-relaxed text-slate-500">
        This is the smoothed headline forecast. Shorter spikes can still appear below as a stronger inbound peak.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Speed" value={current.speedKmS !== null ? Math.round(current.speedKmS).toString() : '—'} unit="km/s" />
        <Stat label="Bz (GSM)" value={fmtNum(current.bzNt)} unit="nT" />
        <Stat label="Density" value={fmtNum(current.densityPerCm3)} unit="n/cc" />
        <Stat label="|B|" value={fmtNum(current.btNt)} unit="nT" />
        <Stat label="Est. Kp" value={fmtNum(d.estKp)} />
        <Stat label="Transit" value={current.lagMinutes !== null ? `${current.lagMinutes}` : '—'} unit="min" />
      </div>
    </section>
  );
}

function RatingChip({ rating }: { rating: { score: number; label: string } }) {
  const color = rating.score >= 90 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
    : rating.score >= 70 ? 'border-lime-500/40 bg-lime-500/10 text-lime-200'
    : rating.score >= 40 ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
    : 'border-rose-500/40 bg-rose-500/10 text-rose-200';
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${color}`}>{rating.label} · {rating.score}</span>;
}

function ForecastRow({ row }: { row: ForecastRowDto }) {
  const { timeZone } = useContext(TimeZoneContext);
  const f = row.forecast;
  const v = row.verification;
  const reading = [
    row.speedKmS != null ? `${Math.round(row.speedKmS)} km/s` : null,
    row.bzNt != null ? `Bz ${row.bzNt >= 0 ? '+' : ''}${row.bzNt.toFixed(1)}` : null,
    row.densityPerCm3 != null ? `${row.densityPerCm3.toFixed(1)} n/cc` : null,
  ].filter(Boolean).join('  ·  ');
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
      <span className="w-[92px] shrink-0 font-mono text-[10px] text-slate-500">{fmtDateTime(row.sampleTimeUtc, timeZone)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">{reading || 'L1 sample'}</span>
      {f && (
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-slate-500">
          forecast for Earth <GTag level={f.gLevel} code={f.gCode} />
          <span className="text-slate-600">@ {fmtClock(f.arrivalUtc, timeZone)}</span>
        </span>
      )}
      <span className="text-slate-700">→</span>
      {v.status === 'verified' && v.observedGLevel !== null && v.observedGCode ? (
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-slate-500">
          observed Kp <GTag level={v.observedGLevel} code={v.observedGCode} />
          {v.observedMaxKp != null && <span className="text-slate-600">Kp{v.observedMaxKp.toFixed(1)}</span>}
          {v.rating && <RatingChip rating={v.rating} />}
        </span>
      ) : v.status === 'pending' ? (
        <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-amber-200/70"><Clock3 className="h-3 w-3" aria-hidden="true" /> pending official Kp</span>
      ) : (
        <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">no Kp data</span>
      )}
    </div>
  );
}

// ---- Charts ----
const DETECTED_COLOR = '#34d399';
const MRU_COLOR = '#38bdf8';

function fmtTick(ms: number, spanMs: number, timeZone = 'UTC') {
  const d = new Date(ms);
  if (spanMs <= 2 * 24 * 3600 * 1000) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  if (spanMs <= 45 * 24 * 3600 * 1000) return d.toLocaleString('en-US', { month: 'short', day: '2-digit', timeZone });
  if (spanMs <= 800 * 24 * 3600 * 1000) return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone });
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone });
}
function fmtFull(ms: number, timeZone = 'UTC') {
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone });
}

const NEAR_EARTH_COLOR = '#fb923c';

type SeriesKey = 'l1' | 'mru' | 'nearEarth' | 'forecast' | 'observed';
type Visible = Record<SeriesKey, boolean>;

/** Clickable legend chip that toggles a series on/off. */
function LegendToggle({ on, color, dashed, label, textClass, onClick }: { on: boolean; color: string; dashed?: boolean; label: string; textClass: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-1 transition-opacity ${on ? textClass : 'text-slate-600 opacity-50 line-through'}`}>
      <span className={dashed ? 'h-0 w-3 border-t border-dashed' : 'h-0.5 w-3'} style={dashed ? { borderColor: color } : { backgroundColor: color }} />
      {label}
    </button>
  );
}

function ConsoleChart({ title, unit, variable, series, visible, onToggle }: { title: string; unit: string; variable: 'speed' | 'density' | 'bt' | 'bz'; series: SeriesDto; visible: Visible; onToggle: (k: SeriesKey) => void }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const data = useMemo(() => {
    const byT = new Map<number, { t: number; detected: number | null; mru: number | null; nearEarth: number | null }>();
    const bucket = Math.max(60000, Math.round((series.endMs - series.startMs) / 3500));
    const key = (t: number) => Math.round(t / bucket) * bucket;
    const blank = (t: number) => ({ t, detected: null, mru: null, nearEarth: null });
    for (const p of series.l1) { const t = key(p.t); const r = byT.get(t) ?? blank(t); r.detected = p[variable]; byT.set(t, r); }
    for (const p of series.mru) { const t = key(p.t); const r = byT.get(t) ?? blank(t); r.mru = p[variable]; byT.set(t, r); }
    for (const p of series.nearEarth) { const t = key(p.t); const r = byT.get(t) ?? blank(t); r.nearEarth = p[variable]; byT.set(t, r); }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }, [series, variable]);
  const hasDetected = data.some(d => d.detected !== null);
  const hasMru = data.some(d => d.mru !== null);
  const hasNear = data.some(d => d.nearEarth !== null);
  const has = hasDetected || hasMru || hasNear;
  // Pin the axis to the requested window [start, now] so historical ranges show all
  // available dates with a blank tail where data hasn't arrived; extend past `now` only
  // if the (live) forecast runs ahead of it.
  const lastT = data.length ? data[data.length - 1].t : series.endMs;
  const axisMin = Math.min(series.startMs, data.length ? data[0].t : series.startMs);
  const axisMax = Math.max(series.endMs, lastT);
  const fullSpan = axisMax - axisMin;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">{title}</h4>
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 font-mono text-[8px] uppercase tracking-widest">
          {hasDetected && <LegendToggle on={visible.l1} color={DETECTED_COLOR} dashed label="L1 · ACE" textClass="text-emerald-200" onClick={() => onToggle('l1')} />}
          {hasMru && <LegendToggle on={visible.mru} color={MRU_COLOR} label="MRU" textClass="text-cyan-200" onClick={() => onToggle('mru')} />}
          {hasNear && <LegendToggle on={visible.nearEarth} color={NEAR_EARTH_COLOR} label="L1 · OMNI" textClass="text-orange-200" onClick={() => onToggle('nearEarth')} />}
          <span className="text-slate-500">{unit}</span>
        </div>
      </div>
      {has ? (
        <ResponsiveContainer width="100%" height={176} minWidth={0} minHeight={176} initialDimension={{ width: 320, height: 176 }}>
          <LineChart data={data} margin={{ top: 6, right: 12, left: 6, bottom: 24 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" type="number" domain={[axisMin, axisMax]} allowDataOverflow scale="time" fontSize={9} stroke="#64748b" tickMargin={4} minTickGap={42} tickFormatter={(v: number) => fmtTick(v, fullSpan, timeZone)}
              label={{ value: `time · ${tzLabel}`, position: 'insideBottom', offset: -6, fill: '#94a3b8', fontSize: 9 }} />
            <YAxis fontSize={9} stroke="#64748b" domain={['auto', 'auto']} width={46} tickFormatter={(v: number) => (variable === 'speed' ? v.toFixed(0) : v.toFixed(1))}
              label={{ value: unit, angle: -90, position: 'insideLeft', offset: 16, style: { textAnchor: 'middle', fontSize: 9, fill: '#94a3b8' } }} />
            <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }} labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`} formatter={(v, n) => [Number(v).toFixed(2), String(n)]} />
            {hasDetected && visible.l1 && <Line name="L1 · ACE (upstream)" dataKey="detected" stroke={DETECTED_COLOR} strokeWidth={1.2} strokeDasharray="4 4" dot={false} connectNulls isAnimationActive={false} type="linear" />}
            {hasMru && visible.mru && <Line name="MRU forecast (L1→Earth)" dataKey="mru" stroke={MRU_COLOR} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} type="linear" />}
            {hasNear && visible.nearEarth && <Line name="L1 · OMNI (shifted to Earth)" dataKey="nearEarth" stroke={NEAR_EARTH_COLOR} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} type="linear" />}
            <Brush dataKey="t" height={14} travellerWidth={8} stroke="#334155" fill="#0b1220" tickFormatter={(v: number) => fmtTick(v, fullSpan, timeZone)} />
          </LineChart>
        </ResponsiveContainer>
      ) : <div className="flex h-[150px] items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No data</div>}
    </div>
  );
}

function GLevelChart({ series, visible, onToggle }: { series: SeriesDto; visible: Visible; onToggle: (k: SeriesKey) => void }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const data = useMemo(() => {
    const byT = new Map<number, { t: number; forecast: number | null; observed: number | null }>();
    const bucket = Math.max(60000, Math.round((series.endMs - series.startMs) / 3500));
    const key = (t: number) => Math.round(t / bucket) * bucket;
    for (const p of series.gForecast) { const t = key(p.t); const r = byT.get(t) ?? { t, forecast: null, observed: null }; r.forecast = Math.max(p.level, r.forecast ?? 0); byT.set(t, r); }
    for (const p of series.gObserved) { const t = key(p.t); const r = byT.get(t) ?? { t, forecast: null, observed: null }; r.observed = Math.max(p.level, r.observed ?? 0); byT.set(t, r); }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }, [series]);
  const has = data.length > 0;
  // Pin the axis to the requested window [start, now], extended only if the forecast
  // runs past now — so historical ranges show all dates with a blank recent tail.
  const lastT = data.length ? data[data.length - 1].t : series.endMs;
  const axisMin = Math.min(series.startMs, data.length ? data[0].t : series.startMs);
  const axisMax = Math.max(series.endMs, lastT);
  const fullSpan = axisMax - axisMin;
  // Observed Kp publishes in 3-h bins and lags a few hours; the MRU forecast also runs
  // ~1 h ahead (wind still in transit). Shade everything past the last real Kp bin so
  // the flat stepAfter tail can't be mistaken for "observed = quiet right up to now".
  const lastObsT = series.gObserved.length ? Math.max(...series.gObserved.map(p => p.t)) : null;
  const awaitingFrom = lastObsT !== null && lastObsT < axisMax ? lastObsT : null;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">G level · forecast vs observed</h4>
        <div className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-widest">
          <LegendToggle on={visible.forecast} color="#c084fc" label="forecast" textClass="text-purple-200" onClick={() => onToggle('forecast')} />
          <LegendToggle on={visible.observed} color="#34d399" label="observed (Kp)" textClass="text-emerald-200" onClick={() => onToggle('observed')} />
        </div>
      </div>
      {has ? (
        <ResponsiveContainer width="100%" height={194} minWidth={0} minHeight={194} initialDimension={{ width: 320, height: 194 }}>
          <LineChart data={data} margin={{ top: 6, right: 12, left: 4, bottom: 24 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            {awaitingFrom !== null && (
              <ReferenceArea x1={awaitingFrom} x2={axisMax} y1={0} y2={5} fill="#fbbf24" fillOpacity={0.07} stroke="#fbbf24" strokeOpacity={0.18} strokeDasharray="3 3"
                label={{ value: 'awaiting Kp', position: 'insideTop', fill: '#fbbf24', fontSize: 9, opacity: 0.7 }} />
            )}
            <XAxis dataKey="t" type="number" domain={[axisMin, axisMax]} allowDataOverflow scale="time" fontSize={9} stroke="#64748b" tickMargin={4} minTickGap={42} tickFormatter={(v: number) => fmtTick(v, fullSpan, timeZone)}
              label={{ value: `time · ${tzLabel}`, position: 'insideBottom', offset: -6, fill: '#94a3b8', fontSize: 9 }} />
            <YAxis domain={[0, 5]} ticks={[0, 1, 2, 3, 4, 5]} fontSize={9} stroke="#64748b" width={42} tickFormatter={(v: number) => `G${v}`}
              label={{ value: 'storm level (G)', angle: -90, position: 'insideLeft', offset: 14, style: { textAnchor: 'middle', fontSize: 9, fill: '#94a3b8' } }} />
            <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }} labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`} formatter={(v, n) => [`G${Number(v)}`, String(n)]} />
            {visible.forecast && <Line name="forecast" dataKey="forecast" stroke="#c084fc" strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} type="stepAfter" />}
            {visible.observed && <Line name="observed" dataKey="observed" stroke="#34d399" strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} type="stepAfter" />}
            <Brush dataKey="t" height={14} travellerWidth={8} stroke="#334155" fill="#0b1220" tickFormatter={(v: number) => fmtTick(v, fullSpan, timeZone)} />
          </LineChart>
        </ResponsiveContainer>
      ) : <div className="flex h-[168px] items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No data</div>}
    </div>
  );
}

// ---- GEO chart: GOES magnetometer (magnetospheric field at geostationary orbit) ----
const GEO_HP_COLOR = '#a78bfa';
const GEO_TOTAL_COLOR = '#64748b';

function GeoChart({ series }: { series: SeriesDto }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const data = useMemo(() => {
    const byT = new Map<number, { t: number; hp: number | null; total: number | null }>();
    const bucket = Math.max(60000, Math.round((series.endMs - series.startMs) / 3500));
    const key = (t: number) => Math.round(t / bucket) * bucket;
    for (const p of series.geo) { const t = key(p.t); const r = byT.get(t) ?? { t, hp: null, total: null }; r.hp = p.hp; r.total = p.total; byT.set(t, r); }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }, [series]);
  const has = data.some(d => d.hp !== null || d.total !== null);
  const lastT = data.length ? data[data.length - 1].t : series.endMs;
  const axisMin = Math.min(series.startMs, data.length ? data[0].t : series.startMs);
  const axisMax = Math.max(series.endMs, lastT);
  const fullSpan = axisMax - axisMin;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">
          GEO · GOES{series.geoSat ? `-${series.geoSat}` : ''} magnetometer <span className="text-slate-600">· {series.geoSource === 'archive' ? 'NCEI archive' : 'SWPC last 7d'}</span>
        </h4>
        <div className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-widest">
          <span className="flex items-center gap-1 text-violet-200"><span className="h-0.5 w-3" style={{ backgroundColor: GEO_HP_COLOR }} />Hp</span>
          <span className="flex items-center gap-1 text-slate-400"><span className="h-0.5 w-3" style={{ backgroundColor: GEO_TOTAL_COLOR }} />|B|</span>
          <span className="text-slate-500">nT</span>
        </div>
      </div>
      {has ? (
        <ResponsiveContainer width="100%" height={176} minWidth={0} minHeight={176} initialDimension={{ width: 320, height: 176 }}>
          <LineChart data={data} margin={{ top: 6, right: 12, left: 6, bottom: 24 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" type="number" domain={[axisMin, axisMax]} allowDataOverflow scale="time" fontSize={9} stroke="#64748b" tickMargin={4} minTickGap={42} tickFormatter={(v: number) => fmtTick(v, fullSpan, timeZone)}
              label={{ value: `time · ${tzLabel}`, position: 'insideBottom', offset: -6, fill: '#94a3b8', fontSize: 9 }} />
            <YAxis fontSize={9} stroke="#64748b" domain={['auto', 'auto']} width={46} tickFormatter={(v: number) => v.toFixed(0)}
              label={{ value: 'nT', angle: -90, position: 'insideLeft', offset: 16, style: { textAnchor: 'middle', fontSize: 9, fill: '#94a3b8' } }} />
            <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }} labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`} formatter={(v, n) => [`${Number(v).toFixed(1)} nT`, String(n)]} />
            <Line name="Hp (GEO)" dataKey="hp" stroke={GEO_HP_COLOR} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} type="linear" />
            <Line name="|B| (GEO)" dataKey="total" stroke={GEO_TOTAL_COLOR} strokeWidth={1} dot={false} connectNulls isAnimationActive={false} type="linear" />
            <Brush dataKey="t" height={14} travellerWidth={8} stroke="#334155" fill="#0b1220" tickFormatter={(v: number) => fmtTick(v, fullSpan, timeZone)} />
          </LineChart>
        </ResponsiveContainer>
      ) : <div className="flex h-[150px] items-center justify-center px-4 text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">GEO (GOES) covers the last ~7 days — use the 24H / 3D / 7D ranges to see it</div>}
    </div>
  );
}

function fmtGeoValue(value: number, unit: string) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (unit === 'W/m^2' || (abs > 0 && abs < 0.01)) return value.toExponential(2);
  if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function GeoAvailablePlot({ plot }: { plot: GeoPlotDto }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const data = useMemo(() => plot.points.slice().sort((a, b) => a.t - b.t), [plot.points]);
  const has = data.some(point => point.value !== null);
  const axisMin = data.length ? data[0].t : 0;
  const axisMax = data.length ? data[data.length - 1].t : 6 * 60 * 60 * 1000;
  const fullSpan = Math.max(1, axisMax - axisMin);
  const validCount = data.filter(point => point.value !== null).length;
  const lastSample = data.length ? data[data.length - 1].t : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-1 flex min-h-10 items-start justify-between gap-2">
        <div className="min-w-0">
          <h5 className="truncate text-[10px] font-semibold uppercase tracking-widest text-slate-300" title={plot.title}>{plot.title}</h5>
          <div className="mt-0.5 truncate font-mono text-[8px] uppercase tracking-widest text-slate-600">
            {plot.spacecraft} · {validCount} samples
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-slate-500">
          <span className="h-0.5 w-3" style={{ backgroundColor: plot.color }} />
          {plot.unit}
        </div>
      </div>
      {has ? (
        <ResponsiveContainer width="100%" height={136} minWidth={0} minHeight={136} initialDimension={{ width: 280, height: 136 }}>
          <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 20 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" type="number" domain={[axisMin, axisMax]} allowDataOverflow scale="time" fontSize={8} stroke="#64748b" tickMargin={4} minTickGap={32} tickFormatter={(v: number) => fmtTick(v, fullSpan, timeZone)}
              label={{ value: `time · ${tzLabel}`, position: 'insideBottom', offset: -5, fill: '#94a3b8', fontSize: 8 }} />
            <YAxis fontSize={8} stroke="#64748b" domain={['auto', 'auto']} width={52} tickFormatter={(v: number) => fmtGeoValue(v, plot.unit)} />
            <Tooltip
              contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }}
              labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`}
              formatter={v => [`${fmtGeoValue(Number(v), plot.unit)} ${plot.unit}`, plot.title]}
            />
            <Line name={plot.title} dataKey="value" stroke={plot.color} strokeWidth={1.4} dot={false} connectNulls isAnimationActive={false} type="linear" />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[136px] items-center justify-center px-4 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">No samples</div>
      )}
      <div className="mt-1 truncate font-mono text-[8px] uppercase tracking-widest text-slate-600">
        latest {lastSample ? `${fmtClock(new Date(lastSample).toISOString(), timeZone)} ${tzLabel}` : '—'}
      </div>
    </div>
  );
}

function GeoAvailablePlots({ plots }: { plots: GeoPlotDto[] }) {
  const [infoOpen, setInfoOpen] = useState(false);
  const activePlots = plots.filter(plot => plot.points.some(point => point.value !== null));
  const spacecraft = Array.from(new Set(activePlots.map(plot => plot.spacecraft))).join(' / ');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">GEO · all available GOES plots</h4>
            <p className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-600">
              SWPC 6h primary/secondary JSON{spacecraft ? ` · ${spacecraft}` : ''}
            </p>
          </div>
          <button type="button" onClick={() => setInfoOpen(o => !o)} aria-expanded={infoOpen} title="What does each GOES plot and unit mean?"
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${infoOpen ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200' : 'border-slate-700/60 text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200'}`}>
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <span className="rounded border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-cyan-200">
          {activePlots.length} plots
        </span>
      </div>
      {infoOpen && <GeoPlotsInfo />}
      {activePlots.length > 0 ? (
        <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
          {activePlots.map(plot => <GeoAvailablePlot key={plot.id} plot={plot} />)}
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center rounded-lg border border-slate-800 bg-slate-950/40 px-4 text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">
          No live GEO plot-ready GOES data available
        </div>
      )}
    </div>
  );
}

function InfoTerm({ name, children }: { name: string; children: ReactNode }) {
  return <li><span className="font-semibold text-slate-200">{name}</span> — {children}</li>;
}

/** Legend for the GEO · all-available GOES deck — toggled by its (i). */
function GeoPlotsInfo() {
  return (
    <div className="rounded-lg border border-cyan-400/20 bg-slate-950/70 p-4 text-[11px] leading-relaxed text-slate-300">
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-cyan-300/80">The GOES plots (geostationary orbit)</div>
          <ul className="flex flex-col gap-1.5">
            <InfoTerm name="Primary / Secondary">the two operational GOES satellites — GOES‑18 (“West”) &amp; GOES‑19 (“East”); SWPC tags one of each pair as primary.</InfoTerm>
            <InfoTerm name="MAG Hp">magnetometer component parallel to Earth’s spin axis (northward), at GEO. Dips during storms/substorms.</InfoTerm>
            <InfoTerm name="MAG Hn">the horizontal/normal component (≈ eastward), completing the field-aligned frame.</InfoTerm>
            <InfoTerm name="MAG |H|">total magnetic-field magnitude at GEO.</InfoTerm>
            <InfoTerm name="Electrons ≥2 MeV">integral flux of high-energy (“killer”) electrons — they charge spacecraft surfaces, a real GEO hazard.</InfoTerm>
            <InfoTerm name="Protons ≥10 MeV">integral flux of solar energetic protons — the basis of NOAA’s <span className="text-amber-200/90">S (radiation storm)</span> scale.</InfoTerm>
            <InfoTerm name="XRS 0.1–0.8 nm">soft X-ray irradiance (“long” channel) — drives NOAA’s <span className="text-amber-200/90">R (radio blackout)</span> scale &amp; the solar-flare class (C/M/X).</InfoTerm>
          </ul>
        </div>
        <div>
          <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-cyan-300/80">Units</div>
          <ul className="flex flex-col gap-1.5">
            <InfoVar term="nT">nanotesla (10⁻⁹ tesla) — magnetic field. GEO field ~100 nT.</InfoVar>
            <InfoVar term="pfu">particle flux unit = particles · cm⁻² · s⁻¹ · sr⁻¹ (per area, per second, per solid angle).</InfoVar>
            <InfoVar term="W/m²">watts per square metre — X-ray irradiance. ~10⁻⁶ ≈ C‑class flare, 10⁻⁵ ≈ M, 10⁻⁴ ≈ X.</InfoVar>
            <InfoVar term="MeV">mega‑electronvolt — particle energy; higher = more penetrating/damaging.</InfoVar>
            <InfoVar term="nm">nanometre — the wavelength band of the X-ray channel (0.1–0.8 nm).</InfoVar>
          </ul>
        </div>
      </div>
    </div>
  );
}

function InfoLine({ color, dashed, name, children }: { color: string; dashed?: boolean; name: string; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className={`mt-1.5 shrink-0 ${dashed ? 'h-0 w-3.5 border-t border-dashed' : 'h-0.5 w-3.5 rounded'}`} style={dashed ? { borderColor: color } : { backgroundColor: color }} />
      <span><span className="font-semibold text-slate-200">{name}</span> — {children}</span>
    </li>
  );
}
function InfoVar({ term, unit, children }: { term: string; unit?: string; children: ReactNode }) {
  return (
    <li><span className="font-mono font-semibold text-cyan-200">{term}</span>{unit && <span className="font-mono text-slate-500"> ({unit})</span>} — {children}</li>
  );
}

/** Explains every plot, line and variable — toggled by the (i) next to the charts title. */
function ChartsInfo() {
  return (
    <div className="mt-3 rounded-lg border border-cyan-400/20 bg-slate-950/70 p-4 text-[11px] leading-relaxed text-slate-300">
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-cyan-300/80">The lines on each chart</div>
          <ul className="flex flex-col gap-1.5">
            <InfoLine color={DETECTED_COLOR} dashed name="L1 · ACE">solar wind measured at the <span className="text-slate-200">L1 point</span> (~1.5 million km sunward) by the ACE craft — “upstream”, i.e. what is coming, ~30–60 min before it reaches Earth.</InfoLine>
            <InfoLine color={MRU_COLOR} name="MRU forecast">that L1 wind carried forward to its Earth-arrival time by the simple ballistic model (lag = distance ÷ speed). This is the <span className="text-slate-200">prediction</span>.</InfoLine>
            <InfoLine color={NEAR_EARTH_COLOR} name="L1 · OMNI">the same L1 solar wind time-shifted to Earth (NASA OMNI) — the <span className="text-slate-200">complete measured record</span> of what actually arrived. Covers gaps in ACE.</InfoLine>
            <InfoLine color={GEO_HP_COLOR} name="GEO · GOES">the magnetic field measured by the GOES satellite at <span className="text-slate-200">geostationary orbit</span> (~36,000 km, inside the magnetosphere) — a different place and quantity from the solar wind above.</InfoLine>
            <InfoLine color="#c084fc" name="forecast vs observed">on the G-level chart: purple = the storm level our forecast implies; green = the level actually observed (from Kp).</InfoLine>
          </ul>
        </div>
        <div>
          <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-cyan-300/80">Variables &amp; units</div>
          <ul className="flex flex-col gap-1.5">
            <InfoVar term="speed" unit="km/s">solar-wind bulk speed (kilometres per second). ~300 calm → &gt;800 fast.</InfoVar>
            <InfoVar term="density" unit="n/cc">solar-wind protons per cubic centimetre.</InfoVar>
            <InfoVar term="|B|" unit="nT">strength (magnitude) of the magnetic field.</InfoVar>
            <InfoVar term="Bz" unit="nT">north–south component of the field. <span className="text-amber-200/90">Negative = southward</span> couples to Earth’s field and drives storms.</InfoVar>
            <InfoVar term="Hp" unit="nT">the GOES field component pointing along Earth’s spin axis (northward), at GEO. It dips during storms/substorms.</InfoVar>
            <InfoVar term="nT">nanotesla = 10⁻⁹ tesla, the unit of magnetic field. (Earth’s surface ~50,000 nT; solar-wind |B| ~5 nT; GEO field ~100 nT.)</InfoVar>
            <InfoVar term="Kp">planetary geomagnetic activity index, 0 (quiet) → 9 (extreme), in 3-hour bins.</InfoVar>
            <InfoVar term="G0–G5">NOAA geomagnetic storm scale: G0 quiet → G5 extreme.</InfoVar>
          </ul>
        </div>
      </div>
    </div>
  );
}

const CHART_WINDOWS = ['24h', '3d', '7d', '30d', '1y', '5y'] as const;

function fmtAge(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface ArchiveStatus { exists: boolean; rows: number; startMs: number | null; endMs: number | null; updatedAtMs: number | null }

/** Local archive status (both L1 sources: ACE upstream + OMNI shifted) + a build/refresh trigger. */
function ArchiveControl({ onBuilt }: { onBuilt: () => void }) {
  const [omni, setOmni] = useState<ArchiveStatus | null>(null);
  const [ace, setAce] = useState<ArchiveStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [building, setBuilding] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/console/archive', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.ok) { const b = (await r.json()) as { status: ArchiveStatus; ace: ArchiveStatus }; setOmni(b.status); setAce(b.ace); setLoaded(true); }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => { const t = window.setTimeout(() => void loadStatus(), 0); return () => window.clearTimeout(t); }, [loadStatus]);

  const build = useCallback(async () => {
    setBuilding(true);
    try {
      const r = await fetch('/api/console/archive?build=1', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.ok) { const b = (await r.json()) as { omni: { status: ArchiveStatus }; ace: { status: ArchiveStatus } }; setOmni(b.omni.status); setAce(b.ace.status); setLoaded(true); onBuilt(); }
    } catch {
      /* ignore */
    } finally {
      setBuilding(false);
    }
  }, [onBuilt]);

  const yr = (ms: number | null) => (ms ? new Date(ms).getUTCFullYear() : '');
  const bothExist = !!omni?.exists && !!ace?.exists;
  const anyExist = !!omni?.exists || !!ace?.exists;
  const startYr = yr(Math.min(omni?.startMs ?? Infinity, ace?.startMs ?? Infinity) === Infinity ? null : Math.min(omni?.startMs ?? Infinity, ace?.startMs ?? Infinity));
  const endYr = yr(Math.max(omni?.endMs ?? 0, ace?.endMs ?? 0) || null);

  return (
    <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest">
      {!loaded ? (
        <span className="flex items-center gap-1 text-slate-600"><Database className="h-3 w-3" aria-hidden="true" /> checking…</span>
      ) : bothExist ? (
        <span className="flex items-center gap-1 text-slate-500" title={`Both L1 archives — ACE (upstream) + OMNI (L1 shifted to Earth) · serve 30d/1y/5y instantly`}>
          <Database className="h-3 w-3 text-emerald-300/70" aria-hidden="true" /> L1 archive {startYr}–{endYr}
        </span>
      ) : anyExist ? (
        <span className="flex items-center gap-1 text-amber-300/70" title={`${omni?.exists ? 'OMNI (L1 at Earth) only' : 'ACE (L1 upstream) only'} — build to add the ${omni?.exists ? 'ACE L1' : 'OMNI L1'} archive`}>
          <Database className="h-3 w-3" aria-hidden="true" /> {omni?.exists ? 'L1 · OMNI only' : 'L1 · ACE only'}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-amber-300/70" title="No local archives yet — historical ranges fetch live from CDAWeb (slow). Build once for instant loads.">
          <Database className="h-3 w-3" aria-hidden="true" /> no local archive
        </span>
      )}
      <button type="button" onClick={build} disabled={building} title="Download/refresh the local L1 archives: ACE (upstream) + OMNI (shifted to Earth) (one-time; a few minutes)"
        className="flex items-center gap-1 rounded border border-slate-700/60 px-1.5 py-0.5 text-slate-400 transition-colors hover:text-cyan-200 disabled:cursor-wait">
        {building ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Download className="h-3 w-3" aria-hidden="true" />}
        {building ? 'building…' : anyExist ? 'refresh' : 'build'}
      </button>
    </div>
  );
}

function ChartsSection({ series, windowKey, onWindow, open, onToggle, loading, visible, onToggleSeries, onRefresh }: { series: SeriesDto | null; windowKey: string; onWindow: (w: string) => void; open: boolean; onToggle: () => void; loading: boolean; visible: Visible; onToggleSeries: (k: SeriesKey) => void; onRefresh: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const [infoOpen, setInfoOpen] = useState(false);
  // Series visibility is owned by ConsoleScreen and shared with the sidebar control,
  // so hiding e.g. L1 from the rail cleans up every chart panel at once.
  const toggleSeries = onToggleSeries;
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onToggle} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-300 hover:text-slate-100">
            <Chevron className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <LineChartIcon className="h-4 w-4 text-cyan-300" aria-hidden="true" />
            Live charts · L1 + MRU forecast
          </button>
          <button type="button" onClick={() => setInfoOpen(o => !o)} aria-expanded={infoOpen} title="What does each plot and variable mean?"
            className={`flex h-6 w-6 items-center justify-center rounded-full border transition-colors ${infoOpen ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200' : 'border-slate-700/60 text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200'}`}>
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        {open && (
          <div className="flex flex-wrap items-center gap-2">
            {series?.cached && !loading && (
              <span className={`font-mono text-[9px] uppercase tracking-widest ${series.stale ? 'text-amber-300/80' : 'text-slate-500'}`} title="Served from the on-disk cache — historical ranges are cached so they load instantly">
                {series.stale ? 'stale cache' : 'cached'}{series.cacheAgeMs != null ? ` · ${fmtAge(series.cacheAgeMs)}` : ''}
              </span>
            )}
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" aria-hidden="true" />}
            <button type="button" onClick={onRefresh} disabled={loading} title="Re-fetch this range from source (bypass cache)" className="flex items-center rounded-md border border-slate-700/60 p-1 text-slate-500 transition-colors hover:text-cyan-200 disabled:cursor-wait disabled:opacity-50">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
            <div className="inline-flex overflow-hidden rounded-md border border-slate-700/60">
              {CHART_WINDOWS.map(w => (
                <button key={w} type="button" onClick={() => onWindow(w)} className={`border-r border-slate-700/60 px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors last:border-r-0 ${windowKey === w ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}>{w}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      {infoOpen && <ChartsInfo />}
      {open && (
        series ? (
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
                {series.source === 'omni'
                  ? 'L1 solar wind — OMNI (shifted to Earth) + ACE (upstream), historical'
                  : series.source === 'compare'
                    ? 'L1 solar wind — ACE (upstream) + MRU forecast vs OMNI (L1 at Earth)'
                    : 'L1 solar wind — DSCOVR (upstream) + MRU forecast'}
              </div>
              {(windowKey === '30d' || windowKey === '1y' || windowKey === '5y') && <ArchiveControl onBuilt={onRefresh} />}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <ConsoleChart title="Solar-wind speed" unit="km/s" variable="speed" series={series} visible={visible} onToggle={toggleSeries} />
              <ConsoleChart title="Bz (north-south)" unit="nT" variable="bz" series={series} visible={visible} onToggle={toggleSeries} />
              <ConsoleChart title="Field magnitude |B|" unit="nT" variable="bt" series={series} visible={visible} onToggle={toggleSeries} />
              <ConsoleChart title="Proton density" unit="n/cc" variable="density" series={series} visible={visible} onToggle={toggleSeries} />
            </div>
            <GLevelChart series={series} visible={visible} onToggle={toggleSeries} />
            <GeoChart series={series} />
            <GeoAvailablePlots plots={series.geoPlots ?? []} />
            <p className="text-[10px] leading-relaxed text-slate-500">
              <span className="text-slate-400">Drag the bar under any chart to scrub through time; click a legend label to show/hide that series across all charts.</span>{' '}
              {series.source === 'omni'
                ? 'All lines are L1-class solar wind (it is only measured at L1 — there is none in GEO/MEO/LEO). Orange = OMNI (the L1 wind shifted to Earth, the complete record); green dashed = ACE upstream at L1 (its plasma sensor died Jul-2024, so speed/density show via OMNI). The G chart compares the G the wind implied vs the observed Kp.'
                : series.source === 'compare'
                  ? 'All L1-class solar wind: green = ACE upstream at L1, cyan = the MRU forecast (L1 propagated to Earth), orange = OMNI (the L1 wind shifted to Earth). Anchored to today; the recent tail is blank where OMNI has not arrived yet (~3 weeks).'
                  : 'All L1-class: green dashed = DSCOVR upstream at L1; cyan = the MRU forecast at its Earth-arrival time. OMNI (L1 shifted to Earth) lags ~2–3 weeks, so it only appears on the 30-day+ ranges. The G chart compares forecast G vs observed Kp — but Kp publishes in 3-hour bins and the forecast runs ~1 h ahead (wind still in transit), so the shaded tail has no observed Kp yet.'}{' '}
              The GEO deck lists every currently wired GOES primary/secondary plot: MAG Hn/Hp/|H|, integral electrons, integral protons, and XRS.
            </p>
          </div>
        ) : loading ? (
          <div className="mt-3 flex h-24 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Loading series…</div>
        ) : (
          <div className="mt-3 flex h-24 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No data in this window</div>
        )
      )}
    </section>
  );
}

// ---- MRU arrival-time accuracy (server: /api/console/arrival) ----
// Validated against the REAL Earth arrival (OMNI 1-min Timeshift) over one curated
// storm interval: predicted-vs-actual arrived wind, observed G bands, GEO response,
// and per-shock arrival timing error in minutes.
interface ArrivalEventDto {
  id: string;
  observedArrivalMs: number;
  predictedArrivalMs: number;
  errorMin: number; // predicted − observed (+ = forecast late)
  leadMin: number; // warning lead = transit time (margin operators had)
  speedBefore: number;
  speedAfter: number;
  deltaSpeed: number;
  minBz: number | null;
  peakKp: number | null;
  peakG: number;
}
interface ArrivalStratumDto { key: 'severe' | 'storm' | 'quiet'; label: string; n: number; sharePct: number; maeMin: number; biasMin: number; within20Pct: number; leadMin: number }
interface ArrivalAccuracy {
  interval: { startUtc: string; stopUtc: string; label: string };
  source: string;
  statsSpan: { startUtc: string; stopUtc: string; multiYear: boolean };
  samples: number;
  biasMin: number;
  maeMin: number;
  rmseMin: number;
  medianAbsMin: number;
  p90AbsMin: number;
  withinMinPct: { '10': number; '20': number; '30': number };
  meanLeadMin: number;
  strata: ArrivalStratumDto[];
  eventsMaeMin: number | null;
  actual: Array<{ t: number; speed: number | null; bz: number | null }>;
  predicted: Array<{ t: number; speed: number | null }>;
  bands: Array<{ from: number; to: number; level: number }>;
  geo: Array<{ t: number; hp: number | null }>;
  events: ArrivalEventDto[];
  headlineEventId: string | null;
  computedAtUtc: string;
}

function BigStat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono text-2xl font-semibold" style={{ color: accent ?? '#e2e8f0' }}>
        {value}
        {unit && <span className="ml-1 text-xs text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

const ARRIVAL_ACTUAL_COLOR = '#fb923c'; // observed at Earth (OMNI)
const ARRIVAL_PRED_COLOR = '#38bdf8'; // MRU prediction

function fmtSignedMin(m: number) { return `${m >= 0 ? '+' : '−'}${Math.abs(m).toFixed(1)}`; }

function ArrivalAccuracyCard() {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const [stats, setStats] = useState<ArrivalAccuracy | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Brush = a horizontal-zoom tool: dragging it re-scales the x-domain of BOTH charts to
  // the selected slice (the absolute interval/brush track stays the full storm).
  const [zoom, setZoom] = useState<[number, number] | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setBusy(true);
    try {
      const r = await fetch(`/api/console/arrival${refresh ? '?refresh=1' : ''}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const b = await r.json() as { stats: ArrivalAccuracy | null; error?: string };
      if (r.ok && b.stats) { setStats(b.stats); setZoom(null); setError(null); } else { setError(b.error ?? 'Could not compute arrival accuracy.'); }
    } catch {
      setError('Could not compute arrival accuracy.');
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void load(false), 0); return () => window.clearTimeout(t); }, [load]);

  const startMs = stats ? Date.parse(stats.interval.startUtc) : 0;
  const stopMs = stats ? Date.parse(stats.interval.stopUtc) : 0;
  const fullSpan = Math.max(1, stopMs - startMs);

  // Overlay: predicted-arrival vs actual-arrival speed, re-bucketed onto a shared axis.
  const { data, yDomain } = useMemo(() => {
    if (!stats) return { data: [] as Array<{ t: number; actual: number | null; predicted: number | null }>, yDomain: [0, 1000] as [number, number] };
    const bucket = Math.max(60000, Math.round(fullSpan / 2000));
    const key = (t: number) => Math.round(t / bucket) * bucket;
    const map = new Map<number, { t: number; actual: number | null; predicted: number | null }>();
    let max = 0;
    let min = Infinity;
    for (const p of stats.actual) { if (p.speed === null) continue; const k = key(p.t); const r = map.get(k) ?? { t: k, actual: null, predicted: null }; r.actual = p.speed; map.set(k, r); max = Math.max(max, p.speed); min = Math.min(min, p.speed); }
    for (const p of stats.predicted) { if (p.speed === null) continue; const k = key(p.t); const r = map.get(k) ?? { t: k, actual: null, predicted: null }; r.predicted = p.speed; map.set(k, r); max = Math.max(max, p.speed); min = Math.min(min, p.speed); }
    const lo = Number.isFinite(min) ? Math.floor(min / 50) * 50 : 0;
    const hi = Math.ceil((max || 1000) / 50) * 50;
    return { data: [...map.values()].sort((a, b) => a.t - b.t), yDomain: [lo, hi] as [number, number] };
  }, [stats, fullSpan]);

  const geoData = useMemo(() => (stats?.geo ?? []).filter(p => p.hp !== null), [stats]);
  const headline = stats?.events.find(e => e.id === stats.headlineEventId) ?? null;

  const xDomain: [number, number] = zoom ?? [startMs, stopMs];
  const onBrush = useCallback((r: { startIndex?: number; endIndex?: number }) => {
    if (r.startIndex == null || r.endIndex == null || r.endIndex <= r.startIndex) { setZoom(null); return; }
    const a = data[r.startIndex]?.t;
    const b = data[r.endIndex]?.t;
    if (typeof a === 'number' && typeof b === 'number' && b > a) setZoom([a, b]);
  }, [data]);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/30 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-cyan-300" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">MRU arrival-time accuracy · validated at Earth</h2>
        </div>
        <div className="flex items-center gap-2">
          {stats && <span className="font-mono text-[10px] text-slate-500">{stats.statsSpan.multiYear ? `${new Date(stats.statsSpan.startUtc).getUTCFullYear()}–${new Date(stats.statsSpan.stopUtc).getUTCFullYear()}` : stats.interval.label} · {stats.samples.toLocaleString()} samples</span>}
          <button type="button" onClick={() => void load(true)} disabled={busy} className="flex items-center gap-1 rounded border border-slate-700/60 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-400 hover:text-cyan-200 disabled:cursor-wait">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />} Recompute
          </button>
        </div>
      </div>
      <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-slate-500">
        A solar-wind parcel is seen upstream; MRU predicts <span className="text-slate-300">when</span> it reaches Earth (lag = L1 distance ÷ speed).
        We re-detect that same parcel arriving near Earth (OMNI) and measure how many <span className="text-slate-300">minutes</span> off the prediction
        was. The headline stats span <span className="text-slate-300">several years</span> of OMNI; the chart below zooms one storm (May 2024 G5) as a worked example.
      </p>

      {loading && !stats ? (
        <div className="flex h-28 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Re-running the forecast over the storm…</div>
      ) : stats ? (
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <BigStat label="Mean abs. arrival error" value={stats.maeMin.toFixed(1)} unit="min" accent="#67e8f9" />
            <BigStat label="Bias (pred − actual)" value={fmtSignedMin(stats.biasMin)} unit="min" accent={Math.abs(stats.biasMin) < 3 ? '#6ee7b7' : '#fbbf24'} />
            <BigStat label="Within ±10 min" value={`${stats.withinMinPct['10'].toFixed(0)}`} unit="%" accent="#a5b4fc" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 font-mono text-[10px]">
            <div className="rounded border border-slate-800 bg-slate-950/40 p-2"><span className="text-slate-500">Median |err|</span><div className="text-slate-200">{stats.medianAbsMin.toFixed(1)} min</div></div>
            <div className="rounded border border-slate-800 bg-slate-950/40 p-2"><span className="text-slate-500">RMSE</span><div className="text-slate-200">{stats.rmseMin.toFixed(1)} min</div></div>
            <div className="rounded border border-slate-800 bg-slate-950/40 p-2"><span className="text-slate-500">90th pct |err|</span><div className="text-slate-200">{stats.p90AbsMin.toFixed(1)} min</div></div>
            <div className="rounded border border-slate-800 bg-slate-950/40 p-2"><span className="text-slate-500">Within ±20 / ±30</span><div className="text-slate-200">{stats.withinMinPct['20'].toFixed(0)} / {stats.withinMinPct['30'].toFixed(0)}%</div></div>
          </div>

          {/* Warning lead (margin): the timing error only matters relative to the transit time. */}
          {stats.meanLeadMin > 0 && (
            <div className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.05] p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-widest text-cyan-200">Warning lead · maneuver margin operators get</span>
                <span className="font-mono text-[9px] text-slate-500">L1 → Earth transit time</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                Mean lead <span className="font-mono text-base font-semibold text-cyan-200">{stats.meanLeadMin.toFixed(0)} min</span> — the typical{' '}
                <span className="text-slate-100">±{stats.maeMin.toFixed(1)} min</span> timing error is only{' '}
                <span className="text-slate-100">{Math.round((stats.maeMin / stats.meanLeadMin) * 100)}%</span> of it, leaving ~
                <span className="text-slate-100">{Math.max(0, stats.meanLeadMin - stats.maeMin).toFixed(0)} min</span> of dependable warning. The error matters
                relative to this margin — not on its own (±8 min on a 30-min lead is fine; on a 10-min lead it is not).
              </p>
            </div>
          )}

          {/* Arrival error broken down by storm intensity — is the mean dominated by calm minutes? */}
          {(stats.strata?.length ?? 0) > 0 && (
          <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Arrival error by storm intensity · each minute classified by the observed G then</span>
              {stats.eventsMaeMin != null && <span className="font-mono text-[9px] text-cyan-200">shock fronts only: {stats.eventsMaeMin.toFixed(1)} min ({stats.events.length})</span>}
            </div>
            <div className="overflow-hidden rounded border border-slate-800">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead>
                  <tr className="bg-slate-950/60 text-slate-500">
                    <th className="px-2 py-1 text-left font-medium">Regime</th>
                    <th className="px-2 py-1 text-right font-medium">Minutes</th>
                    <th className="px-2 py-1 text-right font-medium">Share</th>
                    <th className="px-2 py-1 text-right font-medium">Mean |err|</th>
                    <th className="px-2 py-1 text-right font-medium">Lead</th>
                    <th className="px-2 py-1 text-right font-medium">err / lead</th>
                    <th className="px-2 py-1 text-right font-medium">Bias</th>
                    <th className="px-2 py-1 text-right font-medium">±20 min</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.strata.map(s => {
                    const lvl = s.key === 'severe' ? 4 : s.key === 'storm' ? 2 : 0;
                    const ratio = s.leadMin > 0 ? Math.round((s.maeMin / s.leadMin) * 100) : 0;
                    return (
                      <tr key={s.key} className="border-t border-slate-800/70 text-slate-300">
                        <td className="px-2 py-1"><span style={{ color: dangerStyle(lvl).dot }}>●</span> {s.label}</td>
                        <td className="px-2 py-1 text-right text-slate-400">{s.n.toLocaleString()}</td>
                        <td className="px-2 py-1 text-right text-slate-500">{s.sharePct}%</td>
                        <td className="px-2 py-1 text-right" style={{ color: s.maeMin <= 15 ? '#6ee7b7' : s.maeMin <= 25 ? '#fbbf24' : '#f87171' }}>{s.maeMin.toFixed(1)} min</td>
                        <td className="px-2 py-1 text-right text-cyan-200/90">{s.leadMin.toFixed(0)} min</td>
                        <td className="px-2 py-1 text-right" style={{ color: ratio <= 25 ? '#6ee7b7' : ratio <= 40 ? '#fbbf24' : '#f87171' }}>{ratio}%</td>
                        <td className="px-2 py-1 text-right text-slate-400">{fmtSignedMin(s.biasMin)}</td>
                        <td className="px-2 py-1 text-right text-slate-400">{s.within20Pct.toFixed(0)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
              The headline {stats.maeMin.toFixed(1)} min averages <span className="text-slate-300">every sample</span> across the whole span (≈{stats.samples.toLocaleString()}), so the calm majority dominates it. It is a pure <span className="text-slate-300">timing</span> error — MRU&apos;s ballistic lag vs OMNI&apos;s measured delay for the same parcel — so we never expect an identical trace, only the right arrival time.
            </p>
          </div>
          )}

          {/* Predicted-arrival vs actual-arrival overlay, with observed G storm bands. */}
          <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">Predicted arrival vs actual arrival · solar-wind speed <span className="text-slate-600">· example: May 2024 G5</span></h4>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[8px] uppercase tracking-widest">
                <span className="flex items-center gap-1 text-orange-200"><span className="h-0.5 w-3" style={{ backgroundColor: ARRIVAL_ACTUAL_COLOR }} />actual (OMNI)</span>
                <span className="flex items-center gap-1 text-cyan-200"><span className="h-0.5 w-3 border-t border-dashed" style={{ borderColor: ARRIVAL_PRED_COLOR }} />predicted (MRU)</span>
                <span className="text-slate-500">G bands = observed storm level</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={210} minWidth={0} minHeight={210} initialDimension={{ width: 640, height: 210 }}>
              <LineChart data={data} margin={{ top: 6, right: 12, left: 6, bottom: 24 }}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                {stats.bands.map((b, i) => (
                  <ReferenceArea key={i} x1={b.from} x2={b.to} y1={yDomain[0]} y2={yDomain[1]} fill={dangerStyle(b.level).dot} fillOpacity={0.1} stroke="none" ifOverflow="hidden" />
                ))}
                {stats.events.map(e => (
                  <ReferenceLine key={e.id} x={e.observedArrivalMs} stroke={dangerStyle(e.peakG).dot} strokeOpacity={0.5} strokeDasharray="2 2" ifOverflow="hidden"
                    label={e.id === stats.headlineEventId ? { value: `G${e.peakG} ${fmtSignedMin(e.errorMin)}m`, position: 'insideTopRight', fill: dangerStyle(e.peakG).dot, fontSize: 9 } : undefined} />
                ))}
                <XAxis dataKey="t" type="number" domain={xDomain} allowDataOverflow scale="time" fontSize={9} stroke="#64748b" tickMargin={4} minTickGap={48} tickFormatter={(v: number) => fmtTick(v, xDomain[1] - xDomain[0], timeZone)}
                  label={{ value: `time · ${tzLabel}`, position: 'insideBottom', offset: -6, fill: '#94a3b8', fontSize: 9 }} />
                <YAxis domain={yDomain} fontSize={9} stroke="#64748b" width={46} tickFormatter={(v: number) => v.toFixed(0)}
                  label={{ value: 'km/s', angle: -90, position: 'insideLeft', offset: 16, style: { textAnchor: 'middle', fontSize: 9, fill: '#94a3b8' } }} />
                <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }} labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`} formatter={(v, n) => [`${Number(v).toFixed(0)} km/s`, String(n)]} />
                <Line name="actual (OMNI)" dataKey="actual" stroke={ARRIVAL_ACTUAL_COLOR} strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} type="linear" />
                <Line name="predicted (MRU)" dataKey="predicted" stroke={ARRIVAL_PRED_COLOR} strokeWidth={1.3} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} type="linear" />
                <Brush dataKey="t" height={14} travellerWidth={8} stroke="#334155" fill="#0b1220" onChange={onBrush} tickFormatter={(v: number) => fmtTick(v, fullSpan, timeZone)} />
              </LineChart>
            </ResponsiveContainer>
            {geoData.length > 0 && (
              <div className="mt-2 border-t border-slate-800/70 pt-2">
                <div className="mb-1 font-mono text-[8px] uppercase tracking-widest text-slate-500">GEO (GOES) magnetosphere response · Hp (nT)</div>
                <ResponsiveContainer width="100%" height={90} minWidth={0} minHeight={90} initialDimension={{ width: 640, height: 90 }}>
                  <LineChart data={geoData} margin={{ top: 2, right: 12, left: 6, bottom: 4 }}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="t" type="number" domain={xDomain} allowDataOverflow scale="time" hide />
                    <YAxis fontSize={8} stroke="#64748b" domain={['auto', 'auto']} width={46} tickFormatter={(v: number) => v.toFixed(0)} />
                    <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }} labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`} formatter={v => [`${Number(v).toFixed(0)} nT`, 'GEO Hp']} />
                    <Line dataKey="hp" stroke={GEO_HP_COLOR} strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} type="linear" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Per-shock arrival timing — the "with what precision did it arrive" detail. */}
          {headline && (
            <div className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.05] p-3 text-[11px] text-slate-300">
              <span className="font-semibold text-cyan-200">Headline shock</span> — the storm front was re-detected at Earth on{' '}
              <span className="font-mono text-slate-100">{fmtFull(headline.observedArrivalMs, timeZone)} {tzLabel}</span>; MRU predicted{' '}
              <span className="font-mono text-slate-100">{fmtFull(headline.predictedArrivalMs, timeZone)}</span> →{' '}
              <span className="font-mono" style={{ color: Math.abs(headline.errorMin) <= 15 ? '#6ee7b7' : '#fbbf24' }}>{fmtSignedMin(headline.errorMin)} min</span> error
              on a <span className="font-mono text-cyan-200">{headline.leadMin.toFixed(0)} min</span> warning lead, speed {headline.speedBefore}→{headline.speedAfter} km/s, peak <span style={{ color: dangerStyle(headline.peakG).dot }}>G{headline.peakG}</span>.
            </div>
          )}
          <div className="overflow-x-auto rounded-md border border-slate-800">
            <table className="w-full border-collapse font-mono text-[10px]">
              <thead>
                <tr className="bg-slate-950/60 text-slate-500">
                  <th className="px-2 py-1.5 text-left font-medium">Shock arrival (observed)</th>
                  <th className="px-2 py-1.5 text-left font-medium">Predicted</th>
                  <th className="px-2 py-1.5 text-right font-medium">Error</th>
                  <th className="px-2 py-1.5 text-right font-medium">Lead</th>
                  <th className="px-2 py-1.5 text-right font-medium">Δ speed</th>
                  <th className="px-2 py-1.5 text-right font-medium">min Bz</th>
                  <th className="px-2 py-1.5 text-right font-medium">peak</th>
                </tr>
              </thead>
              <tbody>
                {stats.events.length === 0 ? (
                  <tr><td colSpan={7} className="px-2 py-3 text-center text-slate-600">No distinct shock fronts detected in the interval.</td></tr>
                ) : stats.events.map(e => (
                  <tr key={e.id} className={`border-t border-slate-800/70 ${e.id === stats.headlineEventId ? 'bg-cyan-400/[0.04] text-slate-200' : 'text-slate-300'}`}>
                    <td className="px-2 py-1.5 text-slate-300">{fmtFull(e.observedArrivalMs, timeZone)}</td>
                    <td className="px-2 py-1.5 text-slate-400">{fmtClock(new Date(e.predictedArrivalMs).toISOString(), timeZone)}</td>
                    <td className="px-2 py-1.5 text-right" style={{ color: Math.abs(e.errorMin) <= 15 ? '#6ee7b7' : Math.abs(e.errorMin) <= 30 ? '#fbbf24' : '#f87171' }}>{fmtSignedMin(e.errorMin)} min</td>
                    <td className="px-2 py-1.5 text-right text-cyan-200/90">{e.leadMin.toFixed(0)} min</td>
                    <td className="px-2 py-1.5 text-right text-slate-300">+{e.deltaSpeed} km/s</td>
                    <td className="px-2 py-1.5 text-right text-slate-400">{e.minBz === null ? '—' : `${e.minBz.toFixed(0)} nT`}</td>
                    <td className="px-2 py-1.5 text-right font-semibold" style={{ color: dangerStyle(e.peakG).dot }}>G{e.peakG}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">
            Ground truth is OMNI&apos;s own per-minute propagation delay (the community-standard phase-front technique); the bars/lines above are the
            same wind under the two timings, so the residual is purely the MRU ballistic-timing error. Across the span the forecast lands within
            ~{stats.maeMin.toFixed(0)} min on average ({stats.withinMinPct['20'].toFixed(0)}% within ±20 min), and tightens to {stats.strata.find(s => s.key === 'severe')?.maeMin.toFixed(0) ?? stats.maeMin.toFixed(0)} min during severe storms —
            strong enough to call the arrival to the right hour and the storm level it carried.
          </p>
        </div>
      ) : (
        <div className="flex h-20 items-center justify-center px-4 text-center font-mono text-[10px] uppercase tracking-widest text-amber-200/70">{error ?? 'Could not compute — try recompute'}</div>
      )}
    </section>
  );
}

// ---- Real-time nowcast (server: /api/console/nowcast) ----
// The demo hero: last ~2.5 h of L1 detection + the MRU forecast projected PAST "now"
// (the inbound wind still in transit), with the live + predicted alert state.
interface NowcastDto {
  now: number;
  startMs: number;
  distanceKm: number;
  l1: Array<{ t: number; speed: number | null; bz: number | null; density: number | null }>;
  mru: Array<{ t: number; speed: number | null; bz: number | null; gLevel: number }>;
  current: { sampleTimeUtc: string; speedKmS: number | null; bzNt: number | null; densityPerCm3: number | null; gLevel: number; arrivalUtc: string | null; lagMinutes: number | null } | null;
  inbound: { peakG: number; peakSpeed: number; minBz: number; leadMinutes: number; worstEtaUtc: string } | null;
  warning: string | null;
}

function NowcastChart({ title, unit, variable, dto }: { title: string; unit: string; variable: 'speed' | 'bz'; dto: NowcastDto }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const data = useMemo(() => {
    const map = new Map<number, { t: number; detected: number | null; forecast: number | null }>();
    const key = (t: number) => Math.round(t / 60000) * 60000;
    for (const p of dto.l1) { const k = key(p.t); const r = map.get(k) ?? { t: k, detected: null, forecast: null }; r.detected = p[variable]; map.set(k, r); }
    for (const p of dto.mru) { const k = key(p.t); const r = map.get(k) ?? { t: k, detected: null, forecast: null }; r.forecast = p[variable]; map.set(k, r); }
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [dto, variable]);
  const lastT = data.length ? data[data.length - 1].t : dto.now;
  const axisMin = dto.startMs;
  const axisMax = Math.max(dto.now + 5 * 60000, lastT);
  const span = axisMax - axisMin;
  const has = data.some(d => d.detected !== null || d.forecast !== null);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">{title}</h4>
        <div className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-widest">
          <span className="flex items-center gap-1 text-emerald-200"><span className="h-0.5 w-3" style={{ backgroundColor: DETECTED_COLOR }} />L1 now</span>
          <span className="flex items-center gap-1 text-cyan-200"><span className="h-0.5 w-3 border-t border-dashed" style={{ borderColor: MRU_COLOR }} />inbound</span>
          <span className="text-slate-500">{unit}</span>
        </div>
      </div>
      {has ? (
        <ResponsiveContainer width="100%" height={170} minWidth={0} minHeight={170} initialDimension={{ width: 320, height: 170 }}>
          <LineChart data={data} margin={{ top: 6, right: 12, left: 6, bottom: 24 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
            <ReferenceArea x1={dto.now} x2={axisMax} y1={-100000} y2={100000} fill="#38bdf8" fillOpacity={0.05} stroke="none" />
            {variable === 'bz' && <ReferenceLine y={0} stroke="#475569" strokeDasharray="2 2" />}
            <ReferenceLine x={dto.now} stroke="#cbd5e1" strokeOpacity={0.7} strokeDasharray="3 3" label={{ value: 'now', position: 'insideTopLeft', fill: '#cbd5e1', fontSize: 9 }} />
            <XAxis dataKey="t" type="number" domain={[axisMin, axisMax]} allowDataOverflow scale="time" fontSize={9} stroke="#64748b" tickMargin={4} minTickGap={42} tickFormatter={(v: number) => fmtTick(v, span, timeZone)}
              label={{ value: `time · ${tzLabel}`, position: 'insideBottom', offset: -6, fill: '#94a3b8', fontSize: 9 }} />
            <YAxis fontSize={9} stroke="#64748b" domain={['auto', 'auto']} width={46} tickFormatter={(v: number) => (variable === 'speed' ? v.toFixed(0) : v.toFixed(1))}
              label={{ value: unit, angle: -90, position: 'insideLeft', offset: 16, style: { textAnchor: 'middle', fontSize: 9, fill: '#94a3b8' } }} />
            <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }} labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`} formatter={(v, n) => [`${Number(v).toFixed(1)} ${unit}`, String(n)]} />
            <Line name="L1 detected" dataKey="detected" stroke={DETECTED_COLOR} strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} type="linear" />
            <Line name="inbound forecast" dataKey="forecast" stroke={MRU_COLOR} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} type="linear" />
          </LineChart>
        </ResponsiveContainer>
      ) : <div className="flex h-[150px] items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No live L1 samples</div>}
    </div>
  );
}

function NowcastPanel() {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const [dto, setDto] = useState<NowcastDto | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/console/nowcast', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.ok) setDto((await r.json()) as NowcastDto);
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const t0 = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), 30_000);
    return () => { window.clearTimeout(t0); window.clearInterval(id); };
  }, [load]);

  const cur = dto?.current ?? null;
  const inb = dto?.inbound ?? null;
  const leadMin = dto && dto.mru.length ? Math.max(0, Math.round((Math.max(...dto.mru.map(p => p.t), dto.now) - dto.now) / 60000)) : 0;
  const curStyle = cur ? dangerStyle(cur.gLevel) : DANGER[0];
  const inbStyle = inb ? dangerStyle(inb.peakG) : DANGER[0];

  return (
    <section className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.03] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-400" />
          </span>
          <Wind className="h-4 w-4 text-cyan-300" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-200">Live L1 queue · now vs inbound</h2>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-slate-400">
          <span className="text-cyan-200">forecast lead +{leadMin} min</span>
          {loading && !dto && <Loader2 className="h-3 w-3 animate-spin text-slate-500" aria-hidden="true" />}
        </div>
      </div>

      {/* Live + predicted alert strip */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${curStyle.chip}`}>
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
            <span className="text-slate-400">Latest L1 sample</span>
            {cur ? <GTag level={cur.gLevel} code={`G${cur.gLevel}`} /> : <span className="text-slate-500">—</span>}
          </span>
          <span className="font-mono text-[10px] text-slate-300">
            {cur ? <>{fmtNum(cur.speedKmS, 0)} km/s · Bz {fmtNum(cur.bzNt, 1)} nT</> : 'no L1 sample'}
          </span>
        </div>
        <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${inb ? inbStyle.chip : 'border-slate-700/60 text-slate-400'}`}>
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
            <span className="text-slate-400">Strongest inbound sample</span>
            {inb ? <GTag level={inb.peakG} code={`G${inb.peakG}`} /> : <span className="text-slate-500">quiet</span>}
          </span>
          <span className="font-mono text-[10px] text-slate-300">
            {inb ? <>ETA {fmtClock(inb.worstEtaUtc, timeZone)} {tzLabel} · {inb.peakSpeed} km/s</> : `nothing elevated in next ${leadMin} min`}
          </span>
        </div>
      </div>

      {dto ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <NowcastChart title="Solar-wind speed" unit="km/s" variable="speed" dto={dto} />
          <NowcastChart title="Bz (north-south)" unit="nT" variable="bz" dto={dto} />
        </div>
      ) : !loading ? (
        <div className="flex h-32 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Nowcast feed unavailable</div>
      ) : (
        <div className="flex h-32 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Reading L1 feed…</div>
      )}
      <p className="mt-3 max-w-3xl text-[10px] leading-relaxed text-slate-500">
        Latest L1 sample = what DSCOVR is measuring upstream now; strongest inbound sample = the worst already-measured parcel still travelling to Earth.
        Solid lines are upstream measurements; dashed lines are those same measurements shifted to their estimated Earth-arrival time (~{leadMin} min lead).
      </p>
    </section>
  );
}

// ---- MRU historical backtest (server: /api/console/backtest) ----
interface VarSkill { variable: 'speed' | 'density' | 'bt' | 'bz'; unit: string; n: number; mae: number; rmse: number; bias: number; corr: number }
interface Backtest {
  coverage: { startUtc: string; stopUtc: string } | null;
  pairs: number;
  variables: VarSkill[];
  g: { n: number; within1Pct: number; exactPct: number; bias: number };
  computedAtUtc: string;
}
const VAR_LABEL: Record<VarSkill['variable'], string> = { speed: 'Solar-wind speed', density: 'Proton density', bt: 'Field |B|', bz: 'Bz (GSM)' };

function BacktestPanel() {
  const [stats, setStats] = useState<Backtest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/console/backtest', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const b = await r.json() as { stats: Backtest | null; error?: string };
      if (r.ok && b.stats) { setStats(b.stats); setError(null); } else { setStats(null); setError(b.error ?? 'Could not run backtest.'); }
    } catch {
      setError('Could not run backtest.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t); }, [load]);

  const cov = stats?.coverage;
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/30 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LineChartIcon className="h-4 w-4 text-cyan-300" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">MRU hindcast · forecast vs actual</h2>
        </div>
        <div className="flex items-center gap-2">
          {cov && <span className="font-mono text-[10px] text-slate-500">{stats?.pairs.toLocaleString()} hourly pairs · {cov.startUtc.slice(0, 7)} → {cov.stopUtc.slice(0, 7)}</span>}
          <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1 rounded border border-slate-700/60 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-400 hover:text-cyan-200 disabled:cursor-wait">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />} rerun
          </button>
        </div>
      </div>
      <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-slate-500">
        Replays the MRU model over the archived L1 record: every ACE (upstream L1) reading is propagated ballistically to its Earth-arrival
        time and scored against what the wind actually was then — the OMNI record (the same L1 wind shifted to Earth). This is how the simple
        model would have performed historically.
      </p>

      {loading && !stats ? (
        <div className="flex h-24 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Running backtest…</div>
      ) : error ? (
        <div className="flex h-20 items-center justify-center px-4 text-center font-mono text-[10px] uppercase tracking-widest text-amber-200/70">{error}</div>
      ) : stats ? (
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <BigStat label="G within ±1 level" value={stats.g.within1Pct.toFixed(0)} unit="%" accent="#6ee7b7" />
            <BigStat label="G exact match" value={stats.g.exactPct.toFixed(0)} unit="%" accent="#a5b4fc" />
            <BigStat label="G bias (fcst − obs)" value={`${stats.g.bias >= 0 ? '+' : ''}${stats.g.bias.toFixed(2)}`} accent={Math.abs(stats.g.bias) < 0.3 ? '#6ee7b7' : '#fbbf24'} />
          </div>
          <div className="overflow-hidden rounded-md border border-slate-800">
            <table className="w-full border-collapse font-mono text-[10px]">
              <thead>
                <tr className="bg-slate-950/60 text-slate-500">
                  <th className="px-2 py-1.5 text-left font-medium">Variable</th>
                  <th className="px-2 py-1.5 text-right font-medium">MAE</th>
                  <th className="px-2 py-1.5 text-right font-medium">RMSE</th>
                  <th className="px-2 py-1.5 text-right font-medium">Bias</th>
                  <th className="px-2 py-1.5 text-right font-medium">Corr</th>
                  <th className="px-2 py-1.5 text-right font-medium">n</th>
                </tr>
              </thead>
              <tbody>
                {stats.variables.map(v => (
                  <tr key={v.variable} className="border-t border-slate-800/70 text-slate-300">
                    <td className="px-2 py-1.5 text-slate-400">{VAR_LABEL[v.variable]}</td>
                    <td className="px-2 py-1.5 text-right">{v.mae.toFixed(v.variable === 'speed' ? 0 : 2)} <span className="text-slate-600">{v.unit}</span></td>
                    <td className="px-2 py-1.5 text-right text-slate-400">{v.rmse.toFixed(v.variable === 'speed' ? 0 : 2)}</td>
                    <td className="px-2 py-1.5 text-right">{v.bias >= 0 ? '+' : ''}{v.bias.toFixed(v.variable === 'speed' ? 0 : 2)}</td>
                    <td className="px-2 py-1.5 text-right" style={{ color: v.corr >= 0.8 ? '#6ee7b7' : v.corr >= 0.5 ? '#fbbf24' : '#f87171' }}>{v.corr.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right text-slate-600">{v.n.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">
            MAE/RMSE are the typical forecast error; bias is the mean over/under-estimate; correlation is how well the shape tracks. Because
            MRU and OMNI share the L1 source, the residual error mostly reflects the ballistic propagation lag — i.e. how good the simple
            timing assumption is. Evaluated where ACE plasma exists (≈2021–mid-2024).
          </p>
        </div>
      ) : null}
    </section>
  );
}

// ---- Header dual clock (UTC + a selectable custom timezone) ----
const CONSOLE_ZONES: Array<{ tz: string; city: string }> = [
  { tz: 'Europe/Madrid', city: 'Madrid' },
  { tz: 'Europe/London', city: 'London' },
  { tz: 'Europe/Berlin', city: 'Berlin' },
  { tz: 'America/New_York', city: 'New York' },
  { tz: 'America/Los_Angeles', city: 'Los Angeles' },
  { tz: 'Asia/Tokyo', city: 'Tokyo' },
  { tz: 'UTC', city: 'UTC' },
];

function zoneShort(date: Date, tz: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date);
    return parts.find(p => p.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}

function HeaderClocks({ nowMs, activeClock, onSelectClock, customZone, onChangeCustomZone }: {
  nowMs: number;
  activeClock: 'utc' | 'custom';
  onSelectClock: (clock: 'utc' | 'custom') => void;
  customZone: string;
  onChangeCustomZone: (tz: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const d = nowMs > 0 ? new Date(nowMs) : null;
  const utcTime = d ? d.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' }) : '--:--:--';
  const zTime = d ? d.toLocaleTimeString('en-GB', { hour12: false, timeZone: customZone }) : '--:--:--';
  const zLabel = d ? zoneShort(d, customZone) : 'LOCAL';
  const zCity = CONSOLE_ZONES.find(z => z.tz === customZone)?.city ?? customZone;
  const utcActive = activeClock === 'utc';
  const base = 'min-w-[118px] rounded-md border px-3 py-1.5 text-right transition-colors';
  const active = 'border-cyan-400/40 bg-cyan-400/10';
  const idle = 'border-slate-700/70 bg-slate-950/60 hover:border-slate-600/80';
  const plots = <span className="rounded bg-cyan-400/15 px-1 text-[7px] text-cyan-200">PLOTS</span>;

  return (
    <div className="flex items-stretch gap-2">
      {/* UTC — click to show everything in UTC */}
      <button type="button" onClick={() => onSelectClock('utc')} title="Show all times in UTC" className={`${base} ${utcActive ? active : idle}`}>
        <div className={`flex items-center justify-end gap-1 font-mono text-[9px] uppercase tracking-widest ${utcActive ? 'text-cyan-400/70' : 'text-slate-500'}`}>
          {utcActive && plots}
          <span>UTC</span>
        </div>
        <div className={`font-mono text-base font-semibold tabular-nums ${utcActive ? 'text-cyan-100' : 'text-slate-100'}`}>{utcTime}</div>
      </button>

      {/* Custom — click to show everything in this timezone; 3-dots to pick it */}
      <div className={`relative ${base} cursor-pointer ${!utcActive ? active : idle}`} onClick={() => onSelectClock('custom')} role="button" tabIndex={0}>
        <div className={`flex items-center justify-end gap-1 pr-4 font-mono text-[9px] uppercase tracking-widest ${!utcActive ? 'text-cyan-400/70' : 'text-slate-500'}`}>
          {!utcActive && plots}
          <span className="truncate">{zLabel}</span>
        </div>
        <div className={`font-mono text-base font-semibold tabular-nums ${!utcActive ? 'text-cyan-100' : 'text-slate-100'}`}>{zTime}</div>
        <div className={`font-mono text-[8px] uppercase tracking-widest ${!utcActive ? 'text-cyan-400/50' : 'text-slate-600'}`}>{zCity}</div>
        <button type="button" onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }} title="Choose timezone" className="absolute right-1 top-1 rounded p-0.5 text-slate-400 hover:bg-slate-800/60 hover:text-cyan-200">
          <MoreVertical className="h-3 w-3" aria-hidden="true" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={e => { e.stopPropagation(); setMenuOpen(false); }} aria-hidden="true" />
            <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-slate-700 bg-slate-950/95 p-1 text-left shadow-2xl backdrop-blur" onClick={e => e.stopPropagation()}>
              <div className="px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-600">Custom clock timezone</div>
              {CONSOLE_ZONES.map(z => (
                <button key={z.tz} type="button" onClick={() => { onChangeCustomZone(z.tz); onSelectClock('custom'); setMenuOpen(false); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/70">
                  <span className="flex-1 truncate">{z.city}</span>
                  <span className="font-mono text-[10px] text-slate-500">{d ? zoneShort(d, z.tz) : ''}</span>
                  {z.tz === customZone && <Check className="h-3 w-3 shrink-0 text-cyan-300" aria-hidden="true" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---- Left control rail: small controls + at-a-glance status, kept out of the body ----
function SidebarGroup({ icon: Icon, title, children, right }: { icon: typeof Gauge; title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-500">
          <Icon className="h-3 w-3 text-cyan-300/80" aria-hidden="true" /> {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

/** One series row in the "Show on charts" group — colored swatch + eye toggle. */
function SeriesToggleRow({ on, available, color, dashed, label, onClick }: { on: boolean; available: boolean; color: string; dashed?: boolean; label: string; onClick: () => void }) {
  const live = available && on;
  return (
    <button type="button" onClick={onClick} disabled={!available} title={available ? (on ? 'Hide on charts' : 'Show on charts') : 'Not in this window'}
      className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] transition-colors ${available ? 'hover:bg-slate-800/40' : 'cursor-default opacity-35'}`}>
      <span className={`shrink-0 ${dashed ? 'h-0 w-3 border-t border-dashed' : 'h-0.5 w-3'}`} style={dashed ? { borderColor: color } : { backgroundColor: color }} />
      <span className={`flex-1 truncate ${live ? 'text-slate-200' : 'text-slate-500 line-through'}`}>{label}</span>
      {available ? (on ? <Eye className="h-3.5 w-3.5 text-cyan-300/80" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5 text-slate-600" aria-hidden="true" />) : <span className="font-mono text-[9px] text-slate-600">—</span>}
    </button>
  );
}

function SidebarNav({ view, onView }: { view: ConsoleView; onView: (v: ConsoleView) => void }) {
  const item = (key: ConsoleView, icon: typeof Gauge, label: string) => {
    const Icon = icon;
    const active = view === key;
    return (
      <button type="button" onClick={() => onView(key)} className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${active ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {label}
      </button>
    );
  };
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-slate-800 bg-slate-950/40 p-1">
      {item('realtime', Gauge, 'Real-time forecast')}
      {item('training', Layers, 'Training data')}
      {item('validation', Timer, 'Validation & studies')}
    </div>
  );
}

function ConsoleSidebar({ view, onView, scales, forecastG, visible, seriesAvail, onToggleSeries, sampleTimeUtc, lastSampleAgeMin, displayTimeZone, feedDegraded }: {
  view: ConsoleView;
  onView: (v: ConsoleView) => void;
  scales: ScalesDto | null;
  forecastG: DangerDto | null;
  visible: Visible;
  seriesAvail: Record<SeriesKey, boolean>;
  onToggleSeries: (k: SeriesKey) => void;
  sampleTimeUtc: string | null;
  lastSampleAgeMin: number | null;
  displayTimeZone: string;
  feedDegraded: boolean;
}) {
  return (
    <aside className="flex w-full flex-col gap-3 self-start lg:sticky lg:top-0 lg:w-72 lg:shrink-0">
      <SidebarNav view={view} onView={onView} />
      {view === 'training' ? (
        <SidebarGroup icon={Layers} title="Training data">
          <p className="text-[11px] leading-relaxed text-slate-400">All locally-downloaded historical data, classified by orbit (L1 / GEO / LEO / MEO) and mission, with the dates each package covers.</p>
        </SidebarGroup>
      ) : view === 'validation' ? (
        <SidebarGroup icon={Timer} title="Validation & studies">
          <p className="text-[11px] leading-relaxed text-slate-400">Historical skill of the MRU benchmark: arrival-time accuracy vs the real Earth arrival (2021–2026, with warning-lead margins) and the forecast-vs-actual hindcast.</p>
        </SidebarGroup>
      ) : (<>
      {/* NOAA storm scales */}
      <SidebarGroup icon={Gauge} title="Storm scales · NOAA">
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="w-3 font-mono text-[10px] text-slate-500">G</span>
            {forecastG && <span className="flex items-center gap-1 text-purple-200/80">model next <GTag level={forecastG.level} code={forecastG.code} /></span>}
            <span className="text-slate-600">·</span>
            <span className="flex items-center gap-1 text-emerald-200/80">Earth now {scales ? <GTag level={scales.g.level} code={scales.g.code} /> : '—'}</span>
            {scales?.latestKp != null && <span className="font-mono text-[10px] text-slate-500">Kp{scales.latestKp.toFixed(1)}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 font-mono text-[10px] text-slate-500">S</span>
            <span className="flex items-center gap-1 text-slate-300">obs {scales ? <GTag level={scales.s.level} code={scales.s.code} /> : '—'}</span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">radiation · GOES</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 font-mono text-[10px] text-slate-500">R</span>
            <span className="flex items-center gap-1 text-slate-300">obs {scales ? <GTag level={scales.r.level} code={scales.r.code} /> : '—'}</span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">radio · GOES</span>
          </div>
        </div>
      </SidebarGroup>

      {/* Chart series visibility — master legend, drives every chart */}
      <SidebarGroup icon={LineChartIcon} title="Show on charts">
        <div className="flex flex-col gap-0.5">
          <SeriesToggleRow on={visible.l1} available={seriesAvail.l1} color={DETECTED_COLOR} dashed label="L1 · ACE (upstream)" onClick={() => onToggleSeries('l1')} />
          <SeriesToggleRow on={visible.mru} available={seriesAvail.mru} color={MRU_COLOR} label="MRU forecast" onClick={() => onToggleSeries('mru')} />
          <SeriesToggleRow on={visible.nearEarth} available={seriesAvail.nearEarth} color={NEAR_EARTH_COLOR} label="L1 · OMNI (at Earth)" onClick={() => onToggleSeries('nearEarth')} />
          <div className="my-1 border-t border-slate-800/80" />
          <div className="px-1.5 pb-0.5 font-mono text-[8px] uppercase tracking-widest text-slate-600">G level chart</div>
          <SeriesToggleRow on={visible.forecast} available={seriesAvail.forecast} color="#c084fc" label="G forecast" onClick={() => onToggleSeries('forecast')} />
          <SeriesToggleRow on={visible.observed} available={seriesAvail.observed} color="#34d399" label="G observed (Kp)" onClick={() => onToggleSeries('observed')} />
        </div>
      </SidebarGroup>

      {/* Live feed status */}
      <SidebarGroup icon={Wind} title="Live feed">
        <div className="flex flex-col gap-1.5 font-mono text-[10px]">
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            L1 ~1 min (DSCOVR) · auto 60s
          </span>
          {lastSampleAgeMin !== null && (
            <span className="text-slate-500">
              latest {sampleTimeUtc ? fmtClock(sampleTimeUtc, displayTimeZone) : '--:--'}
              <span className="text-slate-600"> · {lastSampleAgeMin <= 1 ? 'just now' : `${lastSampleAgeMin} min ago`}</span>
            </span>
          )}
          {feedDegraded && <span className="text-amber-300/80">feed degraded — using last samples</span>}
        </div>
      </SidebarGroup>
      </>)}
    </aside>
  );
}

export function ConsoleScreen() {
  const [data, setData] = useState<ConsoleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  const [chartsOpen, setChartsOpen] = useState(true);
  const [chartWindow, setChartWindow] = useState('24h');
  // Forecast-log cadence — how densely the per-sample forecasts are shown.
  const [cadence, setCadence] = useState<ForecastCadence>('1h');
  // Left-rail tab: real-time forecast vs training-data inventory vs validation studies.
  const [view, setView] = useState<ConsoleView>('realtime');
  const [series, setSeries] = useState<SeriesDto | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  // Chart-series visibility — owned here so the sidebar's "Show on charts" control and
  // each chart's legend share one source of truth.
  const [visible, setVisible] = useState<Visible>({ l1: true, mru: true, nearEarth: true, forecast: true, observed: true });
  const toggleSeries = useCallback((k: SeriesKey) => setVisible(v => ({ ...v, [k]: !v[k] })), []);
  // Display timezone, chosen by clicking a header clock.
  const [activeClock, setActiveClock] = useState<'utc' | 'custom'>('utc');
  const [customZone, setCustomZone] = useState('Europe/Madrid');
  const displayTimeZone = activeClock === 'utc' ? 'UTC' : customZone;
  const displayLabel = activeClock === 'utc' ? 'UTC' : (CONSOLE_ZONES.find(z => z.tz === customZone)?.city ?? customZone);
  const chartsActive = chartsOpen && view === 'realtime';

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch(`/api/console?cadence=${cadence}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (response.ok) setData((await response.json()) as ConsoleResponse);
    } catch {
      /* keep last data */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [cadence]);

  // Chart series live in their own (heavier) endpoint so the 60s status poll stays
  // light and year-scale windows are only fetched when the window changes.
  const loadSeries = useCallback(async (windowKey: string, refresh = false) => {
    setSeriesLoading(true);
    try {
      const response = await fetch(`/api/console/series?window=${windowKey}${refresh ? '&refresh=1' : ''}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (response.ok) setSeries((await response.json()) as SeriesDto);
    } catch {
      /* keep last series */
    } finally {
      setSeriesLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => { setNowMs(Date.now()); void load(); }, 0);
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    const poll = window.setInterval(() => void load(), 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(clock); window.clearInterval(poll); };
  }, [load]);

  // Fetch series on window change / when charts open; live windows also auto-refresh.
  // Only while the real-time tab is showing the Live charts (skip on training/validation).
  useEffect(() => {
    if (!chartsActive) return;
    const initial = window.setTimeout(() => void loadSeries(chartWindow), 0);
    const isLive = chartWindow === '24h' || chartWindow === '3d' || chartWindow === '7d';
    const id = isLive ? window.setInterval(() => void loadSeries(chartWindow), 60_000) : null;
    return () => { window.clearTimeout(initial); if (id) window.clearInterval(id); };
  }, [chartWindow, chartsActive, loadSeries]);

  const summary = data?.summary;
  const hitRate = summary && summary.verified > 0 ? Math.round((summary.hits / summary.verified) * 100) : null;
  const lastSampleMs = data?.current?.sampleTimeUtc ? new Date(data.current.sampleTimeUtc).getTime() : null;
  const lastSampleAgeMin = lastSampleMs !== null && nowMs > 0 ? Math.max(0, Math.round((nowMs - lastSampleMs) / 60000)) : null;
  // Which series actually exist in the loaded window — the sidebar dims the rest.
  const seriesAvail: Record<SeriesKey, boolean> = {
    l1: (series?.l1.length ?? 0) > 0,
    mru: (series?.mru.length ?? 0) > 0,
    nearEarth: (series?.nearEarth.length ?? 0) > 0,
    forecast: (series?.gForecast.length ?? 0) > 0,
    observed: (series?.gObserved.length ?? 0) > 0,
  };

  return (
    <TimeZoneContext.Provider value={{ timeZone: displayTimeZone, label: displayLabel }}>
    <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-700/60 text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-200" title="Back">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Internal Console</h1>
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">L1 → Earth · MRU benchmark · live danger</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <HeaderClocks nowMs={nowMs} activeClock={activeClock} onSelectClock={setActiveClock} customZone={customZone} onChangeCustomZone={setCustomZone} />
          <button type="button" onClick={() => void load(true)} disabled={refreshing} className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 disabled:cursor-wait disabled:text-slate-500">
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
          </button>
        </div>
      </header>

      {loading && !data ? (
        <div className="flex h-64 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Reading L1 feed…</div>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {/* Left control rail: nav + scales, chart-series visibility, live-feed status */}
          <ConsoleSidebar
            view={view}
            onView={setView}
            scales={data?.scales ?? null}
            forecastG={data?.current?.danger ?? null}
            visible={visible}
            seriesAvail={seriesAvail}
            onToggleSeries={toggleSeries}
            sampleTimeUtc={data?.current?.sampleTimeUtc ?? null}
            lastSampleAgeMin={lastSampleAgeMin}
            displayTimeZone={displayTimeZone}
            feedDegraded={data?.feedDegraded ?? false}
          />

          {/* Main body */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {view === 'training' ? <TrainingDataPanel /> : view === 'validation' ? (<>
            {/* Validation studies: arrival-time accuracy + historical hindcast */}
            <ArrivalAccuracyCard />
            <BacktestPanel />
            </>) : (<>
            {data?.current ? <DangerHero current={data.current} /> : (
              <div className="flex h-40 items-center justify-center rounded-xl border border-amber-400/25 bg-amber-400/[0.06] font-mono text-xs uppercase tracking-widest text-amber-200/80">
                No live L1 solar-wind sample available
              </div>
            )}

            {/* Real-time nowcast: last ~2.5 h L1 + the inbound MRU forecast past now */}
            <NowcastPanel />

            {/* Live charts: L1 detected + MRU forecast + G-level forecast vs observed */}
            <ChartsSection series={series} windowKey={chartWindow} onWindow={setChartWindow} open={chartsOpen} onToggle={() => setChartsOpen(o => !o)} loading={seriesLoading} visible={visible} onToggleSeries={toggleSeries} onRefresh={() => void loadSeries(chartWindow, true)} />

            {/* Forecast log — one forecast per L1 sample, thinned to the chosen cadence */}
            <section className="rounded-lg border border-slate-800 bg-slate-950/30 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Forecast log · L1 samples waiting for Kp</h2>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {summary && (
                    <div className="flex items-center gap-3 font-mono text-[10px] text-slate-400">
                      <span>{summary.total} forecasts</span>
                      {hitRate != null && <span className="text-emerald-200">{hitRate}% within ±1 G</span>}
                      {summary.avgRating != null && <span className="text-cyan-200">avg rating {summary.avgRating}</span>}
                      {summary.pending > 0 && <span className="text-amber-200">{summary.pending} awaiting</span>}
                    </div>
                  )}
                  {/* Cadence filter: how densely to show the per-sample forecasts */}
                  <div className="inline-flex overflow-hidden rounded-md border border-slate-700/60" title="How densely to show forecasts">
                    {CADENCE_OPTIONS.map(opt => (
                      <button key={opt.key} type="button" onClick={() => setCadence(opt.key)}
                        className={`border-r border-slate-700/60 px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors last:border-r-0 ${cadence === opt.key ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-slate-500">
                Every live L1 sample (~1/min) becomes a forecast for its Earth-arrival time and implied NOAA G level. It stays
                <span className="text-amber-200/80"> pending official Kp</span> until the real 3-hour planetary Kp bin is published, then it becomes
                observed Kp plus a rating. Pick a cadence to thin the stream; each bucket keeps its strongest forecast.
              </p>
              <div className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto pr-1">
                {(data?.forecasts ?? []).length === 0 ? (
                  <div className="flex h-20 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No L1 samples yet</div>
                ) : (
                  (data?.forecasts ?? []).map(row => <ForecastRow key={row.id} row={row} />)
                )}
              </div>
            </section>

            <div className="flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-widest text-slate-600">
              <Gauge className="h-3 w-3" aria-hidden="true" />
              <span>Times in {displayLabel} · MRU ballistic propagation · decision support only</span>
            </div>
            </>)}
          </div>
        </div>
      )}
    </main>
    </TimeZoneContext.Provider>
  );
}
