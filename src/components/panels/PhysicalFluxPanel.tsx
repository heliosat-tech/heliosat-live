import React from 'react';
import { Activity, AlertTriangle, RadioTower } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';
import { derivePhysicalFluxState } from '@/services/satelliteExposureService';
import type { NoaaMagnetometerData, NoaaPlasmaData, NoaaServiceResponse } from '@/services/noaaSolarWindService';
import type { MissionBadge, PhysicalQuantity, SpaceWeatherFlag } from '@/types/spaceWeather';

interface PhysicalFluxPanelProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
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

const QuantityCard: React.FC<{ quantity: PhysicalQuantity; compact?: boolean }> = ({ quantity, compact = false }) => (
  <div className={`rounded border border-slate-800/80 bg-slate-950/45 ${compact ? 'p-2' : 'p-2.5'}`}>
    <div className={`${compact ? 'mb-1' : 'mb-2'} flex items-start justify-between gap-2`}>
      <span className="min-w-0 truncate text-[9px] uppercase tracking-widest text-slate-500" title={quantity.label}>
        {quantity.label}
      </span>
      <Badge value={quantity.badge} />
    </div>
    <div className={`font-mono text-sm ${quantity.value === null ? 'text-slate-600' : 'text-slate-100'}`}>
      {quantity.formattedValue}
      {quantity.value !== null && quantity.unit && <span className="ml-1 text-[10px] text-slate-500">{quantity.unit}</span>}
    </div>
    <div className={`${compact ? 'mt-1 line-clamp-1 leading-snug' : 'mt-2 line-clamp-2 leading-relaxed'} text-[9px] text-slate-600`} title={quantity.details}>
      {quantity.details}
    </div>
  </div>
);

const FlagRow: React.FC<{ flag: SpaceWeatherFlag }> = ({ flag }) => {
  const status = flag.isActive === null ? 'Not available' : flag.isActive ? 'Active' : 'Inactive';
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-800/60 py-1.5 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate text-[10px] uppercase tracking-wider text-slate-300" title={flag.label}>
          {flag.label}
        </div>
        <div className="truncate text-[9px] text-slate-600" title={flag.details}>{flag.details}</div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <span className={`font-mono text-[10px] ${flag.isActive ? 'text-amber-300' : flag.isActive === false ? 'text-slate-500' : 'text-slate-600'}`}>
          {status}
        </span>
        <Badge value={flag.badge} />
      </div>
    </div>
  );
};

export const PhysicalFluxPanel: React.FC<PhysicalFluxPanelProps> = ({ noaaMagData, noaaPlasmaData, compact = false }) => {
  const state = derivePhysicalFluxState(noaaMagData, noaaPlasmaData);
  const connectedQuantityCount = state.quantities.filter(quantity => quantity.value !== null).length;
  const availabilityBadge: MissionBadge = connectedQuantityCount === state.quantities.length
    ? 'AVAILABLE'
    : connectedQuantityCount > 0
      ? 'PARTIAL'
      : 'UNAVAILABLE';

  return (
    <GlassCard
      title="Physical Flux / Drivers"
      className="h-full"
      bodyClassName={compact ? 'p-3' : 'p-4'}
      headerClassName={compact ? 'px-3 py-2' : undefined}
    >
      <div className={`flex h-full flex-col overflow-hidden ${compact ? 'gap-2.5' : 'gap-3'}`}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-800/60 pb-2">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-cyan-300">
              <Activity className="h-3.5 w-3.5" aria-hidden="true" />
              NOAA RTSW Physical Inputs
            </div>
            <div className={`${compact ? 'hidden 2xl:block' : 'block'} mt-1 text-[9px] text-slate-600`}>
              Measured values stay null when source fields are absent.
            </div>
          </div>
          <Badge value={availabilityBadge} />
        </div>

        <div className={`grid min-h-0 gap-2 overflow-y-auto pr-1 ${compact ? 'grid-cols-1 2xl:grid-cols-2' : 'grid-cols-2'}`}>
          {state.quantities.map(quantity => (
            <QuantityCard key={quantity.id} quantity={quantity} compact={compact} />
          ))}
        </div>

        <div className={`rounded border border-slate-800/80 bg-slate-950/35 ${compact ? 'p-2' : 'p-2.5'}`}>
          <div className="mb-1.5 flex items-center gap-2 text-[9px] uppercase tracking-widest text-slate-500">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Physical Flags
          </div>
          {state.flags.map(flag => (
            <FlagRow key={flag.id} flag={flag} />
          ))}
        </div>

        <div className={`rounded border border-slate-800/80 bg-slate-950/35 ${compact ? 'p-2' : 'p-2.5'}`}>
          <div className="mb-2 flex items-center gap-2 text-[9px] uppercase tracking-widest text-slate-500">
            <RadioTower className="h-3.5 w-3.5" aria-hidden="true" />
            Energetic Particle Flux
          </div>
          <div className="grid grid-cols-2 gap-2">
            {state.radiation.map(channel => (
              <div key={channel.channel} className="rounded border border-slate-800 bg-slate-900/35 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[9px] uppercase tracking-wider text-slate-400" title={channel.label}>
                    {channel.label}
                  </span>
                  <Badge value={channel.badge} />
                </div>
                <div className="mt-1 text-[10px] font-mono text-slate-600">Not connected</div>
                <div className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-slate-600" title={channel.details}>
                  {channel.details}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[9px] font-mono text-slate-600">
            Radiation dose is not estimated.
          </div>
        </div>
      </div>
    </GlassCard>
  );
};
