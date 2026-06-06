"use client";

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Activity,
  ArrowLeft,
  CalendarRange,
  Check,
  ChevronDown,
  Clock3,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FlaskConical,
  Globe2,
  Info,
  Layers3,
  ListFilter,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RadioTower,
  Satellite,
  X,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PlaygroundTelemetryData } from '@/services/playgroundTelemetryService';
import type {
  SpacecraftConnectionStatus,
  SpacecraftId,
  SpacecraftTelemetry,
} from '@/services/spacecraftTelemetryService';
import {
  L1_PUBLIC_SOURCES,
  NEAR_EARTH_PUBLIC_SOURCES,
  type PublicDataReadiness,
  type PublicSpaceWeatherSource,
} from '@/services/spaceWeatherSourceCatalog';
import { PipelineHealthPanel } from './PipelineHealthPanel';
import type { PipelineHealthSnapshot } from '@/services/pipelineHealthService';
import { DataQualityPanel } from './DataQualityPanel';
import type { DataQualitySnapshot } from '@/services/dataQualityService';
import { ExplorationUnivariatePanel } from './ExplorationUnivariatePanel';
import { ExplorationCouplingPanel } from './ExplorationCouplingPanel';
import type { ExplorationSnapshot } from '@/services/explorationService';
import { ModelsOverviewPanel, DataPipelinePanel } from './ModelsOverviewPanel';
import { MruValidationPanel } from './MruValidationPanel';
import type { MruValidationSnapshot } from '@/services/mruValidationService';
import { MruLiveForecastPanel } from './MruLiveForecastPanel';
import type { HistoricPlotsSnapshot } from '@/services/historicPlotService';
import { HistoricAvailabilityCalendar } from './HistoricAvailabilityCalendar';
import { InSituOrbitScene } from './InSituOrbitScene';
import { HistoricOrbitScene } from './HistoricOrbitScene';
import {
  PLAYGROUND_SCREENS_BY_STAGE,
  getPlaygroundCodeAriaLabel,
  getPlaygroundStage,
  getScreenForView,
  type PlaygroundScreenConfig,
  type PlaygroundTab,
  type StageCoded,
} from './playgroundTaxonomy';
import { PLAYGROUND_SCREEN_INFO } from './playgroundScreenInfo';

type ChartSourceRow = {
  time_tag: string;
  value: string | number | null;
};

type ChartDefinition = {
  id: string;
  spacecraftId: string;
  spacecraftName: string;
  source: string;
  title: string;
  unit: string;
  dataKey: 'value';
  color: string;
  data: ChartSourceRow[];
  status: SpacecraftConnectionStatus;
  lastSampleTime: string | null;
};

type PlotTimeZone = 'UTC' | 'CEST';

interface PlaygroundDashboardProps extends PlaygroundTelemetryData {
  adminEmail: string | null;
}

const L1_TO_EARTH_DISTANCE_KM = 1_500_000;
const TELEMETRY_POLL_INTERVAL_MS = 30_000;
const PIPELINE_HEALTH_POLL_INTERVAL_MS = 60_000;
const CHART_FRESH_SAMPLE_MS = 45 * 60 * 1000;
const CHART_FUTURE_SAMPLE_TOLERANCE_MS = 5 * 60 * 1000;
const PLOT_TIME_ZONE_CONFIG: Record<PlotTimeZone, { label: string; timeZone: string }> = {
  UTC: { label: 'UTC', timeZone: 'UTC' },
  CEST: { label: 'CEST', timeZone: 'Europe/Madrid' },
};
const HISTORIC_PLOT_COUNT_BY_SOURCE_ID: Record<string, number> = {
  'cdaweb-ace-wind-imap': 16,
  'ncei-dscovr-archive': 1,
  'omni-hro': 7,
  'swpc-goes-json': 12,
};

function getHistoricPlotCount(sourceId: string) {
  return HISTORIC_PLOT_COUNT_BY_SOURCE_ID[sourceId] ?? 0;
}

function getDefaultHistoricRange() {
  const stop = new Date();
  const start = new Date(stop.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    start: start.toISOString().slice(0, 16),
    stop: stop.toISOString().slice(0, 16),
  };
}

function datetimeLocalToUtcIso(value: string) {
  const normalizedValue = value.length === 16 ? `${value}:00Z` : `${value}Z`;
  const parsed = new Date(normalizedValue);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseMetric(value: string | number | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getZoneShortLabel(date: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(date);
    return parts.find(part => part.type === 'timeZoneName')?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** Timezones offered in the second-clock picker. */
const CUSTOM_ZONE_OPTIONS: Array<{ tz: string; city: string }> = [
  { tz: 'Europe/Madrid', city: 'Madrid' },
  { tz: 'Europe/London', city: 'London' },
  { tz: 'Europe/Berlin', city: 'Berlin' },
  { tz: 'America/New_York', city: 'New York' },
  { tz: 'America/Los_Angeles', city: 'Los Angeles' },
  { tz: 'America/Sao_Paulo', city: 'São Paulo' },
  { tz: 'Asia/Tokyo', city: 'Tokyo' },
  { tz: 'Asia/Kolkata', city: 'India' },
  { tz: 'Australia/Sydney', city: 'Sydney' },
];

function formatClockDate(date: Date, timeZone: string) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone,
  });
}

function formatClockTime(date: Date, timeZone: string) {
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
  });
}

function getPlotTimeZoneConfig(plotTimeZone: PlotTimeZone | undefined) {
  return PLOT_TIME_ZONE_CONFIG[plotTimeZone ?? 'UTC'];
}

function parseTelemetryDate(value: string) {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
    return new Date(value);
  }

  return new Date(`${value.replace(' ', 'T')}Z`);
}

function getLatestChartSampleTime(data: ChartSourceRow[]) {
  const latestMs = data.reduce((currentLatest, point) => {
    const parsed = point.time_tag ? parseTelemetryDate(point.time_tag) : null;

    if (!parsed || Number.isNaN(parsed.getTime())) {
      return currentLatest;
    }

    return Math.max(currentLatest, parsed.getTime());
  }, 0);

  return latestMs > 0 ? new Date(latestMs).toISOString() : null;
}

function getChartStatusFromData(data: ChartSourceRow[], fallbackStatus: SpacecraftConnectionStatus) {
  if (fallbackStatus === 'off') {
    return fallbackStatus;
  }

  const lastSampleTime = getLatestChartSampleTime(data);

  if (!lastSampleTime) {
    return 'off';
  }

  const sampleAgeMs = Date.now() - parseTelemetryDate(lastSampleTime).getTime();

  return sampleAgeMs >= -CHART_FUTURE_SAMPLE_TOLERANCE_MS && sampleAgeMs <= CHART_FRESH_SAMPLE_MS
    ? 'live'
    : 'stale';
}

function formatChartTime(value: string, plotTimeZone: PlotTimeZone | undefined) {
  const timeZoneConfig = getPlotTimeZoneConfig(plotTimeZone);

  return parseTelemetryDate(value).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timeZoneConfig.timeZone,
  });
}

function formatDateTime(value: string | null | undefined, plotTimeZone: PlotTimeZone = 'UTC') {
  if (!value) {
    return 'Not available';
  }

  const date = parseTelemetryDate(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: getPlotTimeZoneConfig(plotTimeZone).timeZone,
  }) + ` ${getPlotTimeZoneConfig(plotTimeZone).label}`;
}

