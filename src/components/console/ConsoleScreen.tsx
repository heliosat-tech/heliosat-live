"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Clock3, Database, Download, Eye, EyeOff, Gauge, GitCompareArrows, History, Info, Layers, LineChart as LineChartIcon, Loader2, MoreVertical, RefreshCw, Scale, Timer, Wind } from 'lucide-react';
import { TrainingDataPanel } from './TrainingDataPanel';
import { Area, AreaChart, Brush, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { classifyGFromKp, kpFromCoupling } from '@/services/stormScaleService';

// ---- Server payload (mirror of /api/console) ----
interface DangerDto { level: number; code: string; label: string; estKp: number | null; fraction: number }
interface CurrentDto {
  sampleTimeUtc: string | null;
  speedKmS: number | null;
  densityPerCm3: number | null;
  bzNt: number | null;
  btNt: number | null;
  pdynNpa?: number | null;
  emMvM?: number | null;
  riskAvailable?: boolean;
  sources?: TransitSources;
  missingVariables?: string[];
  qualityFlags?: string[];
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
interface TransitSources {
  speedKmS: string | null;
  bzNt: string | null;
  btNt: string | null;
  densityPerCm3: string | null;
  gLevel: string | null;
}
const EMPTY_TRANSIT_SOURCES: TransitSources = {
  speedKmS: null,
  bzNt: null,
  btNt: null,
  densityPerCm3: null,
  gLevel: null,
};
const EMPTY_SOURCE_TIMES: Record<PhysicalDriverKey, string | null> = {
  speedKmS: null,
  bzNt: null,
  btNt: null,
  densityPerCm3: null,
};
// One solar-wind parcel currently in transit between L1 and Earth (already detected at
// L1, not yet arrived), with its physical drivers and derived G level.
interface InboundDto {
  detectedMs: number;
  arrivalMs: number;
  leadTimeMinutes: number;
  gLevel: number;
  riskAvailable?: boolean;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
  pdynNpa?: number | null;
  emMvM?: number | null;
  sources?: TransitSources;
  sourceTimeByVariable?: Record<string, string | null>;
  missingVariables?: string[];
  qualityFlags?: string[];
}
interface ConsoleResponse {
  generatedAtUtc: string;
  current: CurrentDto | null;
  inbound: InboundDto[];
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
  const riskAvailable = current.riskAvailable ?? true;
  const style = dangerStyle(riskAvailable ? d.level : 0);
  const headline = !riskAvailable
    ? 'G-risk unavailable — required L1 physical variables are missing'
    : d.level === 0
    ? 'Quiet — northward/weak field, nominal wind'
    : `${d.code} ${style.word.toLowerCase()} geomagnetic storm expected`;
  return (
    <section
      className={`rounded-xl border p-5 shadow-2xl ${riskAvailable ? style.chip.split(' ')[0] : 'border-slate-700/60 text-slate-300'}`}
      style={{ background: `radial-gradient(120% 140% at 0% 0%, ${riskAvailable ? style.glow : 'rgba(51,65,85,0.16)'}, rgba(2,6,23,0.6) 60%)` }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-400">Main forecast · 30-min L1 average</div>
          <div className={`mt-1 flex items-baseline gap-3 ${riskAvailable ? style.text : 'text-slate-300'}`}>
            <span className="font-mono text-4xl font-semibold tracking-wider">{riskAvailable ? (d.level === 0 ? 'G0' : d.code) : '—'}</span>
            <span className="text-xl font-semibold uppercase tracking-widest">{riskAvailable ? style.word : 'Risk unavailable'}</span>
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
          {riskAvailable && <div className="absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `calc(${(d.fraction * 100).toFixed(1)}% - 2px)` }} />}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[8px] uppercase tracking-widest text-slate-600">
          <span>Quiet</span><span>G1</span><span>G2</span><span>G3</span><span>G4</span><span>G5</span>
        </div>
      </div>

      <p className="mt-3 max-w-3xl text-[10px] leading-relaxed text-slate-500">
        {riskAvailable
          ? 'This is the smoothed headline forecast. Shorter spikes can still appear below as a stronger inbound peak.'
          : `Missing variables: ${formatMissingVariables(current.missingVariables ?? [])}. Quality flags: ${formatFlags(current.qualityFlags ?? [])}.`}
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

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function fmtCompactKm(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1000)}k`;
  return Math.round(value).toLocaleString('en-US');
}

function fmtCountdown(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

interface InboundParcel {
  detectedMs: number;
  arrivalMs: number;
  leadTimeMinutes: number | null;
  gLevel: number;
  riskAvailable?: boolean;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
  pdynNpa?: number | null;
  emMvM?: number | null;
  sources?: TransitSources;
  sourceTimeByVariable?: Record<string, string | null>;
  missingVariables?: string[];
  qualityFlags?: string[];
}
interface GForecastPoint {
  t: number;
  level: number;
  riskAvailable?: boolean;
  detectedMs: number | null;
  leadTimeMinutes: number | null;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
  pdynNpa?: number | null;
  emMvM?: number | null;
  sources?: TransitSources;
  sourceTimeByVariable?: Record<string, string | null>;
  missingVariables?: string[];
  qualityFlags?: string[];
}
interface TransitCoverageDiagnostics {
  totalBins: number;
  available: { speed: number; bz: number; bt: number; density: number; pdyn: number; em: number; gRisk: number };
  missing: { speed: number; bz: number; bt: number; density: number; pdyn: number; em: number; gRisk: number };
  sourceCounts: Record<string, number>;
  largestGaps: Array<{ variable: string; startUtc: string; endUtc: string; durationMinutes: number; reason: string }>;
}
interface ReplaySeries { window: string; startMs: number; endMs: number; gForecast: GForecastPoint[]; coverage?: TransitCoverageDiagnostics }
interface TransitSample {
  detectedMs: number | null;
  arrivalMs: number;
  leadTimeMinutes: number | null;
  gLevel: number;
  riskAvailable: boolean;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
  pdynNpa: number | null;
  emMvM: number | null;
  sources: TransitSources;
  sourceTimeByVariable: Record<PhysicalDriverKey, string | null>;
  missingVariables: string[];
  qualityFlags: string[];
}
interface TransitPoint { x: number; sample: TransitSample }
interface TransitSegment { start: number; end: number; sample: TransitSample }
type PhysicalDriverKey = 'speedKmS' | 'bzNt' | 'btNt' | 'densityPerCm3';

/** Corridor view: live "now", or a static forecast-G heatmap of a past period. */
const CORRIDOR_WINDOWS: Array<{ key: string; label: string }> = [
  { key: 'live', label: 'Live' },
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 d' },
  { key: '30d', label: '30 d' },
  { key: '90d', label: '3 mo' },
  { key: '1y', label: '1 y' },
];
const NO_DATA_FILL = '#334155';

// NOAA RTSW nominally publishes ~1 sample/min. Past this, the newest L1 sample is treated
// as stale: the live transit corridor only shows parcels still in flight, so when the feed
// lags the newest parcel has already "arrived" and the live view empties out. We surface
// the lag explicitly instead of rendering a bare "no data" state.
const STALE_FEED_THRESHOLD_MIN = 20;

/** Compact age, e.g. "12 min" or "5 h 11 min". */
function fmtFeedAge(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const fmtDay = (ms: number, timeZone: string) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone });

function getVswRiskColor(value: number | null) {
  if (value === null || !Number.isFinite(value)) return NO_DATA_FILL;
  if (value < 400) return '#34d399';
  if (value < 550) return '#a3e635';
  if (value < 700) return '#fbbf24';
  return '#f87171';
}

function getBzRiskColor(value: number | null) {
  if (value === null || !Number.isFinite(value)) return NO_DATA_FILL;
  if (value >= 0) return '#34d399';
  if (value >= -5) return '#a3e635';
  if (value >= -10) return '#fbbf24';
  if (value >= -20) return '#fb923c';
  return '#e879f9';
}

function getBtRiskColor(value: number | null) {
  if (value === null || !Number.isFinite(value)) return NO_DATA_FILL;
  if (value < 5) return '#34d399';
  if (value < 10) return '#a3e635';
  if (value < 20) return '#fbbf24';
  return '#fb923c';
}

function getDensityRiskColor(value: number | null) {
  if (value === null || !Number.isFinite(value)) return NO_DATA_FILL;
  if (value < 5) return '#34d399';
  if (value < 10) return '#a3e635';
  if (value < 30) return '#fbbf24';
  return '#fb923c';
}

function driverRiskRank(key: PhysicalDriverKey, value: number | null) {
  if (value === null || !Number.isFinite(value)) return -1;
  if (key === 'speedKmS') return value < 400 ? 0 : value < 550 ? 1 : value < 700 ? 2 : 3;
  if (key === 'bzNt') return value >= 0 ? 0 : value >= -5 ? 1 : value >= -10 ? 2 : value >= -20 ? 3 : 4;
  if (key === 'btNt') return value < 5 ? 0 : value < 10 ? 1 : value < 20 ? 2 : 3;
  return value < 5 ? 0 : value < 10 ? 1 : value < 30 ? 2 : 3;
}

function driverInterpretation(key: PhysicalDriverKey, value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'sample missing for this variable';
  if (key === 'speedKmS') {
    if (value < 400) return 'slow solar wind';
    if (value < 550) return 'moderate solar-wind speed';
    if (value < 700) return 'fast solar wind';
    return 'high-speed solar wind';
  }
  if (key === 'bzNt') {
    if (value >= 0) return 'northward IMF; low coupling risk';
    if (value >= -5) return 'weak southward IMF';
    if (value >= -10) return 'moderate southward IMF';
    if (value >= -20) return 'strong southward IMF, geoeffective if sustained';
    return 'severe southward IMF, highly geoeffective if sustained';
  }
  if (key === 'btNt') {
    if (value < 5) return 'quiet IMF magnitude';
    if (value < 10) return 'moderate IMF magnitude';
    if (value < 20) return 'elevated IMF magnitude';
    return 'high IMF magnitude';
  }
  if (value < 5) return 'low proton density';
  if (value < 10) return 'moderate proton density';
  if (value < 30) return 'enhanced solar-wind density';
  return 'high solar-wind density';
}

function physicalDriverColor(key: PhysicalDriverKey, value: number | null) {
  if (key === 'speedKmS') return getVswRiskColor(value);
  if (key === 'bzNt') return getBzRiskColor(value);
  if (key === 'btNt') return getBtRiskColor(value);
  return getDensityRiskColor(value);
}

function formatDriverValue(value: number | null, digits: number) {
  return value === null || !Number.isFinite(value) ? 'missing' : value.toFixed(digits);
}

function thinTransitPoints(points: TransitPoint[], target: number, riskFor: (sample: TransitSample) => number) {
  if (points.length <= target) return points;
  const bucket = Math.ceil(points.length / target);
  const out: TransitPoint[] = [];
  for (let i = 0; i < points.length; i += bucket) {
    let best = points[i];
    let bestRank = riskFor(best.sample);
    for (let j = i + 1; j < Math.min(i + bucket, points.length); j += 1) {
      const rank = riskFor(points[j].sample);
      if (rank > bestRank) {
        best = points[j];
        bestRank = rank;
      }
    }
    out.push(best);
  }
  return out;
}

function pointsToSegments(points: TransitPoint[]): TransitSegment[] {
  if (points.length === 0) return [];
  const sorted = points.slice().sort((a, b) => a.x - b.x);
  return sorted.map((point, index) => {
    const prev = sorted[index - 1];
    const next = sorted[index + 1];
    const start = index === 0 ? 0 : clamp01((prev.x + point.x) / 2);
    const end = index === sorted.length - 1 ? 1 : clamp01((point.x + next.x) / 2);
    return { start, end: Math.max(end, start), sample: point.sample };
  });
}

const PHYSICAL_DRIVER_ROWS: Array<{
  key: PhysicalDriverKey;
  label: string;
  unit: string;
  digits: number;
}> = [
  { key: 'speedKmS', label: 'Vsw', unit: 'km/s', digits: 0 },
  { key: 'bzNt', label: 'Bz GSM', unit: 'nT', digits: 1 },
  { key: 'btNt', label: '|B|', unit: 'nT', digits: 1 },
  { key: 'densityPerCm3', label: 'np', unit: 'cm^-3', digits: 1 },
];

function sampleValue(sample: TransitSample, key: PhysicalDriverKey) {
  return sample[key];
}

function normalizeSourceTimes(sourceTimes: Record<string, string | null> | undefined): Record<PhysicalDriverKey, string | null> {
  if (!sourceTimes) return EMPTY_SOURCE_TIMES;
  return {
    speedKmS: sourceTimes.speedKmS ?? sourceTimes.speed ?? null,
    bzNt: sourceTimes.bzNt ?? sourceTimes.bz ?? null,
    btNt: sourceTimes.btNt ?? sourceTimes.bt ?? null,
    densityPerCm3: sourceTimes.densityPerCm3 ?? sourceTimes.density ?? null,
  };
}

function tooltipTime(ms: number | null, timeZone: string, tzLabel: string) {
  if (ms === null || !Number.isFinite(ms)) return 'unavailable';
  return `${fmtDateTime(new Date(ms).toISOString(), timeZone)} ${tzLabel}`;
}

function sourceLabel(source: string | null | undefined) {
  return source && source.trim() ? source : 'no source for this value';
}

function formatFlags(flags: string[]) {
  return flags.length ? flags.join(', ') : 'none';
}

function formatMissingVariables(missing: string[]) {
  return missing.length ? missing.join(', ') : 'none';
}

function gTooltip(sample: TransitSample, timeZone: string, tzLabel: string) {
  const style = dangerStyle(sample.gLevel);
  return [
    sample.riskAvailable ? `G risk: G${sample.gLevel} ${style.word.toLowerCase()}` : 'G risk: unavailable',
    `Detected at L1: ${tooltipTime(sample.detectedMs, timeZone, tzLabel)}`,
    `ETA at Earth's bow-shock nose: ${tooltipTime(sample.arrivalMs, timeZone, tzLabel)}`,
    `Transit lead: ${sample.leadTimeMinutes !== null ? `${sample.leadTimeMinutes} min` : 'unavailable'}`,
    `Source: ${sourceLabel(sample.sources.gLevel)}`,
    `Missing variables: ${formatMissingVariables(sample.missingVariables)}`,
    `Quality flags: ${formatFlags(sample.qualityFlags)}`,
    `Interpretation: ${sample.riskAvailable ? 'derived geomagnetic-risk proxy from propagated solar-wind drivers' : 'not derived because the required L1 drivers are missing'}`,
  ].join('\n');
}

function driverTooltip(
  row: (typeof PHYSICAL_DRIVER_ROWS)[number],
  sample: TransitSample,
  timeZone: string,
  tzLabel: string,
) {
  const value = sampleValue(sample, row.key);
  return [
    `${row.label}: ${formatDriverValue(value, row.digits)} ${row.unit}`,
    `Detected at L1: ${tooltipTime(sample.detectedMs, timeZone, tzLabel)}`,
    `Source time for ${row.label}: ${tooltipTime(sample.sourceTimeByVariable[row.key] ? new Date(sample.sourceTimeByVariable[row.key]!).getTime() : null, timeZone, tzLabel)}`,
    `ETA at Earth's bow-shock nose: ${tooltipTime(sample.arrivalMs, timeZone, tzLabel)}`,
    `Transit lead: ${sample.leadTimeMinutes !== null ? `${sample.leadTimeMinutes} min` : 'unavailable'}`,
    `G risk proxy: ${sample.riskAvailable ? `G${sample.gLevel}` : 'unavailable'}`,
    `Source: ${sourceLabel(sample.sources[row.key])}`,
    `Missing variables: ${formatMissingVariables(sample.missingVariables)}`,
    `Quality flags: ${formatFlags(sample.qualityFlags)}`,
    `Interpretation: ${driverInterpretation(row.key, value)}`,
  ].join('\n');
}

function TransitBand({
  label,
  unit,
  segments,
  heightClass,
  colorFor,
  titleFor,
  liveMarkers,
  ariaLabel,
}: {
  label: string;
  unit?: string;
  segments: TransitSegment[];
  heightClass: string;
  colorFor: (sample: TransitSample) => string;
  titleFor: (sample: TransitSample) => string;
  liveMarkers?: boolean;
  ariaLabel: string;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-2 pr-1 font-mono text-[9px] uppercase tracking-widest text-slate-500">
        <span className="truncate text-slate-400">{label}</span>
        {unit && <span className="shrink-0 text-[8px] text-slate-600">{unit}</span>}
      </div>
      <div
        className={`relative w-full overflow-hidden rounded-md border border-slate-700/70 bg-slate-900/70 shadow-inner ${heightClass}`}
        aria-label={ariaLabel}
      >
        {segments.length > 0 ? segments.map((segment, index) => {
          const title = titleFor(segment.sample);
          return (
            <div
              key={`${segment.sample.arrivalMs}-${index}`}
              className="absolute top-0 h-full"
              style={{
                left: `${(segment.start * 100).toFixed(3)}%`,
                width: `${Math.max((segment.end - segment.start) * 100, 0.06).toFixed(3)}%`,
                backgroundColor: colorFor(segment.sample),
              }}
              title={title}
              aria-label={title}
            />
          );
        }) : (
          <div className="absolute inset-0" style={{ backgroundColor: NO_DATA_FILL }} title="No propagated sample data available" />
        )}
        <div className="pointer-events-none absolute inset-0 opacity-25 mix-blend-overlay" style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.14) 0 1px, transparent 1px 24px)' }} />
        {liveMarkers && (
          <>
            <div className="pointer-events-none absolute inset-y-0 left-0 w-20 bg-gradient-to-r from-black/40 to-transparent" />
            <div className="pointer-events-none absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-black/50 to-transparent" />
            <div className="absolute left-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-white/40 bg-slate-950/70 text-[8px] font-semibold text-cyan-50">L1</div>
            <div className="absolute right-2 top-1/2 h-6 w-6 -translate-y-1/2 rounded-full border border-white/50 bg-[radial-gradient(circle_at_32%_30%,#f8fafc_0%,#60a5fa_22%,#1d4ed8_60%,#0b1220_85%)] shadow-[0_0_18px_rgba(56,189,248,0.4)]" />
            <div className="absolute right-[11px] top-0 h-full w-px bg-white/70 animate-pulse" />
          </>
        )}
        {!liveMarkers && <div className="pointer-events-none absolute right-0 top-0 h-full w-px bg-white/40" />}
      </div>
    </>
  );
}

/**
 * The L1→Earth corridor as a CONTINUOUS band coloured by the forecast G level of the wind
 * in transit. In LIVE mode each in-transit parcel is a colour stop at its current position
 * (0 = just detected at L1, 1 = arriving at Earth); a fresh disturbance appears at the L1
 * edge and slides toward Earth over the next ~lag minutes. In REPLAY mode the band is a
 * static heatmap of the forecast-G history over a chosen window (time ascending,
 * left → right), so a whole month/year of geomagnetic activity is read at a glance.
 */
function CmeTransitScene({ current, inbound, nowMs }: { current: CurrentDto; inbound: InboundParcel[]; nowMs: number }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const sampleMs = current.sampleTimeUtc ? new Date(current.sampleTimeUtc).getTime() : Number.NaN;
  const arrivalMs = current.arrivalUtc ? new Date(current.arrivalUtc).getTime() : Number.NaN;
  const hasTransit = Number.isFinite(sampleMs) && Number.isFinite(arrivalMs) && arrivalMs > sampleMs && current.speedKmS !== null;
  const effectiveNow = nowMs > 0 ? nowMs : sampleMs;
  const progress = hasTransit ? clamp01((effectiveNow - sampleMs) / (arrivalMs - sampleMs)) : 0;
  const totalTransitMs = hasTransit ? arrivalMs - sampleMs : null;
  const remainingMs = hasTransit ? Math.max(0, arrivalMs - effectiveNow) : null;
  const remainingKm = hasTransit ? current.l1DistanceKm * (1 - progress) : null;
  const elapsedKm = hasTransit ? current.l1DistanceKm * progress : null;
  const lagMin = current.lagMinutes;

  // ---- Replay state ----
  const [windowKey, setWindowKey] = useState('live');
  const [replay, setReplay] = useState<ReplaySeries | null>(null);
  const replayCache = useRef<Map<string, ReplaySeries>>(new Map());
  const isReplay = windowKey !== 'live';
  // Trust the loaded series only if it matches the current window (avoids a stale flash).
  const activeReplay = isReplay && replay && replay.window === windowKey ? replay : null;
  const replayLoading = isReplay && !activeReplay;
  const span = activeReplay ? Math.max(1, activeReplay.endMs - activeReplay.startMs) : 1;

  // Load the forecast-G history from the lightweight corridor endpoint. Cached per window in
  // a ref, so re-selecting a window already downloaded is instant. Every setState runs inside
  // the async callback, so the effect never sets state synchronously.
  useEffect(() => {
    if (windowKey === 'live') return;
    let cancelled = false;
    (async () => {
      const cached = replayCache.current.get(windowKey);
      if (cached) { if (!cancelled) setReplay(cached); return; }
      try {
        const r = await fetch(`/api/console/corridor?window=${windowKey}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!r.ok || cancelled) return;
        const s = (await r.json()) as { startMs: number; endMs: number; gForecast?: GForecastPoint[]; coverage?: TransitCoverageDiagnostics };
        if (cancelled) return;
        const series: ReplaySeries = { window: windowKey, startMs: s.startMs, endMs: s.endMs, gForecast: (s.gForecast ?? []).slice().sort((a, b) => a.t - b.t), coverage: s.coverage };
        replayCache.current.set(windowKey, series);
        setReplay(series);
      } catch {
        /* leave empty -> "no data" state */
      }
    })();
    return () => { cancelled = true; };
  }, [windowKey]);

  // Evenly-spaced date ticks under the heatmap.
  const replayTicks = useMemo(() => {
    if (!activeReplay) return [] as Array<{ f: number; ms: number }>;
    const n = 5;
    return Array.from({ length: n }, (_, i) => { const f = i / (n - 1); return { f, ms: activeReplay.startMs + f * span }; });
  }, [activeReplay, span]);

  // Strongest forecast G anywhere in the window (the period's worst storm) — drives the banner.
  const windowPeak = useMemo(() => {
    if (!activeReplay) return { level: 0, atMs: null as number | null, hasData: false, hasRiskData: false };
    let level = 0;
    let atMs: number | null = null;
    let hasRiskData = false;
    for (const p of activeReplay.gForecast) {
      const available = p.riskAvailable ?? (p.speedKmS !== null && p.bzNt !== null);
      if (available) hasRiskData = true;
      if (available && p.level > level) { level = p.level; atMs = p.t; }
    }
    return { level, atMs, hasData: activeReplay.gForecast.length > 0, hasRiskData };
  }, [activeReplay]);

  const replayPoints = useMemo((): TransitPoint[] => {
    if (!activeReplay) return [] as TransitPoint[];
    return activeReplay.gForecast
      .map(p => ({
        x: clamp01((p.t - activeReplay.startMs) / span),
        sample: {
          detectedMs: p.detectedMs ?? null,
          arrivalMs: p.t,
          leadTimeMinutes: p.leadTimeMinutes ?? null,
          gLevel: p.level,
          riskAvailable: p.riskAvailable ?? (p.speedKmS !== null && p.bzNt !== null),
          speedKmS: p.speedKmS ?? null,
          bzNt: p.bzNt ?? null,
          btNt: p.btNt ?? null,
          densityPerCm3: p.densityPerCm3 ?? null,
          pdynNpa: p.pdynNpa ?? null,
          emMvM: p.emMvM ?? null,
          sources: p.sources ?? EMPTY_TRANSIT_SOURCES,
          sourceTimeByVariable: normalizeSourceTimes(p.sourceTimeByVariable),
          missingVariables: p.missingVariables ?? [],
          qualityFlags: p.qualityFlags ?? [],
        },
      }))
      .sort((a, b) => a.x - b.x);
  }, [activeReplay, span]);

  const livePoints = useMemo((): TransitPoint[] => inbound
    .map((p): TransitPoint | null => {
      const spanMs = p.arrivalMs - p.detectedMs;
      if (spanMs <= 0) return null;
      const x = (effectiveNow - p.detectedMs) / spanMs;
      if (x < 0 || x > 1) return null;
      return {
        x,
        sample: {
          detectedMs: p.detectedMs,
          arrivalMs: p.arrivalMs,
          leadTimeMinutes: p.leadTimeMinutes ?? Math.round(spanMs / 60000),
          gLevel: p.gLevel,
          riskAvailable: p.riskAvailable ?? (p.speedKmS !== null && p.bzNt !== null),
          speedKmS: p.speedKmS,
          bzNt: p.bzNt,
          btNt: p.btNt,
          densityPerCm3: p.densityPerCm3,
          pdynNpa: p.pdynNpa ?? null,
          emMvM: p.emMvM ?? null,
          sources: p.sources ?? EMPTY_TRANSIT_SOURCES,
          sourceTimeByVariable: normalizeSourceTimes(p.sourceTimeByVariable),
          missingVariables: p.missingVariables ?? [],
          qualityFlags: p.qualityFlags ?? [],
        },
      };
    })
    .filter((p): p is TransitPoint => p !== null)
    .sort((a, b) => a.x - b.x), [inbound, effectiveNow]);

  const transitPoints = isReplay ? replayPoints : livePoints;
  const gSegments = useMemo(() => pointsToSegments(thinTransitPoints(transitPoints, 2000, sample => sample.riskAvailable ? sample.gLevel : -1)), [transitPoints]);
  const driverSegments = useMemo(() => {
    const result = {} as Record<PhysicalDriverKey, TransitSegment[]>;
    for (const row of PHYSICAL_DRIVER_ROWS) {
      result[row.key] = pointsToSegments(thinTransitPoints(transitPoints, 2000, sample => driverRiskRank(row.key, sampleValue(sample, row.key))));
    }
    return result;
  }, [transitPoints]);
  const coverageSummary = useMemo(() => {
    const coverage = activeReplay?.coverage;
    if (!coverage || coverage.totalBins <= 0) return null;
    const pct = (available: number) => `${Math.round((available / coverage.totalBins) * 100)}%`;
    const gapText = coverage.largestGaps.length
      ? coverage.largestGaps.slice(0, 4).map(gap => `${gap.variable}: ${fmtDateTime(gap.startUtc, timeZone)} → ${fmtClock(gap.endUtc, timeZone)} (${gap.durationMinutes} min)`).join('\n')
      : 'No missing-variable gaps in this replay window.';
    return {
      text: `data coverage · Vsw ${pct(coverage.available.speed)} · Bz ${pct(coverage.available.bz)} · |B| ${pct(coverage.available.bt)} · np ${pct(coverage.available.density)} · G-risk ${pct(coverage.available.gRisk)}`,
      title: `Largest remaining gaps\n${gapText}`,
    };
  }, [activeReplay, timeZone]);

  // Live corridor inbound peak, derived from the same in-transit parcels as the bars.
  const liveCorridor = useMemo(() => {
    let level = 0;
    let eta = Number.POSITIVE_INFINITY;
    let hasRiskData = false;
    for (const p of inbound) {
      if (p.arrivalMs <= effectiveNow) continue;
      if (!(p.riskAvailable ?? (p.speedKmS !== null && p.bzNt !== null))) continue;
      hasRiskData = true;
      if (p.gLevel > level) { level = p.gLevel; eta = p.arrivalMs; }
      else if (p.gLevel === level && level > 0 && p.arrivalMs < eta) eta = p.arrivalMs;
    }
    return { peak: { level, eta }, hasData: inbound.length > 0, hasRiskData };
  }, [inbound, effectiveNow]);

  const hasData = isReplay ? windowPeak.hasData : liveCorridor.hasData;
  const peakStyle = dangerStyle(isReplay ? windowPeak.level : liveCorridor.peak.level);

  // Live-feed staleness: when the newest L1 sample is older than the threshold, nothing is
  // still in transit (it already "arrived"), so the live corridor empties. Detect it here
  // so the empty state can say "feed behind" rather than the cryptic "no forecast data".
  const feedAgeMin = Number.isFinite(sampleMs) && nowMs > 0 ? Math.max(0, Math.round((nowMs - sampleMs) / 60000)) : null;
  const feedStale = !isReplay && feedAgeMin !== null && feedAgeMin > STALE_FEED_THRESHOLD_MIN;

  const tile = (label: string, value: ReactNode, accent = false) => (
    <div className="rounded-md border border-slate-800 bg-slate-950/55 p-2">
      <div className="font-mono text-[8px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`mt-0.5 font-mono text-xs sm:text-sm ${accent ? 'text-cyan-100' : 'text-slate-100'}`}>{value}</div>
    </div>
  );

  return (
    <section className="overflow-hidden rounded-xl border border-cyan-400/20 bg-slate-950/40 p-4 shadow-2xl shadow-black/20">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Timer className="h-4 w-4 flex-shrink-0 text-cyan-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-200">CME transit · L1 to Earth</h2>
            <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">L1 measurements shifted to estimated Earth bow-shock arrival time</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 font-mono text-[10px] uppercase tracking-widest">
          {isReplay ? (
            <span className="rounded border border-violet-400/30 bg-violet-400/10 px-2 py-1 text-violet-200">Replay · {windowKey}</span>
          ) : (
            <>
              <GTag level={current.danger.level} code={current.danger.code} />
              <span className="rounded border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-cyan-100">{current.speedKmS !== null ? `${Math.round(current.speedKmS)} km/s` : 'speed —'}</span>
              <span className="rounded border border-slate-700/70 bg-slate-900/50 px-2 py-1 text-slate-400">{current.distanceIsMeasured ? 'measured L1' : 'nominal L1'}</span>
            </>
          )}
        </div>
      </div>

      {/* Live / replay window selector */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-slate-700/60">
          {CORRIDOR_WINDOWS.map(w => (
            <button key={w.key} type="button" onClick={() => setWindowKey(w.key)}
              className={`px-2 py-1 font-mono text-[9px] uppercase tracking-widest transition ${windowKey === w.key ? 'bg-cyan-400/15 text-cyan-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {!isReplay && liveCorridor.hasData && liveCorridor.peak.level > 0 && Number.isFinite(liveCorridor.peak.eta) ? (
        <div className={`mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${peakStyle.chip}`}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: peakStyle.dot }} />
          G{liveCorridor.peak.level} {peakStyle.word.toLowerCase()} inbound
          <span className="text-slate-400">· reaches Earth in {fmtCountdown(liveCorridor.peak.eta - effectiveNow)} ({fmtClock(new Date(liveCorridor.peak.eta).toISOString(), timeZone)} {tzLabel})</span>
        </div>
      ) : isReplay && windowPeak.hasData && windowPeak.level > 0 && windowPeak.atMs !== null ? (
        <div className={`mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${peakStyle.chip}`}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: peakStyle.dot }} />
          Peak G{windowPeak.level} {peakStyle.word.toLowerCase()} in the last {windowKey}
          <span className="text-slate-400">· {fmtDateTime(new Date(windowPeak.atMs).toISOString(), timeZone)} {tzLabel}</span>
        </div>
      ) : hasData && (isReplay ? !windowPeak.hasRiskData : !liveCorridor.hasRiskData) ? (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-slate-700/50 bg-slate-800/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: NO_DATA_FILL }} />
          G-risk not derived — required physical variables are missing
        </div>
      ) : hasData ? (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/[0.07] px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-emerald-200">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dangerStyle(0).dot }} />
          {isReplay ? `Quiet — no storms reached G1 in the last ${windowKey}` : 'Quiet — only G0 wind in transit'}
        </div>
      ) : feedStale && feedAgeMin !== null ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-400/30 bg-amber-400/[0.07] px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-200">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          L1 feed behind by {fmtFeedAge(feedAgeMin)}
          <span className="text-amber-200/70">· newest sample {current.sampleTimeUtc ? fmtClock(current.sampleTimeUtc, timeZone) : '--:--'} {tzLabel} · nothing currently in transit</span>
        </div>
      ) : (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-slate-700/50 bg-slate-800/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: NO_DATA_FILL }} />
          {replayLoading ? 'Loading forecast history…' : 'No forecast data at this time'}
        </div>
      )}

      <div className="mb-1 grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-2 font-mono text-[9px] uppercase tracking-widest text-slate-500">
        <div />
        <div className="flex items-center justify-between">
          {isReplay ? (
            <>
              <span>{activeReplay ? fmtDay(activeReplay.startMs, timeZone) : '—'}</span>
              <span className="hidden text-slate-600 sm:inline">arrival timeline · {windowKey}</span>
              <span>{activeReplay ? `${fmtDay(activeReplay.endMs, timeZone)} · now` : 'now'}</span>
            </>
          ) : (
            <>
              <span>L1 · active RTSW</span>
              <span className="hidden text-slate-600 sm:inline">detected → in transit → Earth&apos;s bow-shock nose</span>
              <span>Earth bow shock</span>
            </>
          )}
        </div>
      </div>
      {/* Physical rows are measured L1 drivers shifted to Earth's bow-shock arrival time; G risk is a derived proxy. */}
      <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-2 gap-y-1.5">
        <TransitBand
          label="G risk"
          unit="derived"
          segments={gSegments}
          heightClass="h-16 sm:h-20"
          colorFor={sample => sample.riskAvailable ? dangerStyle(sample.gLevel).dot : NO_DATA_FILL}
          titleFor={sample => gTooltip(sample, timeZone, tzLabel)}
          liveMarkers={!isReplay}
          ariaLabel={isReplay ? `Derived G-risk arrival timeline for the last ${windowKey}.` : `L1 to Earth corridor coloured by derived G risk. ${liveCorridor.peak.level > 0 ? `G${liveCorridor.peak.level} present.` : 'Quiet.'}`}
        />
        {PHYSICAL_DRIVER_ROWS.map(row => (
          <TransitBand
            key={row.key}
            label={row.label}
            unit={row.unit}
            segments={driverSegments[row.key]}
            heightClass="h-3.5 sm:h-4"
            colorFor={sample => physicalDriverColor(row.key, sampleValue(sample, row.key))}
            titleFor={sample => driverTooltip(row, sample, timeZone, tzLabel)}
            ariaLabel={`${row.label} propagated physical-driver bar`}
          />
        ))}
      </div>
      {isReplay ? (
        replayTicks.length > 0 && (
          <div className="mt-1 grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-2">
            <div />
            <div className="flex justify-between font-mono text-[8px] tabular-nums text-slate-600">
              {replayTicks.map((t, i) => (
                <span key={i} className={i === replayTicks.length - 1 ? 'text-slate-400' : ''}>
                  {i === replayTicks.length - 1 ? 'now' : fmtDay(t.ms, timeZone)}
                </span>
              ))}
            </div>
          </div>
        )
      ) : (
        <div className="mt-1 grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-2">
          <div />
          <div className="flex justify-between font-mono text-[8px] uppercase tracking-widest text-slate-600">
            <span>{lagMin !== null ? `detected (+${lagMin}m)` : 'detected'}</span>
            <span>{lagMin !== null ? `+${Math.round(lagMin / 2)}m` : 'in transit'}</span>
            <span className="text-slate-400">arriving now</span>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[8px] uppercase tracking-widest text-slate-500">
        <span className="text-slate-600">G scale</span>
        {DANGER.map((d, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: d.dot }} />G{i}
          </span>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[8px] uppercase tracking-widest text-slate-500">
        <span className="text-slate-600">driver thresholds</span>
        <span>Vsw 400/550/700</span>
        <span>Bz 0/-5/-10/-20</span>
        <span>|B| 5/10/20</span>
        <span>np 5/10/30</span>
      </div>
      {coverageSummary && (
        <div className="mt-1 font-mono text-[8px] uppercase tracking-widest text-slate-500" title={coverageSummary.title}>
          {coverageSummary.text}
        </div>
      )}

      {isReplay ? (
        <div className="mt-3 rounded border border-slate-800 bg-slate-950/45 p-2 font-mono text-[10px] text-slate-400">
          {activeReplay
            ? <>Propagated physical-driver heatmap for the last <span className="text-slate-200">{windowKey}</span> ({fmtDateTime(new Date(activeReplay.startMs).toISOString(), timeZone)} → {fmtDateTime(new Date(activeReplay.endMs).toISOString(), timeZone)} {tzLabel}). The G row is derived risk; the lower rows show inbound L1 physical variables shifted to estimated Earth bow-shock arrival.</>
            : (replayLoading ? 'Loading forecast history…' : 'No forecast history available for this window.')}
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tile('Detected at L1', <>{current.sampleTimeUtc ? fmtClock(current.sampleTimeUtc, timeZone) : '--:--'} <span className="text-[8px] text-slate-500">{tzLabel}</span></>)}
            {tile('Bow-shock ETA', <>{current.arrivalUtc ? fmtClock(current.arrivalUtc, timeZone) : '--:--'} <span className="text-[8px] text-slate-500">{tzLabel}</span></>, true)}
            {tile('Countdown', remainingMs !== null ? fmtCountdown(remainingMs) : '—')}
            {tile('Distance left', <>{fmtCompactKm(remainingKm)} <span className="text-[8px] text-slate-500">km</span></>)}
          </div>
          <div className="mt-2 grid gap-2 text-[10px] sm:grid-cols-3">
            <div className="rounded border border-slate-800 bg-slate-950/45 p-2 font-mono text-slate-400">
              <span className="uppercase tracking-widest text-slate-600">Travelled</span>
              <span className="ml-2 text-slate-200">{fmtCompactKm(elapsedKm)} km</span>
            </div>
            <div className="rounded border border-slate-800 bg-slate-950/45 p-2 font-mono text-slate-400">
              <span className="uppercase tracking-widest text-slate-600">Total L1 path</span>
              <span className="ml-2 text-slate-200">{fmtCompactKm(current.l1DistanceKm)} km</span>
            </div>
            <div className="rounded border border-slate-800 bg-slate-950/45 p-2 font-mono text-slate-400">
              <span className="uppercase tracking-widest text-slate-600">Transit model</span>
              <span className="ml-2 text-slate-200">MRU {totalTransitMs !== null ? fmtCountdown(totalTransitMs) : '—'}</span>
            </div>
          </div>
          {!hasTransit && (
            <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Need a valid L1 speed and Earth-arrival estimate to project the corridor.</p>
          )}
        </>
      )}
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

interface ValidationArchiveInfo {
  rows: number;
  startUtc: string | null;
  endUtc: string | null;
  updatedAtUtc: string | null;
  resolution: string;
  role: string;
  variables: string[];
  source: string;
}
interface ValidationDataDto {
  generatedAtUtc: string;
  archives: {
    ace: ValidationArchiveInfo;
    omni: ValidationArchiveInfo;
    geo: ValidationArchiveInfo;
  };
  studies: {
    arrivalTiming: {
      source: string;
      interval: { startUtc: string; stopUtc: string; label: string } | null;
      statsSpan: { startUtc: string; stopUtc: string; multiYear: boolean } | null;
      samples: number | null;
      role: string;
      metrics: string[];
    };
    mlArrival: {
      role: string;
      train: { startUtc: string; endUtc: string; rows: number };
      validation: { startUtc: string; endUtc: string; rows: number };
      generatedAtUtc: string | null;
      metrics: string[];
    } | null;
    timingDistribution: { coverage: { startUtc: string; stopUtc: string } | null; samples: number | null; role: string; metrics: string[] };
    variableAlignment: { role: string; metrics: string[] };
    gProxy: { role: string; metrics: string[]; caveat: string };
  };
}

interface PhysicalDriverIntervalSummary {
  start_time: string;
  end_time: string;
  duration_minutes: number;
  peak_value: number | null;
  max_vsw: number | null;
  min_bz: number | null;
  max_bt: number | null;
  max_np: number | null;
  max_pdyn: number | null;
  max_em: number | null;
  integrated_southward_bz_nt_min: number;
  integrated_em_mvm_min: number;
  sample_count: number;
}
interface PhysicalDriverThresholdStat {
  id: string;
  event_type: string;
  threshold: string;
  unit: string;
  count: number;
  total_duration_minutes: number;
  longest_interval_minutes: number;
  peak_value: number | null;
  peak_kind: 'maximum' | 'minimum';
  integrated_value_minutes: number | null;
  first_occurrence: string | null;
  last_occurrence: string | null;
  strongest_event: PhysicalDriverIntervalSummary | null;
}
interface PhysicalDriverCompoundStat {
  id: string;
  event_type: string;
  threshold: string;
  count: number;
  total_duration_minutes: number;
  longest_interval_minutes: number;
  peak_drivers: {
    max_vsw: number | null;
    min_bz: number | null;
    max_bt: number | null;
    max_np: number | null;
    max_pdyn: number | null;
    max_em: number | null;
  };
  strongest_event: PhysicalDriverIntervalSummary | null;
  strongest_event_summary: string | null;
}
interface PhysicalDriverOccurrenceStrip {
  id: string;
  label: string;
  color: string;
  intervals: Array<{ start_ms: number; end_ms: number; level: number }>;
}
interface PhysicalDriverStatsDto {
  generated_at: string;
  window: string;
  start_ms: number;
  end_ms: number;
  source: 'propagated_l1_samples';
  target: 'earth_bow_shock_nose';
  sample_count: number;
  cadence_minutes: number;
  stats: {
    speed: PhysicalDriverThresholdStat[];
    bz: PhysicalDriverThresholdStat[];
    bt: PhysicalDriverThresholdStat[];
    density: PhysicalDriverThresholdStat[];
    pdyn: PhysicalDriverThresholdStat[];
    em: PhysicalDriverThresholdStat[];
    compound: PhysicalDriverCompoundStat[];
  };
  summary: {
    strongest_southward_bz: PhysicalDriverIntervalSummary | null;
    strongest_high_speed: PhysicalDriverIntervalSummary | null;
    strongest_pressure: PhysicalDriverIntervalSummary | null;
    strongest_coupling: PhysicalDriverIntervalSummary | null;
    total_hazardous_minutes: number;
  };
  occurrence_strips: PhysicalDriverOccurrenceStrip[];
  limitations: string[];
}

const PHYSICAL_DRIVER_WINDOWS: Array<{ key: string; label: string }> = [
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 d' },
  { key: '30d', label: '30 d' },
  { key: '90d', label: '90 d' },
  { key: '1y', label: '1 y' },
];

function fmtDurationMinutes(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)} d`;
}

function fmtDriverPeak(row: PhysicalDriverThresholdStat | PhysicalDriverCompoundStat) {
  if ('peak_value' in row) {
    if (row.peak_value === null) return '—';
    const digits = row.unit === 'nPa' || row.unit === 'mV/m' ? 2 : row.unit === 'cm^-3' ? 1 : 0;
    return `${row.peak_value.toFixed(digits)} ${row.unit}`;
  }
  const p = row.peak_drivers;
  const parts = [
    p.max_vsw !== null ? `${p.max_vsw.toFixed(0)} km/s` : null,
    p.min_bz !== null ? `Bz ${p.min_bz.toFixed(1)} nT` : null,
    p.max_em !== null ? `Em ${p.max_em.toFixed(2)}` : null,
    p.max_pdyn !== null ? `Pdyn ${p.max_pdyn.toFixed(2)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

function fmtIntervalRange(interval: PhysicalDriverIntervalSummary | null, timeZone: string, tzLabel: string) {
  if (!interval) return '—';
  return `${fmtDateTime(interval.start_time, timeZone)} → ${fmtClock(interval.end_time, timeZone)} ${tzLabel}`;
}

function fmtDateOnly(iso: string | null) {
  if (!iso) return 'missing';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'missing';
  return new Date(ms).toISOString().slice(0, 10);
}

// ---- ML arrival-time residual model artifacts (/api/console/ml) ----
// Generated offline by `python -m ml.arrival_residual.train`; every number shown in the
// Benchmark-vs-ML sections comes from these JSONs, never from UI constants.
interface MlErrorSummary { samples: number; biasMin: number; maeMin: number; rmseMin: number; medianAbsMin: number; p90AbsMin: number; within10Pct: number; within20Pct: number; within30Pct: number }
interface MlRegimeRow { key: string; label: string; n: number; sharePct: number; leadMin: number; benchmark: MlErrorSummary; ml: MlErrorSummary }
interface MlMetrics {
  generatedAtUtc: string;
  benchmarkName: string;
  modelName: string;
  pairing: { source: string; cadence: string; spanStartUtc: string; spanStopUtc: string; samplesTotal: number };
  train: { startUtc: string; endUtc: string; samples: number };
  validation: { startUtc: string; endUtc: string; samples: number };
  overall: { benchmark: MlErrorSummary; ml: MlErrorSummary; ridge: MlErrorSummary };
  improvement: { maeMin: number; within20Pct: number; biasAbsMin: number };
  regimes: MlRegimeRow[];
  histogram: { binEdgesMin: number[]; benchmarkCounts: number[]; mlCounts: number[]; benchmarkOutsidePct: number; mlOutsidePct: number };
  featureImportance: Array<{ feature: string; deltaMaeMin: number; std: number }>;
  walkForward: Array<{ year: number; trainRows: number; valRows: number; benchmarkMaeMin: number; mlMaeMin: number }>;
  verdict: string;
}

const ML_BENCH_COLOR = '#f59e0b'; // benchmark (MRU ballistic), matches the model-card figures
const ML_MODEL_COLOR = '#22d3ee'; // MRU + ML correction

/** Shared collapsible shell for every Validation & Studies section: same chevron, same
 *  header style. Children mount only while open, so collapsed panels do not fetch. */
function CollapsibleSection({ icon: Icon, title, subtitle, defaultOpen = false, children }: {
  icon: typeof Gauge; title: string; subtitle?: string; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/30">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg p-4 text-left transition hover:bg-slate-900/30">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{title}</h2>
          {subtitle && <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{subtitle}</span>}
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

/** One benchmark-vs-ML stat pair with its improvement delta. */
function PairedStat({ label, unit, bench, ml, delta, deltaGood, digits = 2 }: {
  label: string; unit: string; bench: number; ml: number; delta: number; deltaGood: boolean; digits?: number;
}) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{label}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ${deltaGood ? 'bg-emerald-400/10 text-emerald-300' : 'bg-rose-400/10 text-rose-300'}`}>
          {delta >= 0 ? '+' : '−'}{Math.abs(delta).toFixed(digits)} {unit}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="font-mono text-[8px] uppercase tracking-widest" style={{ color: ML_BENCH_COLOR }}>benchmark</div>
          <div className="font-mono text-xl font-semibold text-slate-300">{bench.toFixed(digits)}<span className="ml-1 text-[10px] text-slate-500">{unit}</span></div>
        </div>
        <div>
          <div className="font-mono text-[8px] uppercase tracking-widest" style={{ color: ML_MODEL_COLOR }}>MRU + ML</div>
          <div className="font-mono text-xl font-semibold text-slate-100">{ml.toFixed(digits)}<span className="ml-1 text-[10px] text-slate-500">{unit}</span></div>
        </div>
      </div>
    </div>
  );
}

/** 3a · Headline: the MRU benchmark vs the ML residual correction on the held-out tail. */
function BenchmarkVsMlBody({ metrics, error, loading }: { metrics: MlMetrics | null; error: string | null; loading: boolean }) {
  const histData = useMemo(() => {
    if (!metrics) return [];
    const { binEdgesMin, benchmarkCounts, mlCounts } = metrics.histogram;
    return benchmarkCounts.map((b, i) => ({
      x: (binEdgesMin[i] + binEdgesMin[i + 1]) / 2,
      benchmark: b,
      ml: mlCounts[i],
    }));
  }, [metrics]);

  if (loading && !metrics) return <div className="flex h-28 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Reading ML artifacts…</div>;
  if (!metrics) return <div className="flex h-20 items-center justify-center px-4 text-center font-mono text-[10px] uppercase tracking-widest text-amber-200/70">{error ?? 'ML artifacts not found.'}</div>;

  const b = metrics.overall.benchmark;
  const m = metrics.overall.ml;
  const maeBetter = m.maeMin < b.maeMin;
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-4xl text-[11px] leading-relaxed text-slate-500">
        Same paired record as the arrival-time study: for each parcel, the benchmark is the MRU ballistic delay and the ML model adds a learned
        residual correction from upstream-only L1 features. Scored on the held-out chronological tail, <span className="font-mono text-slate-300">{fmtDateOnly(metrics.validation.startUtc)} → {fmtDateOnly(metrics.validation.endUtc)}</span>,{' '}
        <span className="font-mono text-slate-300">{metrics.validation.samples.toLocaleString()}</span> samples the model never saw in training.
      </p>
      <div className={`rounded-md border p-3 text-[11px] leading-relaxed ${maeBetter ? 'border-emerald-400/25 bg-emerald-400/[0.05] text-emerald-100/90' : 'border-amber-400/25 bg-amber-400/[0.06] text-amber-100/90'}`}>
        <span className="font-mono text-[9px] uppercase tracking-widest">verdict</span>
        <div className="mt-0.5 text-slate-200">{metrics.verdict}</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <PairedStat label="Mean abs arrival error" unit="min" bench={b.maeMin} ml={m.maeMin} delta={metrics.improvement.maeMin} deltaGood={metrics.improvement.maeMin > 0} />
        <PairedStat label="Within ±20 min" unit="%" bench={b.within20Pct} ml={m.within20Pct} delta={metrics.improvement.within20Pct} deltaGood={metrics.improvement.within20Pct > 0} digits={1} />
        <PairedStat label="Bias (pred − actual)" unit="min" bench={b.biasMin} ml={m.biasMin} delta={metrics.improvement.biasAbsMin} deltaGood={metrics.improvement.biasAbsMin > 0} />
      </div>
      {/* Overlaid error histogram: both distributions over the same validation samples. */}
      <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Held-out arrival-error distribution</span>
          <div className="flex items-center gap-3 font-mono text-[8px] uppercase tracking-widest">
            <span className="flex items-center gap-1" style={{ color: ML_BENCH_COLOR }}><span className="h-2 w-3 rounded-sm" style={{ backgroundColor: ML_BENCH_COLOR, opacity: 0.6 }} />benchmark (MRU ballistic)</span>
            <span className="flex items-center gap-1" style={{ color: ML_MODEL_COLOR }}><span className="h-2 w-3 rounded-sm" style={{ backgroundColor: ML_MODEL_COLOR, opacity: 0.6 }} />MRU + ML correction</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={180} minWidth={0} minHeight={180} initialDimension={{ width: 640, height: 180 }}>
          <AreaChart data={histData} margin={{ top: 6, right: 12, left: 6, bottom: 14 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} fontSize={9} stroke="#64748b" tickFormatter={(v: number) => v.toFixed(0)}
              label={{ value: 'arrival-time error (min) · predicted − observed', position: 'insideBottom', offset: -8, fill: '#94a3b8', fontSize: 9 }} />
            <YAxis fontSize={9} stroke="#64748b" width={52} tickFormatter={(v: number) => v.toLocaleString()} />
            <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }}
              labelFormatter={v => `${Number(v).toFixed(0)} min`} formatter={(v, n) => [Number(v).toLocaleString(), String(n)]} />
            <ReferenceLine x={0} stroke="#64748b" strokeWidth={0.8} />
            <Area name="benchmark (MRU ballistic)" dataKey="benchmark" type="step" stroke={ML_BENCH_COLOR} strokeWidth={1.2} fill={ML_BENCH_COLOR} fillOpacity={0.3} isAnimationActive={false} />
            <Area name="MRU + ML correction" dataKey="ml" type="step" stroke={ML_MODEL_COLOR} strokeWidth={1.2} fill={ML_MODEL_COLOR} fillOpacity={0.3} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          {metrics.histogram.benchmarkOutsidePct.toFixed(1)}% of benchmark and {metrics.histogram.mlOutsidePct.toFixed(1)}% of ML errors fall outside the ±60 min window shown.
          Model: {metrics.modelName}. Ridge baseline MAE {metrics.overall.ridge.maeMin.toFixed(2)} min. Artifacts generated {fmtDateTime(metrics.generatedAtUtc, 'UTC')} UTC.
        </p>
      </div>
    </div>
  );
}

/** 3b · Benchmark vs ML per observed storm regime (G0 / G1-G2 / G3-G5). */
function ByRegimeBody({ metrics, error, loading }: { metrics: MlMetrics | null; error: string | null; loading: boolean }) {
  if (loading && !metrics) return <div className="flex h-24 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Reading ML artifacts…</div>;
  if (!metrics) return <div className="flex h-20 items-center justify-center px-4 text-center font-mono text-[10px] uppercase tracking-widest text-amber-200/70">{error ?? 'ML artifacts not found.'}</div>;
  return (
    <div className="flex flex-col gap-2">
      <p className="max-w-4xl text-[11px] leading-relaxed text-slate-500">
        Each held-out sample is classified by the observed G level at that instant (official Kp archive, same stratification as the arrival study).
        Severe-storm samples are rare, so their numbers carry wide uncertainty.
      </p>
      <div className="overflow-x-auto rounded-md border border-slate-800">
        <table className="w-full min-w-[640px] border-collapse font-mono text-[10px]">
          <thead>
            <tr className="bg-slate-950/60 text-slate-500">
              <th className="px-2 py-1.5 text-left font-medium">Regime</th>
              <th className="px-2 py-1.5 text-right font-medium">Samples</th>
              <th className="px-2 py-1.5 text-right font-medium">Share</th>
              <th className="px-2 py-1.5 text-right font-medium">Lead</th>
              <th className="px-2 py-1.5 text-right font-medium" style={{ color: ML_BENCH_COLOR }}>Bench MAE</th>
              <th className="px-2 py-1.5 text-right font-medium" style={{ color: ML_MODEL_COLOR }}>ML MAE</th>
              <th className="px-2 py-1.5 text-right font-medium" style={{ color: ML_BENCH_COLOR }}>Bench ±20</th>
              <th className="px-2 py-1.5 text-right font-medium" style={{ color: ML_MODEL_COLOR }}>ML ±20</th>
            </tr>
          </thead>
          <tbody>
            {metrics.regimes.map(r => {
              const lvl = r.key === 'severe' ? 4 : r.key === 'storm' ? 2 : 0;
              const maeBetter = r.ml.maeMin < r.benchmark.maeMin;
              return (
                <tr key={r.key} className="border-t border-slate-800/70 text-slate-300">
                  <td className="px-2 py-1.5"><span style={{ color: dangerStyle(lvl).dot }}>●</span> {r.label}</td>
                  <td className="px-2 py-1.5 text-right text-slate-400">{r.n.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right text-slate-500">{r.sharePct}%</td>
                  <td className="px-2 py-1.5 text-right text-cyan-200/90">{r.leadMin.toFixed(0)} min</td>
                  <td className="px-2 py-1.5 text-right text-slate-400">{r.benchmark.maeMin.toFixed(2)} min</td>
                  <td className="px-2 py-1.5 text-right" style={{ color: maeBetter ? '#6ee7b7' : '#fbbf24' }}>{r.ml.maeMin.toFixed(2)} min</td>
                  <td className="px-2 py-1.5 text-right text-slate-400">{r.benchmark.within20Pct.toFixed(1)}%</td>
                  <td className="px-2 py-1.5 text-right" style={{ color: r.ml.within20Pct >= r.benchmark.within20Pct ? '#6ee7b7' : '#fbbf24' }}>{r.ml.within20Pct.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {metrics.walkForward.length > 0 && (
        <p className="text-[10px] leading-relaxed text-slate-500">
          Walk-forward by year (train on everything before, validate on the year):{' '}
          {metrics.walkForward.map(w => `${w.year}: ${w.benchmarkMaeMin.toFixed(1)} → ${w.mlMaeMin.toFixed(1)} min`).join(' · ')}.
        </p>
      )}
    </div>
  );
}

function ArchiveTile({ title, archive, accent }: { title: string; archive: ValidationArchiveInfo; accent: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/45 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-300">{title}</h3>
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
      </div>
      <div className="font-mono text-[10px] text-slate-500">{archive.resolution} · {archive.rows.toLocaleString()} rows</div>
      <div className="mt-1 font-mono text-[10px] text-slate-300">{fmtDateOnly(archive.startUtc)} → {fmtDateOnly(archive.endUtc)}</div>
      <div className="mt-2 text-[10px] leading-relaxed text-slate-500">{archive.role}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {archive.variables.map(v => <span key={v} className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">{v}</span>)}
      </div>
    </div>
  );
}

function ValidationDataUsedBody() {
  const [data, setData] = useState<ValidationDataDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/console/validation-data', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const b = await r.json() as ValidationDataDto | { error?: string };
      if (r.ok) { setData(b as ValidationDataDto); setError(null); } else { setError((b as { error?: string }).error ?? 'Could not read validation data.'); }
    } catch {
      setError('Could not read validation data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t); }, [load]);

  const studies = data?.studies;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-4xl text-[11px] leading-relaxed text-slate-500">
          Validation uses different datasets for different jobs: ACE is the historical upstream L1 input, OMNI is an internal Earth&apos;s bow-shock nose timing reference,
          GOES/GEO is response context, and Kp/G is a ground geomagnetic response label. None of these turns GOES or Kp into a direct L1 solar-wind measurement.
        </p>
        {data && <span className="shrink-0 font-mono text-[10px] text-slate-500">snapshot {fmtDateTime(data.generatedAtUtc, 'UTC')} UTC</span>}
      </div>

      {loading && !data ? (
        <div className="flex h-24 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Reading validation inventory…</div>
      ) : error ? (
        <div className="flex h-20 items-center justify-center px-4 text-center font-mono text-[10px] uppercase tracking-widest text-amber-200/70">{error}</div>
      ) : data ? (
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 lg:grid-cols-3">
            <ArchiveTile title="ACE upstream L1" archive={data.archives.ace} accent="#22d3ee" />
            <ArchiveTile title="OMNI bow-shock reference" archive={data.archives.omni} accent="#fb923c" />
            <ArchiveTile title="GOES/GEO context" archive={data.archives.geo} accent="#a78bfa" />
          </div>
          <div className="overflow-hidden rounded-md border border-slate-800">
            <table className="w-full border-collapse text-[10px]">
              <thead>
                <tr className="bg-slate-950/60 font-mono uppercase tracking-widest text-slate-500">
                  <th className="px-2 py-1.5 text-left font-medium">Study</th>
                  <th className="px-2 py-1.5 text-left font-medium">Data role</th>
                  <th className="px-2 py-1.5 text-left font-medium">Local coverage</th>
                  <th className="px-2 py-1.5 text-left font-medium">Metrics</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-800/70 text-slate-300">
                  <td className="px-2 py-1.5 font-mono text-cyan-200">Arrival-time validation</td>
                  <td className="px-2 py-1.5 text-slate-400">{studies?.arrivalTiming.role}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">
                    {studies?.arrivalTiming.statsSpan ? `${fmtDateOnly(studies.arrivalTiming.statsSpan.startUtc)} → ${fmtDateOnly(studies.arrivalTiming.statsSpan.stopUtc)}` : 'cache missing'}
                    {studies?.arrivalTiming.samples ? ` · ${studies.arrivalTiming.samples.toLocaleString()} samples` : ''}
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">{studies?.arrivalTiming.metrics.join(', ')}</td>
                </tr>
                <tr className="border-t border-slate-800/70 text-slate-300">
                  <td className="px-2 py-1.5 font-mono text-cyan-200">ML arrival-time correction</td>
                  <td className="px-2 py-1.5 text-slate-400">{studies?.mlArrival?.role ?? 'Learned residual correction on top of the MRU ballistic delay.'}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">
                    {studies?.mlArrival
                      ? <>train {fmtDateOnly(studies.mlArrival.train.startUtc)} → {fmtDateOnly(studies.mlArrival.train.endUtc)} · {studies.mlArrival.train.rows.toLocaleString()} rows<br />
                          validation {fmtDateOnly(studies.mlArrival.validation.startUtc)} → {fmtDateOnly(studies.mlArrival.validation.endUtc)} · {studies.mlArrival.validation.rows.toLocaleString()} rows</>
                      : 'artifacts missing: run python -m ml.arrival_residual.train'}
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">{studies?.mlArrival?.metrics.join(', ') ?? ''}</td>
                </tr>
                <tr className="border-t border-slate-800/70 text-slate-300">
                  <td className="px-2 py-1.5 font-mono text-cyan-200">Variable alignment</td>
                  <td className="px-2 py-1.5 text-slate-400">{studies?.variableAlignment.role}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">{fmtDateOnly(data.archives.ace.startUtc)} → {fmtDateOnly(data.archives.ace.endUtc)} vs {fmtDateOnly(data.archives.omni.startUtc)} → {fmtDateOnly(data.archives.omni.endUtc)}</td>
                  <td className="px-2 py-1.5 text-slate-500">{studies?.variableAlignment.metrics.join(', ')}</td>
                </tr>
                <tr className="border-t border-slate-800/70 text-slate-300">
                  <td className="px-2 py-1.5 font-mono text-cyan-200">Event validation</td>
                  <td className="px-2 py-1.5 text-slate-400">Uses propagated L1 event candidates; reference windows are still being formalized.</td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">Not yet a scored production panel</td>
                  <td className="px-2 py-1.5 text-slate-500">planned: precision, recall, onset error, duration error, peak error</td>
                </tr>
                <tr className="border-t border-slate-800/70 text-slate-300">
                  <td className="px-2 py-1.5 font-mono text-cyan-200">G-level proxy validation</td>
                  <td className="px-2 py-1.5 text-slate-400">{studies?.gProxy.role}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">{fmtDateOnly(data.archives.omni.startUtc)} → {fmtDateOnly(data.archives.omni.endUtc)}</td>
                  <td className="px-2 py-1.5 text-slate-500">{studies?.gProxy.metrics.join(', ')}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 rounded-md border border-cyan-400/20 bg-cyan-400/[0.04] p-3 text-[10px] leading-relaxed text-slate-400">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden="true" />
            <p>
              Key limitation: OMNI is the historical Earth&apos;s bow-shock nose timing reference for solar-wind variables; Kp/G is a ground geomagnetic response index; GOES/GEO
              describes spacecraft-environment response context. They validate different parts of the chain and should not be mixed as the same target.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PhysicalDriverSummaryTile({ label, interval, metric, accent }: { label: string; interval: PhysicalDriverIntervalSummary | null; metric: ReactNode; accent: string }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/45 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{label}</span>
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
      </div>
      <div className="font-mono text-lg font-semibold text-slate-100">{metric}</div>
      <div className="mt-1 truncate font-mono text-[9px] text-slate-500" title={fmtIntervalRange(interval, timeZone, tzLabel)}>
        {fmtIntervalRange(interval, timeZone, tzLabel)}
      </div>
    </div>
  );
}

function PhysicalDriverOccurrenceStrips({ strips, startMs, endMs }: { strips: PhysicalDriverOccurrenceStrip[]; startMs: number; endMs: number }) {
  const span = Math.max(1, endMs - startMs);
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Event occurrence strip · by physical-driver category</span>
        <span className="font-mono text-[9px] text-slate-600">arrival time at Earth&apos;s bow-shock nose</span>
      </div>
      <div className="space-y-1.5">
        {strips.map(strip => (
          <div key={strip.id} className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-2">
            <span className="truncate font-mono text-[9px] uppercase tracking-widest text-slate-500">{strip.label}</span>
            <div className="relative h-3 overflow-hidden rounded-sm border border-slate-800 bg-slate-900/60">
              {strip.intervals.map((interval, i) => {
                const left = clamp01((interval.start_ms - startMs) / span) * 100;
                const right = clamp01((interval.end_ms - startMs) / span) * 100;
                return (
                  <span
                    key={`${strip.id}-${i}`}
                    className="absolute top-0 h-full"
                    style={{ left: `${left}%`, width: `${Math.max(0.4, right - left)}%`, backgroundColor: strip.color, opacity: Math.min(0.95, 0.35 + interval.level * 0.13) }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PhysicalDriverStatsTable({ rows }: { rows: Array<PhysicalDriverThresholdStat | PhysicalDriverCompoundStat> }) {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  return (
    <div className="overflow-x-auto rounded-md border border-slate-800">
      <table className="w-full min-w-[780px] border-collapse font-mono text-[10px]">
        <thead>
          <tr className="bg-slate-950/60 text-slate-500">
            <th className="px-2 py-1.5 text-left font-medium">Event type</th>
            <th className="px-2 py-1.5 text-left font-medium">Threshold</th>
            <th className="px-2 py-1.5 text-right font-medium">Count</th>
            <th className="px-2 py-1.5 text-right font-medium">Total duration</th>
            <th className="px-2 py-1.5 text-right font-medium">Longest</th>
            <th className="px-2 py-1.5 text-right font-medium">Peak value</th>
            <th className="px-2 py-1.5 text-left font-medium">Strongest event time range</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} className="px-2 py-5 text-center text-slate-600">No physical-driver interval rows available.</td></tr>
          ) : rows.map(row => (
            <tr key={row.id} className="border-t border-slate-800/70 text-slate-300">
              <td className="px-2 py-1.5 text-cyan-100">{row.event_type}</td>
              <td className="px-2 py-1.5 text-slate-500">{row.threshold}</td>
              <td className="px-2 py-1.5 text-right text-slate-300">{row.count.toLocaleString()}</td>
              <td className="px-2 py-1.5 text-right text-slate-400">{fmtDurationMinutes(row.total_duration_minutes)}</td>
              <td className="px-2 py-1.5 text-right text-slate-400">{fmtDurationMinutes(row.longest_interval_minutes)}</td>
              <td className="px-2 py-1.5 text-right text-slate-200">{fmtDriverPeak(row)}</td>
              <td className="px-2 py-1.5 text-slate-500">{fmtIntervalRange(row.strongest_event, timeZone, tzLabel)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtPhysicalSummaryMetric(interval: PhysicalDriverIntervalSummary | null, key: keyof Pick<PhysicalDriverIntervalSummary, 'min_bz' | 'max_vsw' | 'max_pdyn' | 'max_em'>, unit: string, digits: number) {
  const value = interval?.[key];
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)} ${unit}`;
}

function PhysicalDriverEventStatsBody() {
  const { timeZone, label: tzLabel } = useContext(TimeZoneContext);
  const [windowKey, setWindowKey] = useState('90d');
  const [stats, setStats] = useState<PhysicalDriverStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/console/physical-driver-stats?window=${key}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const b = await r.json() as PhysicalDriverStatsDto | { error?: string };
      if (r.ok) {
        setStats(b as PhysicalDriverStatsDto);
        setError(null);
      } else {
        setError((b as { error?: string }).error ?? 'Could not compute physical-driver statistics.');
      }
    } catch {
      setError('Could not compute physical-driver statistics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const t = window.setTimeout(() => void load(windowKey), 0); return () => window.clearTimeout(t); }, [load, windowKey]);

  const rows = useMemo(() => {
    if (!stats) return [] as Array<PhysicalDriverThresholdStat | PhysicalDriverCompoundStat>;
    const pick = (items: PhysicalDriverThresholdStat[], ids: string[]) => ids.map(id => items.find(item => item.id === id)).filter((item): item is PhysicalDriverThresholdStat => !!item);
    const compoundIds = ['compound_high_coupling', 'compound_geoeffective_southward'];
    return [
      ...pick(stats.stats.speed, ['speed_elevated', 'speed_high']),
      ...pick(stats.stats.bz, ['bz_moderate_southward', 'bz_strong_southward', 'bz_severe_southward']),
      ...pick(stats.stats.bt, ['bt_elevated', 'bt_high']),
      ...pick(stats.stats.density, ['density_elevated', 'density_high']),
      ...pick(stats.stats.pdyn, ['pdyn_elevated', 'pdyn_high']),
      ...pick(stats.stats.em, ['em_elevated', 'em_high', 'em_severe']),
      ...compoundIds.map(id => stats.stats.compound.find(item => item.id === id)).filter((item): item is PhysicalDriverCompoundStat => !!item),
    ];
  }, [stats]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-4xl text-[11px] leading-relaxed text-slate-500">
          Environmental context, not a model score: this section counts hazardous solar-wind and IMF driver intervals (measured at L1, shifted to estimated
          Earth&apos;s bow-shock nose arrival time) and is decoupled from the benchmark and ML arrival-time results above. It does not count guaranteed satellite
          anomalies or measured G levels.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-slate-700/60">
            {PHYSICAL_DRIVER_WINDOWS.map(w => (
              <button
                key={w.key}
                type="button"
                onClick={() => setWindowKey(w.key)}
                className={`border-r border-slate-700/60 px-2 py-1 font-mono text-[9px] uppercase tracking-widest transition last:border-r-0 ${windowKey === w.key ? 'bg-cyan-400/15 text-cyan-100' : 'text-slate-500 hover:text-slate-300'}`}
              >
                {w.label}
              </button>
            ))}
          </div>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" aria-hidden="true" />}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-amber-400/25 bg-amber-400/[0.06] p-3 font-mono text-[10px] uppercase tracking-widest text-amber-200/80">{error}</div>
      ) : loading && !stats ? (
        <div className="flex h-36 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-slate-600">Computing physical-driver intervals…</div>
      ) : stats ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-widest text-slate-500">
            <span>{fmtDateTime(new Date(stats.start_ms).toISOString(), timeZone)} → {fmtDateTime(new Date(stats.end_ms).toISOString(), timeZone)} {tzLabel}</span>
            <span>{stats.sample_count.toLocaleString()} samples · cadence ≈ {stats.cadence_minutes} min · generated {fmtDateTime(stats.generated_at, timeZone)} {tzLabel}</span>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            <PhysicalDriverSummaryTile label="Strongest southward Bz" interval={stats.summary.strongest_southward_bz} metric={fmtPhysicalSummaryMetric(stats.summary.strongest_southward_bz, 'min_bz', 'nT', 1)} accent="#fb923c" />
            <PhysicalDriverSummaryTile label="Strongest high-speed stream" interval={stats.summary.strongest_high_speed} metric={fmtPhysicalSummaryMetric(stats.summary.strongest_high_speed, 'max_vsw', 'km/s', 0)} accent="#fbbf24" />
            <PhysicalDriverSummaryTile label="Strongest dynamic pressure" interval={stats.summary.strongest_pressure} metric={fmtPhysicalSummaryMetric(stats.summary.strongest_pressure, 'max_pdyn', 'nPa', 2)} accent="#a78bfa" />
            <PhysicalDriverSummaryTile label="Strongest coupling" interval={stats.summary.strongest_coupling} metric={fmtPhysicalSummaryMetric(stats.summary.strongest_coupling, 'max_em', 'mV/m', 2)} accent="#f87171" />
            <div className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.05] p-3">
              <div className="font-mono text-[9px] uppercase tracking-widest text-cyan-200">Total hazardous minutes</div>
              <div className="mt-1 font-mono text-lg font-semibold text-cyan-100">{fmtDurationMinutes(stats.summary.total_hazardous_minutes)}</div>
              <div className="mt-1 font-mono text-[9px] text-slate-500">union of elevated physical-driver intervals</div>
            </div>
          </div>
          <PhysicalDriverOccurrenceStrips strips={stats.occurrence_strips} startMs={stats.start_ms} endMs={stats.end_ms} />
          <PhysicalDriverStatsTable rows={rows} />
          <div className="flex gap-2 rounded-md border border-slate-800 bg-slate-950/45 p-3 text-[10px] leading-relaxed text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden="true" />
            <p>
              {stats.limitations.join(' ')} The G row elsewhere in the console is a derived risk indicator; this section summarizes solar-wind and IMF drivers directly.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ArrivalAccuracyBody() {
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

  // Bz and the derived Em coupling (repo convention: V * max(0, -Bz) * 1e-3, mV/m) at the
  // actual arrival times. G is driven by southward Bz and coupling, NOT by speed, so this
  // panel is what the observed G bands should visibly track.
  const bzData = useMemo(() =>
    (stats?.actual ?? [])
      .filter(p => p.bz !== null)
      .map(p => ({ t: p.t, bz: p.bz as number, em: p.speed !== null ? (p.speed * Math.max(0, -(p.bz as number))) / 1000 : null })),
    [stats]);

  // Rules-based FORECAST G (the same mapping the live console uses: trailing ~3 h mean of
  // Em + the fast-stream speed floor) vs OBSERVED G (official Kp bands), per arrived sample.
  const gOverlay = useMemo(() => {
    if (!stats) return [] as Array<{ t: number; forecastG: number; observedG: number }>;
    const pts = stats.actual.filter(p => p.speed !== null);
    const bands = stats.bands.slice().sort((a, b) => a.from - b.from);
    const obsAt = (t: number) => { let lvl = 0; for (const b of bands) { if (t < b.from) break; if (t < b.to) lvl = Math.max(lvl, b.level); } return lvl; };
    const em = pts.map(p => ((p.speed as number) * Math.max(0, -(p.bz ?? 0))) / 1000);
    const sp = pts.map(p => p.speed as number);
    const out: Array<{ t: number; forecastG: number; observedG: number }> = [];
    let start = 0; let sumEm = 0; let sumSp = 0; let n = 0;
    for (let i = 0; i < pts.length; i++) {
      sumEm += em[i]; sumSp += sp[i]; n += 1;
      while (pts[i].t - pts[start].t > 3 * 3_600_000) { sumEm -= em[start]; sumSp -= sp[start]; n -= 1; start += 1; }
      const kp = kpFromCoupling(sumEm / n, sumSp / n);
      out.push({ t: pts[i].t, forecastG: classifyGFromKp(kp).level, observedG: obsAt(pts[i].t) });
    }
    return out;
  }, [stats]);

  // Honest audit of the rules-based mapping over this event, computed from the data above.
  const gAudit = useMemo(() => {
    if (gOverlay.length === 0) return null;
    const severe = gOverlay.filter(p => p.observedG >= 3);
    const under = severe.filter(p => p.forecastG < p.observedG).length;
    return {
      peakForecast: gOverlay.reduce((m, p) => Math.max(m, p.forecastG), 0),
      peakObserved: gOverlay.reduce((m, p) => Math.max(m, p.observedG), 0),
      severeN: severe.length,
      underSeverePct: severe.length > 0 ? Math.round((under / severe.length) * 100) : null,
    };
  }, [gOverlay]);

  const xDomain: [number, number] = zoom ?? [startMs, stopMs];
  const onBrush = useCallback((r: { startIndex?: number; endIndex?: number }) => {
    if (r.startIndex == null || r.endIndex == null || r.endIndex <= r.startIndex) { setZoom(null); return; }
    const a = data[r.startIndex]?.t;
    const b = data[r.endIndex]?.t;
    if (typeof a === 'number' && typeof b === 'number' && b > a) setZoom([a, b]);
  }, [data]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-[11px] leading-relaxed text-slate-500">
          A solar-wind parcel is seen upstream; MRU predicts <span className="text-slate-300">when</span> it reaches Earth (lag = L1 distance ÷ speed).
          We re-detect that same parcel in the Earth&apos;s bow-shock nose timing reference (OMNI) and measure how many <span className="text-slate-300">minutes</span> off the prediction
          was. The headline stats span <span className="text-slate-300">several years</span> of OMNI; the charts below zoom one storm (May 2024 G5) as a worked example.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {stats && <span className="font-mono text-[10px] text-slate-500">{stats.statsSpan.multiYear ? `${new Date(stats.statsSpan.startUtc).getUTCFullYear()}–${new Date(stats.statsSpan.stopUtc).getUTCFullYear()}` : stats.interval.label} · {stats.samples.toLocaleString()} samples</span>}
          <button type="button" onClick={() => void load(true)} disabled={busy} className="flex items-center gap-1 rounded border border-slate-700/60 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-400 hover:text-cyan-200 disabled:cursor-wait">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />} Recompute
          </button>
        </div>
      </div>

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
                Mean lead <span className="font-mono text-base font-semibold text-cyan-200">{stats.meanLeadMin.toFixed(0)} min</span>: the typical{' '}
                <span className="text-slate-100">±{stats.maeMin.toFixed(1)} min</span> timing error is only{' '}
                <span className="text-slate-100">{Math.round((stats.maeMin / stats.meanLeadMin) * 100)}%</span> of it, leaving ~
                <span className="text-slate-100">{Math.max(0, stats.meanLeadMin - stats.maeMin).toFixed(0)} min</span> of dependable warning. The error matters
                relative to this margin, not on its own (±8 min on a 30-min lead is fine; on a 10-min lead it is not).
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
              The headline {stats.maeMin.toFixed(1)} min averages <span className="text-slate-300">every sample</span> across the whole span (≈{stats.samples.toLocaleString()}), so the calm majority dominates it. It is a pure <span className="text-slate-300">timing</span> error, MRU&apos;s ballistic lag vs OMNI&apos;s measured delay for the same parcel, so we never expect an identical trace, only the right arrival time.
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
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              Note: the G bands do not follow the speed peak. G is driven by southward Bz and the Em coupling, not by speed alone, which is why the
              strongest shading sits where Bz plunges in the panel below, not where the wind is fastest.
            </p>

            {/* Time-aligned Bz + Em subpanel: the quantities the observed G bands actually track. */}
            {bzData.length > 0 && (
              <div className="mt-2 border-t border-slate-800/70 pt-2">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[8px] uppercase tracking-widest text-slate-500">Bz GSM (nT) + Em coupling · the G drivers</span>
                  <div className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-widest">
                    <span className="flex items-center gap-1 text-rose-200"><span className="h-0.5 w-3 bg-rose-400" />Bz GSM</span>
                    <span className="flex items-center gap-1 text-emerald-200"><span className="h-0.5 w-3 bg-emerald-400" />Em = V·max(0,−Bz)·10⁻³ (mV/m)</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={120} minWidth={0} minHeight={120} initialDimension={{ width: 640, height: 120 }}>
                  <LineChart data={bzData} margin={{ top: 2, right: 12, left: 6, bottom: 4 }}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                    {stats.bands.map((b, i) => (
                      <ReferenceArea key={i} x1={b.from} x2={b.to} yAxisId="bz" fill={dangerStyle(b.level).dot} fillOpacity={0.1} stroke="none" ifOverflow="hidden" />
                    ))}
                    <XAxis dataKey="t" type="number" domain={xDomain} allowDataOverflow scale="time" hide />
                    <YAxis yAxisId="bz" fontSize={8} stroke="#f87171" domain={['auto', 'auto']} width={46} tickFormatter={(v: number) => v.toFixed(0)} />
                    <YAxis yAxisId="em" orientation="right" fontSize={8} stroke="#34d399" domain={[0, 'auto']} width={40} tickFormatter={(v: number) => v.toFixed(0)} />
                    <ReferenceLine yAxisId="bz" y={0} stroke="#64748b" strokeWidth={0.7} />
                    <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }}
                      labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`}
                      formatter={(v, n) => [`${Number(v).toFixed(1)} ${String(n).startsWith('Em') ? 'mV/m' : 'nT'}`, String(n)]} />
                    <Line yAxisId="bz" name="Bz GSM" dataKey="bz" stroke="#f87171" strokeWidth={1.2} dot={false} connectNulls isAnimationActive={false} type="linear" />
                    <Line yAxisId="em" name="Em coupling" dataKey="em" stroke="#34d399" strokeWidth={1.1} dot={false} connectNulls isAnimationActive={false} type="linear" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Forecast G vs observed G on a G-level axis: where the rules-based mapping
                under or over predicts during this event. */}
            {gOverlay.length > 0 && (
              <div className="mt-2 border-t border-slate-800/70 pt-2">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[8px] uppercase tracking-widest text-slate-500">Forecast G (rules-based, trailing 3 h coupling) vs observed G (official Kp)</span>
                  <div className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-widest">
                    <span className="flex items-center gap-1 text-cyan-200"><span className="h-0.5 w-3 border-t border-dashed" style={{ borderColor: ARRIVAL_PRED_COLOR }} />forecast G</span>
                    <span className="flex items-center gap-1 text-orange-200"><span className="h-0.5 w-3" style={{ backgroundColor: ARRIVAL_ACTUAL_COLOR }} />observed G</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={110} minWidth={0} minHeight={110} initialDimension={{ width: 640, height: 110 }}>
                  <LineChart data={gOverlay} margin={{ top: 2, right: 12, left: 6, bottom: 4 }}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="t" type="number" domain={xDomain} allowDataOverflow scale="time" hide />
                    <YAxis fontSize={8} stroke="#64748b" domain={[0, 5]} ticks={[0, 1, 2, 3, 4, 5]} width={46} tickFormatter={(v: number) => `G${v}`} />
                    <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }}
                      labelFormatter={v => `${fmtFull(Number(v), timeZone)} ${tzLabel}`} formatter={(v, n) => [`G${Number(v)}`, String(n)]} />
                    <Line name="forecast G" dataKey="forecastG" stroke={ARRIVAL_PRED_COLOR} strokeWidth={1.3} strokeDasharray="4 3" dot={false} isAnimationActive={false} type="stepAfter" />
                    <Line name="observed G" dataKey="observedG" stroke={ARRIVAL_ACTUAL_COLOR} strokeWidth={1.4} dot={false} isAnimationActive={false} type="stepAfter" />
                  </LineChart>
                </ResponsiveContainer>
                {gAudit && (
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                    Audit of the rules-based mapping over this event: peak forecast G{gAudit.peakForecast} vs peak observed G{gAudit.peakObserved}
                    {gAudit.underSeverePct !== null && (
                      <>; during the {gAudit.severeN.toLocaleString()} samples with observed G3+, the forecast sits below the observed level {gAudit.underSeverePct}% of the time</>
                    )}.
                    The trailing 3 h coupling average reacts late at storm onset and saturates near the G5 anchor, so peak G can be reached only briefly even
                    when instantaneous coupling is far above it. Kp itself is a 3-hour bin, so some disagreement is timing granularity, not pure model error.
                  </p>
                )}
              </div>
            )}
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
              <span className="font-semibold text-cyan-200">Headline shock</span>: the storm front was re-detected at Earth on{' '}
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
            ~{stats.maeMin.toFixed(0)} min on average ({stats.withinMinPct['20'].toFixed(0)}% within ±20 min), and tightens to {stats.strata.find(s => s.key === 'severe')?.maeMin.toFixed(0) ?? stats.maeMin.toFixed(0)} min during severe storms:
            strong enough to call the arrival to the right hour and the storm level it carried.
          </p>
        </div>
      ) : (
        <div className="flex h-20 items-center justify-center px-4 text-center font-mono text-[10px] uppercase tracking-widest text-amber-200/70">{error ?? 'Could not compute: try recompute'}</div>
      )}
    </div>
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
  mru: Array<{ t: number; speed: number | null; bz: number | null; gLevel: number | null; riskAvailable?: boolean }>;
  current: {
    sampleTimeUtc: string;
    speedKmS: number | null;
    bzNt: number | null;
    densityPerCm3: number | null;
    gLevel: number | null;
    riskAvailable?: boolean;
    sources?: TransitSources;
    missingVariables?: string[];
    qualityFlags?: string[];
    arrivalUtc: string | null;
    lagMinutes: number | null;
  } | null;
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
  const curRiskAvailable = cur?.riskAvailable ?? (cur ? cur.gLevel !== null : false);
  const curStyle = cur && curRiskAvailable ? dangerStyle(cur.gLevel ?? 0) : DANGER[0];
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
        <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${cur && curRiskAvailable ? curStyle.chip : 'border-slate-700/60 bg-slate-900/40 text-slate-400'}`} title={cur ? `Sources: ${sourceLabel(cur.sources?.gLevel)}\nMissing variables: ${formatMissingVariables(cur.missingVariables ?? [])}\nQuality flags: ${formatFlags(cur.qualityFlags ?? [])}` : undefined}>
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
            <span className="text-slate-400">Latest L1 sample</span>
            {cur && curRiskAvailable ? <GTag level={cur.gLevel ?? 0} code={`G${cur.gLevel ?? 0}`} /> : <span className="text-slate-500">risk unavailable</span>}
          </span>
          <span className="font-mono text-[10px] text-slate-300">
            {cur ? <>{fmtNum(cur.speedKmS, 0)} km/s · Bz {fmtNum(cur.bzNt, 1)} nT</> : 'no L1 sample'}
          </span>
        </div>
        <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${inb ? inbStyle.chip : 'border-slate-700/60 text-slate-400'}`}>
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
            <span className="text-slate-400">Strongest inbound sample</span>
            {inb ? <GTag level={inb.peakG} code={`G${inb.peakG}`} /> : <span className="text-slate-500">risk unavailable</span>}
          </span>
          <span className="font-mono text-[10px] text-slate-300">
            {inb ? <>ETA {fmtClock(inb.worstEtaUtc, timeZone)} {tzLabel} · {inb.peakSpeed} km/s</> : `no derivable G-risk in next ${leadMin} min`}
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
        Latest L1 sample = the active RTSW L1 source upstream now; strongest inbound sample = the worst already-measured parcel still travelling to Earth.
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

function BacktestBody() {
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
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-[11px] leading-relaxed text-slate-500">
          Replays the MRU model over the archived L1 record: every ACE (upstream L1) reading is propagated ballistically to its Earth-arrival
          time and scored against what the wind actually was then: the OMNI record (the same L1 wind shifted to Earth). This is how the simple
          model would have performed historically.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {cov && <span className="font-mono text-[10px] text-slate-500">{stats?.pairs.toLocaleString()} hourly pairs · {cov.startUtc.slice(0, 7)} → {cov.stopUtc.slice(0, 7)}</span>}
          <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1 rounded border border-slate-700/60 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-400 hover:text-cyan-200 disabled:cursor-wait">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />} rerun
          </button>
        </div>
      </div>

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
            MRU and OMNI share the L1 source, the residual error mostly reflects the ballistic propagation lag, i.e. how good the simple
            timing assumption is. Evaluated where ACE plasma exists (≈2021–mid-2024).
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---- Validation & Studies tab: every section is a collapsible panel. Benchmark-vs-ML
// (the headline result) and By-regime open by default; everything else starts collapsed.
// The two ML sections read /api/console/ml (ml_metrics.json), fetched once here. ----
function ValidationStudiesView() {
  const [metrics, setMetrics] = useState<MlMetrics | null>(null);
  const [mlError, setMlError] = useState<string | null>(null);
  const [mlLoading, setMlLoading] = useState(true);

  const load = useCallback(async () => {
    setMlLoading(true);
    try {
      const r = await fetch('/api/console/ml', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const b = await r.json() as { metrics: MlMetrics | null; error?: string };
      if (r.ok && b.metrics) { setMetrics(b.metrics); setMlError(null); } else { setMlError(b.error ?? 'Could not read ML artifacts.'); }
    } catch {
      setMlError('Could not read ML artifacts.');
    } finally {
      setMlLoading(false);
    }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t); }, [load]);

  return (
    <>
      <CollapsibleSection icon={GitCompareArrows} title="Benchmark vs ML · arrival time" subtitle={metrics ? `held-out ${fmtDateOnly(metrics.validation.startUtc)} → ${fmtDateOnly(metrics.validation.endUtc)}` : undefined} defaultOpen>
        <BenchmarkVsMlBody metrics={metrics} error={mlError} loading={mlLoading} />
      </CollapsibleSection>
      <CollapsibleSection icon={Scale} title="By storm regime · benchmark vs ML" subtitle="quiet G0 / G1-G2 / G3-G5" defaultOpen>
        <ByRegimeBody metrics={metrics} error={mlError} loading={mlLoading} />
      </CollapsibleSection>
      <CollapsibleSection icon={Database} title="Data used · validation & studies">
        <ValidationDataUsedBody />
      </CollapsibleSection>
      <CollapsibleSection icon={Timer} title="Worked example · May 2024 G5 storm" subtitle="MRU arrival-time accuracy, validated at Earth">
        <ArrivalAccuracyBody />
      </CollapsibleSection>
      <CollapsibleSection icon={LineChartIcon} title="MRU hindcast · forecast vs actual">
        <BacktestBody />
      </CollapsibleSection>
      <CollapsibleSection icon={Gauge} title="Physical-driver event statistics" subtitle="environmental context, not a model score">
        <PhysicalDriverEventStatsBody />
      </CollapsibleSection>
    </>
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
  const feedStale = lastSampleAgeMin !== null && lastSampleAgeMin > STALE_FEED_THRESHOLD_MIN;
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
            {view === 'training' ? <TrainingDataPanel /> : view === 'validation' ? (
            /* Validation studies: benchmark-vs-ML headline, regime table, then context panels */
            <ValidationStudiesView />
            ) : (<>
            {feedStale && lastSampleAgeMin !== null && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-400/30 bg-amber-400/[0.07] px-4 py-2.5 text-xs text-amber-200">
                <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                <span className="font-semibold uppercase tracking-widest">L1 feed behind by {fmtFeedAge(lastSampleAgeMin)}</span>
                <span className="text-amber-200/75">
                  NOAA real-time solar wind has not published newer data. Newest sample {data?.current?.sampleTimeUtc ? fmtClock(data.current.sampleTimeUtc, displayTimeZone) : '--:--'} {displayLabel}; the headline forecast and the live transit corridor reflect that sample, not the current minute.
                </span>
              </div>
            )}
            {data?.current ? <DangerHero current={data.current} /> : (
              <div className="flex h-40 items-center justify-center rounded-xl border border-amber-400/25 bg-amber-400/[0.06] font-mono text-xs uppercase tracking-widest text-amber-200/80">
                No live L1 solar-wind sample available
              </div>
            )}

            {data?.current && <CmeTransitScene current={data.current} inbound={data.inbound ?? []} nowMs={nowMs} />}

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
