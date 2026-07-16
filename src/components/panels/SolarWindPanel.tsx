import React from 'react';
import { Radio, Satellite } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';
import { DataField } from '../ui/DataField';
import { SolarWindChartsPanel } from './SolarWindChartsPanel';
import type { NoaaServiceResponse, NoaaEphemerisData, NoaaMagnetometerData, NoaaPlasmaData } from '@/services/noaaSolarWindService';

interface SolarWindPanelProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  noaaEphemerisData: NoaaServiceResponse<NoaaEphemerisData>;
}

const MiniValue: React.FC<{ label: string; value?: string | null; unit?: string }> = ({ label, value, unit }) => (
  <div>
    <div className="text-[8px] uppercase tracking-widest text-slate-500">{label}</div>
    <div className={`mt-0.5 text-[10px] font-mono ${value ? 'text-slate-200' : 'text-slate-600'}`}>
      {value ? `${value}${unit ? ` ${unit}` : ''}` : 'Not available'}
    </div>
  </div>
);

const formatKm = (value?: string | null) => {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

export const SolarWindPanel: React.FC<SolarWindPanelProps> = ({ noaaMagData, noaaPlasmaData, noaaEphemerisData }) => {
  const { latestData: magData, errorMessage: magError } = noaaMagData;
  const { latestData: plasmaData, errorMessage: plasmaError } = noaaPlasmaData;
  const { latestData: ephemerisData, errorMessage: ephemerisError } = noaaEphemerisData;

  return (
    <GlassCard title="L1 Solar Wind Measurements" className="h-full">
      <div className="flex flex-col gap-6 h-full overflow-y-auto pr-2">

        {/* Source spacecraft */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-cyan-500/70 mb-3 border-b border-slate-700/50 pb-1">
            Source Spacecraft
          </h3>

          <div className="space-y-2">
            <div className="rounded border border-cyan-500/20 bg-cyan-500/10 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Satellite className="h-4 w-4 flex-shrink-0 text-cyan-300" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-mono font-semibold text-slate-100">
                      Active RTSW spacecraft
                    </div>
                    <div className="text-[9px] font-mono text-slate-500">
                      NOAA multi-spacecraft feed · active record selected by SWPC
                    </div>
                  </div>
                </div>
                <span className="rounded border border-emerald-800/50 bg-emerald-900/30 px-2 py-0.5 text-[8px] font-mono uppercase tracking-widest text-emerald-300">
                  Live
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <MiniValue label="Speed" value={plasmaData?.speed} unit="km/s" />
                <MiniValue label="Density" value={plasmaData?.density} unit="cm⁻³" />
                <MiniValue label="Bt" value={magData?.bt} unit="nT" />
                <MiniValue label="Bz GSM" value={magData?.bz_gsm} unit="nT" />
              </div>

              <div className="mt-3 rounded border border-slate-700/50 bg-slate-950/30 p-2">
                <div className="text-[8px] uppercase tracking-widest text-slate-500">Location · GSE coordinates</div>
                {ephemerisError ? (
                  <div className="mt-1 text-[10px] font-mono text-red-400">{ephemerisError}</div>
                ) : (
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    <MiniValue label="X" value={formatKm(ephemerisData?.x_gse)} unit="km" />
                    <MiniValue label="Y" value={formatKm(ephemerisData?.y_gse)} unit="km" />
                    <MiniValue label="Z" value={formatKm(ephemerisData?.z_gse)} unit="km" />
                  </div>
                )}
                <div className="mt-2 text-[9px] font-mono text-slate-600">
                  {ephemerisData?.time_tag ?? 'Ephemeris timestamp not available'}
                </div>
              </div>
            </div>

            <div className="rounded border border-slate-700/50 bg-slate-800/30 p-3">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 flex-shrink-0 text-slate-500" aria-hidden="true" />
                <div>
                  <div className="text-[11px] font-mono font-semibold text-slate-300">Official same-minute fallback</div>
                  <div className="text-[9px] font-mono text-slate-600">
                    If an active record has a null variable, another official RTSW spacecraft record from that minute may fill only that missing field.
                  </div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <MiniValue label="Reading" value="Active feed only" />
                <MiniValue label="Location" value="Sun-Earth L1 region" />
              </div>
            </div>
          </div>
        </div>
        
        {/* Plasma Section */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-cyan-500/70 mb-3 border-b border-slate-700/50 pb-1">Plasma</h3>
          
          {plasmaError && (
            <div className="text-sm font-mono text-red-400 mb-4 bg-red-900/20 px-3 py-2 rounded border border-red-900/50">
              {plasmaError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <DataField label="Timestamp" value={plasmaData?.time_tag} />
            </div>
            <DataField label="Proton Density" value={plasmaData?.density} unit="cm⁻³" />
            <DataField label="Solar Wind Speed" value={plasmaData?.speed} unit="km/s" />
            <DataField label="Proton Temperature" value={plasmaData?.temperature} unit="K" />
          </div>
        </div>

        {/* Magnetometer Section */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-cyan-500/70 mb-3 border-b border-slate-700/50 pb-1">Magnetometer</h3>
          
          {magError && (
            <div className="text-sm font-mono text-red-400 mb-4 bg-red-900/20 px-3 py-2 rounded border border-red-900/50">
              {magError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <DataField label="Timestamp" value={magData?.time_tag} />
            </div>
            <DataField label="Bt" value={magData?.bt} unit="nT" />
            <DataField label="Bx GSM" value={magData?.bx_gsm} unit="nT" />
            <DataField label="By GSM" value={magData?.by_gsm} unit="nT" />
            <DataField label="Bz GSM" value={magData?.bz_gsm} unit="nT" />
            <DataField label="Longitude GSM" value={magData?.lon_gsm} unit="deg" />
            <DataField label="Latitude GSM" value={magData?.lat_gsm} unit="deg" />
          </div>
        </div>

        <SolarWindChartsPanel noaaMagData={noaaMagData} noaaPlasmaData={noaaPlasmaData} />

      </div>
    </GlassCard>
  );
};
