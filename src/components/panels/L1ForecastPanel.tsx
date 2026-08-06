"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Clock3,
  Gauge,
  History,
  Info,
  Loader2,
  Radio,
  Wind,
} from 'lucide-react';
import {
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
import { GlassCard } from '@/components/ui/GlassCard';
import type {
  L1ForecastHeatmapRow,
  L1ForecastPanelData,
  L1ForecastSeriesPoint,
} from '@/services/l1ForecastPanelService';

export type ForecastVariable = 'speed' | 'bz' | 'density' | 'bt';

interface L1ForecastPanelProps {
  data: L1ForecastPanelData;
  expanded?: boolean;
  className?: string;
}

interface ChartRow {
  t: number;
  detected: number | null;
  forecast: number | null;
}

interface ElectronFluxChartRow {
  t: number;
  de1: number | null;
  de4: number | null;
  de1Log: number | null;
  de4Log: number | null;
}

const DETECTED_COLOR = '#34d399';
const FORECAST_COLOR = '#38bdf8';
const ELECTRON_DE1_COLOR = '#f59e0b';
const ELECTRON_DE4_COLOR = '#e879f9';
// A single "Forecast" line: the ML-corrected series where the model is available, falling back
// to the MRU ballistic propagation otherwise, so a forecast always renders even without a model.
const SERIES_LABELS: Record<keyof Omit<ChartRow, 't'>, string> = {
  detected: 'Detected L1',
  forecast: 'Forecast',
};

const G_STYLES = [
  { label: 'Quiet', chip: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200', dot: '#34d399' },
  { label: 'Minor', chip: 'border-lime-400/40 bg-lime-400/10 text-lime-200', dot: '#a3e635' },
  { label: 'Moderate', chip: 'border-amber-400/40 bg-amber-400/10 text-amber-200', dot: '#fbbf24' },
  { label: 'Strong', chip: 'border-orange-400/40 bg-orange-400/10 text-orange-200', dot: '#fb923c' },
  { label: 'Severe', chip: 'border-red-400/40 bg-red-400/10 text-red-200', dot: '#f87171' },
  { label: 'Extreme', chip: 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200', dot: '#e879f9' },
] as const;

const G_COLORS = G_STYLES.map(style => style.dot);
const NO_DATA_FILL = '#334155';
const MAX_EXPANDED_HEATMAP_CELLS = 260;
const MAX_COMPACT_HEATMAP_CELLS = 96;

type HeatmapWindowKey = 'live' | '24h' | '7d' | '30d' | '90d' | '1y';
type PhysicalDriverKey = 'speedKmS' | 'bzNt' | 'btNt' | 'densityPerCm3';

const HEATMAP_WINDOWS: Array<{ key: HeatmapWindowKey; label: string }> = [
  { key: 'live', label: 'Live' },
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 d' },
  { key: '30d', label: '30 d' },
  { key: '90d', label: '3 mo' },
  { key: '1y', label: '1 y' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const HEATMAP_WINDOW_DAYS: Record<Exclude<HeatmapWindowKey, 'live'>, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 31,
  '90d': 92,
  '1y': 366,
};

interface TransitSources {
  speedKmS: string | null;
  bzNt: string | null;
  btNt: string | null;
  densityPerCm3: string | null;
  gLevel: string | null;
}

interface HeatmapReplayPoint {
  t: number;
  level: number;
  riskAvailable?: boolean;
  detectedMs: number | null;
  leadTimeMinutes: number | null;
  speedKmS: number | null;
  bzNt: number | null;
  btNt: number | null;
  densityPerCm3: number | null;
  sources?: TransitSources;
  sourceTimeByVariable?: Record<string, string | null>;
  missingVariables?: string[];
  qualityFlags?: string[];
}

interface HeatmapReplaySeries {
  window: HeatmapWindowKey;
  startMs: number;
  endMs: number;
  gForecast: HeatmapReplayPoint[];
  coverage?: {
    totalBins: number;
    available: { speed: number; bz: number; bt: number; density: number; gRisk: number };
  };
}

const HEATMAP_REPLAY_CACHE = new Map<HeatmapWindowKey, HeatmapReplaySeries>();

// The home page server-renders the initial payload once; without a client refresh the heatmaps
// freeze at that snapshot. A single module-level poller (shared by every panel instance) refetches
// the forecast each minute so the arrival window slides and parcels visibly advance toward Earth.
const LIVE_FORECAST_REFRESH_MS = 60_000;
let liveForecastTimer: ReturnType<typeof setInterval> | null = null;
let liveForecastLatest: L1ForecastPanelData | null = null;
const liveForecastSubscribers = new Set<(data: L1ForecastPanelData) => void>();

async function refreshLiveForecast() {
  try {
    const response = await fetch('/api/l1-forecast', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const data = await response.json() as L1ForecastPanelData;
    liveForecastLatest = data;
    liveForecastSubscribers.forEach(listener => listener(data));
  } catch {
    // Keep showing the last good snapshot; the next tick retries.
  }
}

function subscribeLiveForecast(listener: (data: L1ForecastPanelData) => void) {
  liveForecastSubscribers.add(listener);
  if (!liveForecastTimer) {
    liveForecastTimer = setInterval(() => { void refreshLiveForecast(); }, LIVE_FORECAST_REFRESH_MS);
  }
  return () => {
    liveForecastSubscribers.delete(listener);
    if (liveForecastSubscribers.size === 0 && liveForecastTimer) {
      clearInterval(liveForecastTimer);
      liveForecastTimer = null;
    }
  };
}

export function useLiveL1ForecastData(initial: L1ForecastPanelData): L1ForecastPanelData {
  const [data, setData] = useState(
    liveForecastLatest && liveForecastLatest.generatedAtMs > initial.generatedAtMs ? liveForecastLatest : initial,
  );
  useEffect(() => subscribeLiveForecast(setData), []);
  return data;
}

function isReplaySeriesValidForWindow(windowKey: Exclude<HeatmapWindowKey, 'live'>, series: HeatmapReplaySeries) {
  if (series.window !== windowKey) return false;
  const spanMs = series.endMs - series.startMs;
  return spanMs >= HEATMAP_WINDOW_DAYS[windowKey] * DAY_MS * 0.8;
}

function cachedHeatmapReplay(windowKey: Exclude<HeatmapWindowKey, 'live'>) {
  const cached = HEATMAP_REPLAY_CACHE.get(windowKey);
  if (!cached) return null;
  if (isReplaySeriesValidForWindow(windowKey, cached)) return cached;
  HEATMAP_REPLAY_CACHE.delete(windowKey);
  return null;
}

async function loadHeatmapReplay(windowKey: Exclude<HeatmapWindowKey, 'live'>): Promise<HeatmapReplaySeries> {
  const cached = cachedHeatmapReplay(windowKey);
  if (cached) return cached;

  const response = await fetch(`/api/console/corridor?window=${windowKey}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error('Forecast history is unavailable.');
  }

  const payload = await response.json() as {
    startMs: number;
    endMs: number;
    gForecast?: HeatmapReplayPoint[];
    coverage?: HeatmapReplaySeries['coverage'];
  };
  const series: HeatmapReplaySeries = {
    window: windowKey,
    startMs: payload.startMs,
    endMs: payload.endMs,
    gForecast: (payload.gForecast ?? []).slice().sort((a, b) => a.t - b.t),
    coverage: payload.coverage,
  };

  if (!isReplaySeriesValidForWindow(windowKey, series)) {
    throw new Error(`Forecast history returned an incomplete ${windowKey} range.`);
  }

  HEATMAP_REPLAY_CACHE.set(windowKey, series);
  return series;
}

const VARIABLE_CONFIG: Record<ForecastVariable, {
  title: string;
  unit: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  digits: number;
  yWidth: number;
}> = {
  speed: { title: 'Speed -> Earth', unit: 'km/s', icon: Wind, digits: 0, yWidth: 48 },
  bz: { title: 'Bz -> Earth', unit: 'nT', icon: Gauge, digits: 1, yWidth: 46 },
  density: { title: 'Proton density -> Earth', unit: 'cm^-3', icon: Activity, digits: 1, yWidth: 50 },
  bt: { title: '|B| -> Earth', unit: 'nT', icon: Radio, digits: 1, yWidth: 46 },
};

function valueFor(point: L1ForecastSeriesPoint, variable: ForecastVariable) {
  return point[variable];
}

function bucketMinute(ms: number) {
  return Math.round(ms / 60000) * 60000;
}

function buildChartRows(data: L1ForecastPanelData, variable: ForecastVariable): ChartRow[] {
  // Collect each series by minute, then collapse to one forecast line: prefer the ML-corrected
  // value, fall back to the MRU ballistic forecast wherever the model produced nothing.
  const byTime = new Map<number, { t: number; detected: number | null; forecast: number | null; ml: number | null }>();
  const add = (points: L1ForecastSeriesPoint[], key: 'detected' | 'forecast' | 'ml') => {
    for (const point of points) {
      const t = bucketMinute(point.t);
      const row = byTime.get(t) ?? { t, detected: null, forecast: null, ml: null };
      row[key] = valueFor(point, variable);
      byTime.set(t, row);
    }
  };

  add(data.series.detected, 'detected');
  add(data.series.forecast, 'forecast');
  add(data.series.ml, 'ml');
  return [...byTime.values()]
    .map(row => ({ t: row.t, detected: row.detected, forecast: row.ml ?? row.forecast }))
    .sort((a, b) => a.t - b.t);
}

function formatClockMs(ms: number | null, timeZone = 'UTC') {
  if (ms === null || !Number.isFinite(ms)) return '--:--';
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  });
}

function formatIsoClock(iso: string | null) {
  if (!iso) return '--:--';
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? '--:--' : formatClockMs(ms);
}

function formatAge(minutes: number | null) {
  if (minutes === null || !Number.isFinite(minutes)) return '--';
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins ? `${hours} h ${mins} min` : `${hours} h`;
}

function formatTransit(minutes: number | null) {
  if (minutes === null || !Number.isFinite(minutes)) return '--';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours} h ${mins.toString().padStart(2, '0')} min`;
}

function formatMetric(value: number | null, digits: number) {
  if (value === null || !Number.isFinite(value)) return '--';
  return digits === 0 ? Math.round(value).toString() : value.toFixed(digits);
}

function formatFlux(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '--';
  if (value >= 1000 || value < 0.1) return value.toExponential(2);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function logFlux(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return Math.log10(value);
}

function formatDistance(km: number) {
  if (!Number.isFinite(km)) return '--';
  return `${(km / 1_000_000).toFixed(2)}M km`;
}

function formatYAxis(value: number | string, variable: ForecastVariable) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  if (variable === 'speed') return Math.round(numeric).toString();
  if (Math.abs(numeric) >= 1000) return `${Math.round(numeric / 1000)}k`;
  return numeric.toFixed(1);
}

function formatLogFluxAxis(value: number | string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return `1e${Math.round(numeric)}`;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function gradientCss(colors: readonly string[]) {
  if (colors.length === 0) return NO_DATA_FILL;
  if (colors.length === 1) return colors[0];
  const step = 100 / (colors.length - 1);
  return `linear-gradient(90deg, ${colors.map((color, index) => `${color} ${Math.round(index * step)}%`).join(', ')})`;
}

function formatDayMs(ms: number, timeZone = 'UTC') {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone,
  });
}

function formatWindowRange(startMs: number | null, endMs: number | null) {
  if (startMs === null || endMs === null) return '--';
  const sameDay = formatDayMs(startMs) === formatDayMs(endMs);
  if (sameDay) return `${formatDayMs(startMs)} ${formatClockMs(startMs)} - ${formatClockMs(endMs)} UTC`;
  return `${formatDayMs(startMs)} ${formatClockMs(startMs)} - ${formatDayMs(endMs)} ${formatClockMs(endMs)} UTC`;
}

function speedHeatmapColor(value: number | null) {
  if (value === null || !Number.isFinite(value)) return NO_DATA_FILL;
  if (value < 400) return '#34d399';
  if (value < 550) return '#a3e635';
  if (value < 700) return '#fbbf24';
  return '#f87171';
}

function bzHeatmapColor(value: number | null) {
  if (value === null || !Number.isFinite(value)) return NO_DATA_FILL;
  if (value >= 0) return '#34d399';
  if (value >= -5) return '#a3e635';
  if (value >= -10) return '#fbbf24';
  if (value >= -20) return '#fb923c';
  return '#e879f9';
}

function btHeatmapColor(value: number | null) {
  if (value === null || !Number.isFinite(value)) return NO_DATA_FILL;
  if (value < 5) return '#34d399';
  if (value < 10) return '#a3e635';
  if (value < 20) return '#fbbf24';
  return '#fb923c';
}

function densityHeatmapColor(value: number | null) {
  if (value === null || !Number.isFinite(value)) return NO_DATA_FILL;
  if (value < 5) return '#34d399';
  if (value < 10) return '#a3e635';
  if (value < 30) return '#fbbf24';
  return '#fb923c';
}

function speedHeatmapRank(value: number | null) {
  if (value === null || !Number.isFinite(value)) return -1;
  return value < 400 ? 0 : value < 550 ? 1 : value < 700 ? 2 : 3;
}

function bzHeatmapRank(value: number | null) {
  if (value === null || !Number.isFinite(value)) return -1;
  return value >= 0 ? 0 : value >= -5 ? 1 : value >= -10 ? 2 : value >= -20 ? 3 : 4;
}

function btHeatmapRank(value: number | null) {
  if (value === null || !Number.isFinite(value)) return -1;
  return value < 5 ? 0 : value < 10 ? 1 : value < 20 ? 2 : 3;
}

function densityHeatmapRank(value: number | null) {
  if (value === null || !Number.isFinite(value)) return -1;
  return value < 5 ? 0 : value < 10 ? 1 : value < 30 ? 2 : 3;
}

function replayValue(point: HeatmapReplayPoint, key: PhysicalDriverKey) {
  return point[key] ?? null;
}

function replayDriverColor(key: PhysicalDriverKey, value: number | null) {
  if (key === 'speedKmS') return speedHeatmapColor(value);
  if (key === 'bzNt') return bzHeatmapColor(value);
  if (key === 'btNt') return btHeatmapColor(value);
  return densityHeatmapColor(value);
}

function thinHeatmapItems<T>(items: T[], target: number, rank: (item: T) => number): T[] {
  if (items.length <= target) return items;
  const bucketSize = Math.ceil(items.length / target);
  const out: T[] = [];
  for (let i = 0; i < items.length; i += bucketSize) {
    let selected = items[i];
    let selectedRank = rank(selected);
    for (let j = i + 1; j < Math.min(i + bucketSize, items.length); j += 1) {
      const candidateRank = rank(items[j]);
      if (candidateRank > selectedRank) {
        selected = items[j];
        selectedRank = candidateRank;
      }
    }
    out.push(selected);
  }
  return out;
}

const REPLAY_DRIVER_ROWS: Array<{
  id: L1ForecastHeatmapRow['id'];
  key: PhysicalDriverKey;
  label: string;
  unit: string;
  digits: number;
}> = [
  { id: 'speed', key: 'speedKmS', label: 'Vsw', unit: 'km/s', digits: 0 },
  { id: 'bz', key: 'bzNt', label: 'Bz GSM', unit: 'nT', digits: 1 },
  { id: 'bt', key: 'btNt', label: '|B|', unit: 'nT', digits: 1 },
  { id: 'density', key: 'densityPerCm3', label: 'Np', unit: 'cm^-3', digits: 1 },
];

const DRIVER_LEGENDS = [
  { label: 'Vsw', unit: 'km/s', colors: ['#34d399', '#a3e635', '#fbbf24', '#f87171'], ticks: ['<400', '400', '550', '700+'] },
  { label: 'Bz GSM', unit: 'nT', colors: ['#34d399', '#a3e635', '#fbbf24', '#fb923c', '#e879f9'], ticks: ['>=0', '-5', '-10', '-20', '<-20'] },
  { label: '|B|', unit: 'nT', colors: ['#34d399', '#a3e635', '#fbbf24', '#fb923c'], ticks: ['<5', '5', '10', '20+'] },
  { label: 'Np', unit: 'cm^-3', colors: ['#34d399', '#a3e635', '#fbbf24', '#fb923c'], ticks: ['<5', '5', '10', '30+'] },
] as const;

function buildReplayHeatmapRows(points: HeatmapReplayPoint[], target: number): L1ForecastHeatmapRow[] {
  const selectedPoints = thinHeatmapItems(points, target, point => Math.max(
    point.riskAvailable === false ? -1 : point.level,
    speedHeatmapRank(point.speedKmS),
    bzHeatmapRank(point.bzNt),
    btHeatmapRank(point.btNt),
    densityHeatmapRank(point.densityPerCm3),
  ));
  const latest = selectedPoints[selectedPoints.length - 1] ?? null;

  return [
    {
      id: 'g',
      label: 'G',
      unit: 'risk',
      cells: selectedPoints.map(point => ({
        t: point.t,
        value: point.riskAvailable === false ? null : point.level,
        label: point.riskAvailable === false ? 'G --' : `G${point.level}`,
        color: point.riskAvailable === false ? NO_DATA_FILL : G_COLORS[Math.max(0, Math.min(5, point.level))],
      })),
      latestLabel: latest && latest.riskAvailable !== false ? `G${latest.level}` : '--',
    },
    ...REPLAY_DRIVER_ROWS.map(row => {
      const latestValue = latest ? replayValue(latest, row.key) : null;
      return {
        id: row.id,
        label: row.label,
        unit: row.unit,
        cells: selectedPoints.map(point => {
          const value = replayValue(point, row.key);
          return {
            t: point.t,
            value,
            label: `${formatMetric(value, row.digits)} ${row.unit}`,
            color: replayDriverColor(row.key, value),
          };
        }),
        latestLabel: latest ? formatMetric(latestValue, row.digits) : '--',
      };
    }),
  ];
}

function StatusChip({ level, code }: { level: number; code: string }) {
  const style = G_STYLES[Math.max(0, Math.min(5, level))];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${style.chip}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: style.dot }} />
      {code} {style.label}
    </span>
  );
}

function StatTile({ label, value, unit, accent = false }: { label: string; value: string; unit?: string; accent?: boolean }) {
  return (
    <div className={`min-w-0 rounded-md border p-2 ${accent ? 'border-cyan-400/25 bg-cyan-400/[0.07]' : 'border-slate-800 bg-slate-950/45'}`}>
      <div className="truncate font-mono text-[8px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-1 flex min-w-0 items-baseline gap-1">
        <span className={`truncate font-mono text-sm ${accent ? 'text-cyan-100' : 'text-slate-100'}`}>{value}</span>
        {unit && <span className="shrink-0 font-mono text-[9px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

function SeriesLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[8px] uppercase tracking-widest">
      <span className="inline-flex items-center gap-1 text-emerald-200">
        <span className="h-0.5 w-3 border-t border-dashed border-emerald-300" />
        {SERIES_LABELS.detected}
      </span>
      <span className="inline-flex items-center gap-1 text-cyan-200">
        <span className="h-0.5 w-3" style={{ backgroundColor: FORECAST_COLOR }} />
        {SERIES_LABELS.forecast}
      </span>
    </div>
  );
}

export function ForecastLineChart({
  data,
  variable,
  nowMs,
  expanded,
}: {
  data: L1ForecastPanelData;
  variable: ForecastVariable;
  nowMs: number;
  expanded: boolean;
}) {
  const config = VARIABLE_CONFIG[variable];
  const Icon = config.icon;
  const rows = useMemo(() => buildChartRows(data, variable), [data, variable]);
  const hasData = rows.some(row => row.detected !== null || row.forecast !== null);
  const domainEnd = rows.length ? Math.max(...rows.map(row => row.t), nowMs) : nowMs;
  const height = expanded ? 226 : 144;

  return (
    <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/45 p-3">
      <div className="mb-2 flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden />
          <div className="min-w-0">
            <h3 className="truncate text-[11px] font-semibold uppercase tracking-widest text-slate-300">{config.title}</h3>
            <p className="mt-0.5 font-mono text-[8px] uppercase tracking-widest text-slate-600">{config.unit}</p>
          </div>
        </div>
      </div>
      <SeriesLegend />
      <div className="mt-2 w-full" style={{ height }}>
        {hasData ? (
          <ResponsiveContainer width="100%" height={height} minWidth={0} minHeight={height} initialDimension={{ width: 320, height }}>
            <LineChart data={rows} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              {domainEnd > nowMs && (
                <ReferenceArea x1={nowMs} x2={domainEnd} fill="#0ea5e9" fillOpacity={0.08} strokeOpacity={0} ifOverflow="hidden" />
              )}
              <ReferenceLine
                x={nowMs}
                stroke="#22d3ee"
                strokeDasharray="3 3"
                strokeOpacity={0.65}
                ifOverflow="hidden"
                label={expanded ? { value: 'NOW', position: 'insideTop', fill: '#67e8f9', fontSize: 9 } : undefined}
              />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                stroke="#475569"
                fontSize={10}
                tickMargin={5}
                minTickGap={expanded ? 30 : 42}
                tickFormatter={(value: number) => formatClockMs(value)}
              />
              <YAxis
                width={config.yWidth}
                stroke="#475569"
                fontSize={10}
                tickMargin={5}
                domain={['auto', 'auto']}
                tickFormatter={(value: number | string) => formatYAxis(value, variable)}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '12px' }}
                labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                labelFormatter={value => `${formatClockMs(Number(value))} UTC`}
                formatter={(value, name) => [
                  `${formatMetric(Number(value), config.digits)} ${config.unit}`,
                  SERIES_LABELS[String(name) as keyof Omit<ChartRow, 't'>] ?? String(name),
                ]}
              />
              <Line name="detected" dataKey="detected" stroke={DETECTED_COLOR} strokeWidth={1.3} strokeDasharray="4 4" dot={false} connectNulls isAnimationActive={false} type="linear" />
              {/* Single forecast line: ML-corrected where available, MRU ballistic as fallback (folded in buildChartRows). */}
              <Line name="forecast" dataKey="forecast" stroke={FORECAST_COLOR} strokeWidth={1.55} dot={false} connectNulls isAnimationActive={false} type="linear" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded border border-slate-800 bg-slate-950/60 font-mono text-[10px] uppercase tracking-widest text-slate-600">
            No live data
          </div>
        )}
      </div>
    </div>
  );
}

function buildElectronFluxRows(data: L1ForecastPanelData): ElectronFluxChartRow[] {
  return data.electronFlux.points.map(point => ({
    t: point.t,
    de1: point.de1,
    de4: point.de4,
    de1Log: logFlux(point.de1),
    de4Log: logFlux(point.de4),
  }));
}

function ElectronFluxChart({ data, expanded }: { data: L1ForecastPanelData; expanded: boolean }) {
  const rows = useMemo(() => buildElectronFluxRows(data), [data]);
  const hasData = rows.some(row => row.de1Log !== null || row.de4Log !== null);
  const height = expanded ? 226 : 144;

  return (
    <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/45 p-3">
      <div className="mb-2 flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden />
          <div className="min-w-0">
            <h3 className="truncate text-[11px] font-semibold uppercase tracking-widest text-slate-300">Electron flux at L1</h3>
            <p className="mt-0.5 truncate font-mono text-[8px] uppercase tracking-widest text-slate-600">
              ACE EPAM · differential channels
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest text-amber-100">
          L1 upstream
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[8px] uppercase tracking-widest">
        <span className="inline-flex items-center gap-1 text-amber-200">
          <span className="h-0.5 w-3" style={{ backgroundColor: ELECTRON_DE1_COLOR }} />
          DE1
        </span>
        <span className="inline-flex items-center gap-1 text-fuchsia-200">
          <span className="h-0.5 w-3" style={{ backgroundColor: ELECTRON_DE4_COLOR }} />
          DE4
        </span>
        <span className="text-slate-600">log scale</span>
      </div>

      <div className="mt-2 w-full" style={{ height }}>
        {hasData ? (
          <ResponsiveContainer width="100%" height={height} minWidth={0} minHeight={height} initialDimension={{ width: 320, height }}>
            <LineChart data={rows} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                stroke="#475569"
                fontSize={10}
                tickMargin={5}
                minTickGap={expanded ? 30 : 42}
                tickFormatter={(value: number) => formatClockMs(value)}
              />
              <YAxis
                width={48}
                stroke="#475569"
                fontSize={10}
                tickMargin={5}
                domain={['auto', 'auto']}
                tickFormatter={formatLogFluxAxis}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '12px' }}
                labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                labelFormatter={value => `${formatClockMs(Number(value))} UTC`}
                formatter={(value, name, item) => {
                  const payload = (item as { payload?: ElectronFluxChartRow }).payload;
                  const rawValue = String(name) === 'de1Log' ? payload?.de1 ?? null : payload?.de4 ?? null;
                  const label = String(name) === 'de1Log' ? 'DE1 electron flux' : 'DE4 electron flux';
                  return [`${formatFlux(rawValue)} ${data.electronFlux.unit}`, label];
                }}
              />
              <Line name="de1Log" dataKey="de1Log" stroke={ELECTRON_DE1_COLOR} strokeWidth={1.45} dot={false} connectNulls isAnimationActive={false} type="linear" />
              <Line name="de4Log" dataKey="de4Log" stroke={ELECTRON_DE4_COLOR} strokeWidth={1.45} dot={false} connectNulls isAnimationActive={false} type="linear" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded border border-slate-800 bg-slate-950/60 px-3 text-center font-mono text-[10px] uppercase tracking-widest text-slate-600">
            {data.electronFlux.warning ?? 'ACE EPAM electron flux unavailable'}
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2 font-mono text-[8px] uppercase tracking-widest text-slate-600">
        <span>{data.electronFlux.sourceLabel}</span>
        <span>{data.electronFlux.latestTimeUtc ? `${formatIsoClock(data.electronFlux.latestTimeUtc)} UTC` : 'latest --'}</span>
      </div>
    </div>
  );
}

function CurrentL1Summary({ data, expanded }: { data: L1ForecastPanelData; expanded: boolean }) {
  return (
    <section className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.055] p-3 shadow-[0_0_24px_rgba(8,145,178,0.08)]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ArrowRight className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden />
          <div className="min-w-0">
            <h3 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-200">L1 -&gt; Earth now</h3>
            <p className="mt-0.5 truncate font-mono text-[9px] uppercase tracking-widest text-slate-500">
              {formatIsoClock(data.latest.sampleTimeUtc)} UTC detected - {formatIsoClock(data.latest.arrivalUtc)} UTC arrival
            </p>
          </div>
        </div>
        <StatusChip level={data.latest.gLevel} code={data.latest.gCode} />
      </div>

      <div className={`grid gap-2 ${expanded ? 'sm:grid-cols-3 xl:grid-cols-6' : 'grid-cols-2'}`}>
        <StatTile label="Speed" value={formatMetric(data.latest.speed, 0)} unit="km/s" accent />
        <StatTile label="Bz GSM" value={formatMetric(data.latest.bz, 1)} unit="nT" />
        <StatTile label="Density" value={formatMetric(data.latest.density, 1)} unit="cm^-3" />
        <StatTile label="|B|" value={formatMetric(data.latest.bt, 1)} unit="nT" />
        <StatTile label="Lead" value={formatTransit(data.latest.transitMinutes)} />
        <StatTile label="Kp est." value={formatMetric(data.latest.kp, 1)} />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-cyan-400/10 pt-2 font-mono text-[9px] uppercase tracking-widest text-slate-500">
        <span className="truncate">{data.sourceLabel ?? 'L1 source unavailable'}</span>
        <span>{formatDistance(data.distanceKm)} - {data.distanceIsMeasured ? 'measured' : 'nominal'}</span>
      </div>
    </section>
  );
}

