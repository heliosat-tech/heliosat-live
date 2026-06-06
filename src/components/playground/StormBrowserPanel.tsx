"use client";

import { useMemo, useState } from 'react';
import { Filter, RefreshCw, Zap } from 'lucide-react';
import type { StormBrowserSnapshot, StormIntensity } from '@/services/stormEventService';

interface StormBrowserPanelProps {
  snapshot: StormBrowserSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

type IntensityFilter = StormIntensity | 'all';

function formatNumber(value: number | null, maximumFractionDigits = 2) {
  if (value === null) {
    return 'NA';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'Not available';
  }

  return value.slice(0, 16).replace('T', ' ') + ' UTC';
}

function Timeline({ snapshot, selectedEventId, onSelect }: { snapshot: StormBrowserSnapshot; selectedEventId: string | null; onSelect: (eventId: string) => void }) {
  const width = 920;
  const height = 220;
  const points = snapshot.timeline.filter(point => point.negDst !== null);

  if (points.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No Dst timeline
      </div>
    );
  }

  const minMs = new Date(points[0].timestampUtc).getTime();
  const maxMs = new Date(points[points.length - 1].timestampUtc).getTime();
  const maxNegDst = Math.max(...points.map(point => point.negDst ?? 0), 60);
  const x = (timestampUtc: string) => ((new Date(timestampUtc).getTime() - minMs) / (maxMs - minMs || 1)) * (width - 28) + 14;
  const y = (value: number) => height - (value / maxNegDst) * (height - 28) - 14;
  const line = points.map(point => `${x(point.timestampUtc).toFixed(1)},${y(point.negDst ?? 0).toFixed(1)}`).join(' ');

  return (
    <svg aria-hidden="true" className="h-64 w-full rounded border border-slate-800 bg-slate-950/50" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" points={line} stroke="#22d3ee" strokeLinejoin="round" strokeWidth="2.2" />
      {snapshot.events.map(event => {
        const eventX = x(event.onsetUtc);
        const isSelected = selectedEventId === event.eventId;
        const color = event.intensity === 'extreme' ? '#fb7185' : event.intensity === 'intense' ? '#f59e0b' : '#fde047';

        return (
          <g key={event.eventId} onClick={() => onSelect(event.eventId)} className="cursor-pointer">
            <line stroke={color} strokeDasharray="4 4" x1={eventX} x2={eventX} y1="12" y2={height - 12} />
            <circle cx={eventX} cy={y(-event.peakDstNt)} fill={color} r={isSelected ? 6 : 4} />
          </g>
        );
      })}
      <text fill="#94a3b8" fontSize="10" x="14" y="18">-Dst</text>
    </svg>
  );
}

function DetailSeries({ snapshot, selectedEventId }: { snapshot: StormBrowserSnapshot; selectedEventId: string | null }) {
  const event = snapshot.events.find(item => item.eventId === selectedEventId) ?? snapshot.events[0] ?? null;
  const series = snapshot.selectedEventId === event?.eventId ? snapshot.selectedEventSeries : [];

  if (!event || series.length === 0) {
    return (
      <div className="flex h-96 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No selected event detail
      </div>
    );
  }

  const rows = [
    { label: 'L1 Bz', key: 'bzGsm' as const, color: '#22d3ee' },
    { label: 'L1 V', key: 'speed' as const, color: '#fb7185' },
    { label: 'GOES MAG', key: 'goesMag' as const, color: '#a78bfa' },
    { label: 'Dst', key: 'dst' as const, color: '#f59e0b' },
  ];

  return (
    <div className="grid gap-3">
      <div className="rounded border border-slate-800 bg-slate-950/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{event.eventId}</div>
            <div className="mt-1 text-sm text-slate-100">{event.intensity} · {event.driver}</div>
          </div>
          <div className="font-mono text-[10px] text-slate-400">
            onset {formatTimestamp(event.onsetUtc)} · peak {formatNumber(event.peakDstNt)} nT
          </div>
        </div>
      </div>
      {rows.map(row => {
        const width = 840;
        const height = 90;
        const values = series.map(point => point[row.key]).filter((value): value is number => value !== null);
        const minValue = values.length > 0 ? Math.min(...values) : 0;
        const maxValue = values.length > 0 ? Math.max(...values) : 1;
        const range = maxValue - minValue || 1;
        const line = series
          .map((point, index) => {
            const value = point[row.key];
            if (value === null) {
              return null;
            }
            const px = (index / Math.max(1, series.length - 1)) * (width - 24) + 12;
            const py = height - ((value - minValue) / range) * (height - 18) - 9;
            return `${px.toFixed(1)},${py.toFixed(1)}`;
          })
          .filter(Boolean)
          .join(' ');

        return (
          <svg key={row.key} aria-hidden="true" className="h-24 w-full rounded border border-slate-800 bg-slate-950/50" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
            <polyline fill="none" points={line} stroke={row.color} strokeLinejoin="round" strokeWidth="2" />
            <text fill="#94a3b8" fontSize="10" x="12" y="16">{row.label}</text>
          </svg>
        );
      })}
    </div>
  );
}

