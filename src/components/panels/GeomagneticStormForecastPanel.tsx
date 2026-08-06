"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Bell, BellOff, BellRing, Clock3, Info, Radio, ShieldAlert, TriangleAlert } from 'lucide-react';
import { GlassCard } from '@/components/ui/GlassCard';
import { ForecastLineChart, useLiveL1ForecastData } from '@/components/panels/L1ForecastPanel';
import type { L1ForecastPanelData, GeomagneticSevereEvent } from '@/services/l1ForecastPanelService';
import type { G3StudySummary } from '@/services/geomagneticStormStudySummaryService';

interface GeomagneticStormForecastPanelProps {
  data: L1ForecastPanelData;
  study: G3StudySummary | null;
  expanded?: boolean;
}

type BrowserPermission = NotificationPermission | 'unsupported';

const NOTIFICATIONS_ENABLED_KEY = 'heliosat.g3Notifications.enabled.v1';
const LAST_NOTIFICATION_KEY = 'heliosat.g3Notifications.lastEvent.v1';
const SAME_EVENT_TOLERANCE_MS = 2 * 60 * 60 * 1000;
const EVENT_MEMORY_MS = 6 * 60 * 60 * 1000;

const G_STYLES = [
  { word: 'Quiet', text: 'text-emerald-200', border: 'border-emerald-400/30', bg: 'bg-emerald-400/[0.07]', dot: '#34d399' },
  { word: 'Minor', text: 'text-lime-200', border: 'border-lime-400/30', bg: 'bg-lime-400/[0.07]', dot: '#a3e635' },
  { word: 'Moderate', text: 'text-amber-200', border: 'border-amber-400/30', bg: 'bg-amber-400/[0.07]', dot: '#fbbf24' },
  { word: 'Strong', text: 'text-orange-200', border: 'border-orange-400/35', bg: 'bg-orange-400/[0.09]', dot: '#fb923c' },
  { word: 'Severe', text: 'text-red-200', border: 'border-red-400/35', bg: 'bg-red-400/[0.09]', dot: '#f87171' },
  { word: 'Extreme', text: 'text-fuchsia-200', border: 'border-fuchsia-400/35', bg: 'bg-fuchsia-400/[0.09]', dot: '#e879f9' },
] as const;

function levelStyle(level: number | null) {
  return G_STYLES[Math.max(0, Math.min(5, Math.round(level ?? 0)))];
}

function utcClock(iso: string | null) {
  if (!iso) return '--:--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

function etaLabel(minutes: number) {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins ? `${hours} h ${mins} min` : `${hours} h`;
}

function notificationBody(event: GeomagneticSevereEvent) {
  return `${event.peak.code} ${event.peak.label.toLowerCase()} expected at Earth in ${etaLabel(event.etaMinutes)} (${utcClock(event.firstArrivalUtc)} UTC). Peak estimated Kp ${event.peak.kp.toFixed(1)}.`;
}

async function showStormNotification(event: GeomagneticSevereEvent) {
  const title = `HelioSat · ${event.peak.code} geomagnetic storm forecast`;
  const options: NotificationOptions = {
    body: notificationBody(event),
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'heliosat-g3-storm',
    data: { url: '/' },
  };

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/heliosat-alerts-sw.js', { scope: '/' });
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, options);
      return;
    } catch {
      // Desktop fallback below; mobile browsers require the service worker path.
    }
  }

  const notification = new Notification(title, options);
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

function shouldNotify(event: GeomagneticSevereEvent) {
  try {
    const previous = JSON.parse(window.localStorage.getItem(LAST_NOTIFICATION_KEY) ?? 'null') as {
      firstArrivalMs?: number;
      peakLevel?: number;
      notifiedAtMs?: number;
    } | null;
    const firstArrivalMs = new Date(event.firstArrivalUtc).getTime();
    if (!previous || !Number.isFinite(previous.firstArrivalMs) || !Number.isFinite(previous.notifiedAtMs)) return true;
    const sameEvent = Math.abs((previous.firstArrivalMs as number) - firstArrivalMs) <= SAME_EVENT_TOLERANCE_MS;
    const recent = Date.now() - (previous.notifiedAtMs as number) <= EVENT_MEMORY_MS;
    const notEscalated = (previous.peakLevel ?? 0) >= event.peak.level;
    return !(sameEvent && recent && notEscalated);
  } catch {
    return true;
  }
}

