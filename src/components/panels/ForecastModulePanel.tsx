import React from 'react';
import { Clock, Navigation, TriangleAlert } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';
import { estimateEarthArrival } from '@/services/arrivalTimeService';
import type { NoaaEphemerisData, NoaaPlasmaData, NoaaServiceResponse } from '@/services/noaaSolarWindService';
import type { MissionBadge } from '@/types/spaceWeather';

interface ForecastModulePanelProps {
  noaaPlasmaData?: NoaaServiceResponse<NoaaPlasmaData>;
  noaaEphemerisData?: NoaaServiceResponse<NoaaEphemerisData>;
  compact?: boolean;
}

const badgeClass: Record<MissionBadge, string> = {
  AVAILABLE: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  PARTIAL: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  UNAVAILABLE: 'border-slate-700/60 bg-slate-900/60 text-slate-500',
  MEASURED: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  DERIVED: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  HEURISTIC: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  'DECISION SUPPORT ONLY': 'border-blue-500/30 bg-blue-500/10 text-blue-300',
};

const Badge: React.FC<{ value: MissionBadge }> = ({ value }) => (
  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest ${badgeClass[value]}`}>
    {value}
  </span>
);

const formatNumber = (value: number | null, maximumFractionDigits = 2) => (
  value === null ? 'Not available' : value.toLocaleString('en-US', { maximumFractionDigits })
);

const Metric: React.FC<{ label: string; value: string; unit?: string; badge?: MissionBadge }> = ({ label, value, unit, badge }) => (
  <div className="rounded border border-slate-800/80 bg-slate-950/45 p-2.5">
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <span className="truncate text-[8px] uppercase tracking-widest text-slate-500" title={label}>{label}</span>
      {badge && <Badge value={badge} />}
    </div>
    <div className={`font-mono text-sm ${value === 'Not available' ? 'text-slate-600' : 'text-slate-100'}`}>
      {value}
      {value !== 'Not available' && unit && <span className="ml-1 text-[10px] text-slate-500">{unit}</span>}
    </div>
  </div>
);

export const ForecastModulePanel: React.FC<ForecastModulePanelProps> = ({ noaaPlasmaData, noaaEphemerisData, compact = false }) => {
  if (!noaaPlasmaData || !noaaEphemerisData) {
    return (
      <GlassCard
        title="Arrival Prediction"
        className="h-full"
        bodyClassName={compact ? 'p-3' : 'p-4'}
        headerClassName={compact ? 'px-3 py-2' : undefined}
      >
        <div className="flex h-full items-center justify-center p-4 text-center">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
              Required NOAA inputs unavailable
            </div>
            <div className="mt-2 text-[10px] font-mono leading-relaxed text-slate-600">
              Solar-wind speed and L1 ephemeris data are required for arrival timing.
            </div>
          </div>
        </div>
      </GlassCard>
    );
  }

  const estimate = estimateEarthArrival(noaaPlasmaData, noaaEphemerisData);
  const distanceBadge: MissionBadge = estimate.distanceKm === null
    ? 'UNAVAILABLE'
    : estimate.distanceIsAssumption
      ? 'HEURISTIC'
      : 'DERIVED';

  return (
    <GlassCard
      title="Arrival Prediction"
      className="h-full"
      bodyClassName={compact ? 'p-3' : 'p-4'}
      headerClassName={compact ? 'px-3 py-2' : undefined}
    >
      <div className={`flex h-full flex-col overflow-hidden ${compact ? 'gap-2.5' : 'gap-3'}`}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-800/60 pb-2">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-cyan-300">
              <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
              L1 to Earth Timing
            </div>
          </div>
          <Badge value={estimate.confidence} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Metric
            label="Travel time"
            value={formatNumber(estimate.travelTimeSeconds, 0)}
            unit="s"
            badge={estimate.isAvailable ? 'DERIVED' : 'UNAVAILABLE'}
          />
          <Metric
            label="Minutes"
            value={formatNumber(estimate.travelTimeMinutes, 1)}
            unit="min"
            badge={estimate.isAvailable ? 'DERIVED' : 'UNAVAILABLE'}
          />
          <Metric
            label="Hours"
            value={formatNumber(estimate.travelTimeHours, 2)}
            unit="h"
            badge={estimate.isAvailable ? 'DERIVED' : 'UNAVAILABLE'}
          />
          <Metric
            label="Speed"
            value={formatNumber(estimate.speedKmS, 1)}
            unit="km/s"
            badge={estimate.speedKmS === null ? 'UNAVAILABLE' : 'MEASURED'}
          />
        </div>

        <div className={`rounded border border-cyan-500/20 bg-cyan-500/10 ${compact ? 'p-2.5' : 'p-3'}`}>
          <div className="mb-1 flex items-center gap-2 text-[9px] uppercase tracking-widest text-cyan-300/80">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Estimated Arrival UTC
          </div>
          <div className={`font-mono text-sm ${estimate.estimatedArrivalUtc ? 'text-slate-100' : 'text-slate-600'}`}>
            {estimate.estimatedArrivalUtc ?? 'Not available'}
          </div>
          <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-2 rounded border border-slate-800 bg-slate-950/45 p-2">
            <div className="min-w-0">
              <div className="truncate text-[8px] uppercase tracking-widest text-slate-500">
                Distance source
              </div>
              <div className="mt-1 truncate text-[10px] font-mono text-slate-300" title={estimate.distanceSourceLabel}>
                {estimate.distanceSourceLabel}
              </div>
              <div className="mt-1 text-[9px] text-slate-600">
                {estimate.distanceKm === null ? 'Not available' : `${formatNumber(estimate.distanceKm, 0)} km`}
              </div>
            </div>
            <Badge value={distanceBadge} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
            <section className={`rounded border border-slate-800/80 bg-slate-950/35 ${compact ? 'p-2.5' : 'p-3'}`}>
              <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Assumptions</h4>
              <ul className="space-y-1">
                {estimate.assumptions.map((item, index) => (
                  <li key={`assumption-${index}`} className="text-[10px] leading-relaxed text-slate-300">
                    <span className="mr-2 text-slate-600">-</span>{item}
                  </li>
                ))}
              </ul>
            </section>

            <section className={`rounded border border-slate-800/80 bg-slate-950/35 ${compact ? 'p-2.5' : 'p-3'}`}>
              <h4 className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                Limitations
              </h4>
              <ul className="space-y-1">
                {estimate.limitations.map((item, index) => (
                  <li key={`limitation-${index}`} className="text-[10px] leading-relaxed text-slate-300">
                    <span className="mr-2 text-slate-600">-</span>{item}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </GlassCard>
  );
};
