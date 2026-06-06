"use client";

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Clock3,
  Gauge,
  History,
  Info,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wind,
} from 'lucide-react';
import {
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  NoaaEphemerisData,
  NoaaMagnetometerData,
  NoaaPlasmaData,
  NoaaServiceResponse,
} from '@/services/noaaSolarWindService';
import {
  NOMINAL_L1_DISTANCE_KM,
  classifyConditions,
  propagateL1Sample,
  propagateL1Series,
  type GeoeffectiveLevel,
  type L1Sample,
} from '@/services/mruForecastService';
import {
  SCALE_META,
  forecastGFromSolarWind,
  type StormScaleKind,
  type StormScaleValue,
} from '@/services/stormScaleService';

/** Mirror of NoaaStormScalesResult (server type) — kept inline to avoid importing server I/O. */
interface ObservedStormScales {
  g: StormScaleValue;
  s: StormScaleValue;
  r: StormScaleValue;
  latestKp: number | null;
  latestKpTimeUtc: string | null;
  gFromKp: StormScaleValue;
  observedAtUtc: string | null;
}
interface StormScalesResponse {
  observed: ObservedStormScales | null;
  outlook: Array<{ dateUtc: string; g: StormScaleValue; rMinorProbPct: number | null; rMajorProbPct: number | null; sProbPct: number | null }>;
  errorMessage: string | null;
}

// NOAA scale level 0..5 -> palette (quiet slate -> extreme fuchsia).
const SCALE_LEVEL_STYLE = [
  { text: 'text-slate-400', chip: 'border-slate-700 bg-slate-800/50 text-slate-300', dot: '#64748b' },
  { text: 'text-emerald-300', chip: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100', dot: '#34d399' },
  { text: 'text-yellow-300', chip: 'border-yellow-500/40 bg-yellow-500/15 text-yellow-100', dot: '#fde047' },
  { text: 'text-orange-300', chip: 'border-orange-500/40 bg-orange-500/15 text-orange-100', dot: '#fb923c' },
  { text: 'text-rose-300', chip: 'border-rose-500/40 bg-rose-500/15 text-rose-100', dot: '#fb7185' },
  { text: 'text-fuchsia-300', chip: 'border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-100', dot: '#e879f9' },
] as const;

function scaleStyle(level: number) {
  return SCALE_LEVEL_STYLE[Math.max(0, Math.min(5, level))];
}

/** Big "G2 / Moderate" or "Quiet" badge for a scale value. */
function ScaleBadge({ value, size = 'lg' }: { value: StormScaleValue; size?: 'lg' | 'sm' }) {
  const style = scaleStyle(value.level);
  const display = value.level === 0 ? (value.kind === 'G' ? 'Quiet' : 'None') : value.code;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border font-mono uppercase tracking-widest ${style.chip} ${
        size === 'lg' ? 'px-2.5 py-1 text-sm' : 'px-1.5 py-0.5 text-[10px]'
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: style.dot }} />
      {display}
      {value.level > 0 && <span className="text-[9px] opacity-70">{value.label}</span>}
    </span>
  );
}

interface MruLiveForecastPanelProps {
  plasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  magData: NoaaServiceResponse<NoaaMagnetometerData>;
  ephemerisData: NoaaServiceResponse<NoaaEphemerisData>;
  isRefreshing: boolean;
  onRefresh: () => void;
  /** Display timezone for all times in the panel (driven by the header clock). */
  timeZone?: string;
  timeZoneLabel?: string;
}

const MIN_RELIABLE_L1_DISTANCE_KM = 500_000;
const MAX_RELIABLE_L1_DISTANCE_KM = 2_500_000;

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Display timezone for all times in this panel (driven by the header clock). */
const TimeZoneContext = createContext<{ timeZone: string; label: string }>({ timeZone: 'UTC', label: 'UTC' });

function formatClock(ms: number | null, timeZone = 'UTC') {
  if (ms === null) {
    return '--:--';
  }
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  });
}

function parseNoaaTimeMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const ms = new Date(normalized).getTime();

  return Number.isNaN(ms) ? null : ms;
}

function formatRelativeMinutes(minutes: number | null) {
  if (minutes === null) {
    return '—';
  }
  if (minutes < 1) {
    return 'now';
  }
  return `${Math.round(minutes)} min`;
}

function getL1DistanceKm(ephemeris: NoaaEphemerisData | null): { km: number; isMeasured: boolean } {
  const x = toNumber(ephemeris?.x_gse);
  const y = toNumber(ephemeris?.y_gse);
  const z = toNumber(ephemeris?.z_gse);

  if (x === null || y === null || z === null) {
    return { km: NOMINAL_L1_DISTANCE_KM, isMeasured: false };
  }

  const distance = Math.sqrt(x * x + y * y + z * z);
  const isReliable = distance >= MIN_RELIABLE_L1_DISTANCE_KM && distance <= MAX_RELIABLE_L1_DISTANCE_KM;

  return isReliable ? { km: distance, isMeasured: true } : { km: NOMINAL_L1_DISTANCE_KM, isMeasured: false };
}

const LEVEL_STYLE: Record<GeoeffectiveLevel, { ring: string; chip: string; icon: typeof ShieldCheck }> = {
  quiet: { ring: 'border-emerald-400/30 bg-emerald-400/[0.07]', chip: 'border-emerald-400/40 bg-emerald-400/15 text-emerald-100', icon: ShieldCheck },
  unsettled: { ring: 'border-amber-300/30 bg-amber-300/[0.07]', chip: 'border-amber-300/40 bg-amber-300/15 text-amber-100', icon: ShieldAlert },
  storm: { ring: 'border-rose-400/30 bg-rose-400/[0.07]', chip: 'border-rose-400/40 bg-rose-400/15 text-rose-100', icon: ShieldAlert },
  unknown: { ring: 'border-slate-700 bg-slate-900/40', chip: 'border-slate-700 bg-slate-800/60 text-slate-400', icon: Info },
};