function rememberNotification(event: GeomagneticSevereEvent) {
  try {
    window.localStorage.setItem(LAST_NOTIFICATION_KEY, JSON.stringify({
      firstArrivalMs: new Date(event.firstArrivalUtc).getTime(),
      peakLevel: event.peak.level,
      notifiedAtMs: Date.now(),
    }));
  } catch {
    // Deduplication is best-effort when browser storage is unavailable.
  }
}

function NotificationControl({
  event,
  eligible,
}: {
  event: GeomagneticSevereEvent | null;
  eligible: boolean;
}) {
  const [permission, setPermission] = useState<BrowserPermission>('unsupported');
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!('Notification' in window)) return;
    const initial = window.setTimeout(() => {
      setPermission(Notification.permission);
      try {
        setEnabled(Notification.permission === 'granted' && window.localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) === 'true');
      } catch {
        setEnabled(false);
      }
    }, 0);
    return () => window.clearTimeout(initial);
  }, []);

  useEffect(() => {
    if (!enabled || permission !== 'granted' || !event || !eligible || !shouldNotify(event)) return;
    void showStormNotification(event)
      .then(() => rememberNotification(event))
      .catch(() => undefined);
  }, [eligible, enabled, event, permission]);

  const setPreference = useCallback((value: boolean) => {
    setEnabled(value);
    try {
      window.localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, String(value));
    } catch {
      // The preference remains active for this page session.
    }
  }, []);

  const toggle = useCallback(async () => {
    if (!('Notification' in window)) return;
    if (permission === 'granted') {
      setPreference(!enabled);
      return;
    }
    if (permission === 'denied') return;
    const next = await Notification.requestPermission();
    setPermission(next);
    if (next === 'granted') setPreference(true);
  }, [enabled, permission, setPreference]);

  const blocked = permission === 'denied';
  const unsupported = permission === 'unsupported';
  const Icon = enabled ? BellRing : blocked || unsupported ? BellOff : Bell;
  const label = unsupported
    ? 'Browser alerts unavailable'
    : blocked
      ? 'Notifications blocked in browser'
      : enabled
        ? 'G3+ browser alerts on'
        : 'Enable G3+ browser alerts';

  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-950/55 p-3">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={blocked || unsupported}
        aria-pressed={enabled}
        className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition ${enabled ? 'border-cyan-400/35 bg-cyan-400/10 text-cyan-100' : 'border-slate-700 bg-slate-900/60 text-slate-300 hover:border-cyan-400/30 hover:text-cyan-100'} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest">
          <Icon className="h-4 w-4" aria-hidden="true" /> {label}
        </span>
        {enabled && <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" />}
      </button>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Alerts include intensity and Earth-arrival ETA. Keep this dashboard open; the forecast is checked every minute. Repeated updates to the same storm are deduplicated unless severity increases.
      </p>
    </div>
  );
}