function timelineFraction(startMs: number | null, endMs: number | null, markerMs: number | null) {
  if (startMs === null || endMs === null || markerMs === null || endMs <= startMs) return null;
  if (markerMs < startMs || markerMs > endMs) return null;
  return clamp01((markerMs - startMs) / (endMs - startMs));
}

function GGradientLegend({
  level,
  label,
  detail,
}: {
  level: number | null;
  label: string;
  detail: string;
}) {
  const markerPct = level === null ? null : clamp01(level / 5) * 100;

  return (
    <section className="rounded-lg border border-cyan-400/20 bg-slate-950/55 p-3 shadow-[0_0_24px_rgba(8,145,178,0.08)]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-100">Forecast severity legend</h3>
          <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-slate-300">{detail}</p>
        </div>
        <span className="rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-cyan-100">
          {label}
        </span>
      </div>

      <div className="relative pt-5">
        {markerPct !== null && (
          <div
            className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-1"
            style={{ left: `${markerPct}%` }}
          >
            <span className="rounded border border-white/35 bg-slate-950/90 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest text-white">Now</span>
            <span className="h-3 w-px bg-white shadow-[0_0_10px_rgba(255,255,255,0.55)]" />
          </div>
        )}
        <div
          className="h-4 rounded-full border border-white/20 shadow-inner"
          style={{ background: gradientCss(G_COLORS) }}
        />
        <div className="mt-2 flex justify-between font-mono text-[8px] uppercase tracking-widest text-slate-200">
          <span>G0 quiet</span>
          <span>G1</span>
          <span>G2</span>
          <span>G3</span>
          <span>G4</span>
          <span>G5</span>
        </div>
      </div>
    </section>
  );
}