function formatCompactAge(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = parseTelemetryDate(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? 'ago' : '';
  const prefix = diffMs < 0 ? 'in ' : '';

  if (absMs < 60 * 1000) {
    return 'now';
  }

  const minutes = Math.round(absMs / (60 * 1000));

  if (minutes < 60) {
    return `${prefix}${minutes}m${suffix ? ` ${suffix}` : ''}`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return `${prefix}${hours}h${suffix ? ` ${suffix}` : ''}`;
  }

  const days = Math.round(hours / 24);

  if (days < 60) {
    return `${prefix}${days}d${suffix ? ` ${suffix}` : ''}`;
  }

  const months = Math.round(days / 30);

  if (months < 24) {
    return `${prefix}${months}mo${suffix ? ` ${suffix}` : ''}`;
  }

  const years = Math.round(months / 12);

  return `${prefix}${years}y${suffix ? ` ${suffix}` : ''}`;
}

function formatLastSample(value: string | null | undefined, plotTimeZone: PlotTimeZone = 'UTC') {
  if (!value) {
    return 'Not available';
  }

  const compactAge = formatCompactAge(value);

  return compactAge ? `${formatDateTime(value, plotTimeZone)} (${compactAge})` : formatDateTime(value, plotTimeZone);
}

function formatDuration(seconds: number | null) {
  if (seconds === null) {
    return 'Not available';
  }

  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours}h ${minutes}m`;
}

function formatNumber(value: number | null, maximumFractionDigits = 1) {
  if (value === null) {
    return 'Not available';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function getStatusMeta(status: SpacecraftConnectionStatus) {
  if (status === 'live') {
    return {
      label: 'Live',
      className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    };
  }

  if (status === 'stale') {
    return {
      label: 'Stale',
      className: 'border-amber-300/30 bg-amber-300/10 text-amber-100',
    };
  }

  return {
    label: 'Off',
    className: 'border-slate-700 bg-slate-800/60 text-slate-500',
  };
}

const StatusPill = ({ status }: { status: SpacecraftConnectionStatus }) => {
  const statusMeta = getStatusMeta(status);

  return (
    <span className={`rounded border px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest ${statusMeta.className}`}>
      {statusMeta.label}
    </span>
  );
};

function getSourceReadinessMeta(readiness: PublicDataReadiness) {
  if (readiness === 'connected') {
    return {
      label: 'Connected',
      className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    };
  }

  if (readiness === 'candidate') {
    return {
      label: 'Candidate',
      className: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100',
    };
  }

  if (readiness === 'archive') {
    return {
      label: 'Archive',
      className: 'border-amber-300/30 bg-amber-300/10 text-amber-100',
    };
  }

  return {
    label: 'Gap',
    className: 'border-rose-400/30 bg-rose-400/10 text-rose-100',
  };
}

const SourceReadinessPill = ({ readiness }: { readiness: PublicDataReadiness }) => {
  const statusMeta = getSourceReadinessMeta(readiness);

  return (
    <span className={`rounded border px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest ${statusMeta.className}`}>
      {statusMeta.label}
    </span>
  );
};

const MetricCard = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0 rounded-md border border-slate-800 bg-slate-950/50 p-3">
    <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
    <div className="mt-2 truncate font-mono text-sm text-slate-100">{value}</div>
  </div>
);

function SourceCatalogCard({
  source,
  selectable = false,
  selected = false,
  onToggle,
  activeActionLabel = 'Selected',
  inactiveActionLabel = 'Select',
  plotCount,
}: {
  source: PublicSpaceWeatherSource;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (sourceId: string) => void;
  activeActionLabel?: string;
  inactiveActionLabel?: string;
  plotCount?: number;
}) {
  const content = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-slate-100">{source.name}</h3>
            <span className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-400">
              {source.orbit}
            </span>
            <span className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-400">
              {source.cadence}
            </span>
            {plotCount !== undefined && (
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${
                plotCount > 0
                  ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100'
                  : 'border-slate-800 bg-slate-950 text-slate-600'
              }`}>
                {plotCount} plots
              </span>
            )}
          </div>
          <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
            {source.provider}
          </div>
        </div>
        <SourceReadinessPill readiness={source.readiness} />
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-400">{source.useCase}</p>

      <div className="mt-3 grid gap-2 rounded-md border border-slate-800 bg-slate-950/50 p-3 font-mono text-[10px] text-slate-400 sm:grid-cols-2">
        <div className="min-w-0">
          <div className="uppercase tracking-widest text-slate-600">Access</div>
          <div className="mt-1 truncate text-slate-300" title={source.access}>{source.access}</div>
        </div>
        <div className="min-w-0">
          <div className="uppercase tracking-widest text-slate-600">Endpoint</div>
          <div className="mt-1 truncate text-cyan-300/70" title={source.endpoint}>{source.endpoint}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {source.variables.slice(0, 5).map(variable => (
          <span
            key={variable}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-300"
          >
            {variable}
          </span>
        ))}
        {source.variables.length > 5 && (
          <span className="rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-500">
            +{source.variables.length - 5}
          </span>
        )}
      </div>

      <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 truncate font-mono text-[10px] text-slate-500" title={source.spacecraft.join(', ')}>
          {source.spacecraft.join(' / ')}
        </div>
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-700 px-2.5 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100"
          onClick={event => event.stopPropagation()}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Source</span>
        </a>
      </div>
    </>
  );

  if (selectable) {
    return (
      <article
        className={`min-w-0 rounded-lg border p-4 text-left transition ${
          selected
            ? 'border-cyan-400/45 bg-cyan-400/10 shadow-inner shadow-cyan-950/20'
            : 'border-slate-800 bg-slate-950/45 hover:border-slate-600 hover:bg-slate-900/50'
        }`}
      >
        <button
          type="button"
          aria-pressed={selected}
          onClick={() => onToggle?.(source.id)}
          className="mb-3 flex h-7 items-center gap-2 rounded-md border border-slate-700 bg-slate-950/60 px-2 font-mono text-[10px] uppercase tracking-widest text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-100"
        >
          <span className={`flex h-4 w-4 items-center justify-center rounded border ${
            selected ? 'border-cyan-300 bg-cyan-300 text-slate-950' : 'border-slate-600'
          }`}>
            {selected && <Check className="h-3 w-3" aria-hidden="true" />}
          </span>
          <span>{selected ? activeActionLabel : inactiveActionLabel}</span>
        </button>
        {content}
      </article>
    );
  }

  return (
    <article className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/45 p-4">
      {content}
    </article>
  );
}

function SourceCatalogGrid({
  sources,
  selectable = false,
  selectedSourceIds = [],
  onToggleSource,
  activeActionLabel,
  inactiveActionLabel,
  getPlotCount,
}: {
  sources: PublicSpaceWeatherSource[];
  selectable?: boolean;
  selectedSourceIds?: string[];
  onToggleSource?: (sourceId: string) => void;
  activeActionLabel?: string;
  inactiveActionLabel?: string;
  getPlotCount?: (sourceId: string) => number;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {sources.map(source => (
        <SourceCatalogCard
          key={source.id}
          source={source}
          selectable={selectable}
          selected={selectedSourceIds.includes(source.id)}
          onToggle={onToggleSource}
          activeActionLabel={activeActionLabel}
          inactiveActionLabel={inactiveActionLabel}
          plotCount={getPlotCount?.(source.id)}
        />
      ))}
    </div>
  );
}

function HistoricSourceSelector({
  sources,
  selectedSourceIds,
  showUnselected,
  onToggleSource,
  onToggleShowUnselected,
}: {
  sources: PublicSpaceWeatherSource[];
  selectedSourceIds: string[];
  showUnselected: boolean;
  onToggleSource: (sourceId: string) => void;
  onToggleShowUnselected: () => void;
}) {
  const selectedSources = sources.filter(source => selectedSourceIds.includes(source.id));
  const unselectedSources = sources.filter(source => !selectedSourceIds.includes(source.id));

  const renderSourceRow = (source: PublicSpaceWeatherSource) => {
    const selected = selectedSourceIds.includes(source.id);
    const plotCount = getHistoricPlotCount(source.id);
    const disabled = plotCount === 0 && !selected;

    return (
      <button
        key={source.id}
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        onClick={() => onToggleSource(source.id)}
        className={`min-w-0 rounded-md border p-2.5 text-left transition ${
          selected
            ? 'border-cyan-400/45 bg-cyan-400/10 text-slate-100'
            : disabled
              ? 'cursor-not-allowed border-slate-800 bg-slate-950/35 text-slate-600'
              : 'border-slate-800 bg-slate-950/45 text-slate-300 hover:border-slate-600 hover:bg-slate-900/50'
        }`}
        title={disabled ? 'No historic plot parser wired for this source yet' : undefined}
      >
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="flex min-w-0 items-start gap-2">
            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
              selected ? 'border-cyan-300 bg-cyan-300 text-slate-950' : 'border-slate-600'
            }`}>
              {selected && <Check className="h-3 w-3" aria-hidden="true" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{source.name}</span>
              <span className="mt-1 block truncate font-mono text-[9px] uppercase tracking-widest text-slate-500">
                {source.provider}
              </span>
            </span>
          </span>
          <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${
            plotCount > 0
              ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100'
              : 'border-slate-800 bg-slate-950 text-slate-600'
          }`}>
            {plotCount} plots
          </span>
        </span>
        <span className="mt-2 flex items-center gap-1.5">
          <span className="rounded border border-slate-700/80 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest text-slate-500">
            {source.orbit}
          </span>
          <span className="rounded border border-slate-700/80 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest text-slate-500">
            {source.cadence}
          </span>
        </span>
      </button>
    );
  };

  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ListFilter className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
            Historic data sets
          </h2>
        </div>
        <button
          type="button"
          onClick={onToggleShowUnselected}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-2 font-mono text-[9px] uppercase tracking-widest text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-100"
        >
          {showUnselected ? (
            <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{showUnselected ? 'Hide' : 'Show'} others</span>
        </button>
      </div>

      <div className="grid gap-2">
        {selectedSources.length > 0 ? (
          selectedSources.map(renderSourceRow)
        ) : (
          <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-500">
            No plot-ready source selected.
          </div>
        )}
      </div>

      {showUnselected && (
        <div className="mt-4">
          <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-slate-600">
            Other sources
          </div>
          <div className="grid gap-2">
            {unselectedSources.map(renderSourceRow)}
          </div>
        </div>
      )}
    </section>
  );
}

function HistoricSidebarRail({
  sources,
  selectedSourceIds,
  onToggleSource,
  onOpenAvailability,
  onExpand,
}: {
  sources: PublicSpaceWeatherSource[];
  selectedSourceIds: string[];
  onToggleSource: (sourceId: string) => void;
  onOpenAvailability: () => void;
  onExpand: () => void;
}) {
  const selectedSources = sources.filter(source => selectedSourceIds.includes(source.id));

  return (
    <aside className="grid content-start gap-3">
      <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-2 shadow-2xl backdrop-blur-xl">
        <button
          type="button"
          aria-label="Expand historic sidebar"
          title="Expand sidebar"
          onClick={onExpand}
          className="flex h-10 w-full items-center justify-center rounded-md border border-slate-700 bg-slate-950/60 text-slate-400 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100"
        >
          <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="mt-2 grid gap-2">
          <button
            type="button"
            aria-label="Open historical availability calendar"
            onClick={onOpenAvailability}
            className="flex h-10 items-center justify-center rounded-md border border-slate-800 bg-slate-950/50 text-cyan-300 transition hover:border-cyan-400/50 hover:bg-cyan-400/10 hover:text-cyan-100"
            title="Historical availability"
          >
            <CalendarRange className="h-4 w-4" aria-hidden="true" />
          </button>
          <div
            className="grid min-h-12 place-items-center rounded-md border border-slate-800 bg-slate-950/50 text-amber-300"
            title={`${selectedSources.length} selected data sets`}
          >
            <ListFilter className="h-4 w-4" aria-hidden="true" />
            <span className="font-mono text-[9px] text-slate-500">{selectedSources.length}</span>
          </div>
        </div>
      </section>

      <section className="grid gap-2 rounded-lg border border-slate-700/50 bg-slate-900/30 p-2 shadow-2xl backdrop-blur-xl">
        {selectedSources.map(source => (
          <button
            key={source.id}
            type="button"
            aria-label={`Remove ${source.name}`}
            title={`${source.name} · ${getHistoricPlotCount(source.id)} plots`}
            onClick={() => onToggleSource(source.id)}
            className="grid min-h-14 place-items-center rounded-md border border-cyan-400/35 bg-cyan-400/10 text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-mono text-[9px] uppercase tracking-widest text-slate-300">
              {source.orbit}
            </span>
            <span className="font-mono text-[9px] text-cyan-200">
              {getHistoricPlotCount(source.id)}
            </span>
          </button>
        ))}
      </section>
    </aside>
  );
}

