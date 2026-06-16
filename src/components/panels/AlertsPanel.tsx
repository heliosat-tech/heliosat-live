"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Radio, Satellite } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';
import type { NoaaAlertsResponse } from '@/services/noaaAlertsService';
import { humanizeNoaaAlert, type AlertTiming, type AlertTone, type HumanizedAlert } from '@/services/noaaAlertFormatService';

interface AlertsPanelProps {
  noaaAlertsData: NoaaAlertsResponse;
  compact?: boolean;
}

const toneStyles: Record<AlertTone, { card: string; chip: string; dot: string }> = {
  high: {
    card: 'border-red-500/40 bg-red-500/5',
    chip: 'border-red-500/40 bg-red-500/10 text-red-300',
    dot: 'bg-red-400',
  },
  elevated: {
    card: 'border-amber-500/30 bg-amber-500/5',
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    dot: 'bg-amber-400',
  },
  info: {
    card: 'border-slate-700/50 bg-slate-800/20',
    chip: 'border-slate-600/50 bg-slate-800/40 text-slate-300',
    dot: 'bg-slate-500',
  },
};

type TimingMode = 'expected' | 'ongoing' | 'occurred';

const timingStyles: Record<TimingMode, string> = {
  expected: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200',
  ongoing: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  occurred: 'border-slate-700/60 bg-slate-900/50 text-slate-300',
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => n.toString().padStart(2, '0');

/** "13 Jun · 13:32 UTC" */
function absLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Coarse human duration for a positive millisecond span. */
function spanLabel(absMs: number): string {
  const minutes = Math.round(absMs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = absMs / 3_600_000;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
  return `${Math.round(absMs / 86_400_000)} d`;
}

interface TimingView {
  mode: TimingMode;
  label: string;
  primary: string;
  secondary: string | null;
}

/** Turn the parsed instants into an operator-facing "when does it reach Earth?" line. */
function buildTimingView(timing: AlertTiming, nowMs: number | null): TimingView {
  const start = timing.validFromIso ? Date.parse(timing.validFromIso)
    : timing.onsetIso ? Date.parse(timing.onsetIso)
    : timing.validToIso ? Date.parse(timing.validToIso)
    : null;
  const end = timing.validToIso ? Date.parse(timing.validToIso) : null;
  if (start === null) {
    return { mode: 'occurred', label: 'Timing', primary: 'See bulletin', secondary: null };
  }

  // Before a client clock is available, show the absolute time only (no live countdown) so the
  // server and first client render agree.
  if (nowMs === null) {
    return {
      mode: timing.isPrediction ? 'expected' : 'ongoing',
      label: timing.isPrediction ? 'Expected to reach Earth' : 'Affecting Earth',
      primary: absLabel(start),
      secondary: end ? `until ${absLabel(end)}` : null,
    };
  }

  if (nowMs < start) {
    return {
      mode: 'expected',
      label: 'Expected to reach Earth',
      primary: `in ${spanLabel(start - nowMs)}`,
      secondary: `${absLabel(start)}${end ? ` → ${pad(new Date(end).getUTCHours())}:${pad(new Date(end).getUTCMinutes())} UTC` : ''}`,
    };
  }
  if (end !== null && nowMs < end) {
    return {
      mode: 'ongoing',
      label: 'Affecting Earth now',
      primary: `ends in ${spanLabel(end - nowMs)}`,
      secondary: `since ${absLabel(start)}`,
    };
  }
  if (end === null) {
    return {
      mode: 'ongoing',
      label: 'Affecting Earth now',
      primary: `since ${absLabel(start)}`,
      secondary: `${spanLabel(nowMs - start)} ago onset`,
    };
  }
  return {
    mode: 'occurred',
    label: 'Effect window ended',
    primary: absLabel(end),
    secondary: `${spanLabel(nowMs - end)} ago`,
  };
}

const TimingBox: React.FC<{ timing: AlertTiming; nowMs: number | null }> = ({ timing, nowMs }) => {
  const view = buildTimingView(timing, nowMs);
  return (
    <div className={`flex items-center gap-2 rounded border px-2.5 py-1.5 ${timingStyles[view.mode]}`}>
      <Clock className="h-3.5 w-3.5 flex-shrink-0 opacity-80" aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-[8px] font-mono uppercase tracking-widest opacity-70">{view.label}</div>
        <div className="text-xs font-mono font-semibold">
          {view.primary}
          {view.secondary && <span className="ml-1.5 font-normal opacity-60">{view.secondary}</span>}
        </div>
      </div>
    </div>
  );
};

const AlertCard: React.FC<{ alert: HumanizedAlert; compact: boolean; nowMs: number | null }> = ({ alert, compact, nowMs }) => {
  const tone = toneStyles[alert.tone];
  return (
    <div className={`flex flex-col gap-2 rounded border ${tone.card} ${compact ? 'p-2.5' : 'p-3'}`}>
      {/* Headline: phenomenon + bulletin kind / NOAA scale */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
          <div className="min-w-0">
            <div className={`font-semibold text-slate-100 ${compact ? 'text-xs' : 'text-sm'}`}>{alert.title}</div>
            {alert.issuedLabel && (
              <div className="mt-0.5 text-[9px] font-mono uppercase tracking-wider text-slate-500">
                Issued {alert.issuedLabel}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1">
          <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest ${tone.chip}`}>
            {alert.kind}
          </span>
          {alert.noaaScale && (
            <span className="inline-flex items-center rounded border border-slate-700/60 bg-slate-900/60 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-slate-400">
              {alert.noaaScale}
            </span>
          )}
        </div>
      </div>

      {/* When does it reach / affect Earth — the headline an operator acts on */}
      {alert.timing && <TimingBox timing={alert.timing} nowMs={nowMs} />}

      {/* NOAA's own one-line condition */}
      {alert.condition && (
        <p className={`text-slate-300 ${compact ? 'text-[11px] leading-snug' : 'text-xs leading-relaxed'}`}>
          {alert.condition}
        </p>
      )}

      {/* Key parsed fields (peak value, extra times…) */}
      {alert.highlights.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {alert.highlights.map(highlight => (
            <span key={highlight.label} className="text-[9px] font-mono text-slate-500">
              <span className="uppercase tracking-wider text-slate-600">{highlight.label}: </span>
              <span className="text-slate-400">{highlight.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* NOAA's "Potential Impacts" paragraph, if present */}
      {alert.impacts && (
        <p className={`text-slate-400 ${compact ? 'text-[10px] leading-snug' : 'text-[11px] leading-relaxed'}`}>
          <span className="text-slate-500">Impacts: </span>{alert.impacts}
        </p>
      )}

      {/* What this means for satellites, by orbit class */}
      {alert.relevance && (
        <div className="flex items-start gap-1.5 rounded border border-slate-700/40 bg-slate-950/40 px-2 py-1.5">
          <Satellite className="mt-0.5 h-3 w-3 flex-shrink-0 text-cyan-400/70" aria-hidden="true" />
          <span className={`text-cyan-200/80 ${compact ? 'text-[10px] leading-snug' : 'text-[11px] leading-relaxed'}`}>
            {alert.relevance}
          </span>
        </div>
      )}

      {/* Original NOAA telex, on demand */}
      <details className="group">
        <summary className="cursor-pointer list-none text-[9px] font-mono uppercase tracking-wider text-slate-600 hover:text-slate-400">
          Show original
        </summary>
        <pre className="mt-1.5 whitespace-pre-wrap rounded bg-slate-950/60 p-2 text-[9px] leading-snug text-slate-500">
          {alert.raw || 'No message content available.'}
        </pre>
      </details>
    </div>
  );
};

export const AlertsPanel: React.FC<AlertsPanelProps> = ({ noaaAlertsData, compact = false }) => {
  const { alerts, errorMessage } = noaaAlertsData;

  // Collapse NOAA's daily "continued" re-issues: keep the most recent bulletin per product code,
  // then show newest first. This drops the near-identical stacked cards for an ongoing condition.
  const humanized = useMemo(() => {
    const byKey = new Map<string, HumanizedAlert>();
    for (const alert of (alerts ?? []).map(humanizeNoaaAlert)) {
      const existing = byKey.get(alert.dedupeKey);
      if (!existing || (alert.issuedMs ?? 0) > (existing.issuedMs ?? 0)) byKey.set(alert.dedupeKey, alert);
    }
    return [...byKey.values()].sort((a, b) => (b.issuedMs ?? 0) - (a.issuedMs ?? 0));
  }, [alerts]);

  // Live clock for the "in ~6 h / since 2 h ago" countdowns. Starts null so SSR and the first
  // client render agree (absolute times only); the relative phrasing fills in after mount.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const initial = window.setTimeout(() => setNowMs(Date.now()), 0);
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(id);
    };
  }, []);

  return (
    <GlassCard
      title="NOAA Alerts"
      className="h-full"
      bodyClassName={compact ? 'p-3' : 'p-4'}
      headerClassName={compact ? 'px-3 py-2' : undefined}
    >
      <div className="flex h-full flex-col gap-2">
        {/* These are global SWPC bulletins for the whole near-Earth environment — not specific to
            the satellites you track. The per-alert note maps each one to the orbits it affects. */}
        <div className="flex items-center gap-1.5 border-b border-slate-800/60 pb-2 text-[9px] font-mono uppercase tracking-wider text-slate-500">
          <Radio className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          Global NOAA SWPC bulletins · not satellite-specific
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto pr-1 ${compact ? 'space-y-2.5' : 'space-y-3'}`}>
          {errorMessage && (
            <div className={`rounded border border-red-900/50 bg-red-900/20 px-3 py-2 font-mono text-red-400 ${compact ? 'text-[10px]' : 'text-sm'}`}>
              {errorMessage}
            </div>
          )}

          {humanized.length > 0 ? (
            humanized.map((alert, index) => <AlertCard key={index} alert={alert} compact={compact} nowMs={nowMs} />)
          ) : (
            !errorMessage && (
              <div className="flex h-full items-center justify-center text-center font-mono text-xs uppercase tracking-wider text-slate-500">
                No active alerts from NOAA
              </div>
            )
          )}
        </div>
      </div>
    </GlassCard>
  );
};