function DriverLegendGrid() {
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {DRIVER_LEGENDS.map(legend => (
        <div key={legend.label} className="rounded-md border border-slate-700/60 bg-slate-950/55 p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] uppercase tracking-widest text-slate-100">{legend.label}</span>
            <span className="font-mono text-[8px] uppercase tracking-widest text-slate-300">{legend.unit}</span>
          </div>
          <div className="h-3 rounded-full border border-white/15" style={{ background: gradientCss(legend.colors) }} />
          <div className="mt-1 flex justify-between gap-1 font-mono text-[8px] text-slate-200">
            {legend.ticks.map(tick => <span key={tick}>{tick}</span>)}
          </div>
        </div>
      ))}
    </div>
  );
}

function HeatmapWindowSelector({
  value,
  onChange,
}: {
  value: HeatmapWindowKey;
  onChange: (key: HeatmapWindowKey) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-slate-700/70 bg-slate-950/60">
      {HEATMAP_WINDOWS.map(window => (
        <button
          key={window.key}
          type="button"
          onClick={() => onChange(window.key)}
          className={`px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-widest transition ${value === window.key ? 'bg-cyan-400/18 text-cyan-50' : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'}`}
        >
          {window.label}
        </button>
      ))}
    </div>
  );
}

function HeatmapRow({
  row,
  expanded,
  markerFraction,
  liveMarkers,
}: {
  row: L1ForecastHeatmapRow;
  expanded: boolean;
  markerFraction: number | null;
  liveMarkers: boolean;
}) {
  const height = row.id === 'g' ? (expanded ? 'h-16' : 'h-9') : (expanded ? 'h-5' : 'h-4');
  const showEndpointMarkers = liveMarkers && row.id === 'g';
  const l1MarkerClass = expanded ? 'h-7 w-7 text-[8px]' : 'h-6 w-6 text-[7px]';
  const earthMarkerClass = expanded ? 'right-2 h-6 w-6' : 'right-1.5 h-5 w-5';
  const edgeFadeClass = expanded ? 'w-20' : 'w-12';

  return (
    <div className={`grid min-w-0 items-center gap-2 ${expanded ? 'grid-cols-[4.75rem_minmax(0,1fr)_3.75rem]' : 'grid-cols-[3.25rem_minmax(0,1fr)_3rem]'}`}>
      <div className="min-w-0">
        <div className="truncate font-mono text-[9px] uppercase tracking-widest text-slate-100">{row.label}</div>
        <div className="truncate font-mono text-[7px] uppercase tracking-widest text-slate-300">{row.unit}</div>
      </div>
      <div className={`relative flex min-w-0 overflow-hidden rounded-md border border-slate-600/80 bg-slate-900/80 shadow-inner ${height}`}>
        {row.cells.length ? row.cells.map((cell, index) => (
          <div
            key={`${row.id}-${index}`}
            className="min-w-[2px] flex-1 border-r border-slate-950/35 transition-colors duration-700 last:border-r-0"
            style={{ backgroundColor: cell.color }}
            title={`${formatClockMs(cell.t)} UTC - ${cell.label}`}
          />
        )) : (
          <div className="h-full w-full bg-slate-700" title="No forecast samples available" />
        )}
        <div className="pointer-events-none absolute inset-0 opacity-25 mix-blend-overlay" style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.14) 0 1px, transparent 1px 24px)' }} />
        {markerFraction !== null && (
          <div
            className="pointer-events-none absolute top-0 h-full w-px bg-white/80 shadow-[0_0_10px_rgba(255,255,255,0.55)]"
            style={{ left: `${markerFraction * 100}%` }}
          />
        )}
        {showEndpointMarkers && (
          <>
            <div className={`pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-black/40 to-transparent ${edgeFadeClass}`} />
            <div className={`pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-black/45 to-transparent ${edgeFadeClass}`} />
            <div
              className={`absolute left-1.5 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md border border-white/40 bg-slate-950/75 font-semibold text-cyan-50 shadow-[0_0_14px_rgba(34,211,238,0.22)] ${l1MarkerClass}`}
              title="L1 source"
            >
              L1
            </div>
            <div
              className={`absolute top-1/2 -translate-y-1/2 rounded-full border border-white/50 bg-[radial-gradient(circle_at_32%_30%,#f8fafc_0%,#60a5fa_22%,#1d4ed8_60%,#0b1220_85%)] shadow-[0_0_18px_rgba(56,189,248,0.4)] ${earthMarkerClass}`}
              title="Earth"
            />
          </>
        )}
      </div>
      <div className="truncate text-right font-mono text-[9px] text-slate-100">{row.latestLabel}</div>
    </div>
  );
}