function MissionInfoModal({
  spacecraftTelemetry,
  onClose,
}: {
  spacecraftTelemetry: SpacecraftTelemetry[];
  onClose: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[2147483647] bg-slate-950/85 p-4 backdrop-blur-md sm:p-8">
      <button
        type="button"
        aria-label="Cerrar informacion de misiones"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <section className="relative mx-auto flex h-full max-h-[900px] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-slate-200 shadow-2xl shadow-cyan-950/30">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300">
              Mapa de fuentes
            </div>
            <h2 className="mt-1 truncate text-xl font-semibold text-slate-100">
              Misiones, naves y variables
            </h2>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-4 lg:grid-cols-2">
            {spacecraftTelemetry.map(mission => (
              <article
                key={mission.id}
                className="rounded-lg border border-slate-800 bg-slate-900/35 p-4"
              >
                <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-slate-100">{mission.displayName}</h3>
                    <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      {mission.source}
                    </div>
                  </div>
                  <StatusPill status={mission.status} />
                </div>

                <div className="space-y-3 text-sm text-slate-300">
                  <div>
                    <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-slate-500">
                      Plataforma / satelite
                    </div>
                    <p className="leading-relaxed">{mission.platform}</p>
                  </div>

                  <div>
                    <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-slate-500">
                      Feed
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-cyan-300/70" title={mission.endpoint}>
                      {mission.endpoint}
                    </div>
                  </div>

                  <p className="leading-relaxed text-slate-400">{mission.description}</p>

                  <div className="grid gap-2 rounded-md border border-slate-800 bg-slate-950/50 p-3 font-mono text-[10px] uppercase tracking-widest text-slate-500 sm:grid-cols-2">
                    <div>
                      <span className="block text-slate-600">Ultimo dato</span>
                      <span className="mt-1 block truncate text-slate-300">
                        {mission.lastSampleTime ? formatLastSample(mission.lastSampleTime) : 'Sin muestras'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-slate-600">Plots</span>
                      <span className="mt-1 block text-slate-300">{mission.charts.length}</span>
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-slate-500">
                      Variables
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {mission.variables.map(variable => (
                        <span
                          key={variable}
                          className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-300"
                        >
                          {variable}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function LiveDualClock({
  activeClock,
  onSelectClock,
  customZone,
  onChangeCustomZone,
}: {
  activeClock: 'utc' | 'custom';
  onSelectClock: (clock: 'utc' | 'custom') => void;
  customZone: string;
  onChangeCustomZone: (tz: string) => void;
}) {
  const [now, setNow] = useState<Date | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const utcActive = activeClock === 'utc';
  const customLabel = now ? getZoneShortLabel(now, customZone) : 'LOCAL';
  const customCity = CUSTOM_ZONE_OPTIONS.find(o => o.tz === customZone)?.city ?? (customZone.split('/').pop() ?? customZone).replace('_', ' ');
  const utcTime = now ? formatClockTime(now, 'UTC') : '--:--:--';
  const utcDate = now ? formatClockDate(now, 'UTC') : '--- --';
  const customTime = now ? formatClockTime(now, customZone) : '--:--:--';
  const customDate = now ? formatClockDate(now, customZone) : '--- --';

  const baseChip = 'min-w-[188px] rounded-md border px-3 py-2 text-left transition-colors';
  const activeChip = 'border-cyan-400/40 bg-cyan-400/10 shadow-[0_0_22px_rgba(34,211,238,0.08)]';
  const idleChip = 'border-slate-700/70 bg-slate-950/60 hover:border-slate-600/80';

  return (
    <div className="hidden min-w-0 items-stretch gap-2 lg:flex">
      {/* UTC clock — click to drive plot times */}
      <button type="button" onClick={() => onSelectClock('utc')} title="Show plot times in UTC" className={`${baseChip} ${utcActive ? activeChip : idleChip}`}>
        <div className={`mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest ${utcActive ? 'text-cyan-400/70' : 'text-slate-500'}`}>
          <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>UTC</span>
          {utcActive && <span className="ml-auto rounded bg-cyan-400/15 px-1 text-[8px] text-cyan-200">PLOTS</span>}
        </div>
        <div className={`font-mono text-xl font-semibold leading-none tracking-wider tabular-nums ${utcActive ? 'text-cyan-100' : 'text-slate-100'}`}>{utcTime}</div>
        <div className={`mt-1 font-mono text-[10px] uppercase tracking-widest ${utcActive ? 'text-cyan-400/50' : 'text-slate-600'}`}>{utcDate}</div>
      </button>

      {/* Custom clock — click to drive plot times; 3-dots to pick the timezone */}
      <div className="relative">
        <button type="button" onClick={() => onSelectClock('custom')} title={`Show plot times in ${customCity} (${customLabel})`} className={`${baseChip} w-full ${!utcActive ? activeChip : idleChip}`}>
          <div className={`mb-1 flex items-center gap-1.5 pr-5 font-mono text-[10px] uppercase tracking-widest ${!utcActive ? 'text-cyan-400/70' : 'text-slate-500'}`}>
            <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="truncate">{customLabel}</span>
            {!utcActive && <span className="ml-auto rounded bg-cyan-400/15 px-1 text-[8px] text-cyan-200">PLOTS</span>}
          </div>
          <div className={`font-mono text-xl font-semibold leading-none tracking-wider tabular-nums ${!utcActive ? 'text-cyan-100' : 'text-slate-100'}`}>{customTime}</div>
          <div className={`mt-1 truncate font-mono text-[10px] uppercase tracking-widest ${!utcActive ? 'text-cyan-400/50' : 'text-slate-600'}`}>{customDate} {customCity}</div>
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen(open => !open)}
          title="Choose timezone"
          className="absolute right-1 top-1 rounded p-1 text-slate-500 hover:bg-slate-800/60 hover:text-slate-200"
        >
          <MoreVertical className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
            <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-slate-700 bg-slate-950/95 p-1 shadow-2xl backdrop-blur">
              <div className="px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-600">Custom clock timezone</div>
              {CUSTOM_ZONE_OPTIONS.map(opt => (
                <button
                  key={opt.tz}
                  type="button"
                  onClick={() => { onChangeCustomZone(opt.tz); onSelectClock('custom'); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/70"
                >
                  <span className="flex-1 truncate">{opt.city}</span>
                  <span className="font-mono text-[10px] text-slate-500">{now ? getZoneShortLabel(now, opt.tz) : ''}</span>
                  {opt.tz === customZone && <Check className="h-3 w-3 shrink-0 text-cyan-300" aria-hidden="true" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function getStageAccentStyle(item: StageCoded): CSSProperties {
  const stage = getPlaygroundStage(item.stageId);

  return {
    color: `var(${stage.colorVar})`,
    borderColor: `color-mix(in srgb, var(${stage.colorVar}) 48%, transparent)`,
    backgroundColor: `color-mix(in srgb, var(${stage.colorVar}) 12%, transparent)`,
  };
}

function StageCodePill({
  item,
  compact = false,
}: {
  item: StageCoded;
  compact?: boolean;
}) {
  return (
    <span
      aria-label={getPlaygroundCodeAriaLabel(item)}
      className={`inline-flex shrink-0 items-center rounded border font-mono font-semibold leading-none tracking-normal ${
        compact ? 'px-1.5 py-1 text-[9px]' : 'px-2 py-1 text-[10px]'
      }`}
      style={getStageAccentStyle(item)}
    >
      {item.code}
    </span>
  );
}

function ScreenViewTabs({
  screen,
  activeView,
  onSelectView,
}: {
  screen: PlaygroundScreenConfig;
  activeView: PlaygroundTab;
  onSelectView: (viewId: PlaygroundTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={`${screen.label} views`}
      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-700/70 bg-slate-950/60 p-1 shadow-inner shadow-black/30"
    >
      {screen.views.map(view => {
        const Icon = view.icon;
        const isActive = view.id === activeView;

        return (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={view.description}
            onClick={() => onSelectView(view.id)}
            className={`flex h-8 items-center gap-2 rounded-md px-3 font-mono text-[11px] uppercase tracking-widest transition ${
              isActive
                ? 'bg-cyan-400/15 text-cyan-100 shadow-inner shadow-cyan-950/30'
                : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{view.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ScreenInfoModal({ screen, onClose }: { screen: PlaygroundScreenConfig; onClose: () => void }) {
  const info = PLAYGROUND_SCREEN_INFO[screen.id];
  const stage = getPlaygroundStage(screen.stageId);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  if (!info) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[2147483647] grid place-items-center bg-slate-950/80 p-4 backdrop-blur-md">
      <button type="button" aria-label="Cerrar" className="absolute inset-0 cursor-default" onClick={onClose} />
      <section className="relative w-full max-w-xl overflow-hidden rounded-lg border border-slate-700 bg-slate-950 shadow-2xl shadow-cyan-950/30">
        <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.26em]" style={{ color: `var(${stage.colorVar})` }}>
              {stage.id} · {stage.label}
            </div>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-100">
              <span className="font-mono text-base" style={{ color: `var(${stage.colorVar})` }}>{screen.code}</span>
              <span className="text-slate-600">·</span>
              <span className="truncate">{screen.label}</span>
            </h2>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <p className="text-sm leading-relaxed text-slate-200">{info.intro}</p>

          <div>
            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-500">What it does</div>
            <ul className="space-y-1.5 text-sm leading-relaxed text-slate-300">
              {info.details.map(detail => (
                <li key={detail} className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-cyan-400/60" aria-hidden="true" />
                  <span>{detail}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-cyan-300/70">How it fits the project</div>
            <p className="text-sm leading-relaxed text-slate-300">{info.fitsIn}</p>
          </div>

          <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
            info.userAction
              ? 'border-amber-300/25 bg-amber-300/10 text-amber-100/90'
              : 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100/90'
          }`}>
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-semibold">{info.userAction ? 'You do: ' : 'Automatic: '}</span>
              {info.userAction ?? 'no action needed — it runs on its own.'}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

function PlaygroundPageHeader({
  screen,
  activeView,
  onSelectView,
  onShowInfo,
}: {
  screen: PlaygroundScreenConfig;
  activeView: PlaygroundTab;
  onSelectView: (viewId: PlaygroundTab) => void;
  onShowInfo: () => void;
}) {
  const stage = getPlaygroundStage(screen.stageId);
  const hasMultipleViews = screen.views.length > 1;
  const activeViewConfig = screen.views.find(view => view.id === activeView) ?? screen.views[0];

  return (
    <section className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800/80 px-1 pb-3">
      <div className="min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-[0.26em] text-slate-500">
          {stage.id} · {stage.label}
        </div>
        <h2 className="mt-1 flex min-w-0 items-center gap-2 text-xl font-semibold text-slate-100">
          <span
            aria-label={getPlaygroundCodeAriaLabel(screen)}
            className="shrink-0 self-baseline font-mono text-base tracking-normal"
            style={{ color: `var(${stage.colorVar})` }}
          >
            {screen.code}
          </span>
          <span className="shrink-0 self-baseline text-slate-600">·</span>
          <span className="truncate">{screen.label}</span>
          <button
            type="button"
            onClick={onShowInfo}
            aria-label={`What is ${screen.label}?`}
            title={`What is ${screen.label}?`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-400 transition hover:border-cyan-400/50 hover:bg-cyan-400/10 hover:text-cyan-100"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </h2>
        {hasMultipleViews && (
          <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
            {activeViewConfig.description}
          </div>
        )}
      </div>
      {hasMultipleViews ? (
        <ScreenViewTabs screen={screen} activeView={activeView} onSelectView={onSelectView} />
      ) : (
        <div className="truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
          {screen.description}
        </div>
      )}
    </section>
  );
}

function TelemetryChart({
  definition,
  plotTimeZone,
}: {
  definition: ChartDefinition;
  plotTimeZone: PlotTimeZone;
}) {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const [chartSize, setChartSize] = useState<{ width: number; height: number } | null>(null);
  const chartData = useMemo(
    () =>
      definition.data.map((point) => ({
        time: point.time_tag ? formatChartTime(point.time_tag, plotTimeZone) : '',
        value: parseMetric(point[definition.dataKey]),
      })),
    [definition, plotTimeZone],
  );

  const hasData = definition.status !== 'off' && chartData.some((point) => point.value !== null);

  useEffect(() => {
    const chartContainer = chartContainerRef.current;

    if (!chartContainer) {
      return;
    }

    const updateChartReadiness = () => {
      const { width, height } = chartContainer.getBoundingClientRect();

      if (width <= 0 || height <= 0) {
        setChartSize(null);
        return;
      }

      const nextSize = {
        width: Math.floor(width),
        height: Math.floor(height),
      };

      setChartSize(currentSize =>
        currentSize?.width === nextSize.width && currentSize.height === nextSize.height
          ? currentSize
          : nextSize,
      );
    };

    updateChartReadiness();

    const scheduleChartReadiness = () => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = window.setTimeout(() => {
        resizeTimeoutRef.current = null;
        updateChartReadiness();
      }, 90);
    };

    const resizeObserver = new ResizeObserver(scheduleChartReadiness);
    resizeObserver.observe(chartContainer);

    return () => {
      resizeObserver.disconnect();

      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
    };
  }, [hasData]);

  return (
    <div className="min-h-[210px] min-w-0 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
            {definition.spacecraftName} · {definition.title}
          </h3>
          <div className="mt-1 truncate font-mono text-[10px] text-slate-500">
            {definition.unit} · {definition.source}
          </div>
          <div className={`mt-1 truncate font-mono text-[10px] ${
            definition.status === 'stale' ? 'text-amber-200/80' : 'text-slate-500'
          }`}>
            Last sample: {definition.lastSampleTime ? formatLastSample(definition.lastSampleTime, plotTimeZone) : 'Not available'}
          </div>
        </div>
        <StatusPill status={definition.status} />
      </div>

      {hasData ? (
        <div ref={chartContainerRef} className="h-36 min-h-36 min-w-0">
          {chartSize ? (
            <LineChart
              data={chartData}
              height={chartSize.height}
              margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
              width={chartSize.width}
            >
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" fontSize={10} minTickGap={24} stroke="#64748b" tickMargin={6} />
              <YAxis
                domain={['auto', 'auto']}
                fontSize={10}
                stroke="#64748b"
                tickFormatter={(value: number | string) => Number(value).toFixed(1)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#020617',
                  border: '1px solid #334155',
                  borderRadius: '6px',
                  color: '#e2e8f0',
                  fontSize: '12px',
                }}
                formatter={(value) => {
                  const numericValue = Number(value);
                  return [
                    Number.isFinite(numericValue) ? numericValue.toFixed(2) : 'Not available',
                    definition.unit,
                  ];
                }}
                labelStyle={{ color: '#94a3b8' }}
              />
              <Line
                activeDot={{ r: 3, strokeWidth: 0 }}
                connectNulls={false}
                dataKey="value"
                dot={false}
                isAnimationActive={false}
                stroke={definition.color}
                strokeWidth={1.6}
                type="linear"
              />
            </LineChart>
          ) : (
            <div className="flex h-full items-center justify-center rounded border border-slate-800 bg-slate-900/30">
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-600">
                Loading
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-36 items-center justify-center rounded border border-slate-800 bg-slate-900/30">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-600">
            {hasData ? 'Loading' : 'Not available'}
          </span>
        </div>
      )}
    </div>
  );
}

export function PlaygroundDashboard({
  adminEmail,
  noaaMagData: initialNoaaMagData,
  noaaPlasmaData: initialNoaaPlasmaData,
  noaaEphemerisData: initialNoaaEphemerisData,
  spacecraftTelemetry: initialSpacecraftTelemetry,
  nearEarthTelemetry: initialNearEarthTelemetry,
}: PlaygroundDashboardProps) {
  const [telemetryData, setTelemetryData] = useState<PlaygroundTelemetryData>({
    noaaMagData: initialNoaaMagData,
    noaaPlasmaData: initialNoaaPlasmaData,
    noaaEphemerisData: initialNoaaEphemerisData,
    spacecraftTelemetry: initialSpacecraftTelemetry,
    nearEarthTelemetry: initialNearEarthTelemetry,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pipelineHealth, setPipelineHealth] = useState<PipelineHealthSnapshot | null>(null);
  const [isPipelineHealthRefreshing, setIsPipelineHealthRefreshing] = useState(false);
  const [pipelineHealthError, setPipelineHealthError] = useState<string | null>(null);
  const [dataQuality, setDataQuality] = useState<DataQualitySnapshot | null>(null);
  const [isDataQualityRefreshing, setIsDataQualityRefreshing] = useState(false);
  const [dataQualityError, setDataQualityError] = useState<string | null>(null);
  const [exploration, setExploration] = useState<ExplorationSnapshot | null>(null);
  const [isExplorationRefreshing, setIsExplorationRefreshing] = useState(false);
  const [explorationError, setExplorationError] = useState<string | null>(null);
  const [mruValidation, setMruValidation] = useState<MruValidationSnapshot | null>(null);
  const [isMruValidationRefreshing, setIsMruValidationRefreshing] = useState(false);
  const [mruValidationError, setMruValidationError] = useState<string | null>(null);
  // null = use the auto, coverage-anchored window; set once the user edits dates.
  const [validationRange, setValidationRange] = useState<{ start: string; stop: string } | null>(null);
  const [historicPlots, setHistoricPlots] = useState<HistoricPlotsSnapshot | null>(null);
  const [isHistoricPlotsRefreshing, setIsHistoricPlotsRefreshing] = useState(false);
  const [historicPlotsError, setHistoricPlotsError] = useState<string | null>(null);
  const [plotTimeZone, setPlotTimeZone] = useState<PlotTimeZone>('UTC');
  // Header-driven display timezone for the Live Forecast plots/feed.
  const [activeClock, setActiveClock] = useState<'utc' | 'custom'>('utc');
  const [customZone, setCustomZone] = useState<string>('Europe/Madrid');
  const displayTimeZone = activeClock === 'utc' ? 'UTC' : customZone;
  const displayTimeZoneLabel = activeClock === 'utc'
    ? 'UTC'
    : (CUSTOM_ZONE_OPTIONS.find(o => o.tz === customZone)?.city ?? customZone.split('/').pop()?.replace('_', ' ') ?? customZone);
  const [activeTab, setActiveTab] = useState<PlaygroundTab>('insitu');
  const [isTabMenuOpen, setIsTabMenuOpen] = useState(false);
  const [isMissionInfoOpen, setIsMissionInfoOpen] = useState(false);
  const [isScreenInfoOpen, setIsScreenInfoOpen] = useState(false);
  const [isHistoricAvailabilityOpen, setIsHistoricAvailabilityOpen] = useState(false);
  const [isHistoricSidebarCollapsed, setIsHistoricSidebarCollapsed] = useState(false);
  const [selectedSpacecraftIds, setSelectedSpacecraftIds] = useState<SpacecraftId[]>(['DSCOVR']);
  const [historicRange, setHistoricRange] = useState(getDefaultHistoricRange);
  const [selectedHistoricSourceIds, setSelectedHistoricSourceIds] = useState<string[]>([
    'omni-hro',
    'cdaweb-ace-wind-imap',
    'swpc-goes-json',
  ]);
  const [showUnselectedHistoricSources, setShowUnselectedHistoricSources] = useState(false);
  const [selectedNearEarthSpacecraft, setSelectedNearEarthSpacecraft] = useState<string[]>(['GOES-19']);
  const [selectedLiveNearEarthSourceIds, setSelectedLiveNearEarthSourceIds] = useState<string[]>(['swpc-goes-json']);
  const isRequestInFlightRef = useRef(false);
  const isPipelineHealthRequestInFlightRef = useRef(false);
  const isDataQualityRequestInFlightRef = useRef(false);
  const isMruValidationRequestInFlightRef = useRef(false);
  const isExplorationRequestInFlightRef = useRef(false);
  const isHistoricPlotsRequestInFlightRef = useRef(false);
  const isMountedRef = useRef(false);
  const tabMenuRef = useRef<HTMLDivElement | null>(null);

  const refreshTelemetry = useCallback(async (options: { showActivity?: boolean } = {}) => {
    if (isRequestInFlightRef.current) {
      return;
    }

    const showActivity = options.showActivity ?? true;
    isRequestInFlightRef.current = true;
    if (showActivity) {
      setIsRefreshing(true);
    }
    setRefreshError(null);

    try {
      const response = await fetch('/api/playground/telemetry', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Telemetry request failed with ${response.status}`);
      }

      const nextTelemetryData = await response.json() as PlaygroundTelemetryData;

      if (!isMountedRef.current) {
        return;
      }

      setTelemetryData(nextTelemetryData);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      setRefreshError(error instanceof Error ? error.message : 'Telemetry request failed');
    } finally {
      isRequestInFlightRef.current = false;

      if (showActivity && isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

  const refreshPipelineHealth = useCallback(async (options: { showActivity?: boolean } = {}) => {
    if (isPipelineHealthRequestInFlightRef.current) {
      return;
    }

    const showActivity = options.showActivity ?? true;
    isPipelineHealthRequestInFlightRef.current = true;
    if (showActivity) {
      setIsPipelineHealthRefreshing(true);
    }
    setPipelineHealthError(null);

    try {
      const response = await fetch('/api/playground/pipeline-health', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Pipeline health request failed with ${response.status}`);
      }

      const nextPipelineHealth = await response.json() as PipelineHealthSnapshot;

      if (!isMountedRef.current) {
        return;
      }

      setPipelineHealth(nextPipelineHealth);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      setPipelineHealthError(error instanceof Error ? error.message : 'Pipeline health request failed');
    } finally {
      isPipelineHealthRequestInFlightRef.current = false;

      if (showActivity && isMountedRef.current) {
        setIsPipelineHealthRefreshing(false);
      }
    }
  }, []);

  const refreshHistoricPlots = useCallback(async (options: { showActivity?: boolean } = {}) => {
    if (isHistoricPlotsRequestInFlightRef.current) {
      return;
    }

    const startUtc = datetimeLocalToUtcIso(historicRange.start);
    const stopUtc = datetimeLocalToUtcIso(historicRange.stop);

    if (!startUtc || !stopUtc) {
      setHistoricPlotsError('Invalid historic plot range');
      return;
    }

    const showActivity = options.showActivity ?? true;
    isHistoricPlotsRequestInFlightRef.current = true;
    if (showActivity) {
      setIsHistoricPlotsRefreshing(true);
    }
    setHistoricPlotsError(null);

    try {
      const params = new URLSearchParams({
        startUtc,
        stopUtc,
        sourceIds: selectedHistoricSourceIds.join(','),
      });
      const response = await fetch(`/api/playground/historic-plots?${params.toString()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Historic plots request failed with ${response.status}`);
      }

      const nextHistoricPlots = await response.json() as HistoricPlotsSnapshot;

      if (!isMountedRef.current) {
        return;
      }

      setHistoricPlots(nextHistoricPlots);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      setHistoricPlotsError(error instanceof Error ? error.message : 'Historic plots request failed');
    } finally {
      isHistoricPlotsRequestInFlightRef.current = false;

      if (showActivity && isMountedRef.current) {
        setIsHistoricPlotsRefreshing(false);
      }
    }
  }, [historicRange.start, historicRange.stop, selectedHistoricSourceIds]);

  const refreshDataQuality = useCallback(async (options: { showActivity?: boolean } = {}) => {
    if (isDataQualityRequestInFlightRef.current) {
      return;
    }

    const startUtc = datetimeLocalToUtcIso(historicRange.start);
    const stopUtc = datetimeLocalToUtcIso(historicRange.stop);

    if (!startUtc || !stopUtc) {
      setDataQualityError('Invalid data quality range');
      return;
    }

    const showActivity = options.showActivity ?? true;
    isDataQualityRequestInFlightRef.current = true;
    if (showActivity) {
      setIsDataQualityRefreshing(true);
    }
    setDataQualityError(null);

    try {
      const params = new URLSearchParams({
        startUtc,
        stopUtc,
      });
      const response = await fetch(`/api/playground/data-quality?${params.toString()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Data quality request failed with ${response.status}`);
      }

      const nextDataQuality = await response.json() as DataQualitySnapshot;

      if (!isMountedRef.current) {
        return;
      }

      setDataQuality(nextDataQuality);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      setDataQualityError(error instanceof Error ? error.message : 'Data quality request failed');
    } finally {
      isDataQualityRequestInFlightRef.current = false;

      if (showActivity && isMountedRef.current) {
        setIsDataQualityRefreshing(false);
      }
    }
  }, [historicRange.start, historicRange.stop]);

  const refreshMruValidation = useCallback(async (
    options: { showActivity?: boolean; rangeOverride?: { start: string; stop: string } } = {},
  ) => {
    if (isMruValidationRequestInFlightRef.current) {
      return;
    }

    const showActivity = options.showActivity ?? true;
    isMruValidationRequestInFlightRef.current = true;
    if (showActivity) {
      setIsMruValidationRefreshing(true);
    }
    setMruValidationError(null);

    try {
      // No range set yet → let the service auto-anchor to real data coverage.
      const activeRange = options.rangeOverride ?? validationRange;
      const params = new URLSearchParams();
      if (activeRange) {
        const startUtc = datetimeLocalToUtcIso(activeRange.start);
        const stopUtc = datetimeLocalToUtcIso(activeRange.stop);
        if (startUtc && stopUtc) {
          params.set('startUtc', startUtc);
          params.set('stopUtc', stopUtc);
        }
      }
      const query = params.toString();
      const response = await fetch(`/api/playground/mru-validation${query ? `?${query}` : ''}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Validation request failed with ${response.status}`);
      }

      const nextSnapshot = await response.json() as MruValidationSnapshot;

      if (!isMountedRef.current) {
        return;
      }

      setMruValidation(nextSnapshot);
      // Reflect the window actually used (auto-anchored) into the date pickers,
      // without overriding a window the user has already set.
      setValidationRange(current => current ?? {
        start: nextSnapshot.range.startUtc.slice(0, 16),
        stop: nextSnapshot.range.stopUtc.slice(0, 16),
      });
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      setMruValidationError(error instanceof Error ? error.message : 'Validation request failed');
    } finally {
      isMruValidationRequestInFlightRef.current = false;

      if (showActivity && isMountedRef.current) {
        setIsMruValidationRefreshing(false);
      }
    }
  }, [validationRange]);

  const refreshExploration = useCallback(async (options: { showActivity?: boolean } = {}) => {
    if (isExplorationRequestInFlightRef.current) {
      return;
    }

    const showActivity = options.showActivity ?? true;
    isExplorationRequestInFlightRef.current = true;
    if (showActivity) {
      setIsExplorationRefreshing(true);
    }
    setExplorationError(null);

    try {
      // The exploration service auto-selects a historical window with data, so
      // no range params are sent — it just works without user action.
      const response = await fetch('/api/playground/exploration', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Exploration request failed with ${response.status}`);
      }

      const nextExploration = await response.json() as ExplorationSnapshot;

      if (!isMountedRef.current) {
        return;
      }

      setExploration(nextExploration);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      setExplorationError(error instanceof Error ? error.message : 'Exploration request failed');
    } finally {
      isExplorationRequestInFlightRef.current = false;

      if (showActivity && isMountedRef.current) {
        setIsExplorationRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    const refreshInterval = window.setInterval(() => {
      void refreshTelemetry({ showActivity: false });
    }, TELEMETRY_POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      window.clearInterval(refreshInterval);
    };
  }, [refreshTelemetry]);

  useEffect(() => {
    if (!isTabMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!tabMenuRef.current?.contains(event.target as Node)) {
        setIsTabMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsTabMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTabMenuOpen]);

  const hasPipelineHealth = pipelineHealth !== null;

  useEffect(() => {
    if (activeTab !== 'pipeline') {
      return;
    }

    let initialRefreshTimeout: number | null = null;

    if (!hasPipelineHealth) {
      initialRefreshTimeout = window.setTimeout(() => {
        void refreshPipelineHealth({ showActivity: true });
      }, 0);
    }

    const refreshInterval = window.setInterval(() => {
      void refreshPipelineHealth({ showActivity: false });
    }, PIPELINE_HEALTH_POLL_INTERVAL_MS);

    return () => {
      if (initialRefreshTimeout !== null) {
        window.clearTimeout(initialRefreshTimeout);
      }

      window.clearInterval(refreshInterval);
    };
  }, [activeTab, hasPipelineHealth, refreshPipelineHealth]);

  const hasDataQuality = dataQuality !== null;

  useEffect(() => {
    if (activeTab !== 'quality') {
      return;
    }

    let initialRefreshTimeout: number | null = null;

    if (!hasDataQuality) {
      initialRefreshTimeout = window.setTimeout(() => {
        void refreshDataQuality({ showActivity: true });
      }, 0);
    }

    return () => {
      if (initialRefreshTimeout !== null) {
        window.clearTimeout(initialRefreshTimeout);
      }
    };
  }, [activeTab, hasDataQuality, refreshDataQuality]);

  const hasExploration = exploration !== null;

  useEffect(() => {
    if (activeTab !== 'eda' && activeTab !== 'coupling') {
      return;
    }

    let initialRefreshTimeout: number | null = null;

    if (!hasExploration) {
      initialRefreshTimeout = window.setTimeout(() => {
        void refreshExploration({ showActivity: true });
      }, 0);
    }

    return () => {
      if (initialRefreshTimeout !== null) {
        window.clearTimeout(initialRefreshTimeout);
      }
    };
  }, [activeTab, hasExploration, refreshExploration]);

  const hasMruValidation = mruValidation !== null;

  useEffect(() => {
    if (activeTab !== 'validation') {
      return;
    }

    let initialRefreshTimeout: number | null = null;

    if (!hasMruValidation) {
      initialRefreshTimeout = window.setTimeout(() => {
        void refreshMruValidation({ showActivity: true });
      }, 0);
    }

    return () => {
      if (initialRefreshTimeout !== null) {
        window.clearTimeout(initialRefreshTimeout);
      }
    };
  }, [activeTab, hasMruValidation, refreshMruValidation]);

  useEffect(() => {
    if (activeTab !== 'historic') {
      return;
    }

    const refreshTimeout = window.setTimeout(() => {
      void refreshHistoricPlots({ showActivity: true });
    }, 350);

    return () => window.clearTimeout(refreshTimeout);
  }, [
    activeTab,
    historicRange.start,
    historicRange.stop,
    selectedHistoricSourceIds,
    refreshHistoricPlots,
  ]);

  const {
    noaaMagData,
    noaaPlasmaData,
    spacecraftTelemetry,
    nearEarthTelemetry,
  } = telemetryData;

  const speedKmS = parseMetric(noaaPlasmaData.latestData?.speed);
  const eventTimestamp = noaaPlasmaData.latestData?.time_tag ?? noaaMagData.latestData?.time_tag ?? null;
  const travelSeconds = speedKmS ? L1_TO_EARTH_DISTANCE_KM / speedKmS : null;
  const arrivalTime =
    eventTimestamp && travelSeconds
      ? new Date(parseTelemetryDate(eventTimestamp).getTime() + travelSeconds * 1000).toISOString()
      : null;

  const toggleSpacecraftSelection = useCallback((spacecraftId: SpacecraftId) => {
    setSelectedSpacecraftIds(currentSelection => (
      currentSelection.includes(spacecraftId)
        ? currentSelection.filter(currentId => currentId !== spacecraftId)
        : [...currentSelection, spacecraftId]
    ));
  }, []);

  const toggleHistoricSource = useCallback((sourceId: string) => {
    if (!selectedHistoricSourceIds.includes(sourceId) && getHistoricPlotCount(sourceId) === 0) {
      return;
    }

    setHistoricPlots(null);
    setSelectedHistoricSourceIds(currentSelection => (
      currentSelection.includes(sourceId)
        ? currentSelection.filter(currentId => currentId !== sourceId)
        : [...currentSelection, sourceId]
    ));
  }, [selectedHistoricSourceIds]);

  const toggleNearEarthSpacecraft = useCallback((spacecraftName: string) => {
    setSelectedNearEarthSpacecraft(currentSelection => (
      currentSelection.includes(spacecraftName)
        ? currentSelection.filter(currentName => currentName !== spacecraftName)
        : [...currentSelection, spacecraftName]
    ));
  }, []);

  const toggleLiveNearEarthSource = useCallback((sourceId: string) => {
    setSelectedLiveNearEarthSourceIds(currentSelection => (
      currentSelection.includes(sourceId)
        ? currentSelection.filter(currentId => currentId !== sourceId)
        : [...currentSelection, sourceId]
    ));
  }, []);

  const selectedSpacecraft = useMemo(
    () => spacecraftTelemetry.filter(mission => selectedSpacecraftIds.includes(mission.id)),
    [selectedSpacecraftIds, spacecraftTelemetry],
  );

  const chartDefinitions = useMemo<ChartDefinition[]>(
    () => selectedSpacecraft.flatMap(mission =>
      mission.charts.map(chart => {
        const chartLastSampleTime = getLatestChartSampleTime(chart.data);

        return {
          id: chart.id,
          spacecraftId: mission.id,
          spacecraftName: mission.displayName,
          source: mission.source,
          title: chart.title,
          unit: chart.unit,
          dataKey: 'value' as const,
          color: chart.color,
          data: chart.data,
          status: getChartStatusFromData(chart.data, mission.status),
          lastSampleTime: chartLastSampleTime ?? mission.lastSampleTime,
        };
      }),
    ),
    [selectedSpacecraft],
  );

  const liveNearEarthSources = useMemo(
    () => NEAR_EARTH_PUBLIC_SOURCES.filter(source => source.cadence !== 'historic'),
    [],
  );
  const historicL1Sources = useMemo(
    () => L1_PUBLIC_SOURCES.filter(source => source.cadence !== 'live'),
    [],
  );
  const historicNearEarthSources = useMemo(
    () => NEAR_EARTH_PUBLIC_SOURCES.filter(source => source.cadence !== 'live' || source.id === 'swpc-goes-json'),
    [],
  );
  const allHistoricSources = useMemo(() => {
    const byId = new Map<string, PublicSpaceWeatherSource>();

    [...historicL1Sources, ...historicNearEarthSources].forEach(source => {
      byId.set(source.id, source);
    });

    return Array.from(byId.values()).sort((a, b) => {
      const aCount = getHistoricPlotCount(a.id);
      const bCount = getHistoricPlotCount(b.id);

      if (aCount !== bCount) {
        return bCount - aCount;
      }

      return a.name.localeCompare(b.name);
    });
  }, [historicL1Sources, historicNearEarthSources]);
  const nearEarthSpacecraftOptions = useMemo(
    () => Array.from(new Set(liveNearEarthSources.flatMap(source => source.spacecraft))).sort(),
    [liveNearEarthSources],
  );
  const filteredLiveNearEarthSources = useMemo(
    () =>
      liveNearEarthSources.filter(source =>
        selectedNearEarthSpacecraft.length === 0 ||
        source.spacecraft.some(spacecraftName => selectedNearEarthSpacecraft.includes(spacecraftName)),
      ),
    [liveNearEarthSources, selectedNearEarthSpacecraft],
  );
  const selectedNearEarthFeeds = useMemo(
    () => nearEarthTelemetry.filter(feed => selectedLiveNearEarthSourceIds.includes(feed.sourceId)),
    [nearEarthTelemetry, selectedLiveNearEarthSourceIds],
  );
  const nearEarthChartDefinitions = useMemo<ChartDefinition[]>(
    () => selectedNearEarthFeeds.flatMap(feed =>
      feed.charts
        .filter(chart => (
          selectedNearEarthSpacecraft.length === 0 ||
          selectedNearEarthSpacecraft.includes(chart.spacecraft)
        ))
        .map(chart => {
          const chartLastSampleTime = getLatestChartSampleTime(chart.data);

          return {
            id: chart.id,
            spacecraftId: `${feed.id}:${chart.spacecraft}`,
            spacecraftName: chart.spacecraft,
            source: feed.source,
            title: chart.title,
            unit: chart.unit,
            dataKey: 'value' as const,
            color: chart.color,
            data: chart.data,
            status: getChartStatusFromData(chart.data, feed.status),
            lastSampleTime: chartLastSampleTime ?? feed.lastSampleTime,
          };
        }),
    ),
    [selectedNearEarthFeeds, selectedNearEarthSpacecraft],
  );
  const selectedNearEarthFeedErrors = useMemo(
    () => selectedNearEarthFeeds
      .map(feed => feed.errorMessage)
      .filter((message): message is string => Boolean(message)),
    [selectedNearEarthFeeds],
  );
  const selectedHistoricL1Sources = useMemo(
    () => historicL1Sources.filter(source => selectedHistoricSourceIds.includes(source.id)),
    [historicL1Sources, selectedHistoricSourceIds],
  );
  const selectedHistoricNearEarthSources = useMemo(
    () => historicNearEarthSources.filter(source => selectedHistoricSourceIds.includes(source.id)),
    [historicNearEarthSources, selectedHistoricSourceIds],
  );
  const historicChartDefinitions = useMemo<ChartDefinition[]>(
    () => (historicPlots?.charts ?? []).map(chart => ({
      id: chart.id,
      spacecraftId: chart.sourceId,
      spacecraftName: chart.spacecraftName,
      source: chart.source,
      title: chart.title,
      unit: chart.unit,
      dataKey: 'value' as const,
      color: chart.color,
      data: chart.data,
      status: getChartStatusFromData(chart.data, 'stale'),
      lastSampleTime: chart.lastSampleTime,
    })),
    [historicPlots],
  );
  const activeScreen = getScreenForView(activeTab);
  const ActiveScreenIcon = activeScreen.icon;
  const activeScreenView = activeScreen.views.find(view => view.id === activeTab) ?? activeScreen.views[0];
  const activeScreenHasMultipleViews = activeScreen.views.length > 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="relative z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700/50 bg-slate-900/40 px-5 py-4 shadow-lg backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label="Volver"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border border-cyan-400/30 bg-cyan-400/10 text-cyan-200">
            <FlaskConical className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-slate-100">Admin Playground</h1>
            <div className="truncate font-mono text-[11px] text-slate-500">{adminEmail ?? 'Admin'}</div>
          </div>
        </div>

        <div ref={tabMenuRef} className="relative order-3 w-full min-w-0 md:order-none md:max-w-xl md:flex-1">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={isTabMenuOpen}
            onClick={() => setIsTabMenuOpen(open => !open)}
            className="flex h-14 w-full items-center justify-between gap-3 rounded-md border border-slate-700/70 bg-slate-950/60 px-3 text-left transition hover:border-cyan-400/40 hover:bg-slate-900/70"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-cyan-400/25 bg-cyan-400/10 text-cyan-200">
                <ActiveScreenIcon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-100">
                  <StageCodePill item={activeScreen} compact />
                  <span className="truncate">{activeScreen.label}</span>
                  {activeScreenHasMultipleViews && (
                    <span className="shrink-0 rounded border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest text-cyan-200/90">
                      {activeScreenView.label}
                    </span>
                  )}
                </span>
                <span className="block truncate font-mono text-[9px] uppercase tracking-widest text-slate-500">
                  {activeScreenHasMultipleViews
                    ? activeScreen.views.map(view => view.label).join(' · ')
                    : activeScreen.description}
                </span>
              </span>
            </span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-slate-400 transition ${isTabMenuOpen ? 'rotate-180 text-cyan-200' : ''}`}
              aria-hidden="true"
            />
          </button>

          {isTabMenuOpen && (
            <div
              role="menu"
              className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-50 max-h-[min(72vh,36rem)] overflow-y-auto rounded-md border border-slate-700/80 bg-slate-950/95 p-1 shadow-2xl shadow-black/50 backdrop-blur-xl"
            >
              {PLAYGROUND_SCREENS_BY_STAGE.map(({ stage, screens }) => (
                <div key={stage.id}>
                  <div
                    role="separator"
                    aria-label={stage.separatorLabel}
                    className="flex items-center gap-2 px-2 py-2 first:pt-1"
                  >
                    <span className="h-px flex-1 bg-slate-800" aria-hidden="true" />
                    <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-slate-500">
                      {stage.separatorLabel}
                    </span>
                    <span className="h-px flex-1 bg-slate-800" aria-hidden="true" />
                  </div>

                  {screens.map(screen => {
                    const isSelected = activeScreen.id === screen.id;
                    const Icon = screen.icon;
                    const hasMultipleViews = screen.views.length > 1;

                    return (
                      <button
                        key={screen.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => {
                          if (!isSelected) {
                            setActiveTab(screen.views[0].id);
                          }
                          setIsTabMenuOpen(false);
                        }}
                        className={`flex min-h-14 w-full items-center justify-between gap-3 rounded px-3 py-2 text-left transition ${
                          isSelected
                            ? 'bg-cyan-400/15 text-cyan-100'
                            : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-100'
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-2 text-sm">
                              <StageCodePill item={screen} />
                              <span className="truncate">{screen.label}</span>
                            </span>
                            <span className="block truncate font-mono text-[9px] uppercase tracking-widest opacity-70">
                              {hasMultipleViews
                                ? screen.views.map(view => view.label).join(' · ')
                                : screen.description}
                            </span>
                          </span>
                        </span>
                        {isSelected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <LiveDualClock
            activeClock={activeClock}
            onSelectClock={setActiveClock}
            customZone={customZone}
            onChangeCustomZone={setCustomZone}
          />
          {refreshError && (
            <div className="hidden max-w-64 truncate font-mono text-[10px] uppercase tracking-widest text-rose-300 md:block" title={refreshError}>
              Sync error
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              void refreshTelemetry({ showActivity: true });
            }}
            className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
            disabled={isRefreshing}
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{isRefreshing ? 'Syncing' : 'Refresh'}</span>
          </button>
        </div>
      </header>

      <PlaygroundPageHeader
        screen={activeScreen}
        activeView={activeTab}
        onSelectView={setActiveTab}
        onShowInfo={() => setIsScreenInfoOpen(true)}
      />

      {activeTab === 'insitu' ? (
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto pr-1 xl:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="grid content-start gap-4">
            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <RadioTower className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
                  <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                    L1 missions
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="Informacion de misiones"
                  onClick={() => setIsMissionInfoOpen(true)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100"
                >
                  <Info className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <div className="grid gap-2">
                {spacecraftTelemetry.map((mission) => {
                  const isSelected = selectedSpacecraftIds.includes(mission.id);

                  return (
                    <button
                      key={mission.id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggleSpacecraftSelection(mission.id)}
                      className={`min-w-0 rounded-md border px-3 py-3 text-left transition ${
                        isSelected
                          ? 'border-cyan-400/45 bg-cyan-400/10 shadow-inner shadow-cyan-950/20'
                          : 'border-slate-800 bg-slate-950/40 hover:border-slate-600 hover:bg-slate-900/50'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-3 w-3 shrink-0 rounded border ${
                              isSelected
                                ? 'border-cyan-300 bg-cyan-300'
                                : 'border-slate-600 bg-slate-950'
                            }`}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-slate-100">{mission.displayName}</span>
                            <span className="block truncate font-mono text-[10px] text-slate-500">
                              {mission.source}
                            </span>
                          </span>
                        </span>
                        <StatusPill status={mission.status} />
                      </span>
                      <span className={`mt-2 block truncate font-mono text-[10px] ${
                        mission.status === 'stale' ? 'text-amber-200/80' : 'text-slate-500'
                      }`}>
                        Last: {mission.lastSampleTime ? formatLastSample(mission.lastSampleTime) : 'No samples'}
                      </span>
                      <span className="mt-2 flex flex-wrap gap-1.5">
                        {mission.variables.slice(0, 5).map(variable => (
                          <span
                            key={variable}
                            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[10px] text-slate-300"
                          >
                            {variable}
                          </span>
                        ))}
                        {mission.variables.length > 5 && (
                          <span className="rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-500">
                            +{mission.variables.length - 5}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-3 flex items-center gap-2">
                <Activity className="h-4 w-4 text-rose-300" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">
                  MRU L1 to Earth
                </h2>
              </div>
              <div className="grid gap-3">
                <MetricCard label="Evento L1" value={formatDateTime(eventTimestamp)} />
                <MetricCard label="Speed" value={`${formatNumber(speedKmS)} km/s`} />
                <MetricCard label="Distancia" value={`${formatNumber(L1_TO_EARTH_DISTANCE_KM, 0)} km`} />
                <MetricCard label="Transit" value={formatDuration(travelSeconds)} />
                <MetricCard label="ETA Earth" value={formatDateTime(arrivalTime)} />
              </div>
            </section>
          </aside>

          <section className="min-w-0 space-y-4">
            <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Database className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <div className="min-w-0">
                    <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                      L1 in situ telemetry
                    </h2>
                    <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      Current feed when live; full timestamp shown for stale data
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    2H selected series
                  </div>
                  <div className="flex overflow-hidden rounded-md border border-slate-700/70 bg-slate-950/60">
                    {(Object.keys(PLOT_TIME_ZONE_CONFIG) as PlotTimeZone[]).map(timeZoneKey => {
                      const isSelected = plotTimeZone === timeZoneKey;

                      return (
                        <button
                          key={timeZoneKey}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => setPlotTimeZone(timeZoneKey)}
                          className={`h-8 px-3 font-mono text-[10px] uppercase tracking-widest transition ${
                            isSelected
                              ? 'bg-cyan-400/15 text-cyan-100'
                              : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-200'
                          }`}
                        >
                          {PLOT_TIME_ZONE_CONFIG[timeZoneKey].label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              {chartDefinitions.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {chartDefinitions.map((definition) => (
                    <TelemetryChart
                      key={definition.id}
                      definition={definition}
                      plotTimeZone={plotTimeZone}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 p-6 text-center">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      Sin plots seleccionados
                    </div>
                    <div className="mt-2 text-sm text-slate-400">
                      Selecciona uno o varios spacecraft en L1 missions.
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Globe2 className="h-4 w-4 text-emerald-300" aria-hidden="true" />
                  <div className="min-w-0">
                    <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                      Near-Earth public feeds
                    </h2>
                    <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      LEO / MEO / GEO sources; plot-ready feeds can be selected below
                    </div>
                  </div>
                </div>
                <div className="flex max-w-full flex-wrap gap-1.5">
                  {nearEarthSpacecraftOptions.map(spacecraftName => {
                    const isSelected = selectedNearEarthSpacecraft.includes(spacecraftName);

                    return (
                      <button
                        key={spacecraftName}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => toggleNearEarthSpacecraft(spacecraftName)}
                        className={`h-8 rounded-md border px-2.5 font-mono text-[10px] uppercase tracking-widest transition ${
                          isSelected
                            ? 'border-emerald-300/50 bg-emerald-300/10 text-emerald-100'
                            : 'border-slate-700 bg-slate-950/50 text-slate-500 hover:border-slate-500 hover:text-slate-200'
                        }`}
                      >
                        {spacecraftName}
                      </button>
                    );
                  })}
                </div>
              </div>
              {filteredLiveNearEarthSources.length > 0 ? (
                <SourceCatalogGrid
                  sources={filteredLiveNearEarthSources}
                  selectable
                  selectedSourceIds={selectedLiveNearEarthSourceIds}
                  onToggleSource={toggleLiveNearEarthSource}
                  activeActionLabel="Plotted"
                  inactiveActionLabel="Plot"
                />
              ) : (
                <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-6 text-center text-sm text-slate-400">
                  No near-Earth live source matches the selected spacecraft filter.
                </div>
              )}
            </section>

            <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Satellite className="h-4 w-4 text-emerald-300" aria-hidden="true" />
                  <div className="min-w-0">
                    <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                      Near-Earth telemetry plots
                    </h2>
                    <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      6h SWPC GOES JSON series filtered by selected spacecraft
                    </div>
                  </div>
                </div>
                {selectedNearEarthFeedErrors.length > 0 && (
                  <div
                    className="max-w-full truncate font-mono text-[10px] uppercase tracking-widest text-amber-200/80 sm:max-w-96"
                    title={selectedNearEarthFeedErrors.join(' | ')}
                  >
                    Partial feed warning
                  </div>
                )}
              </div>

              {nearEarthChartDefinitions.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {nearEarthChartDefinitions.map((definition) => (
                    <TelemetryChart
                      key={definition.id}
                      definition={definition}
                      plotTimeZone={plotTimeZone}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 p-6 text-center">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      No plot-ready near-Earth feed selected
                    </div>
                    <div className="mt-2 text-sm text-slate-400">
                      Select GOES primary/secondary JSON and keep GOES-18 or GOES-19 enabled.
                    </div>
                  </div>
                </div>
              )}
            </section>

            <InSituOrbitScene
              spacecraftTelemetry={spacecraftTelemetry}
              selectedSpacecraftIds={selectedSpacecraftIds}
              nearEarthTelemetry={nearEarthTelemetry}
              selectedLiveNearEarthSourceIds={selectedLiveNearEarthSourceIds}
              selectedNearEarthSpacecraft={selectedNearEarthSpacecraft}
            />
          </section>
        </main>
      ) : activeTab === 'historic' ? (
        <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1 xl:flex-row">
          <aside
            className={`min-w-0 flex-none overflow-hidden transition-[width] duration-150 ease-out [will-change:width] motion-reduce:transition-none ${
              isHistoricSidebarCollapsed ? 'w-[76px]' : 'w-full xl:w-[360px]'
            }`}
          >
            {isHistoricSidebarCollapsed ? (
              <HistoricSidebarRail
                sources={allHistoricSources}
                selectedSourceIds={selectedHistoricSourceIds}
                onToggleSource={toggleHistoricSource}
                onOpenAvailability={() => setIsHistoricAvailabilityOpen(true)}
                onExpand={() => setIsHistoricSidebarCollapsed(false)}
              />
            ) : (
                <div className="grid content-start gap-4">
                  <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          aria-label="Open historical availability calendar"
                          title="Historical availability"
                          onClick={() => setIsHistoricAvailabilityOpen(true)}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-cyan-400/30 bg-cyan-400/10 text-cyan-200 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 hover:text-cyan-50"
                        >
                          <CalendarRange className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                          Historic window
                        </h2>
                      </div>
                      <button
                        type="button"
                        aria-label="Collapse historic sidebar"
                        title="Collapse sidebar"
                        onClick={() => setIsHistoricSidebarCollapsed(true)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-700 bg-slate-950/60 text-slate-400 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100"
                      >
                        <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="grid gap-3">
                      <label className="grid gap-1.5">
                        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Start UTC</span>
                        <input
                          type="datetime-local"
                          value={historicRange.start}
                          onChange={event => {
                            setHistoricRange(current => ({ ...current, start: event.target.value }));
                            setHistoricPlots(null);
                            setDataQuality(null);
                          }}
                          className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60"
                        />
                      </label>
                      <label className="grid gap-1.5">
                        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Stop UTC</span>
                        <input
                          type="datetime-local"
                          value={historicRange.stop}
                          onChange={event => {
                            setHistoricRange(current => ({ ...current, stop: event.target.value }));
                            setHistoricPlots(null);
                            setDataQuality(null);
                          }}
                          className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60"
                        />
                      </label>
                    </div>
                  </section>

                  <HistoricSourceSelector
                    sources={allHistoricSources}
                    selectedSourceIds={selectedHistoricSourceIds}
                    showUnselected={showUnselectedHistoricSources}
                    onToggleSource={toggleHistoricSource}
                    onToggleShowUnselected={() => setShowUnselectedHistoricSources(current => !current)}
                  />
                </div>
            )}
          </aside>

          <section className="min-w-0 flex-1 space-y-4">
            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-4 flex min-w-0 items-center gap-2">
                <Layers3 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                <div className="min-w-0">
                  <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                    L1 historic data
                  </h2>
                  <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    Selected L1 sources with plot-ready connector counts
                  </div>
                </div>
              </div>
              {selectedHistoricL1Sources.length > 0 ? (
                <SourceCatalogGrid
                  sources={selectedHistoricL1Sources}
                  getPlotCount={getHistoricPlotCount}
                />
              ) : (
                <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-6 text-center text-sm text-slate-400">
                  No L1 source selected.
                </div>
              )}
            </section>

            <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-4 flex min-w-0 items-center gap-2">
                <Satellite className="h-4 w-4 text-emerald-300" aria-hidden="true" />
                <div className="min-w-0">
                  <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                    Near-Earth historic data
                  </h2>
                  <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    Selected Near-Earth sources with real plot availability
                  </div>
                </div>
              </div>
              {selectedHistoricNearEarthSources.length > 0 ? (
                <SourceCatalogGrid
                  sources={selectedHistoricNearEarthSources}
                  getPlotCount={getHistoricPlotCount}
                />
              ) : (
                <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-6 text-center text-sm text-slate-400">
                  No Near-Earth source selected.
                </div>
              )}
            </section>

            <HistoricOrbitScene
              snapshot={historicPlots}
              isLoading={isHistoricPlotsRefreshing}
            />

            <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Database className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <div className="min-w-0">
                    <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                      Historic telemetry plots
                    </h2>
                    <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      Plots available for selected sources and UTC window
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void refreshHistoricPlots({ showActivity: true });
                  }}
                  className="flex h-9 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-xs text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
                  disabled={isHistoricPlotsRefreshing}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isHistoricPlotsRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                  <span>{isHistoricPlotsRefreshing ? 'Loading' : 'Load plots'}</span>
                </button>
              </div>

              {historicPlotsError && (
                <div className="mb-3 rounded-md border border-rose-400/25 bg-rose-400/10 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-rose-200">
                  {historicPlotsError}
                </div>
              )}

              {historicPlots?.warnings && historicPlots.warnings.length > 0 && (
                <div className="mb-3 grid gap-2">
                  {historicPlots.warnings.slice(0, 4).map(warning => (
                    <div
                      key={warning}
                      className="rounded-md border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs text-amber-100/90"
                    >
                      {warning}
                    </div>
                  ))}
                </div>
              )}

              {isHistoricPlotsRefreshing && !historicPlots ? (
                <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 p-6">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    Loading historic plots
                  </div>
                </div>
              ) : historicChartDefinitions.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {historicChartDefinitions.map((definition) => (
                    <TelemetryChart
                      key={definition.id}
                      definition={definition}
                      plotTimeZone={plotTimeZone}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 p-6 text-center">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      No plot data for this selection
                    </div>
                    <div className="mt-2 max-w-xl text-sm text-slate-400">
                      Select a plot-ready source such as ACE / WIND / IMAP HAPI, OMNI HRO, or GOES primary/secondary JSON. Archive-only sources remain in the catalog until their file parsers are wired.
                    </div>
                  </div>
                </div>
              )}
            </section>
          </section>
        </main>
      ) : activeTab === 'pipeline' ? (
        <PipelineHealthPanel
          snapshot={pipelineHealth}
          isLoading={isPipelineHealthRefreshing}
          error={pipelineHealthError}
          activeExperiment={null}
          onRefresh={() => {
            void refreshPipelineHealth({ showActivity: true });
          }}
        />
      ) : activeTab === 'quality' ? (
        <DataQualityPanel
          snapshot={dataQuality}
          isLoading={isDataQualityRefreshing}
          error={dataQualityError}
          activeExperiment={null}
          range={historicRange}
          onRangeChange={(nextRange) => {
            setHistoricRange(nextRange);
            setDataQuality(null);
          }}
          onRefresh={() => {
            void refreshDataQuality({ showActivity: true });
          }}
        />
      ) : activeTab === 'eda' ? (
        <ExplorationUnivariatePanel
          snapshot={exploration}
          isLoading={isExplorationRefreshing}
          error={explorationError}
          onRefresh={() => {
            void refreshExploration({ showActivity: true });
          }}
        />
      ) : activeTab === 'coupling' ? (
        <ExplorationCouplingPanel
          snapshot={exploration}
          isLoading={isExplorationRefreshing}
          error={explorationError}
          onRefresh={() => {
            void refreshExploration({ showActivity: true });
          }}
        />
      ) : activeTab === 'overview' ? (
        <ModelsOverviewPanel
          onGoToValidation={() => setActiveTab('validation')}
          onGoToLive={() => setActiveTab('forecast')}
        />
      ) : activeTab === 'datapipeline' ? (
        <DataPipelinePanel
          onGoToValidation={() => setActiveTab('validation')}
          onGoToLive={() => setActiveTab('forecast')}
        />
      ) : activeTab === 'validation' ? (
        <MruValidationPanel
          snapshot={mruValidation}
          isLoading={isMruValidationRefreshing}
          error={mruValidationError}
          range={validationRange ?? { start: '', stop: '' }}
          onRangeChange={(nextRange) => {
            setValidationRange(nextRange);
          }}
          onSelectInterval={(nextRange) => {
            setValidationRange(nextRange);
            setMruValidation(null);
            void refreshMruValidation({ showActivity: true, rangeOverride: nextRange });
          }}
          onRefresh={() => {
            void refreshMruValidation({ showActivity: true });
          }}
        />
      ) : (
        <MruLiveForecastPanel
          plasmaData={telemetryData.noaaPlasmaData}
          magData={telemetryData.noaaMagData}
          ephemerisData={telemetryData.noaaEphemerisData}
          isRefreshing={isRefreshing}
          onRefresh={() => {
            void refreshTelemetry({ showActivity: true });
          }}
          timeZone={displayTimeZone}
          timeZoneLabel={displayTimeZoneLabel}
        />
      )}

      {isMissionInfoOpen && (
        <MissionInfoModal
          spacecraftTelemetry={spacecraftTelemetry}
          onClose={() => setIsMissionInfoOpen(false)}
        />
      )}

      {isScreenInfoOpen && (
        <ScreenInfoModal screen={activeScreen} onClose={() => setIsScreenInfoOpen(false)} />
      )}

      {isHistoricAvailabilityOpen && (
        <HistoricAvailabilityCalendar
          sources={allHistoricSources}
          selectedSourceIds={selectedHistoricSourceIds}
          range={historicRange}
          getPlotCount={getHistoricPlotCount}
          onClose={() => setIsHistoricAvailabilityOpen(false)}
        />
      )}
    </div>
  );
}
