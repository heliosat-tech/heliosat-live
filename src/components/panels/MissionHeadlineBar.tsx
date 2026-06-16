import React from 'react';
import { Globe2, Radio } from 'lucide-react';
import type { L1ForecastPanelData, L1ForecastSeriesPoint } from '@/services/l1ForecastPanelService';
import type { ObservedStormScales } from '@/services/noaaStormScalesService';

interface MissionHeadlineBarProps {
  l1: L1ForecastPanelData;
  observed: ObservedStormScales | null;
}

// G/S/R palette indexed by NOAA level 0..5.
const SCALE_STYLE = [
  { word: 'QUIET', text: 'text-emerald-300', chip: 'border-emerald-400/40 bg-emerald-400/[0.08]', dot: 'bg-emerald-400' },
  { word: 'MINOR', text: 'text-lime-300', chip: 'border-lime-400/40 bg-lime-400/[0.08]', dot: 'bg-lime-400' },
  { word: 'MODERATE', text: 'text-amber-300', chip: 'border-amber-400/40 bg-amber-400/[0.08]', dot: 'bg-amber-400' },
  { word: 'STRONG', text: 'text-orange-300', chip: 'border-orange-400/40 bg-orange-400/[0.08]', dot: 'bg-orange-400' },
  { word: 'SEVERE', text: 'text-red-300', chip: 'border-red-400/40 bg-red-400/[0.08]', dot: 'bg-red-400' },
  { word: 'EXTREME', text: 'text-fuchsia-300', chip: 'border-fuchsia-400/40 bg-fuchsia-400/[0.08]', dot: 'bg-fuchsia-400' },
] as const;

const styleForLevel = (level: number) => SCALE_STYLE[Math.max(0, Math.min(5, level))];

const fmt = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);

const clockUtc = (iso: string | null) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')} UTC`;
};

// The solar wind currently arriving at Earth = the propagated L1 sample whose arrival time is ≈ now.
// series.forecast is sorted ascending by arrival time, so keep the last point that has already arrived.
function earthNowPoint(forecast: L1ForecastSeriesPoint[], nowMs: number): L1ForecastSeriesPoint | null {
  let arrived: L1ForecastSeriesPoint | null = null;
  for (const point of forecast) {
    if (point.t <= nowMs) arrived = point;
    else break;
  }
  return arrived ?? forecast[0] ?? null;
}

const Drivers: React.FC<{ speed: number | null; bz: number | null; bt: number | null; density: number | null }> = ({ speed, bz, bt, density }) => (
  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-slate-200">
    <span>{fmt(speed, 0)}<span className="text-slate-500"> km/s</span></span>
    <span>Bz {bz !== null && bz >= 0 ? '+' : ''}{fmt(bz, 1)}<span className="text-slate-500"> nT</span></span>
    <span>|B| {fmt(bt, 1)}<span className="text-slate-500"> nT</span></span>
    <span>{fmt(density, 1)}<span className="text-slate-500"> n/cc</span></span>
  </div>
);