function StatRow({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-1 font-mono">
        <span className="text-lg text-slate-100">{value}</span>
        {unit && <span className="text-[11px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

const DETECTED_COLOR = '#34d399';
const MRU_COLOR = '#38bdf8';
const ML_COLOR = '#c084fc';

function ForecastChart({
  title,
  unit,
  detectedPoints,
  points,
  mlPoints,
  nowMs,
}: {
  title: string;
  unit: string;
  detectedPoints?: Array<{ t: number; value: number | null }>;
  points: Array<{ t: number; value: number | null }>;
  mlPoints?: Array<{ t: number; value: number | null }>;
  nowMs: number;
}) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const data = useMemo(() => {
    const byT = new Map<number, { t: number; detected: number | null; mru: number | null; ml: number | null }>();
    const key = (t: number) => Math.round(t / 60000) * 60000;
    for (const point of detectedPoints ?? []) {
      const t = key(point.t);
      const row = byT.get(t) ?? { t, detected: null, mru: null, ml: null };
      row.detected = point.value;
      byT.set(t, row);
    }
    for (const point of points) {
      const t = key(point.t);
      const row = byT.get(t) ?? { t, detected: null, mru: null, ml: null };
      row.mru = point.value;
      byT.set(t, row);
    }
    for (const point of mlPoints ?? []) {
      const t = key(point.t);
      const row = byT.get(t) ?? { t, detected: null, mru: null, ml: null };
      row.ml = point.value;
      byT.set(t, row);
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }, [detectedPoints, points, mlPoints]);

  const hasDetected = data.some(row => row.detected !== null);
  const hasMru = data.some(row => row.mru !== null);
  const hasData = data.some(row => row.detected !== null || row.mru !== null || row.ml !== null);
  const hasMl = data.some(row => row.ml !== null);
  const maxT = data.length > 0 ? data[data.length - 1].t : nowMs;

  return (
    <div className="min-h-[200px] rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{title}</h4>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-widest">
          {hasDetected && (
            <span className="flex items-center gap-1 text-emerald-200">
              <span className="h-0.5 w-3 border-t border-dashed" style={{ borderColor: DETECTED_COLOR }} />
              Detected L1
            </span>
          )}
          {hasMru && <span className="flex items-center gap-1 text-cyan-200"><span className="h-0.5 w-3" style={{ backgroundColor: MRU_COLOR }} />MRU benchmark</span>}
          {hasMl && <span className="flex items-center gap-1 text-purple-200"><span className="h-0.5 w-3" style={{ backgroundColor: ML_COLOR }} />ML model</span>}
          <span className="text-slate-500">{unit}</span>
        </div>
      </div>
      {hasData ? (
        <div className="h-40 w-full">
          <ResponsiveContainer width="100%" height={160} minWidth={0} minHeight={160} initialDimension={{ width: 320, height: 160 }}>
            <LineChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              {maxT > nowMs && (
                <ReferenceArea x1={nowMs} x2={maxT} fill="#22d3ee" fillOpacity={0.06} strokeOpacity={0} />
              )}
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                fontSize={10}
                stroke="#64748b"
                tickMargin={6}
                minTickGap={28}
                tickFormatter={(value: number) => formatClock(value, timeZone)}
              />
              <YAxis domain={['auto', 'auto']} fontSize={10} stroke="#64748b" tickFormatter={(value: number) => value.toFixed(1)} />
              <Tooltip
                contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '12px' }}
                labelFormatter={value => `${formatClock(Number(value), timeZone)} ${tzLabel}`}
                formatter={(value, name) => [Number(value).toFixed(2), String(name)]}
              />
              <ReferenceLine
                x={nowMs}
                stroke="#22d3ee"
                strokeDasharray="4 3"
                strokeOpacity={0.8}
                label={{ value: 'NOW', position: 'insideTopRight', fill: '#67e8f9', fontSize: 9, fontFamily: 'monospace', offset: 6 }}
              />
              {hasDetected && (
                <Line
                  name="Detected L1"
                  dataKey="detected"
                  stroke={DETECTED_COLOR}
                  strokeWidth={1.35}
                  strokeDasharray="4 4"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                  type="linear"
                />
              )}
              {hasMru && <Line name="MRU benchmark" dataKey="mru" stroke={MRU_COLOR} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} type="linear" />}
              {hasMl && <Line name="ML model" dataKey="ml" stroke={ML_COLOR} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} type="linear" />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-40 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">
          No live samples
        </div>
      )}
    </div>
  );
}

/** Tiny forecast-vs-observed agreement marker. */
function MatchTiny({ predicted, observed }: { predicted: StormScaleValue; observed: StormScaleValue }) {
  const diff = predicted.level - observed.level;
  if (diff === 0) return <span title="Matches observed" className="text-emerald-300">✓</span>;
  return (
    <span title={`Forecast ${Math.abs(diff)} level${Math.abs(diff) === 1 ? '' : 's'} ${diff > 0 ? 'higher' : 'lower'}`} className={diff > 0 ? 'text-amber-300' : 'text-sky-300'}>
      {diff > 0 ? '▲' : '▼'}
    </span>
  );
}

/** One compact line per NOAA scale (G / S / R). */
function ScaleRow({
  kind,
  forecastScale,
  forecastKp,
  observed,
  observedKp,
  loading,
}: {
  kind: StormScaleKind;
  forecastScale?: StormScaleValue;
  forecastKp?: number | null;
  observed: StormScaleValue | null;
  observedKp?: number | null;
  loading: boolean;
}) {
  const meta = SCALE_META[kind];
  const headStyle = scaleStyle(observed?.level ?? forecastScale?.level ?? 0);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-800 bg-slate-950/40 px-2.5 py-2">
      <span className={`w-4 shrink-0 text-center font-mono text-base font-semibold ${headStyle.text}`}>{kind}</span>
      <span title={`${meta.title} — ${meta.note}`} className="shrink-0 cursor-help font-mono text-[10px] uppercase tracking-widest text-slate-400">
        {meta.title.replace(' storm', '').replace(' blackout', '')}
      </span>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1 font-mono text-[10px]">
        {meta.forecastable && forecastScale ? (
          <>
            <span className="flex items-center gap-1 text-purple-200/70">
              fcst <ScaleBadge value={forecastScale} size="sm" />
              {forecastKp != null && <span className="text-slate-500">Kp{forecastKp.toFixed(1)}</span>}
            </span>
            <span className="text-slate-600">·</span>
            <span className="flex items-center gap-1 text-emerald-200/70">
              obs{' '}
              {loading && !observed ? '…' : observed ? <ScaleBadge value={observed} size="sm" /> : '—'}
              {observedKp != null && <span className="text-slate-500">Kp{observedKp.toFixed(1)}</span>}
            </span>
            {forecastScale && observed && <MatchTiny predicted={forecastScale} observed={observed} />}
          </>
        ) : (
          <span className="flex items-center gap-1 text-emerald-200/70">
            obs {loading && !observed ? '…' : observed ? <ScaleBadge value={observed} size="sm" /> : '—'}
            <span className="text-slate-600">· GOES</span>
          </span>
        )}
      </div>
    </div>
  );
}

