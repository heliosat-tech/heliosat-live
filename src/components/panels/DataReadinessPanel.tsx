"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { GlassCard } from '../ui/GlassCard';
import type { NoaaServiceResponse, NoaaMagnetometerData, NoaaPlasmaData } from '@/services/noaaSolarWindService';
import type { NoaaAlertsResponse } from '@/services/noaaAlertsService';
import type { CelesTrakResponse } from '@/services/celestrakService';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import { propagateSatelliteFromTle, PropagatedSatelliteData } from '@/services/satellitePropagationService';
import { checkDataReadiness } from '@/services/dataAvailability';

interface DataReadinessPanelProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  noaaAlertsData: NoaaAlertsResponse;
  celestrakData: CelesTrakResponse;
}

const ReadinessRow: React.FC<{ label: string; isAvailable: boolean }> = ({ label, isAvailable }) => (
  <div className="flex justify-between items-center py-1.5 border-b border-slate-800/50">
    <span className="text-[10px] text-slate-300 uppercase tracking-wider">{label}</span>
    <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${isAvailable ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800/50' : 'bg-slate-800/50 text-slate-500 border border-slate-700/50'}`}>
      {isAvailable ? 'Available' : 'Not available'}
    </span>
  </div>
);

export const DataReadinessPanel: React.FC<DataReadinessPanelProps> = ({
  noaaMagData,
  noaaPlasmaData,
  noaaAlertsData,
  celestrakData,
}) => {
  const { selectedTle } = useSatelliteSelection();
  // Stable initial value so SSR and the first client render match (avoids a
  // hydration mismatch); the real clock is set right after mount.
  const [readinessTime, setReadinessTime] = useState(0);

  useEffect(() => {
    const initial = window.setTimeout(() => setReadinessTime(Date.now()), 0);
    const interval = setInterval(() => setReadinessTime(Date.now()), 2000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  const propagatedData: PropagatedSatelliteData | null = useMemo(() => {
    if (!selectedTle) return null;
    return propagateSatelliteFromTle(selectedTle, new Date(readinessTime));
  }, [selectedTle, readinessTime]);

  const readiness = checkDataReadiness(noaaMagData, noaaPlasmaData, noaaAlertsData, celestrakData, propagatedData);

  return (
    <GlassCard title="Data Readiness" className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto pr-2 mb-4">
        <ReadinessRow label="Magnetic field Bt" isAvailable={readiness.magBt} />
        <ReadinessRow label="Magnetic field Bx" isAvailable={readiness.magBx} />
        <ReadinessRow label="Magnetic field By" isAvailable={readiness.magBy} />
        <ReadinessRow label="Magnetic field Bz" isAvailable={readiness.magBz} />
        <ReadinessRow label="Solar wind speed" isAvailable={readiness.windSpeed} />
        <ReadinessRow label="Proton density" isAvailable={readiness.protonDensity} />
        <ReadinessRow label="Proton temperature" isAvailable={readiness.protonTemp} />
        <ReadinessRow label="NOAA alerts" isAvailable={readiness.noaaAlerts} />
        <ReadinessRow label="Satellite TLE" isAvailable={readiness.satelliteTle} />
        <ReadinessRow label="Satellite location" isAvailable={readiness.satellitePosition} />
        <ReadinessRow label="Satellite velocity" isAvailable={readiness.satelliteVelocity} />
        <ReadinessRow label="Satellite inclination" isAvailable={readiness.satelliteInclination} />
      </div>

      <div className="mt-auto pt-3 border-t border-slate-700/50">
        {readiness.allAvailable ? (
          <p className="text-[10px] text-emerald-400/90 font-mono leading-relaxed bg-emerald-900/10 p-2 rounded border border-emerald-900/30">
            Required real inputs are available.
          </p>
        ) : (
          <p className="text-[10px] text-amber-500/80 font-mono leading-relaxed bg-amber-900/10 p-2 rounded border border-amber-900/30">
            Some required real inputs are not available.
          </p>
        )}
      </div>
    </GlassCard>
  );
};