function HeatmapCoverage({ replay }: { replay: HeatmapReplaySeries | null }) {
  const coverage = replay?.coverage;
  if (!coverage || coverage.totalBins <= 0) return null;
  const pct = (value: number) => `${Math.round((value / coverage.totalBins) * 100)}%`;

  return (
    <div className="rounded border border-slate-700/60 bg-slate-950/55 px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-slate-200">
      Data coverage - Vsw {pct(coverage.available.speed)} - Bz {pct(coverage.available.bz)} - |B| {pct(coverage.available.bt)} - Np {pct(coverage.available.density)} - G-risk {pct(coverage.available.gRisk)}
    </div>
  );
}

function ArrivalHeatmaps({ data, expanded }: { data: L1ForecastPanelData; expanded: boolean }) {
  const [windowKey, setWindowKey] = useState<HeatmapWindowKey>('live');
  const [replay, setReplay] = useState<HeatmapReplaySeries | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [showDriverLegend, setShowDriverLegend] = useState(false);
  const prefetchedRef = useRef(false);
  const isReplay = expanded && windowKey !== 'live';
  const activeReplay = isReplay && replay && isReplaySeriesValidForWindow(windowKey, replay) ? replay : null;
  const replayLoading = isReplay && !activeReplay && replayError === null;

  const selectWindow = useCallback((key: HeatmapWindowKey) => {
    setWindowKey(key);
    setReplayError(null);
    if (key === 'live') {
      setReplay(null);
      return;
    }
    const cached = cachedHeatmapReplay(key);
    setReplay(cached);
  }, []);

  useEffect(() => {
    if (!expanded || windowKey === 'live') return;
    let cancelled = false;
    void loadHeatmapReplay(windowKey).then(series => {
      if (!cancelled) setReplay(series);
    }).catch(error => {
      if (!cancelled) setReplayError(error instanceof Error ? error.message : 'Forecast history is unavailable.');
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, windowKey]);

  useEffect(() => {
    if (!expanded || windowKey === 'live' || prefetchedRef.current) return;
    prefetchedRef.current = true;
    void (async () => {
      for (const window of HEATMAP_WINDOWS) {
        if (window.key === 'live' || window.key === windowKey || cachedHeatmapReplay(window.key)) continue;
        try {
          await loadHeatmapReplay(window.key);
          await new Promise(resolve => setTimeout(resolve, 350));
        } catch {
          return;
        }
      }
    })();
  }, [expanded, windowKey]);

  const replayRows = useMemo(
    () => activeReplay ? buildReplayHeatmapRows(activeReplay.gForecast, expanded ? MAX_EXPANDED_HEATMAP_CELLS : MAX_COMPACT_HEATMAP_CELLS) : [],
    [activeReplay, expanded],
  );
  const liveRows = useMemo(() => {
    // Live view runs L1 (newest detection) on the left to Earth (imminent arrival) on the right,
    // so cells are drawn in descending arrival time: each refresh shifts every parcel rightward,
    // toward the Earth marker. Replay windows keep chronological (ascending) order.
    return data.heatmap.rows.map(row => ({ ...row, cells: [...row.cells].reverse() }));
  }, [data.heatmap.rows]);
  const rows = isReplay ? replayRows : liveRows;
  const startMs = isReplay ? activeReplay?.startMs ?? null : data.heatmap.startMs;
  const endMs = isReplay ? activeReplay?.endMs ?? null : data.heatmap.endMs;
  const markerMs = isReplay ? activeReplay?.endMs ?? null : data.generatedAtMs;
  const timeFraction = timelineFraction(startMs, endMs, markerMs);
  const markerFraction = timeFraction === null || isReplay ? timeFraction : 1 - timeFraction;
  const hasCells = rows.some(row => row.cells.length > 0);
  const replayPeak = useMemo(() => {
    if (!activeReplay || activeReplay.gForecast.length === 0) return null;
    return activeReplay.gForecast.reduce((peak, point) => {
      if (point.riskAvailable === false) return peak;
      if (peak === null || point.level > peak.level) return point;
      return peak;
    }, null as HeatmapReplayPoint | null);
  }, [activeReplay]);
  const legendLevel = isReplay ? replayPeak?.level ?? null : data.latest.gLevel;
  const legendLabel = isReplay
    ? (replayPeak ? `Peak in ${windowKey} - G${replayPeak.level}` : `Replay ${windowKey}`)
    : `Now at Earth - ${data.latest.gCode}`;

  return (
    <div className="flex min-w-0 flex-col">
      {expanded && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-slate-100">
            <History className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden />
            <HeatmapWindowSelector value={windowKey} onChange={selectWindow} />
          </div>
          <button
            type="button"
            onClick={() => setShowDriverLegend(value => !value)}
            className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-widest transition ${showDriverLegend ? 'border-cyan-400/40 bg-cyan-400/15 text-cyan-50' : 'border-slate-700/70 bg-slate-950/60 text-slate-200 hover:text-white'}`}
          >
            <Info className="h-3.5 w-3.5" aria-hidden />
            {showDriverLegend ? 'Hide variable scales' : 'Variable scales'}
          </button>
        </div>
      )}

      {expanded && (
        <div className="mb-3">
          <GGradientLegend
            level={legendLevel}
            label={legendLabel}
            detail={isReplay ? 'Historical arrivals colored by forecast severity' : 'Now marker shows the wind parcel currently reaching Earth'}
          />
        </div>
      )}

      {expanded && showDriverLegend && (
        <div className="mb-3">
          <DriverLegendGrid />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="truncate font-mono text-[9px] uppercase tracking-widest text-slate-200">
          {isReplay ? 'Historical arrival timeline - colour = forecast severity' : 'L1 to Earth propagation - colour = forecast severity on arrival'}
        </p>
        <span className="font-mono text-[9px] uppercase tracking-widest text-slate-200">
          {formatWindowRange(startMs, endMs)}
        </span>
      </div>

      {isReplay && replayLoading && (
        <div className="mb-3 flex items-center gap-2 rounded border border-cyan-400/20 bg-cyan-400/[0.06] px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-cyan-100">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Loading forecast history
        </div>
      )}

      {isReplay && replayError && (
        <div className="mb-3 rounded border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-amber-100">
          {replayError}
        </div>
      )}

      {hasCells ? (
        <>
          <div className={`mb-1 grid gap-2 font-mono text-[8px] uppercase tracking-widest text-slate-300 ${expanded ? 'grid-cols-[4.75rem_minmax(0,1fr)_3.75rem]' : 'grid-cols-[3.25rem_minmax(0,1fr)_3rem]'}`}>
            <span />
            <div className="flex items-center justify-between">
              {isReplay ? (
                <>
                  <span>{startMs !== null ? formatDayMs(startMs) : '--'}</span>
                  <span className="hidden text-slate-400 sm:inline">arrival history - {windowKey}</span>
                  <span>{endMs !== null ? 'now' : '--'}</span>
                </>
              ) : expanded ? (
                <>
                  <span>L1 - active RTSW</span>
                  <span className="hidden text-slate-400 sm:inline">detected - in transit - Earth bow-shock nose</span>
                  <span>Earth bow shock</span>
                </>
              ) : (
                <>
                  <span>now at L1</span>
                  <span>arriving at Earth</span>
                </>
              )}
            </div>
            <span className="text-right">{isReplay ? 'last' : 'L1 now'}</span>
          </div>
          <div className="space-y-1.5">
            {rows.map(row => (
              <HeatmapRow
                key={row.id}
                row={row}
                expanded={expanded}
                markerFraction={markerFraction}
                liveMarkers={!isReplay}
              />
            ))}
          </div>
          {expanded && isReplay && <div className="mt-3"><HeatmapCoverage replay={activeReplay} /></div>}
        </>
      ) : (
        <div className="flex h-28 items-center justify-center rounded border border-slate-700 bg-slate-950/60 font-mono text-[10px] uppercase tracking-widest text-slate-200">
          {replayLoading ? 'Loading forecast history' : 'No arrival samples'}
        </div>
      )}
    </div>
  );
}

function DataQualityFooter({ data }: { data: L1ForecastPanelData }) {
  const stale = data.freshness !== 'fresh';
  const warning = data.warnings[0] ?? null;
  if (!stale && !warning) return null;

  return (
    <div className="rounded-md border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-amber-100/80">
      {stale ? `L1 feed ${data.freshness} - last sample ${formatAge(data.latestSampleAgeMinutes)} ago` : warning}
    </div>
  );
}

// Left column: the definitive L1 -> Earth propagation (now + expected at arrival) plus the live
// forecast charts. This is the single surviving version of the old "Arrival Prediction" content.
export const L1PropagationPanel: React.FC<L1ForecastPanelProps> = ({
  data: initialData,
  expanded = false,
  className = '',
}) => {
  const data = useLiveL1ForecastData(initialData);
  const variables: ForecastVariable[] = ['speed', 'bz', 'density', 'bt'];

  return (
    <GlassCard
      title="L1 -> Earth Propagation"
      className={`h-full ${className}`}
      bodyClassName="p-3"
      headerClassName="pr-12"
    >
      <div className="flex min-h-0 flex-col gap-3">
        <CurrentL1Summary data={data} expanded={expanded} />

        <section className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <BarChart3 className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden />
              <h3 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">Live charts</h3>
            </div>
            <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">L1 + Forecast</span>
          </div>
          <div className={`grid min-w-0 gap-3 ${expanded ? 'lg:grid-cols-2' : ''}`}>
            {variables.map(variable => (
              <ForecastLineChart
                key={variable}
                data={data}
                variable={variable}
                nowMs={data.generatedAtMs}
                expanded={expanded}
              />
            ))}
            <div className={expanded ? 'lg:col-span-2' : ''}>
              <ElectronFluxChart data={data} expanded={expanded} />
            </div>
          </div>
        </section>

        <DataQualityFooter data={data} />

        <div className="flex items-center gap-1.5 px-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-600">
          <Clock3 className="h-3 w-3 shrink-0" aria-hidden />
          <span>Generated {formatClockMs(data.generatedAtMs)} UTC</span>
        </div>
      </div>
    </GlassCard>
  );
};

// Center column: the forecast severity heatmaps over the L1->Earth arrival timeline.
export const ArrivalHeatmapPanel: React.FC<L1ForecastPanelProps> = ({
  data: initialData,
  expanded = false,
  className = '',
}) => {
  const data = useLiveL1ForecastData(initialData);
  return (
    <GlassCard
      title="Forecast Heatmaps"
      className={`h-full ${className}`}
      bodyClassName="p-3"
      headerClassName="pr-12 [&>h2]:text-slate-200"
    >
      <div className="flex min-h-0 flex-col gap-3">
        <ArrivalHeatmaps data={data} expanded={expanded} />
        <DataQualityFooter data={data} />
      </div>
    </GlassCard>
  );
};