function ForecastInfo({ study }: { study: G3StudySummary | null }) {
  return (
    <details className="group relative z-20 shrink-0">
      <summary
        aria-label="About this geomagnetic forecast"
        title="About this forecast"
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-full border border-cyan-400/30 bg-slate-950/80 text-cyan-200 transition hover:border-cyan-300 hover:bg-cyan-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 [&::-webkit-details-marker]:hidden"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </summary>
      <div className="absolute right-0 top-9 z-30 w-[min(21rem,calc(100vw-4rem))] rounded-lg border border-cyan-400/25 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-xl">
        <p className="rounded-md border border-cyan-400/20 bg-cyan-400/[0.06] px-3 py-2.5 text-[10px] leading-relaxed text-slate-300">
          Solar Cycle 25 is still in an active phase. The recent definitive Kp record suggests <strong className="font-semibold text-cyan-100">about 1 G3+ event per month</strong> as a practical reference for this year. Events are not evenly spaced: several may cluster together, followed by quiet weeks.
        </p>
        <p className="mt-1.5 font-mono text-[8px] uppercase tracking-wider text-slate-600">Basis · definitive Kp · Jan 2024–Apr 2026</p>

        <div className="mt-3 font-mono text-[9px] font-semibold uppercase tracking-widest text-cyan-100">How this forecast works</div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-300">
          The live forecast propagates measured L1 solar-wind speed and Bz to Earth, smooths them over 30 minutes and requires a G3 signal to remain present for at least 10 minutes before issuing an alert.
        </p>

        {study && (
          <div className="mt-3 border-t border-slate-800 pt-3">
            <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-violet-200">
              <Activity className="h-3.5 w-3.5" aria-hidden="true" /> Historical G3+ validation
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">Precision</div><div className="mt-0.5 font-mono text-sm text-violet-200">{study.precisionPct.toFixed(0)}%</div></div>
              <div><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">Recall</div><div className="mt-0.5 font-mono text-sm text-cyan-200">{study.recallPct.toFixed(0)}%</div></div>
              <div><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">Independent events</div><div className="mt-0.5 font-mono text-sm text-slate-300">{study.observedEvents}</div></div>
              <div><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">False alarms</div><div className="mt-0.5 font-mono text-sm text-amber-200">{study.falseAlarmRatioPct.toFixed(0)}%</div></div>
            </div>
            <p className="mt-2 text-[9px] leading-relaxed text-slate-500">
              These retrospective results belong to a separate validation model that is not used for live browser alerts.
            </p>
          </div>
        )}
      </div>
    </details>
  );
}