export function StormBrowserPanel({ snapshot, isLoading, error, onRefresh }: StormBrowserPanelProps) {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [intensityFilter, setIntensityFilter] = useState<IntensityFilter>('all');
  const visibleEvents = useMemo(
    () => (snapshot?.events ?? []).filter(event => intensityFilter === 'all' || event.intensity === intensityFilter),
    [intensityFilter, snapshot],
  );
  const activeEventId = selectedEventId ?? visibleEvents[0]?.eventId ?? snapshot?.selectedEventId ?? null;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="space-y-4">
        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300">Storm Browser</div>
              <h2 className="mt-1 truncate text-lg font-semibold text-slate-100">Event holdout catalog</h2>
              <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                {snapshot ? `${snapshot.events.length} events · ${snapshot.splitsConfig.folds.length} folds` : 'Not available'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select value={intensityFilter} onChange={event => setIntensityFilter(event.target.value as IntensityFilter)} className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-100 outline-none">
                <option value="all">All intensities</option>
                <option value="moderate">Moderate</option>
                <option value="intense">Intense</option>
                <option value="extreme">Extreme</option>
              </select>
              <button type="button" onClick={onRefresh} disabled={isLoading} className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500">
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>{isLoading ? 'Loading' : 'Refresh'}</span>
              </button>
            </div>
          </div>
          {(error || (snapshot?.warnings.length ?? 0) > 0) && (
            <div className="mt-3 grid gap-2">
              {error && <div className="rounded border border-rose-400/30 bg-rose-400/10 p-2 font-mono text-[10px] uppercase tracking-widest text-rose-100">{error}</div>}
              {snapshot?.warnings.map(warning => <div key={warning} className="rounded border border-amber-300/30 bg-amber-300/10 p-2 font-mono text-[10px] text-amber-100">{warning}</div>)}
            </div>
          )}
        </section>

        {snapshot ? (
          <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-2">
                  <Zap className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Timeline</h2>
                </div>
                <Timeline snapshot={{ ...snapshot, events: visibleEvents }} selectedEventId={activeEventId} onSelect={setSelectedEventId} />
              </article>
              <article className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <DetailSeries snapshot={snapshot} selectedEventId={activeEventId} />
              </article>
            </div>
            <aside className="grid content-start gap-4">
              <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-2">
                  <Filter className="h-4 w-4 text-amber-300" aria-hidden="true" />
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Events</h2>
                </div>
                <div className="grid max-h-[520px] gap-2 overflow-y-auto">
                  {visibleEvents.map(event => (
                    <button key={event.eventId} type="button" onClick={() => setSelectedEventId(event.eventId)} className={`rounded border p-3 text-left ${activeEventId === event.eventId ? 'border-cyan-400/50 bg-cyan-400/10' : 'border-slate-800 bg-slate-950/50 hover:border-slate-600'}`}>
                      <div className="truncate text-sm text-slate-100">{event.eventId}</div>
                      <div className="mt-1 font-mono text-[10px] text-slate-500">{event.intensity} · {formatTimestamp(event.onsetUtc)}</div>
                      <div className="mt-1 font-mono text-[10px] text-slate-400">peak {formatNumber(event.peakDstNt)} nT</div>
                    </button>
                  ))}
                </div>
              </section>
            </aside>
          </section>
        ) : (
          <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
            {isLoading ? 'Loading storm catalog' : 'Not available'}
          </div>
        )}
      </div>
    </main>
  );
}