const ScaleChip: React.FC<{ kind: 'S' | 'R'; level: number }> = ({ kind, level }) => {
  const style = styleForLevel(level);
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${level > 0 ? style.chip : 'border-slate-700/60 bg-slate-950/60'}`}>
      <span className={`h-1 w-1 rounded-full ${level > 0 ? style.dot : 'bg-slate-600'}`} />
      <span className={level > 0 ? style.text : 'text-slate-400'}>{kind}{level}</span>
    </span>
  );
};

/**
 * Mission headline: a left/right split of the live situation.
 *  - LEFT — "now at Earth": the REAL observed NOAA G (from planetary Kp) + the solar wind currently
 *    arriving (the L1 wind propagated to now). This is the prominent, current state.
 *  - RIGHT — "now at L1": the freshly measured L1 drivers + the FORECAST G they imply for Earth, with
 *    the transit lead time. Rendered less prominently because it is a prediction, not the present.
 *  - FAR RIGHT — the current observed S / R scales (NOAA, from GOES), shown when there's room.
 */
export const MissionHeadlineBar: React.FC<MissionHeadlineBarProps> = ({ l1, observed }) => {
  const earth = earthNowPoint(l1.series.forecast, l1.generatedAtMs);

  const gObserved = observed?.g ?? null;
  const hasObserved = Boolean(gObserved);
  const gStyle = styleForLevel(gObserved?.level ?? 0);

  const forecastStyle = styleForLevel(l1.latest.gLevel);

  return (
    <div className="flex flex-wrap items-stretch overflow-hidden rounded-lg border border-slate-800 bg-slate-950/50">
      {/* ============ NOW AT EARTH (observed, real) ============ */}
      {/* Prominent observed G */}
      <div className={`flex min-w-[12rem] flex-1 items-center gap-3 border-l-2 px-4 py-2.5 ${hasObserved ? gStyle.chip : 'border-l-slate-700 bg-slate-950/40'}`}>
        <span className={`inline-flex h-2.5 w-2.5 rounded-full ${hasObserved ? gStyle.dot : 'bg-slate-600'}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-widest text-slate-500">
            <Globe2 className="h-3 w-3" aria-hidden="true" /> En la Tierra · ahora
          </div>
          <div className={`mt-0.5 truncate font-mono text-lg font-semibold leading-tight ${hasObserved ? gStyle.text : 'text-slate-400'}`}>
            {hasObserved ? `${gObserved!.code} · ${gObserved!.label}` : 'Sin datos'}
          </div>
          <div className="font-mono text-[8px] uppercase tracking-widest text-slate-500">
            {observed?.latestKp != null ? `Kp ${observed.latestKp.toFixed(1)} · ` : ''}observado {clockUtc(observed?.observedAtUtc ?? null)}
          </div>
        </div>
      </div>

      {/* Solar wind arriving at Earth now (L1 propagated) */}
      <div className="flex min-w-0 flex-1 items-center border-l border-slate-800/70 px-4 py-2.5">
        <div className="min-w-0">
          <div className="font-mono text-[8px] uppercase tracking-widest text-slate-500">Viento solar · llegando</div>
          <div className="mt-0.5"><Drivers speed={earth?.speed ?? null} bz={earth?.bz ?? null} bt={earth?.bt ?? null} density={earth?.density ?? null} /></div>
        </div>
      </div>

      {/* ============ NOW AT L1 (measured) + forecast ============ */}
      {/* L1 measured drivers — thicker divider marks the Earth | L1 split */}
      <div className="flex min-w-0 flex-1 items-center border-l-2 border-slate-700/80 px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-widest text-slate-500">
            <Radio className="h-3 w-3" aria-hidden="true" /> En L1 · ahora
          </div>
          <div className="mt-0.5"><Drivers speed={l1.latest.speed} bz={l1.latest.bz} bt={l1.latest.bt} density={l1.latest.density} /></div>
        </div>
      </div>

      {/* Forecast G implied by the current L1 wind (muted: it's a prediction) */}
      <div className="flex min-w-0 flex-1 items-center border-l border-slate-800/70 px-4 py-2.5">
        <div className="min-w-0">
          <div className="font-mono text-[8px] uppercase tracking-widest text-slate-500">Pronóstico G · L1→Tierra</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded border border-slate-700/70 bg-slate-950/50 px-1.5 py-0.5 font-mono text-[11px]">
              <span className={`h-1.5 w-1.5 rounded-full ${forecastStyle.dot}`} />
              <span className={forecastStyle.text}>{l1.latest.gCode} · {forecastStyle.word}</span>
            </span>
            {l1.latest.transitMinutes != null && (
              <span className="whitespace-nowrap font-mono text-[10px] text-cyan-300/80">llega ~{l1.latest.transitMinutes.toFixed(0)} min</span>
            )}
          </div>
          <div className="font-mono text-[7px] uppercase tracking-widest text-slate-600">pronóstico · no es Kp/G oficial</div>
        </div>
      </div>

      {/* ============ Observed S / R scales (if there's room) ============ */}
      {observed && (
        <div className="flex items-center border-l border-slate-800/70 px-4 py-2.5">
          <div>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-widest text-slate-500">Escalas NOAA</div>
            <div className="flex gap-1.5">
              <ScaleChip kind="S" level={observed.s.level} />
              <ScaleChip kind="R" level={observed.r.level} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