export const GeomagneticStormForecastPanel: React.FC<GeomagneticStormForecastPanelProps> = ({
  data: initialData,
  study,
  expanded = false,
}) => {
  const data = useLiveL1ForecastData(initialData);
  const forecast = data.geomagneticForecast;
  const event = forecast.severeEvent;
  const peak = event?.peak ?? forecast.peak;
  const style = levelStyle(peak?.level ?? 0);
  const feedNotFresh = data.freshness !== 'fresh';
  const lowCoverage = forecast.coveragePct < 80;
  const eligible = Boolean(event) && !feedNotFresh && !lowCoverage;
  const gRow = data.heatmap.rows.find(row => row.id === 'g');

  const headline = feedNotFresh
    ? `Forecast paused · L1 feed is ${data.freshness}`
    : lowCoverage
      ? 'Forecast incomplete · insufficient L1 coverage'
      : event
        ? `${event.peak.code} ${event.peak.label.toLowerCase()} expected at Earth`
        : 'No sustained G3+ signal in the current arrival window';

  const horizonMinutes = useMemo(() => {
    if (!forecast.forecastStartUtc || !forecast.forecastEndUtc) return null;
    return Math.max(0, Math.round((new Date(forecast.forecastEndUtc).getTime() - data.generatedAtMs) / 60_000));
  }, [data.generatedAtMs, forecast.forecastEndUtc, forecast.forecastStartUtc]);

  const metric = (label: string, value: string, accent = false) => (
    <div className="rounded-md border border-slate-800 bg-slate-950/60 p-2.5">
      <div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">{label}</div>
      <div className={`mt-1 font-mono text-sm font-semibold ${accent ? style.text : 'text-slate-200'}`}>{value}</div>
    </div>
  );

  return (
    <GlassCard title="Real-time Geomagnetic Storm Forecast" className="h-full" bodyClassName="p-3" headerClassName="pr-12">
      <div className="flex min-h-0 flex-col gap-3">
        <section className={`rounded-xl border p-4 ${style.border} ${style.bg}`} role={event ? 'alert' : undefined}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-slate-400">
              <ShieldAlert className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" /> HelioSat live forecast · G3 threshold Kp 7
            </div>
            <ForecastInfo study={study} />
          </div>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className={`text-lg font-semibold leading-tight ${feedNotFresh || lowCoverage ? 'text-amber-200' : style.text}`}>{headline}</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                {event
                  ? `G3+ onset ${utcClock(event.firstArrivalUtc)} UTC · peak ${event.peak.code} around ${utcClock(event.peak.arrivalUtc)} UTC · sustained for ~${event.durationMinutes} min.`
                  : `Strongest current signal ${peak?.code ?? '—'}${peak ? ` (Kp est. ${peak.kp.toFixed(1)})` : ''}. Horizon ${horizonMinutes === null ? 'unavailable' : `~${etaLabel(horizonMinutes)}`}.`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <div className={`font-mono text-4xl font-semibold ${feedNotFresh || lowCoverage ? 'text-slate-500' : style.text}`}>{peak?.code ?? '—'}</div>
              <div className="font-mono text-[8px] uppercase tracking-widest text-slate-500">30-min coupling signal</div>
            </div>
          </div>
        </section>

        {gRow && gRow.cells.length > 0 && (
          <section>
            <div className="mb-1.5 flex items-center justify-between font-mono text-[8px] uppercase tracking-widest text-slate-600">
              <span>Arrival timeline · now</span><span>{horizonMinutes !== null ? `+${horizonMinutes} min` : 'horizon —'}</span>
            </div>
            <div className="flex h-9 overflow-hidden rounded-md border border-slate-700/70 bg-slate-900">
              {gRow.cells.map((cell, index) => (
                <div key={`${cell.t}-${index}`} className="min-w-px flex-1" style={{ backgroundColor: cell.color }} title={`${cell.label} · ${utcClock(new Date(cell.t).toISOString())} UTC`} />
              ))}
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[8px] uppercase tracking-wider text-slate-700"><span>now</span><span className="flex items-center gap-1 text-orange-300/70"><span className="h-1.5 w-1.5 rounded-full bg-orange-400" /> G3 threshold</span><span>{horizonMinutes !== null ? `+${horizonMinutes} min` : 'end'}</span></div>
          </section>
        )}

        <div className={`grid gap-2 ${expanded ? 'sm:grid-cols-4' : 'grid-cols-2'}`}>
          {metric('G3+ onset ETA', event ? etaLabel(event.etaMinutes) : 'No event', Boolean(event))}
          {metric('Peak Kp estimate', peak ? peak.kp.toFixed(1) : '—', Boolean(event))}
          {metric('Solar-wind speed', peak ? `${peak.speed} km/s` : '—')}
          {metric('Bz GSM · 30-min', peak ? `${peak.bz.toFixed(1)} nT` : '—')}
        </div>

        {(feedNotFresh || lowCoverage) && (
          <div className="flex items-start gap-2 rounded-md border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-[10px] leading-relaxed text-amber-100/80">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Browser alerts are paused until the L1 feed is current and at least 80% of the arrival window has usable speed and Bz.
          </div>
        )}

        <NotificationControl event={event} eligible={eligible} />

        <section className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <BarChart3 className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">What is arriving at Earth</h3>
                <p className="mt-0.5 text-[9px] leading-relaxed text-slate-500">A southward Bz is the key magnetic condition behind the G forecast.</p>
              </div>
            </div>
          </div>
          <div className={`grid min-w-0 gap-3 ${expanded ? 'lg:grid-cols-2' : ''}`}>
            <ForecastLineChart data={data} variable="bz" nowMs={data.generatedAtMs} expanded={expanded} />
            {expanded && <ForecastLineChart data={data} variable="speed" nowMs={data.generatedAtMs} expanded />}
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2 font-mono text-[8px] uppercase tracking-widest text-slate-600">
          <span className="flex items-center gap-1.5"><Radio className="h-3 w-3" aria-hidden="true" /> {data.sourceLabel ?? 'L1 source unavailable'} · {data.freshness}</span>
          <span className="flex items-center gap-1.5"><Clock3 className="h-3 w-3" aria-hidden="true" /> updated {utcClock(data.generatedAtUtc)} UTC · coverage {forecast.coveragePct.toFixed(0)}%</span>
        </div>
      </div>
    </GlassCard>
  );
};