function StormSeveritySection({
  forecastG,
  forecastKp,
  scales,
  loading,
}: {
  forecastG: StormScaleValue;
  forecastKp: number | null;
  scales: StormScalesResponse | null;
  loading: boolean;
}) {
  const observed = scales?.observed ?? null;
  const outlook = scales?.outlook ?? [];
  return (
    <section className="flex flex-col rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Storm severity · NOAA scales</h2>
        <span
          title="HELIOSAT forecasts the G (geomagnetic) scale from the arriving solar wind and compares it with the real Kp. S (radiation) and R (radio-blackout) come from the Sun directly, measured at Earth by GOES — shown as observed, not forecast."
          className="cursor-help text-slate-600 hover:text-slate-400"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <ScaleRow kind="G" forecastScale={forecastG} forecastKp={forecastKp} observed={observed?.g ?? null} observedKp={observed?.latestKp ?? null} loading={loading} />
        <ScaleRow kind="S" observed={observed?.s ?? null} loading={loading} />
        <ScaleRow kind="R" observed={observed?.r ?? null} loading={loading} />
      </div>
      {outlook.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-800 pt-2 font-mono text-[9px] text-slate-500">
          <span className="uppercase tracking-widest text-slate-600">NOAA outlook</span>
          {outlook.map((day, index) => (
            <span key={day.dateUtc} className="flex items-center gap-1">
              <span className="text-slate-600">{index === 0 ? 'Today' : `+${index}d`}</span>
              <ScaleBadge value={day.g} size="sm" />
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Live event log (server: /api/playground/live-events) ----
interface ModelPredictionDto {
  model: 'MRU' | 'ML';
  arrivalUtc: string;
  lagMinutes: number;
  arrivalSpeedKmS: number | null;
  peakSpeedKmS: number | null;
  peakBzNt: number | null;
  estimatedKp: number;
  gLevel: number;
  gCode: string;
}
interface EventVerificationDto {
  status: 'pending' | 'verified' | 'unverifiable';
  observedMaxKp: number | null;
  observedGLevel: number | null;
  observedGCode: string | null;
  windowEndUtc: string | null;
  verdicts: Array<{ model: 'MRU' | 'ML'; predictedGLevel: number; hit: boolean | null }>;
}
interface LiveEventDto {
  id: string;
  type: 'shock' | 'southward_bz' | 'shock_southward';
  detectedAtL1Utc: string;
  endAtL1Utc: string;
  driver: { label: string; peakSpeedKmS: number | null; deltaSpeedKmS: number | null; minBzNt: number | null; peakBtNt: number | null };
  l1DistanceKm: number;
  predictions: ModelPredictionDto[];
  verification: EventVerificationDto;
}
interface LiveEventsResponse {
  events: LiveEventDto[];
  summary: { total: number; verified: number; pending: number; unverifiable: number; mru: { checked: number; hits: number }; ml: { checked: number; hits: number } };
  mlAvailable: boolean;
}

function formatDateTimeUtc(iso: string | number, timeZone = 'UTC') {
  const ms = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
}

/** Compact NOAA G-level tag for an event prediction/observation. */
function GTag({ level, code, dim = false }: { level: number; code: string; dim?: boolean }) {
  const style = scaleStyle(level);
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${style.chip} ${dim ? 'opacity-80' : ''}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: style.dot }} />
      {level === 0 ? 'G0 quiet' : code}
    </span>
  );
}

const MODEL_COLOR: Record<'MRU' | 'ML', string> = { MRU: '#38bdf8', ML: '#c084fc' };

function HitChip({ model, hit }: { model: 'MRU' | 'ML'; hit: boolean | null }) {
  if (hit === null) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${
        hit ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
      }`}
    >
      <span style={{ color: MODEL_COLOR[model] }}>{model}</span>
      {hit ? '✓' : '✗'}
    </span>
  );
}

interface FeedTickDto {
  t: number;
  gLevel: number;
  gCode: string;
  speed: number | null;
  bz: number | null;
  density: number | null;
  bt: number | null;
  estKp: number | null;
  eventId: string | null;
}

type FeedItem =
  | { kind: 'event'; key: string; t: number; event: LiveEventDto }
  | { kind: 'tick'; key: string; t: number; tick: FeedTickDto };

/** Expanded detail for an event: per-model arrival/intensity + verification. */
function EventDetail({ event }: { event: LiveEventDto }) {
  const { verification: v } = event;
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  return (
    <div className="border-t border-slate-800 px-2.5 pb-2.5 pt-2">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-400">
        {event.driver.deltaSpeedKmS != null && event.driver.deltaSpeedKmS > 0 && <span>Δv +{event.driver.deltaSpeedKmS} km/s</span>}
        {event.driver.minBzNt != null && <span>Bz {event.driver.minBzNt.toFixed(1)} nT</span>}
        {event.driver.peakBtNt != null && <span>|B| {event.driver.peakBtNt.toFixed(1)} nT</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {event.predictions.map(p => (
          <div key={p.model} className="rounded-md border border-slate-800 bg-slate-900/40 p-2.5">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-widest" style={{ color: MODEL_COLOR[p.model] }}>
                {p.model === 'MRU' ? 'MRU baseline' : 'ML model'}
              </span>
              <GTag level={p.gLevel} code={p.gCode} />
            </div>
            <div className="font-mono text-[11px] text-slate-300">
              Arrives <span className="text-slate-100">{formatDateTimeUtc(p.arrivalUtc, timeZone)} {tzLabel}</span>
              {Number.isFinite(p.lagMinutes) && <span className="text-slate-500"> · {p.lagMinutes} min transit</span>}
            </div>
            <div className="font-mono text-[10px] text-slate-500">est. Kp {p.estimatedKp.toFixed(1)}{p.peakSpeedKmS != null ? ` · ${Math.round(p.peakSpeedKmS)} km/s` : ''}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {v.status === 'pending' ? (
          <span className="inline-flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-amber-200">
            <Clock3 className="h-3 w-3" aria-hidden="true" /> Awaiting near-Earth confirmation
          </span>
        ) : v.status === 'unverifiable' ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-600">No Kp data in window</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-800/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-slate-300">Observed at Earth</span>
            {v.observedGLevel != null && v.observedGCode && <GTag level={v.observedGLevel} code={v.observedGCode} />}
            {v.observedMaxKp != null && <span className="font-mono text-[10px] text-slate-400">max Kp {v.observedMaxKp.toFixed(1)}</span>}
            <div className="ml-auto flex items-center gap-1.5">
              {v.verdicts.map(verdict => (
                <HitChip key={verdict.model} model={verdict.model} hit={verdict.hit} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One compact, collapsible feed line (an event or a 2-min status tick). */
function FeedRow({ item, expanded, onToggle }: { item: FeedItem; expanded: boolean; onToggle: () => void }) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const { timeZone } = useContext(TimeZoneContext);

  if (item.kind === 'event') {
    const e = item.event;
    const v = e.verification;
    const maxG = Math.max(0, ...e.predictions.map(p => p.gLevel));
    const level = v.status === 'verified' && v.observedGLevel != null ? v.observedGLevel : maxG;
    const code = v.status === 'verified' && v.observedGCode ? v.observedGCode : `G${maxG}`;
    return (
      <div className="rounded-md border border-slate-800 bg-slate-950/50">
        <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-slate-900/40">
          <Chevron className="h-3 w-3 shrink-0 text-slate-500" aria-hidden="true" />
          <span className="w-[88px] shrink-0 font-mono text-[10px] text-slate-500">{formatDateTimeUtc(e.detectedAtL1Utc, timeZone)}</span>
          <GTag level={level} code={code} />
          <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{e.driver.label}</span>
          {v.status === 'pending' ? (
            <Clock3 className="h-3 w-3 shrink-0 text-amber-300" aria-hidden="true" />
          ) : (
            <span className="hidden shrink-0 items-center gap-1 sm:flex">
              {v.verdicts.map(verdict => (
                <HitChip key={verdict.model} model={verdict.model} hit={verdict.hit} />
              ))}
            </span>
          )}
        </button>
        {expanded && <EventDetail event={e} />}
      </div>
    );
  }

  const tk = item.tick;
  const muted = tk.gLevel === 0;
  return (
    <div className={`rounded-md border bg-slate-950/30 ${muted ? 'border-slate-800/50' : 'border-slate-800'}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-slate-900/40">
        <Chevron className="h-3 w-3 shrink-0 text-slate-600" aria-hidden="true" />
        <span className="w-[88px] shrink-0 font-mono text-[10px] text-slate-600">{formatDateTimeUtc(tk.t, timeZone)}</span>
        <GTag level={tk.gLevel} code={tk.gCode} dim={muted} />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-500">
          {tk.speed != null ? Math.round(tk.speed) : '—'} km/s · Bz {tk.bz != null ? tk.bz.toFixed(1) : '—'} nT
        </span>
      </button>
      {expanded && (
        <div className="border-t border-slate-800/60 px-2.5 py-1.5 font-mono text-[10px] text-slate-500">
          density {tk.density != null ? tk.density.toFixed(1) : '—'} n/cc · |B| {tk.bt != null ? tk.bt.toFixed(1) : '—'} nT · est. Kp {tk.estKp != null ? tk.estKp.toFixed(1) : '—'}
        </div>
      )}
    </div>
  );
}

function LiveEventLog({ ticks, data, loading }: { ticks: FeedTickDto[]; data: LiveEventsResponse | null; loading: boolean }) {
  const [filter, setFilter] = useState<'all' | 'events'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const events = data?.events;
  const summary = data?.summary;
  const mruRate = summary && summary.mru.checked > 0 ? Math.round((summary.mru.hits / summary.mru.checked) * 100) : null;
  const mlRate = summary && summary.ml.checked > 0 ? Math.round((summary.ml.hits / summary.ml.checked) * 100) : null;

  const items = useMemo<FeedItem[]>(() => {
    const evItems: FeedItem[] = (events ?? []).map(e => ({ kind: 'event', key: `e-${e.id}`, t: new Date(e.detectedAtL1Utc).getTime(), event: e }));
    // Quiet ticks fill the gaps between events (ticks inside an event window are
    // represented by that event row, not duplicated).
    const tickItems: FeedItem[] = ticks.filter(t => t.eventId === null).map(t => ({ kind: 'tick', key: `t-${t.t}`, t: t.t, tick: t }));
    const all = [...evItems, ...tickItems].sort((a, b) => b.t - a.t);
    return filter === 'events' ? all.filter(i => i.kind === 'event') : all;
  }, [events, ticks, filter]);

  const toggle = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Live feed · detected → forecast → verified</h2>
          <span
            title="A status tick every ~2 min (quiet or active). Disturbances become events with a per-model Earth-arrival forecast and intensity, verified against the real Kp once they arrive. Click a row to expand."
            className="cursor-help text-slate-600 hover:text-slate-400"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {summary && summary.verified > 0 && (
            <div className="flex items-center gap-2 font-mono text-[10px] text-slate-400">
              {mruRate != null && <span className="text-cyan-200">MRU {mruRate}%</span>}
              {mlRate != null && <span className="text-purple-200">ML {mlRate}%</span>}
              {summary.pending > 0 && <span className="text-amber-200">{summary.pending} pending</span>}
            </div>
          )}
          <div className="inline-flex overflow-hidden rounded-md border border-slate-700/60">
            {(['all', 'events'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setFilter(mode)}
                className={`border-r border-slate-700/60 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest transition-colors last:border-r-0 ${
                  filter === mode ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {mode === 'all' ? 'All ticks' : 'Events only'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div className="flex h-20 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Scanning L1 stream…</div>
      ) : items.length === 0 ? (
        <div className="flex h-20 items-center justify-center text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">
          {filter === 'events' ? 'No significant events in the recent stream' : 'No L1 samples yet'}
        </div>
      ) : (
        <div className="flex max-h-[26rem] flex-col gap-1 overflow-y-auto pr-1">
          {items.map(item => (
            <FeedRow key={item.key} item={item} expanded={expanded.has(item.key)} onToggle={() => toggle(item.key)} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Time-ranged history charts (server: /api/playground/forecast-history) ----
type HistoryRange = 'live' | '1d' | '1w' | '1m' | '1y';
const RANGE_OPTIONS: Array<{ id: HistoryRange; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: '1d', label: '1 day' },
  { id: '1w', label: '1 week' },
  { id: '1m', label: '1 month' },
  { id: '1y', label: '1 year' },
];

interface HistoryPoint { t: number; speed: number | null; density: number | null; bt: number | null; bz: number | null }
interface HistoryBand { id: string; startMs: number; endMs: number; gLevel: number; gCode: string; label: string; status: 'pending' | 'verified' | 'unverifiable' }
interface ForecastHistoryResponse {
  range: HistoryRange;
  source: 'rtsw' | 'omni';
  cadenceLabel: string;
  startMs: number;
  endMs: number;
  points: HistoryPoint[];
  mru: HistoryPoint[];
  ml: HistoryPoint[];
  mlAvailable: boolean;
  bands: HistoryBand[];
  catalog: { count: number; verified: number; hits: number; spanDays: number; events: LiveEventDto[] };
  warnings: string[];
}

// Band fill opacity grows with G level so storms stand out, G0 stays a quiet tint.
const BAND_OPACITY = [0.06, 0.16, 0.22, 0.28, 0.34, 0.42];

function formatHistoryTick(ms: number, range: HistoryRange, timeZone = 'UTC') {
  const d = new Date(ms);
  if (range === 'live' || range === '1d') {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  }
  if (range === '1w') {
    return d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', hour12: false, timeZone });
  }
  if (range === '1m') {
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone });
  }
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone });
}

function RangeSelector({ value, onChange, loading }: { value: HistoryRange; onChange: (r: HistoryRange) => void; loading: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Range</span>
      <div className="inline-flex overflow-hidden rounded-md border border-slate-700/60">
        {RANGE_OPTIONS.map(opt => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={`border-r border-slate-700/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors last:border-r-0 ${
              value === opt.id ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-slate-500" aria-hidden="true" />}
    </div>
  );
}

function HistoryChart({
  title,
  unit,
  variable,
  color,
  data,
  range,
}: {
  title: string;
  unit: string;
  variable: 'speed' | 'bz' | 'bt' | 'density';
  color: string;
  data: ForecastHistoryResponse;
  range: HistoryRange;
}) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const series = useMemo(() => {
    const byT = new Map<number, { t: number; measured: number | null; mru: number | null; ml: number | null }>();
    const bucket = (ms: number) => Math.round(ms / 60000) * 60000;
    for (const p of data.points) {
      const t = bucket(p.t);
      const row = byT.get(t) ?? { t, measured: null, mru: null, ml: null };
      row.measured = p[variable];
      byT.set(t, row);
    }
    for (const p of data.mru) {
      const t = bucket(p.t);
      const row = byT.get(t) ?? { t, measured: null, mru: null, ml: null };
      row.mru = p[variable];
      byT.set(t, row);
    }
    for (const p of data.ml) {
      const t = bucket(p.t);
      const row = byT.get(t) ?? { t, measured: null, mru: null, ml: null };
      row.ml = p[variable];
      byT.set(t, row);
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }, [data.points, data.mru, data.ml, variable]);
  const hasData = series.some(d => d.measured !== null || d.mru !== null || d.ml !== null);
  const hasMru = series.some(d => d.mru !== null);
  const hasMl = series.some(d => d.ml !== null);
  const bandLevels = useMemo(() => Array.from(new Set(data.bands.map(b => b.gLevel))).sort((a, b) => a - b), [data.bands]);

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{title}</h3>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-widest">
          <span className="flex items-center gap-1" style={{ color }}><span className="h-0.5 w-3" style={{ backgroundColor: color }} />{data.source === 'omni' ? 'Detected near Earth' : 'Detected L1'}</span>
          {hasMru && <span className="flex items-center gap-1 text-cyan-200"><span className="h-0.5 w-3" style={{ backgroundColor: MRU_COLOR }} />MRU</span>}
          {hasMl && <span className="flex items-center gap-1 text-purple-200"><span className="h-0.5 w-3" style={{ backgroundColor: ML_COLOR }} />ML</span>}
          <span className="text-slate-500">{unit}</span>
        </div>
      </div>
      {hasData ? (
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height={224} minWidth={0} minHeight={224} initialDimension={{ width: 320, height: 224 }}>
            <LineChart data={series} margin={{ top: 6, right: 10, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              {data.bands.map(band => (
                <ReferenceArea
                  key={band.id}
                  x1={band.startMs}
                  x2={band.endMs}
                  fill={scaleStyle(band.gLevel).dot}
                  fillOpacity={BAND_OPACITY[Math.max(0, Math.min(5, band.gLevel))]}
                  strokeOpacity={0}
                  ifOverflow="hidden"
                />
              ))}
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                fontSize={10}
                stroke="#64748b"
                tickMargin={6}
                minTickGap={40}
                tickFormatter={(value: number) => formatHistoryTick(value, range, timeZone)}
              />
              <YAxis domain={['auto', 'auto']} fontSize={10} stroke="#64748b" tickFormatter={(value: number) => value.toFixed(variable === 'speed' ? 0 : 1)} />
              <Tooltip
                contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '12px' }}
                labelFormatter={value => `${new Date(Number(value)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone })} ${tzLabel}`}
                formatter={(value, name) => [Number(value).toFixed(2), String(name)]}
              />
              <Line name={data.source === 'omni' ? 'Detected near Earth' : 'Detected L1'} dataKey="measured" stroke={color} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} type="linear" />
              {hasMru && <Line name="MRU" dataKey="mru" stroke={MRU_COLOR} strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} type="linear" />}
              {hasMl && <Line name="ML" dataKey="ml" stroke={ML_COLOR} strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} type="linear" />}
              <Brush
                dataKey="t"
                height={18}
                travellerWidth={8}
                stroke="#334155"
                fill="#0b1220"
                tickFormatter={(value: number) => formatHistoryTick(value, range, timeZone)}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-56 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">No data in range</div>
      )}
      {bandLevels.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-widest text-slate-500">
          <span>Event bands</span>
          {bandLevels.map(level => (
            <span key={level} className="flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: scaleStyle(level).dot, opacity: 0.5 }} />
              {level === 0 ? 'G0' : `G${level}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CatalogRow({ event }: { event: LiveEventDto }) {
  const forecast = event.predictions[0];
  const v = event.verification;
  const { timeZone } = useContext(TimeZoneContext);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-800/60 py-2 last:border-b-0">
      <span className="w-28 shrink-0 font-mono text-[10px] text-slate-500">{formatDateTimeUtc(event.detectedAtL1Utc, timeZone)}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{event.driver.label}</span>
      {forecast && (
        <span className="flex items-center gap-1 font-mono text-[10px] text-slate-500">
          forecast <GTag level={forecast.gLevel} code={forecast.gCode} dim />
        </span>
      )}
      {v.status === 'verified' && v.observedGLevel != null && v.observedGCode ? (
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-slate-500">
          actual <GTag level={v.observedGLevel} code={v.observedGCode} />
          {v.verdicts[0] && <HitChip model={v.verdicts[0].model} hit={v.verdicts[0].hit} />}
        </span>
      ) : (
        <span className="font-mono text-[9px] uppercase tracking-widest text-amber-200/70">pending</span>
      )}
    </div>
  );
}

function YearCatalog({ catalog }: { catalog: ForecastHistoryResponse['catalog'] }) {
  if (catalog.count === 0) {
    return (
      <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-500">
        Select <span className="text-slate-300">1 month</span> or <span className="text-slate-300">1 year</span> to build the OMNI event catalog.
      </div>
    );
  }
  const rate = catalog.verified > 0 ? Math.round((catalog.hits / catalog.verified) * 100) : null;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Event catalog · last 12 months</h3>
        <div className="flex items-center gap-3 font-mono text-[10px] text-slate-400">
          <span>{catalog.count} events</span>
          {rate != null && <span className="text-emerald-200">{rate}% within ±1 G ({catalog.hits}/{catalog.verified})</span>}
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto pr-1">
        {catalog.events.map(event => (
          <CatalogRow key={event.id} event={event} />
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Detected from OMNI hourly solar wind at Earth; each event&apos;s forecast G (from the V·Bz coupling) is checked against OMNI&apos;s own
        measured Kp. This is the full record of storms studied over the past year.
      </p>
    </div>
  );
}

export function MruLiveForecastPanel({
  plasmaData,
  magData,
  ephemerisData,
  isRefreshing,
  onRefresh,
  timeZone = 'UTC',
  timeZoneLabel = 'UTC',
}: MruLiveForecastPanelProps) {
  const forecast = useMemo(() => {
    const distance = getL1DistanceKm(ephemerisData.latestData);

    const magByTime = new Map<string, NoaaMagnetometerData>();
    for (const sample of magData.timeSeries) {
      magByTime.set(sample.time_tag, sample);
    }

    const l1Samples: L1Sample[] = plasmaData.timeSeries.map(sample => {
      const mag = magByTime.get(sample.time_tag) ?? null;
      return {
        timeUtc: sample.time_tag,
        speedKmS: toNumber(sample.speed),
        densityPerCm3: toNumber(sample.density),
        temperatureK: toNumber(sample.temperature),
        bzNt: toNumber(mag?.bz_gsm),
        btNt: toNumber(mag?.bt),
      };
    });

    const propagated = propagateL1Series(l1Samples, distance.km);

    const latestPlasma = plasmaData.latestData;
    const latestMag = magData.latestData;
    const latestSpeed = toNumber(latestPlasma?.speed);
    const latestBz = toNumber(latestMag?.bz_gsm);
    const latestSample: L1Sample | null = latestPlasma
      ? {
          timeUtc: latestPlasma.time_tag,
          speedKmS: latestSpeed,
          densityPerCm3: toNumber(latestPlasma.density),
          temperatureK: toNumber(latestPlasma.temperature),
          bzNt: latestBz,
          btNt: toNumber(latestMag?.bt),
        }
      : null;
    const latestPropagated = latestSample ? propagateL1Sample(latestSample, distance.km) : null;

    return {
      distance,
      l1Samples,
      propagated,
      status: classifyConditions(latestSpeed, latestBz),
      latest: {
        speed: latestSpeed,
        density: toNumber(latestPlasma?.density),
        bz: latestBz,
        bt: toNumber(latestMag?.bt),
        sampleTimeMs: parseNoaaTimeMs(latestPlasma?.time_tag),
      },
      lagMinutes: latestPropagated?.lagMinutes ?? null,
      arrivalMs: latestPropagated ? new Date(latestPropagated.arrivalTimeUtc).getTime() : null,
    };
  }, [plasmaData, magData, ephemerisData]);

  // Time-ranged history for the charts (Live / 1D / 1W / 1M / 1Y) + event bands +
  // the year-long OMNI catalog. Fetched on range change.
  const [historyRange, setHistoryRange] = useState<HistoryRange>('live');
  const [history, setHistory] = useState<ForecastHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      if (cancelled) return;
      setHistoryLoading(true);
      try {
        const response = await fetch(`/api/playground/forecast-history?range=${historyRange}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) {
          if (!cancelled) setHistoryLoading(false);
          return;
        }
        const body = (await response.json()) as ForecastHistoryResponse;
        if (!cancelled) {
          setHistory(body);
          setHistoryLoading(false);
        }
      } catch {
        if (!cancelled) setHistoryLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [historyRange]);

  const detectedSpeedPoints = forecast.l1Samples
    .map(sample => {
      const t = parseNoaaTimeMs(sample.timeUtc);
      return t === null ? null : { t, value: sample.speedKmS };
    })
    .filter((point): point is { t: number; value: number | null } => point !== null);
  const detectedBzPoints = forecast.l1Samples
    .map(sample => {
      const t = parseNoaaTimeMs(sample.timeUtc);
      return t === null ? null : { t, value: sample.bzNt };
    })
    .filter((point): point is { t: number; value: number | null } => point !== null);
  const speedPoints = forecast.propagated.map(sample => ({ t: new Date(sample.arrivalTimeUtc).getTime(), value: sample.speedKmS }));
  const bzPoints = forecast.propagated.map(sample => ({ t: new Date(sample.arrivalTimeUtc).getTime(), value: sample.bzNt }));

  // ML-corrected overlay (if a model is trained): fetched from the server, which
  // applies the trained artifact to the current L1 feed.
  const [mlForecast, setMlForecast] = useState<{ available: boolean; points: Array<{ t: number; speed: number | null; bz: number | null }> }>({ available: false, points: [] });
  const latestSampleTag = plasmaData.latestData?.time_tag ?? null;
  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/playground/live-forecast-ml', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const body = (await response.json()) as { available: boolean; points: Array<{ t: number; speed: number | null; bz: number | null }> };
        if (!cancelled) setMlForecast({ available: body.available, points: body.points ?? [] });
      } catch {
        /* leave MRU only */
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [latestSampleTag]);
  const mlSpeedPoints = mlForecast.points.map(point => ({ t: point.t, value: point.speed }));
  const mlBzPoints = mlForecast.points.map(point => ({ t: point.t, value: point.bz }));

  // Real, near-Earth observed NOAA storm scales (G/S/R) + measured Kp, fetched
  // server-side. Refreshes whenever the live L1 feed advances.
  const [stormScales, setStormScales] = useState<StormScalesResponse | null>(null);
  const [stormScalesLoading, setStormScalesLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      if (cancelled) return;
      setStormScalesLoading(true);
      try {
        const response = await fetch('/api/playground/storm-scales', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) {
          if (!cancelled) setStormScalesLoading(false);
          return;
        }
        const body = (await response.json()) as StormScalesResponse;
        if (!cancelled) {
          setStormScales(body);
          setStormScalesLoading(false);
        }
      } catch {
        if (!cancelled) setStormScalesLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [latestSampleTag]);

  // HELIOSAT's forecast G scale from the solar wind arriving at Earth (the latest
  // L1 sample, which reaches Earth in ~lag minutes). ML-corrected speed/Bz are used
  // when available, otherwise the directly-measured L1 values.
  const arrivingSpeed = mlForecast.available && mlForecast.points.length > 0
    ? mlForecast.points[mlForecast.points.length - 1].speed ?? forecast.latest.speed
    : forecast.latest.speed;
  const arrivingBz = mlForecast.available && mlForecast.points.length > 0
    ? mlForecast.points[mlForecast.points.length - 1].bz ?? forecast.latest.bz
    : forecast.latest.bz;
  const forecastG = forecastGFromSolarWind(arrivingSpeed, arrivingBz);

  // Accumulating event log: detected L1 disturbances, multi-model arrival/intensity
  // forecasts, and retrospective verification against the real near-Earth Kp.
  const [liveEvents, setLiveEvents] = useState<LiveEventsResponse | null>(null);
  const [liveEventsLoading, setLiveEventsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      if (cancelled) return;
      setLiveEventsLoading(true);
      try {
        const response = await fetch('/api/playground/live-events', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) {
          if (!cancelled) setLiveEventsLoading(false);
          return;
        }
        const body = (await response.json()) as LiveEventsResponse;
        if (!cancelled) {
          setLiveEvents(body);
          setLiveEventsLoading(false);
        }
      } catch {
        if (!cancelled) setLiveEventsLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [latestSampleTag]);

  // Continuous status feed: one tick every ~2 min from the live L1 stream (quiet
  // or active), each carrying the instantaneous forecast G. Ticks that fall inside
  // a detected event window are linked to it so the feed isn't duplicated.
  const feedTicks = useMemo<FeedTickDto[]>(() => {
    const events = liveEvents?.events ?? [];
    const windows = events.map(e => ({ id: e.id, start: new Date(e.detectedAtL1Utc).getTime(), end: new Date(e.endAtL1Utc).getTime() }));
    const samples = forecast.l1Samples
      .map(s => ({ t: parseNoaaTimeMs(s.timeUtc), s }))
      .filter((x): x is { t: number; s: L1Sample } => x.t !== null)
      .sort((a, b) => a.t - b.t);
    const ticks: FeedTickDto[] = [];
    let lastT = Number.NEGATIVE_INFINITY;
    for (const { t, s } of samples) {
      if (t - lastT < 2 * 60 * 1000) continue;
      lastT = t;
      const fg = forecastGFromSolarWind(s.speedKmS, s.bzNt);
      const eventId = windows.find(w => t >= w.start && t <= w.end)?.id ?? null;
      ticks.push({
        t,
        gLevel: fg.scale.level,
        gCode: fg.scale.code,
        speed: s.speedKmS,
        bz: s.bzNt,
        density: s.densityPerCm3,
        bt: s.btNt,
        estKp: fg.kp ? fg.kp.kp : null,
        eventId,
      });
    }
    return ticks;
  }, [forecast.l1Samples, liveEvents]);

  // Wall-clock "now" for the NOW marker on the live charts, aligned with the header
  // clock. Stable initial 0 (SSR-safe), set after mount and ticked every 30 s.
  const [wallNowMs, setWallNowMs] = useState(0);
  useEffect(() => {
    const set = () => setWallNowMs(Date.now());
    const initial = window.setTimeout(set, 0);
    const interval = window.setInterval(set, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);
  // The NOW line is the real current instant; everything to its right is solar wind
  // already measured at L1 but not yet arrived (the forecast lead time). Falls back
  // to the latest L1 sample time before the clock mounts.
  const nowMs = wallNowMs > 0 ? wallNowMs : (forecast.latest.sampleTimeMs ?? (speedPoints.length > 0 ? speedPoints[speedPoints.length - 1].t : 0));
  const style = LEVEL_STYLE[forecast.status.level];
  const StatusIcon = style.icon;
  const hasForecast = forecast.propagated.length > 0;

  return (
    <TimeZoneContext.Provider value={{ timeZone, label: timeZoneLabel }}>
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      {/* Slim status bar */}
      <section className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 shadow-2xl backdrop-blur-xl ${style.ring}`}>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${style.chip}`}>
            <StatusIcon className="h-4 w-4" aria-hidden="true" />
          </div>
          <span className={`inline-flex shrink-0 items-center rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${style.chip}`}>
            {forecast.status.label}
          </span>
          <p className="min-w-0 flex-1 truncate text-sm text-slate-200">{forecast.status.headline}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="flex h-8 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-xs text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>{isRefreshing ? 'Syncing' : 'Refresh'}</span>
        </button>
      </section>

      {/* Compact top row: L1→Earth now + Storm severity side by side */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="mb-2 flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">L1 → Earth right now</h2>
            <span
              title={`The green trace is the real-time signal detected at L1; the cyan MRU and purple ML are shifted to the estimated Earth-arrival time. The shaded band is solar wind already measured at L1 but not yet arrived — your free lead time. ${forecast.distance.isMeasured ? 'L1 distance is from live spacecraft ephemeris.' : `L1 distance uses the nominal ${(NOMINAL_L1_DISTANCE_KM / 1_000_000).toFixed(1)}M km (ephemeris unavailable).`}`}
              className="cursor-help text-slate-600 hover:text-slate-400"
            >
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-300">
            {hasForecast ? (
              <>
                Wind at L1 is{' '}
                <span className="font-mono text-cyan-200">{forecast.latest.speed !== null ? Math.round(forecast.latest.speed) : '—'} km/s</span> → crosses{' '}
                <span className="font-mono text-cyan-200">{(forecast.distance.km / 1_000_000).toFixed(2)}M km</span> in{' '}
                <span className="font-mono text-cyan-200">{formatRelativeMinutes(forecast.lagMinutes)}</span>
                {forecast.arrivalMs !== null && (
                  <>, near <span className="font-mono text-cyan-200">{formatClock(forecast.arrivalMs, timeZone)} {timeZoneLabel}</span></>
                )}
                .
              </>
            ) : (
              'Waiting for a valid L1 solar-wind speed to compute the propagation.'
            )}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <StatRow label="Speed" value={forecast.latest.speed !== null ? Math.round(forecast.latest.speed).toString() : '—'} unit="km/s" />
            <StatRow label="Density" value={forecast.latest.density !== null ? forecast.latest.density.toFixed(1) : '—'} unit="n/cc" />
            <StatRow label="Bz (GSM)" value={forecast.latest.bz !== null ? forecast.latest.bz.toFixed(1) : '—'} unit="nT" />
            <StatRow label="|B|" value={forecast.latest.bt !== null ? forecast.latest.bt.toFixed(1) : '—'} unit="nT" />
            <StatRow label="Transit" value={formatRelativeMinutes(forecast.lagMinutes)} />
            <StatRow label="Arrival" value={forecast.arrivalMs !== null ? formatClock(forecast.arrivalMs, timeZone) : '—'} unit={timeZoneLabel} />
          </div>
        </section>

        {/* Storm severity (NOAA G/S/R scales) */}
        <StormSeveritySection
          forecastG={forecastG.scale}
          forecastKp={forecastG.kp ? forecastG.kp.kp : null}
          scales={stormScales}
          loading={stormScalesLoading}
        />
      </div>

      {/* Range selector for the charts below */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeSelector value={historyRange} onChange={setHistoryRange} loading={historyLoading} />
        {historyRange !== 'live' && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Drag the brush below a chart to scroll through time</span>
        )}
      </div>

      {/* Forecast charts — live shows the propagation overlay; longer ranges show
          measured history with G-coloured event bands and a scroll brush. */}
      {historyRange === 'live' ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
            <div className="mb-2 flex items-center gap-2">
              <Wind className="h-4 w-4 text-cyan-300" aria-hidden="true" />
              <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Speed → Earth</h3>
            </div>
            <ForecastChart title="Detected signal + forecasts" unit="km/s" detectedPoints={detectedSpeedPoints} points={speedPoints} mlPoints={mlSpeedPoints} nowMs={nowMs} />
          </div>
          <div className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
            <div className="mb-2 flex items-center gap-2">
              <Gauge className="h-4 w-4 text-cyan-300" aria-hidden="true" />
              <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Bz → Earth</h3>
            </div>
            <ForecastChart title="Detected signal + forecasts" unit="nT" detectedPoints={detectedBzPoints} points={bzPoints} mlPoints={mlBzPoints} nowMs={nowMs} />
          </div>
        </section>
      ) : history ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <HistoryChart title="Solar-wind speed" unit="km/s" variable="speed" color={MRU_COLOR} data={history} range={historyRange} />
          <HistoryChart title="Bz (north-south field)" unit="nT" variable="bz" color="#a5b4fc" data={history} range={historyRange} />
          <HistoryChart title="Field magnitude |B|" unit="nT" variable="bt" color="#34d399" data={history} range={historyRange} />
          <HistoryChart title="Proton density" unit="n/cc" variable="density" color="#fbbf24" data={history} range={historyRange} />
        </section>
      ) : (
        <div className="flex h-40 items-center justify-center rounded-lg border border-slate-700/50 bg-slate-900/30 font-mono text-[10px] uppercase tracking-widest text-slate-600">
          Loading {RANGE_OPTIONS.find(o => o.id === historyRange)?.label} history…
        </div>
      )}

      {/* Year-long OMNI event catalog (shown for month/year ranges) */}
      {history && history.source === 'omni' && <YearCatalog catalog={history.catalog} />}

      {/* Continuous live feed (2-min ticks) + verified event history */}
      <LiveEventLog ticks={feedTicks} data={liveEvents} loading={liveEventsLoading} />

      {!mlForecast.available && (
        <div className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
          <Info className="h-3.5 w-3.5 shrink-0 text-purple-300/70" aria-hidden="true" />
          <span>Detected L1 and the MRU benchmark are shown. Train the ML model (Models screen) to overlay its correction here.</span>
        </div>
      )}

      {(!plasmaData.isConnected || !magData.isConnected) && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-amber-100/90">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Live L1 feed is degraded — the forecast uses the most recent samples available.</span>
        </div>
      )}

      <div className="flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        <Clock3 className="h-3 w-3" aria-hidden="true" />
        <span>Times in {timeZoneLabel} · decision support only</span>
      </div>
    </main>
    </TimeZoneContext.Provider>
  );
}
