"use client";

import { useEffect, useMemo, useState } from 'react';
import {
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Grid3X3,
  X,
} from 'lucide-react';
import type { PublicSpaceWeatherSource } from '@/services/spaceWeatherSourceCatalog';

type AvailabilityMode = 'month' | 'day' | 'six-month' | 'year';

interface HistoricAvailabilityCalendarProps {
  sources: PublicSpaceWeatherSource[];
  selectedSourceIds: string[];
  range: {
    start: string;
    stop: string;
  };
  getPlotCount: (sourceId: string) => number;
  onClose: () => void;
}

type AvailabilityProfile = {
  startUtc: string;
  stopUtc: string | null;
  quality: 0 | 1 | 2 | 3 | 4;
  coverageMode: 'none' | 'catalog' | 'queryable' | 'verified' | 'live';
  label: string;
};
type CoverageMode = AvailabilityProfile['coverageMode'];
type HistoricAvailabilityDay = {
  dateUtc: string;
  observedSamples: number;
  expectedSamples: number;
  coveragePercent: number | null;
};
type HistoricAvailabilitySnapshot = {
  generatedAtUtc: string;
  sources: Array<{
    sourceId: string;
    coverageKind: 'daily-indexed';
    startDateUtc: string;
    stopDateUtc: string;
    expectedSamplesPerDay: number;
    days: HistoricAvailabilityDay[];
  }>;
};
type HistoricAvailabilitySourceIndex = {
  startDateUtc: string;
  stopDateUtc: string;
  expectedSamplesPerDay: number;
  days: Map<string, HistoricAvailabilityDay>;
};
type HistoricAvailabilityIndex = Map<string, HistoricAvailabilitySourceIndex>;
type CoverageCellState = {
  level: 0 | 1 | 2 | 3 | 4;
  mode: CoverageMode;
  statusLabel: string;
  detailLabel: string;
  coveragePercent: number | null;
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const COVERAGE_MODE_COLORS: Record<CoverageMode, string> = {
  none: '#64748b',
  catalog: '#f59e0b',
  queryable: '#22d3ee',
  verified: '#34d399',
  live: '#38bdf8',
};

const SOURCE_AVAILABILITY: Record<string, AvailabilityProfile> = {
  'ncei-goes-sem': { startUtc: '1974-05-17T00:00:00.000Z', stopUtc: '2020-03-02T23:59:59.999Z', quality: 1, coverageMode: 'catalog', label: 'needs backfill' },
  'omni-hro': { startUtc: '1981-01-01T00:00:00.000Z', stopUtc: null, quality: 3, coverageMode: 'queryable', label: 'preview only' },
  'cdaweb-ace-wind-imap': { startUtc: '1994-11-01T00:00:00.000Z', stopUtc: null, quality: 3, coverageMode: 'queryable', label: 'preview only' },
  'ncei-dscovr-archive': { startUtc: '2015-06-08T00:00:00.000Z', stopUtc: null, quality: 1, coverageMode: 'catalog', label: 'needs backfill' },
  'ncei-goes-r-mag-seiss': { startUtc: '2017-01-01T00:00:00.000Z', stopUtc: null, quality: 4, coverageMode: 'verified', label: 'ready for study' },
  'swpc-goes-json': { startUtc: '2024-06-25T00:00:00.000Z', stopUtc: null, quality: 2, coverageMode: 'live', label: 'live' },
  'poes-metop-sem': { startUtc: '1978-10-13T00:00:00.000Z', stopUtc: null, quality: 1, coverageMode: 'catalog', label: 'needs backfill' },
  'lanl-gps-energetic-particles': { startUtc: '1997-01-01T00:00:00.000Z', stopUtc: null, quality: 1, coverageMode: 'catalog', label: 'needs backfill' },
  'dmsp-space-weather': { startUtc: '1987-01-01T00:00:00.000Z', stopUtc: '2020-12-31T23:59:59.999Z', quality: 1, coverageMode: 'catalog', label: 'needs backfill' },
  'us-tec-gnss': { startUtc: '2004-01-01T00:00:00.000Z', stopUtc: null, quality: 1, coverageMode: 'catalog', label: 'needs backfill' },
  'space-track-tle-history': { startUtc: '1957-10-04T00:00:00.000Z', stopUtc: null, quality: 1, coverageMode: 'catalog', label: 'orbit only' },
  'starlink-ephemerides': { startUtc: '2019-05-24T00:00:00.000Z', stopUtc: null, quality: 1, coverageMode: 'catalog', label: 'orbit only' },
  'cdaweb-mms-themis-rbsp': { startUtc: '2007-02-17T00:00:00.000Z', stopUtc: null, quality: 1, coverageMode: 'catalog', label: 'needs backfill' },
  'meo-public-gap': { startUtc: '2026-01-01T00:00:00.000Z', stopUtc: null, quality: 0, coverageMode: 'none', label: 'no data' },
};

function parseDatetimeLocal(value: string) {
  const parsed = new Date(`${value.length === 16 ? `${value}:00` : value}Z`);

  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function makeUtcDate(year: number, month = 0, day = 1) {
  return new Date(Date.UTC(year, month, day));
}

function startOfUtcDay(date: Date) {
  return makeUtcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addMonths(date: Date, months: number) {
  return makeUtcDate(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}

function addDays(date: Date, days: number) {
  return makeUtcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function endOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function startOfMonth(date: Date) {
  return makeUtcDate(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function parseUtcDate(value: string) {
  return new Date(value);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatAvailabilityDate(value: string | null) {
  if (!value) {
    return 'present';
  }

  const date = parseUtcDate(value);

  return `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function getAvailabilityYears(profile: AvailabilityProfile) {
  const startDate = parseUtcDate(profile.startUtc);
  const now = new Date();
  const declaredStopDate = profile.stopUtc ? parseUtcDate(profile.stopUtc) : now;
  const stopDate = declaredStopDate.getTime() < now.getTime() ? declaredStopDate : now;
  const startYear = startDate.getUTCFullYear();
  const stopYear = Math.max(startYear, stopDate.getUTCFullYear());

  return Array.from({ length: stopYear - startYear + 1 }, (_, index) => startYear + index);
}

function getAvailabilityProfile(source: PublicSpaceWeatherSource, plotCount: number): AvailabilityProfile {
  const base = SOURCE_AVAILABILITY[source.id] ?? {
    startUtc: source.cadence === 'live' ? '2024-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z',
    stopUtc: null,
    quality: source.readiness === 'gap' ? 0 : source.readiness === 'connected' ? 2 : 1,
    coverageMode: source.readiness === 'gap' ? 'none' : source.cadence === 'live' ? 'live' : 'catalog',
    label: source.readiness,
  } satisfies AvailabilityProfile;

  if (plotCount > 0 && base.coverageMode === 'catalog' && source.id !== 'ncei-dscovr-archive') {
    return { ...base, quality: Math.max(base.quality, 3) as 0 | 1 | 2 | 3 | 4, coverageMode: 'queryable', label: 'preview only' };
  }

  return base;
}

function formatPercent(value: number | null) {
  if (value === null) {
    return 'Not indexed';
  }

  if (value >= 99.95) {
    return '100%';
  }

  return `${value.toFixed(1)}%`;
}

function levelFromCoveragePercent(value: number | null): 0 | 1 | 2 | 3 | 4 {
  if (value === null || value <= 0) return 0;
  if (value >= 99.5) return 4;
  if (value >= 90) return 3;
  if (value >= 50) return 2;
  return 1;
}

function measuredStatusFromLevel(level: 0 | 1 | 2 | 3 | 4) {
  if (level === 4) return 'Complete';
  if (level === 3) return 'High';
  if (level === 2) return 'Partial';
  if (level === 1) return 'Sparse';
  return 'No data';
}

function isPeriodInMissionSpan(profile: AvailabilityProfile, periodStart: Date, periodStop: Date) {
  const nowMs = Date.now();
  const startMs = parseUtcDate(profile.startUtc).getTime();
  const declaredStopMs = profile.stopUtc ? parseUtcDate(profile.stopUtc).getTime() : nowMs;
  const stopMs = Math.min(declaredStopMs, nowMs);

  return profile.quality !== 0 && periodStop.getTime() >= startMs && periodStart.getTime() <= stopMs;
}

function getMeasuredCoveragePercent(
  sourceId: string,
  periodStart: Date,
  periodStop: Date,
  availabilityIndex: HistoricAvailabilityIndex,
) {
  const sourceCoverage = availabilityIndex.get(sourceId);

  if (!sourceCoverage) {
    return null;
  }

  let observedSamples = 0;
  let expectedSamples = 0;
  let hasIndexedOverlap = false;
  const indexStartMs = parseUtcDate(`${sourceCoverage.startDateUtc}T00:00:00.000Z`).getTime();
  const indexStopMs = endOfUtcDay(parseUtcDate(`${sourceCoverage.stopDateUtc}T00:00:00.000Z`)).getTime();
  const todayStopMs = endOfUtcDay(new Date()).getTime();
  const stopMs = Math.min(indexStopMs, todayStopMs);

  for (
    let day = startOfUtcDay(periodStart);
    day.getTime() <= periodStop.getTime();
    day = addDays(day, 1)
  ) {
    const dayMs = day.getTime();

    if (dayMs < indexStartMs || dayMs > stopMs) {
      continue;
    }

    const coverage = sourceCoverage.days.get(dateKey(day));
    hasIndexedOverlap = true;
    observedSamples += coverage?.observedSamples ?? 0;
    expectedSamples += coverage?.expectedSamples ?? sourceCoverage.expectedSamplesPerDay;
  }

  if (!hasIndexedOverlap || expectedSamples <= 0) {
    return null;
  }

  return Math.min(100, (observedSamples / expectedSamples) * 100);
}

function getCoverageCellStateForPeriod(
  source: PublicSpaceWeatherSource,
  periodStart: Date,
  periodStop: Date,
  plotCount: number,
  availabilityIndex: HistoricAvailabilityIndex,
): CoverageCellState {
  const profile = getAvailabilityProfile(source, plotCount);

  if (!isPeriodInMissionSpan(profile, periodStart, periodStop)) {
    return {
      level: 0,
      mode: 'none',
      statusLabel: 'No data',
      detailLabel: profile.coverageMode === 'none' ? 'Not wired' : 'Outside span',
      coveragePercent: null,
    };
  }

  if (profile.coverageMode === 'verified') {
    const coveragePercent = getMeasuredCoveragePercent(source.id, periodStart, periodStop, availabilityIndex);
    const level = levelFromCoveragePercent(coveragePercent);

    return {
      level,
      mode: level === 0 ? 'none' : 'verified',
      statusLabel: coveragePercent === null ? 'No indexed samples' : measuredStatusFromLevel(level),
      detailLabel: coveragePercent === null ? 'No observed/expected count' : formatPercent(coveragePercent),
      coveragePercent,
    };
  }

  if (source.id === 'swpc-goes-json') {
    const nowMs = Date.now();
    const liveHistoryMs = 10 * 24 * 60 * 60 * 1000;
    const liveStartMs = nowMs - liveHistoryMs;
    const hasLiveCoverage = periodStop.getTime() >= liveStartMs && periodStart.getTime() <= nowMs;

    return {
      level: hasLiveCoverage ? 2 : 0,
      mode: hasLiveCoverage ? 'live' : 'none',
      statusLabel: hasLiveCoverage ? 'Live' : 'No history',
      detailLabel: hasLiveCoverage ? 'Rolling feed' : 'Outside live window',
      coveragePercent: null,
    };
  }

  return {
    level: 0,
    mode: 'none',
    statusLabel: profile.coverageMode === 'queryable' ? 'Not measured' : 'Needs backfill',
    detailLabel: profile.coverageMode === 'queryable' ? 'No daily density index' : 'No observed/expected count',
    coveragePercent: null,
  };
}

function getCoverageModeClassName(mode: CoverageMode) {
  if (mode === 'verified') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100';
  if (mode === 'queryable') return 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100';
  if (mode === 'live') return 'border-sky-400/30 bg-sky-400/10 text-sky-100';
  if (mode === 'catalog') return 'border-amber-300/30 bg-amber-300/10 text-amber-100';
  return 'border-slate-700 bg-slate-950 text-slate-500';
}

function OrbitBadge({ orbit }: { orbit: PublicSpaceWeatherSource['orbit'] }) {
  return (
    <span className="shrink-0 rounded border border-slate-600/70 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-300">
      {orbit}
    </span>
  );
}

function getSourceBadgeLabel(profile: AvailabilityProfile) {
  if (profile.coverageMode === 'verified') return 'Ready';
  if (profile.coverageMode === 'queryable') return 'Preview only';
  if (profile.coverageMode === 'live') return 'Live';
  if (profile.coverageMode === 'catalog') return profile.label === 'orbit only' ? 'Orbit only' : 'Needs backfill';
  return 'No data';
}

function cellStyle(level: number, coverageMode: CoverageMode) {
  if (level === 0) {
    return {
      backgroundColor: 'rgba(15,23,42,0.7)',
      borderColor: 'rgba(51,65,85,0.7)',
      color: '#64748b',
    };
  }

  const color = COVERAGE_MODE_COLORS[coverageMode];
  const opacity = [0, 0.2, 0.38, 0.62, 0.86][level] ?? 0.2;
  const tint = Math.round(opacity * 100);
  const borderTint = Math.round((opacity + 0.15) * 100);

  if (coverageMode === 'catalog') {
    return {
      backgroundImage: `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} 16%, transparent) 0 6px, rgba(15,23,42,0.35) 6px 12px)`,
      backgroundColor: 'rgba(15,23,42,0.55)',
      borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
      color: '#cbd5e1',
    };
  }

  if (coverageMode === 'queryable') {
    return {
      backgroundImage: `linear-gradient(135deg, color-mix(in srgb, ${color} ${tint}%, transparent), color-mix(in srgb, ${color} ${Math.max(18, tint - 18)}%, transparent))`,
      borderColor: `color-mix(in srgb, ${color} ${borderTint}%, transparent)`,
      color: '#f8fafc',
    };
  }

  return {
    backgroundColor: `color-mix(in srgb, ${color} ${tint}%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} ${borderTint}%, transparent)`,
    color: level >= 3 ? '#f8fafc' : '#cbd5e1',
  };
}

function getPeriodLabel(mode: AvailabilityMode, anchor: Date) {
  if (mode === 'day') {
    return `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;
  }

  if (mode === 'six-month') {
    const stop = addMonths(anchor, 5);

    return `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()} - ${MONTH_LABELS[stop.getUTCMonth()]} ${stop.getUTCFullYear()}`;
  }

  if (mode === 'year') {
    return 'Mission archive span';
  }

  return String(anchor.getUTCFullYear());
}

function getModeStep(mode: AvailabilityMode) {
  if (mode === 'day') return 1;
  if (mode === 'six-month') return 6;
  if (mode === 'year') return 12;
  return 12;
}

function SourceLegend({
  sources,
  visibleSourceIds,
  getPlotCount,
  onToggle,
}: {
  sources: PublicSpaceWeatherSource[];
  visibleSourceIds: Set<string>;
  getPlotCount: (sourceId: string) => number;
  onToggle: (sourceId: string) => void;
}) {
  const sourceStateCounts = sources.reduce(
    (counts, source) => {
      const profile = getAvailabilityProfile(source, getPlotCount(source.id));

      if (profile.coverageMode === 'verified') {
        return { ...counts, ready: counts.ready + 1 };
      }

      if (profile.coverageMode === 'queryable' || profile.coverageMode === 'live') {
        return { ...counts, preview: counts.preview + 1 };
      }

      if (profile.coverageMode === 'catalog') {
        return { ...counts, backfill: counts.backfill + 1 };
      }

      return { ...counts, none: counts.none + 1 };
    },
    { ready: 0, preview: 0, backfill: 0, none: 0 },
  );

  return (
    <aside className="flex min-h-0 flex-col rounded-lg border border-slate-800 bg-slate-950/45 p-3">
      <div className="shrink-0">
        <div className="font-mono text-[10px] uppercase tracking-widest text-cyan-300">Missions</div>
        <div className="mt-1 text-xs leading-relaxed text-slate-500">Select missions to compare historical coverage.</div>
        <div className="mt-3 grid grid-cols-2 gap-1">
          <div className="rounded border border-emerald-400/20 bg-emerald-400/10 px-2 py-1">
            <div className="font-mono text-[9px] text-emerald-100">{sourceStateCounts.ready}</div>
            <div className="font-mono text-[8px] uppercase tracking-widest text-emerald-200/60">ready</div>
          </div>
          <div className="rounded border border-cyan-400/20 bg-cyan-400/10 px-2 py-1">
            <div className="font-mono text-[9px] text-cyan-100">{sourceStateCounts.preview}</div>
            <div className="font-mono text-[8px] uppercase tracking-widest text-cyan-200/60">preview</div>
          </div>
          <div className="rounded border border-amber-300/20 bg-amber-300/10 px-2 py-1">
            <div className="font-mono text-[9px] text-amber-100">{sourceStateCounts.backfill}</div>
            <div className="font-mono text-[8px] uppercase tracking-widest text-amber-200/60">backfill</div>
          </div>
          <div className="rounded border border-slate-700 bg-slate-950 px-2 py-1">
            <div className="font-mono text-[9px] text-slate-300">{sourceStateCounts.none}</div>
            <div className="font-mono text-[8px] uppercase tracking-widest text-slate-500">no data</div>
          </div>
        </div>
      </div>

      <div className="mt-3 grid min-h-0 gap-2 overflow-y-auto pr-1 pb-2">
        {sources.map(source => {
          const visible = visibleSourceIds.has(source.id);
          const plotCount = getPlotCount(source.id);
          const profile = getAvailabilityProfile(source, plotCount);

          return (
            <button
              key={source.id}
              type="button"
              aria-pressed={visible}
              onClick={() => onToggle(source.id)}
              className={`min-w-0 rounded-md border p-2 text-left transition ${
                visible
                  ? 'border-slate-600 bg-slate-900/70 text-slate-100'
                  : 'border-slate-800 bg-slate-950/50 text-slate-500'
              }`}
            >
              <span className="flex min-w-0 items-start gap-2">
                <span
                  className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                  style={{
                    backgroundColor: visible ? '#22d3ee' : 'transparent',
                    borderColor: visible ? '#67e8f9' : '#475569',
                  }}
                >
                  {visible && <Check className="h-3 w-3 text-slate-950" aria-hidden="true" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold">{source.name}</span>
                  <span className="mt-1 block truncate font-mono text-[9px] uppercase tracking-widest text-slate-500">
                    {source.orbit} · {source.cadence}
                  </span>
                  <span className={`mt-2 inline-flex rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest ${getCoverageModeClassName(profile.coverageMode)}`}>
                    {getSourceBadgeLabel(profile)}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function AvailabilityScale() {
  const scaleItems: Array<{
    label: string;
    description: string;
    level: 0 | 1 | 2 | 3 | 4;
  }> = [
    { label: 'No indexed samples', description: 'No observed/expected sample count exists for that period.', level: 0 },
    { label: 'Sparse', description: 'Measured coverage is greater than 0% and below 50%.', level: 1 },
    { label: 'Partial', description: 'Measured coverage is at least 50% and below 90%.', level: 2 },
    { label: 'High', description: 'Measured coverage is at least 90% and below 99.5%.', level: 3 },
    { label: 'Complete', description: 'Measured coverage is at least 99.5%.', level: 4 },
  ];

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/45 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-cyan-300">
          Data availability
        </div>
        <div className="hidden font-mono text-[9px] uppercase tracking-widest text-slate-600 sm:block">
          Same colors for every mission
        </div>
      </div>
      <div className="grid gap-2">
        {scaleItems.map(item => (
          <div
            key={item.label}
            className="grid items-start gap-3 rounded-md border border-slate-800 bg-slate-950/45 px-2 py-2 sm:grid-cols-[70px_145px_minmax(0,1fr)]"
          >
            <span
              className="mt-0.5 block h-3 w-12 rounded border"
              style={cellStyle(item.level, item.level === 0 ? 'none' : 'verified')}
              aria-hidden="true"
            />
            <span className="font-mono text-[9px] uppercase tracking-widest text-slate-100">{item.label}</span>
            <span className="text-xs leading-snug text-slate-500">{item.description}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded border border-sky-400/20 bg-sky-400/10 px-2 py-1.5 text-xs text-sky-100/80">
        LIVE, Preview only, and Needs backfill are source badges. They do not claim historical completeness until a daily density index exists.
      </div>
    </div>
  );
}

function MonthView({
  sources,
  anchor,
  getPlotCount,
  availabilityIndex,
}: {
  sources: PublicSpaceWeatherSource[];
  anchor: Date;
  getPlotCount: (sourceId: string) => number;
  availabilityIndex: HistoricAvailabilityIndex;
}) {
  const year = anchor.getUTCFullYear();

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[1420px] gap-1" style={{ gridTemplateColumns: '260px repeat(12, minmax(88px, 1fr))' }}>
        <div className="rounded border border-slate-800 bg-slate-950 px-2 py-2 font-mono text-[9px] uppercase tracking-widest text-slate-600">
          Mission
        </div>
        {MONTH_LABELS.map(month => (
          <div key={month} className="rounded border border-slate-800 bg-slate-950 px-2 py-2 text-center font-mono text-[9px] uppercase tracking-widest text-slate-500">
            {month}
          </div>
        ))}
        {sources.map(source => {
          const plotCount = getPlotCount(source.id);
          const profile = getAvailabilityProfile(source, plotCount);

          return (
            <div key={source.id} className="contents">
              <div className="sticky left-0 z-10 min-w-0 rounded border border-slate-800 bg-slate-950 px-2 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-xs font-semibold text-slate-100">{source.name}</div>
                  <OrbitBadge orbit={source.orbit} />
                </div>
                <div className="mt-1 truncate font-mono text-[9px] uppercase tracking-widest text-slate-600">{getSourceBadgeLabel(profile)}</div>
              </div>
              {MONTH_LABELS.map((month, monthIndex) => {
                const periodStart = makeUtcDate(year, monthIndex, 1);
                const periodStop = endOfUtcDay(makeUtcDate(year, monthIndex, daysInMonth(year, monthIndex)));
                const cellState = getCoverageCellStateForPeriod(source, periodStart, periodStop, plotCount, availabilityIndex);

                return (
                  <div
                    key={`${source.id}-${month}`}
                    className="grid min-h-16 place-items-center rounded border px-1 text-center"
                    style={cellStyle(cellState.level, cellState.mode)}
                    title={`${source.name} · ${month} ${year} · ${cellState.statusLabel} · ${cellState.detailLabel}`}
                  >
                    <span className="grid gap-1">
                      <span className="font-mono text-[10px] uppercase tracking-widest">
                        {cellState.statusLabel}
                      </span>
                      <span className="text-[10px] leading-tight text-current opacity-70">
                        {cellState.detailLabel}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayView({
  sources,
  anchor,
  getPlotCount,
  availabilityIndex,
}: {
  sources: PublicSpaceWeatherSource[];
  anchor: Date;
  getPlotCount: (sourceId: string) => number;
  availabilityIndex: HistoricAvailabilityIndex;
}) {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const totalDays = daysInMonth(year, month);

  return (
    <div className="grid gap-3">
      {sources.map(source => {
        const plotCount = getPlotCount(source.id);
        const profile = getAvailabilityProfile(source, plotCount);

        return (
          <article key={source.id} className="rounded-lg border border-slate-800 bg-slate-950/35 p-3">
            <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-slate-100">{source.name}</h3>
                  <OrbitBadge orbit={source.orbit} />
                </div>
                <div className="mt-1 truncate font-mono text-[9px] uppercase tracking-widest text-slate-600">{source.provider}</div>
              </div>
              <span className={`rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${getCoverageModeClassName(profile.coverageMode)}`}>
                {profile.coverageMode === 'live' ? `Live · ${totalDays} days` : getSourceBadgeLabel(profile)}
              </span>
            </div>
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAY_LABELS.map((weekday, index) => (
                <div key={`${weekday}-${index}`} className="text-center font-mono text-[9px] text-slate-600">{weekday}</div>
              ))}
              {Array.from({ length: (makeUtcDate(year, month, 1).getUTCDay() + 6) % 7 }).map((_, index) => (
                <div key={`empty-${index}`} />
              ))}
              {Array.from({ length: totalDays }, (_, index) => {
                const day = index + 1;
                const currentDate = makeUtcDate(year, month, day);
                const cellState = getCoverageCellStateForPeriod(source, currentDate, endOfUtcDay(currentDate), plotCount, availabilityIndex);

                return (
                  <div
                    key={day}
                    className="grid aspect-square min-h-8 place-items-center rounded border px-1 text-center"
                    style={cellStyle(cellState.level, cellState.mode)}
                    title={`${source.name} · ${MONTH_LABELS[month]} ${day}, ${year} · ${cellState.statusLabel} · ${cellState.detailLabel}`}
                  >
                    <span className="grid gap-0.5">
                      <span className="font-mono text-[10px]">{day}</span>
                      <span className="hidden text-[9px] leading-none opacity-70 sm:block">
                        {cellState.statusLabel}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function SixMonthView({
  sources,
  anchor,
  getPlotCount,
  availabilityIndex,
}: {
  sources: PublicSpaceWeatherSource[];
  anchor: Date;
  getPlotCount: (sourceId: string) => number;
  availabilityIndex: HistoricAvailabilityIndex;
}) {
  const months = Array.from({ length: 6 }, (_, index) => addMonths(anchor, index));

  return (
    <div className="grid gap-3">
      {sources.map(source => {
        const plotCount = getPlotCount(source.id);
        const profile = getAvailabilityProfile(source, plotCount);

        return (
          <article key={source.id} className="rounded-lg border border-slate-800 bg-slate-950/35 p-3">
            <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-slate-100">{source.name}</h3>
                  <OrbitBadge orbit={source.orbit} />
                </div>
                <div className="mt-1 truncate font-mono text-[9px] uppercase tracking-widest text-slate-600">{source.provider}</div>
              </div>
              <span className={`rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${getCoverageModeClassName(profile.coverageMode)}`}>
                {getSourceBadgeLabel(profile)}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {months.map(monthDate => {
                const year = monthDate.getUTCFullYear();
                const month = monthDate.getUTCMonth();
                const totalDays = daysInMonth(year, month);

                return (
                  <div key={`${year}-${month}`} className="rounded-md border border-slate-800 bg-slate-950/50 p-2">
                    <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-slate-500">
                      {MONTH_LABELS[month]} {year}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {Array.from({ length: totalDays }, (_, index) => {
                        const day = index + 1;
                        const currentDate = makeUtcDate(year, month, day);
                        const cellState = getCoverageCellStateForPeriod(source, currentDate, endOfUtcDay(currentDate), plotCount, availabilityIndex);

                        return (
                          <span
                            key={day}
                            className="aspect-square rounded-sm border"
                            style={cellStyle(cellState.level, cellState.mode)}
                            title={`${source.name} · ${MONTH_LABELS[month]} ${day}, ${year} · ${cellState.statusLabel} · ${cellState.detailLabel}`}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function YearStripesView({
  sources,
  getPlotCount,
  availabilityIndex,
}: {
  sources: PublicSpaceWeatherSource[];
  getPlotCount: (sourceId: string) => number;
  availabilityIndex: HistoricAvailabilityIndex;
}) {
  return (
    <div className="grid gap-4">
      {sources.map(source => {
        const plotCount = getPlotCount(source.id);
        const profile = getAvailabilityProfile(source, plotCount);
        const years = getAvailabilityYears(profile);

        return (
          <article key={source.id} className="rounded-lg border border-slate-800 bg-slate-950/35 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-slate-100">{source.name}</h3>
                  <OrbitBadge orbit={source.orbit} />
                </div>
                <div className="mt-1 truncate font-mono text-[9px] uppercase tracking-widest text-slate-600">
                  {formatAvailabilityDate(profile.startUtc)} - {formatAvailabilityDate(profile.stopUtc)}
                </div>
              </div>
              <span className={`rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${getCoverageModeClassName(profile.coverageMode)}`}>
                {getSourceBadgeLabel(profile)}
              </span>
            </div>
            <div className="grid gap-1">
              {years.map(year => (
                <div key={year} className="grid items-center gap-2" style={{ gridTemplateColumns: '48px minmax(0, 1fr)' }}>
                  <div className="font-mono text-[9px] text-slate-500">{year}</div>
                  <div className="grid grid-cols-[repeat(53,minmax(0,1fr))] gap-0.5">
                    {Array.from({ length: 53 }, (_, weekIndex) => {
                      const weekStart = makeUtcDate(year, 0, 1 + (weekIndex * 7));
                      const weekStop = endOfUtcDay(makeUtcDate(year, 0, 1 + (weekIndex * 7) + 6));
                      const cellState = getCoverageCellStateForPeriod(source, weekStart, weekStop, plotCount, availabilityIndex);

                      return (
                        <span
                          key={weekIndex}
                          className="h-2 rounded-sm border"
                          style={cellStyle(cellState.level, cellState.mode)}
                          title={`${source.name} · ${year} week ${weekIndex + 1} · ${cellState.statusLabel} · ${cellState.detailLabel}`}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function HistoricAvailabilityCalendar({
  sources,
  selectedSourceIds,
  range,
  getPlotCount,
  onClose,
}: HistoricAvailabilityCalendarProps) {
  const [mode, setMode] = useState<AvailabilityMode>('six-month');
  const [anchor, setAnchor] = useState(() => startOfMonth(parseDatetimeLocal(range.start)));
  const [availabilitySnapshot, setAvailabilitySnapshot] = useState<HistoricAvailabilitySnapshot | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [visibleSourceIds, setVisibleSourceIds] = useState<Set<string>>(() => {
    const initial = sources
      .filter(source => selectedSourceIds.includes(source.id) || getPlotCount(source.id) > 0)
      .map(source => source.id);

    return new Set(initial.length > 0 ? initial : sources.slice(0, 5).map(source => source.id));
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchAvailability() {
      try {
        setAvailabilityError(null);
        const response = await fetch('/api/playground/historic-availability', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Availability index request failed with ${response.status}`);
        }

        const nextSnapshot = await response.json() as HistoricAvailabilitySnapshot;

        if (!cancelled) {
          setAvailabilitySnapshot(nextSnapshot);
        }
      } catch (error) {
        if (!cancelled) {
          setAvailabilityError(error instanceof Error ? error.message : 'Availability index request failed');
        }
      }
    }

    void fetchAvailability();

    return () => {
      cancelled = true;
    };
  }, []);

  const availabilityIndex = useMemo(() => {
    const index: HistoricAvailabilityIndex = new Map();

    availabilitySnapshot?.sources.forEach(source => {
      index.set(source.sourceId, {
        startDateUtc: source.startDateUtc,
        stopDateUtc: source.stopDateUtc,
        expectedSamplesPerDay: source.expectedSamplesPerDay,
        days: new Map<string, HistoricAvailabilityDay>(source.days.map(day => [day.dateUtc, day] as const)),
      });
    });

    return index;
  }, [availabilitySnapshot]);

  const visibleSources = useMemo(
    () => sources.filter(source => visibleSourceIds.has(source.id)),
    [sources, visibleSourceIds],
  );
  const modeStep = getModeStep(mode);

  const toggleSource = (sourceId: string) => {
    setVisibleSourceIds(current => {
      const next = new Set(current);

      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }

      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[2147483647] bg-slate-950/85 p-4 backdrop-blur-md sm:p-6">
      <button
        type="button"
        aria-label="Close historic availability calendar"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <section className="relative mx-auto flex h-[calc(100dvh-2rem)] max-h-[920px] w-full max-w-7xl flex-col overflow-hidden rounded-lg border border-cyan-400/25 bg-slate-950 text-slate-200 shadow-2xl shadow-cyan-950/30 sm:h-[calc(100dvh-3rem)]">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300">
              <CalendarRange className="h-4 w-4" aria-hidden="true" />
              Historical availability
            </div>
            <h2 className="mt-1 truncate text-xl font-semibold text-slate-100">
              Mission coverage calendar
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-slate-700 bg-slate-950">
              {[
                ['month', 'Months'],
                ['day', 'Days'],
                ['six-month', '6 months'],
                ['year', 'Years'],
              ].map(([nextMode, label]) => (
                <button
                  key={nextMode}
                  type="button"
                  aria-pressed={mode === nextMode}
                  onClick={() => setMode(nextMode as AvailabilityMode)}
                  className={`h-9 px-3 font-mono text-[10px] uppercase tracking-widest transition ${
                    mode === nextMode
                      ? 'bg-cyan-400/15 text-cyan-100'
                      : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode !== 'year' && (
              <div className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-1">
                <button
                  type="button"
                  aria-label="Previous period"
                  onClick={() => setAnchor(current => addMonths(current, -modeStep))}
                  className="grid h-8 w-8 place-items-center rounded text-slate-400 transition hover:bg-slate-800 hover:text-cyan-100"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
                <div className="min-w-44 text-center font-mono text-[10px] uppercase tracking-widest text-slate-300">
                  {getPeriodLabel(mode, anchor)}
                </div>
                <button
                  type="button"
                  aria-label="Next period"
                  onClick={() => setAnchor(current => addMonths(current, modeStep))}
                  className="grid h-8 w-8 place-items-center rounded text-slate-400 transition hover:bg-slate-800 hover:text-cyan-100"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}

            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <SourceLegend
            sources={sources}
            visibleSourceIds={visibleSourceIds}
            getPlotCount={getPlotCount}
            onToggle={toggleSource}
          />

          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden">
            <div className="grid gap-3 xl:grid-cols-[300px_minmax(0,1fr)]">
              <div className="rounded-lg border border-slate-800 bg-slate-950/45 p-3">
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  <Grid3X3 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  Visible missions: {visibleSources.length}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-400 xl:text-xs">
                  Cells show measured density only when daily observed/expected counts exist. Unindexed sources stay neutral until a backfill creates a density index.
                </p>
                <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-slate-600">
                  {availabilityError
                    ? 'Density index unavailable'
                    : availabilitySnapshot
                      ? `Indexed sources: ${availabilitySnapshot.sources.length}`
                      : 'Loading density index'}
                </div>
              </div>
              <AvailabilityScale />
            </div>

            <div className="min-h-0 overflow-auto rounded-lg border border-slate-800 bg-slate-900/25 p-3 pb-8">
              {visibleSources.length === 0 ? (
                <div className="grid min-h-64 place-items-center text-center">
                  <div>
                    <Circle className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
                    <div className="mt-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      Select at least one mission
                    </div>
                  </div>
                </div>
              ) : mode === 'month' ? (
                <MonthView sources={visibleSources} anchor={anchor} getPlotCount={getPlotCount} availabilityIndex={availabilityIndex} />
              ) : mode === 'day' ? (
                <DayView sources={visibleSources} anchor={anchor} getPlotCount={getPlotCount} availabilityIndex={availabilityIndex} />
              ) : mode === 'six-month' ? (
                <SixMonthView sources={visibleSources} anchor={anchor} getPlotCount={getPlotCount} availabilityIndex={availabilityIndex} />
              ) : (
                <YearStripesView sources={visibleSources} getPlotCount={getPlotCount} availabilityIndex={availabilityIndex} />
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
