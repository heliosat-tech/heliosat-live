"use client";

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Clock } from 'lucide-react';
import { AdminIndicator } from '../auth/AdminIndicator';
import { AuthControls } from '../auth/AuthControls';

// A live data source surfaced in the consolidated "Data sources" dropdown. Adding a new feed
// (another mission, GOES, IMAP, …) is just one more entry in the array page.tsx builds.
export interface SourceStatus {
  name: string;
  connected: boolean;
  partial?: boolean;
  lastUpdated: string | null;
}

interface TopStatusBarProps {
  sources: SourceStatus[];
}

const TIME_ZONES: { id: string; label: string; tz?: string }[] = [
  { id: 'UTC', label: 'UTC', tz: 'UTC' },
  { id: 'local', label: 'Local' }, // no tz => browser local
  { id: 'America/New_York', label: 'New York', tz: 'America/New_York' },
  { id: 'America/Los_Angeles', label: 'Los Angeles', tz: 'America/Los_Angeles' },
  { id: 'Europe/London', label: 'London', tz: 'Europe/London' },
  { id: 'Europe/Madrid', label: 'Madrid', tz: 'Europe/Madrid' },
  { id: 'Asia/Tokyo', label: 'Tokyo', tz: 'Asia/Tokyo' },
];

const TZ_STORAGE_KEY = 'helios.clockTz';

const zoneFor = (id: string) => TIME_ZONES.find(zone => zone.id === id)?.tz;
const zoneLabel = (id: string) => TIME_ZONES.find(zone => zone.id === id)?.label ?? id;

function formatDate(date: Date, tzId: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zoneFor(tzId), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function formatTime(date: Date, tzId: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zoneFor(tzId), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
function formatUpdated(iso: string | null, tzId: string) {
  if (!iso) return 'no data';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'no data';
  return new Intl.DateTimeFormat('en-GB', { timeZone: zoneFor(tzId), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/** Dropdown open/close with click-away + Escape. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const ClockMenu: React.FC<{ now: Date | null; tzId: string; onSelect: (id: string) => void }> = ({ now, tzId, onSelect }) => {
  const { open, setOpen, ref } = useDropdown();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-800/30 px-3 py-1.5 font-mono text-sm text-cyan-300 transition-colors hover:border-slate-600"
        aria-expanded={open}
      >
        <Clock className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span className="tracking-wider">{now ? formatTime(now, tzId) : '--:--:--'}</span>
        <span className="text-[10px] uppercase tracking-widest text-slate-500">{zoneLabel(tzId)}</span>
        <ChevronDown className="h-3 w-3 text-slate-500" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-[120] mt-2 w-48 rounded-md border border-slate-700 bg-slate-950 p-1 shadow-xl">
          <div className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            {now ? formatDate(now, tzId) : '----'} · zone
          </div>
          {TIME_ZONES.map(zone => (
            <button
              key={zone.id}
              type="button"
              onClick={() => { onSelect(zone.id); setOpen(false); }}
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left font-mono text-xs transition-colors ${zone.id === tzId ? 'bg-cyan-400/10 text-cyan-200' : 'text-slate-300 hover:bg-slate-800'}`}
            >
              <span>{zone.label}</span>
              <span className="text-[10px] text-slate-500">{now ? formatTime(now, zone.id) : '--:--:--'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const SourcesMenu: React.FC<{ sources: SourceStatus[]; tzId: string }> = ({ sources, tzId }) => {
  const { open, setOpen, ref } = useDropdown();
  const connectedCount = sources.filter(source => source.connected).length;
  const anyDown = sources.some(source => !source.connected);
  const anyPartial = sources.some(source => source.connected && source.partial);
  const overallDot = anyDown ? 'bg-red-500' : anyPartial ? 'bg-amber-400' : 'bg-cyan-400';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-800/30 px-3 py-1.5 text-xs transition-colors hover:border-slate-600"
        aria-expanded={open}
      >
        <span className={`h-2 w-2 rounded-full ${overallDot} ${!anyDown && !anyPartial ? 'animate-pulse' : ''}`} />
        <span className="text-slate-300">Data sources</span>
        <span className="font-mono text-[10px] text-slate-500">{connectedCount}/{sources.length}</span>
        <ChevronDown className="h-3 w-3 text-slate-500" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-[120] mt-2 w-80 rounded-md border border-slate-700 bg-slate-950 p-1.5 shadow-xl">
          <div className="px-2 py-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-500">Live data sources · last update</div>
          {sources.map(source => (
            <div key={source.name} className="flex items-center justify-between gap-3 rounded px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${source.connected ? (source.partial ? 'bg-amber-400' : 'bg-cyan-400') : 'bg-red-500/70'}`} />
                <span className="truncate text-xs text-slate-200">{source.name}</span>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <span className={`font-mono text-[10px] ${source.connected ? (source.partial ? 'text-amber-300' : 'text-slate-400') : 'text-red-400/80'}`}>
                  {source.connected ? (source.partial ? 'Partial' : 'Connected') : 'Offline'}
                </span>
                <span className="w-12 text-right font-mono text-[10px] text-slate-600">{formatUpdated(source.lastUpdated, tzId)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const TopStatusBar: React.FC<TopStatusBarProps> = ({ sources }) => {
  // now stays null until mount so SSR and first client render agree (no clock hydration mismatch).
  const [now, setNow] = useState<Date | null>(null);
  const [tzId, setTzId] = useState('UTC');

  useEffect(() => {
    const initial = window.setTimeout(() => {
      setNow(new Date());
      try {
        const saved = window.localStorage.getItem(TZ_STORAGE_KEY);
        if (saved) setTzId(saved);
      } catch {
        /* ignore unreadable storage */
      }
    }, 0);
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  const selectTz = (id: string) => {
    setTzId(id);
    try {
      window.localStorage.setItem(TZ_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  return (
    <header className="sticky top-3 z-[100] flex shrink-0 items-center justify-between gap-4 overflow-visible rounded-lg border border-slate-700/50 bg-slate-900/75 px-4 py-3 shadow-lg backdrop-blur-md xl:top-0 xl:px-6">
      <div className="flex items-center gap-3">
        <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-cyan-400" />
        {/* HelioSat logo — mix-blend lighten inverts the white background against the dark shell */}
        <img
          src="/heliosat-logo.jpeg"
          alt="HelioSat Technologies"
          className="h-9 w-auto object-contain"
          style={{ mixBlendMode: 'lighten', filter: 'brightness(1.05) contrast(1.1)' }}
        />
        <span className="ml-1 border-l border-slate-700 pl-3 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-400">
          Mission Control
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-3">
        <ClockMenu now={now} tzId={tzId} onSelect={selectTz} />
        <SourcesMenu sources={sources} tzId={tzId} />
        <div className="relative z-[110] flex shrink-0 items-center gap-3 border-l border-slate-700 pl-3">
          <AdminIndicator />
          <AuthControls />
        </div>
      </div>
    </header>
  );
};
