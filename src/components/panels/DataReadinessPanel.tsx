"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { GlassCard } from '../ui/GlassCard';
import type { NoaaServiceResponse, NoaaMagnetometerData, NoaaPlasmaData } from '@/services/noaaSolarWindService';
import type { NoaaAlertsResponse } from '@/services/noaaAlertsService';
import { useSatelliteConfig } from '@/contexts/SatelliteConfigContext';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import { propagateSatelliteFromTle, PropagatedSatelliteData } from '@/services/satellitePropagationService';
import { checkDataReadiness } from '@/services/dataAvailability';

interface DataReadinessPanelProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  noaaAlertsData: NoaaAlertsResponse;
}

type ReadinessStatus = 'available' | 'cached' | 'checking' | 'unavailable';

const ReadinessRow: React.FC<{ label: string; status: ReadinessStatus }> = ({ label, status }) => (
  <div className="flex justify-between items-center py-1.5 border-b border-slate-800/50">
    <span className="text-[10px] text-slate-300 uppercase tracking-wider">{label}</span>
    <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${
      status === 'available'
        ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800/50'
        : status === 'checking' || status === 'cached'
          ? 'border border-amber-800/50 bg-amber-900/20 text-amber-300'
          : 'bg-slate-800/50 text-slate-500 border border-slate-700/50'
    }`}>
      {status === 'available'
        ? 'Available'
        : status === 'checking'
          ? 'Checking'
          : status === 'cached'
            ? 'Cached'
            : 'Not available'}
    </span>
  </div>
);

const readinessStatus = (available: boolean): ReadinessStatus => available ? 'available' : 'unavailable';

export const DataReadinessPanel: React.FC<DataReadinessPanelProps> = ({
  noaaMagData,
  noaaPlasmaData,
  noaaAlertsData,
}) => {
  const { selectedTle } = useSatelliteSelection();
  const { tleData, tleLoading } = useSatelliteConfig();
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

  const readiness = checkDataReadiness(noaaMagData, noaaPlasmaData, noaaAlertsData, tleData, propagatedData);

  return (
    <GlassCard title="Data Readiness" className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto pr-2 mb-4">
        <ReadinessRow label="Magnetic field Bt" status={readinessStatus(readiness.magBt)} />
        <ReadinessRow label="Magnetic field Bx" status={readinessStatus(readiness.magBx)} />
        <ReadinessRow label="Magnetic field By" status={readinessStatus(readiness.magBy)} />
        <ReadinessRow label="Magnetic field Bz" status={readinessStatus(readiness.magBz)} />
        <ReadinessRow label="Solar wind speed" status={readinessStatus(readiness.windSpeed)} />
        <ReadinessRow label="Proton density" status={readinessStatus(readiness.protonDensity)} />
        <ReadinessRow label="Proton temperature" status={readinessStatus(readiness.protonTemp)} />
        <ReadinessRow label="NOAA alerts" status={readinessStatus(readiness.noaaAlerts)} />
        <ReadinessRow
          label="Satellite TLE"
          status={tleLoading
            ? 'checking'
            : tleData.stale && readiness.satelliteTle
              ? 'cached'
              : readinessStatus(readiness.satelliteTle)}
        />
        <ReadinessRow label="Satellite location" status={readinessStatus(readiness.satellitePosition)} />
        <ReadinessRow label="Satellite velocity" status={readinessStatus(readiness.satelliteVelocity)} />
        <ReadinessRow label="Satellite inclination" status={readinessStatus(readiness.satelliteInclination)} />
      </div>

      <div className="mt-auto pt-3 border-t border-slate-700/50">
        {tleLoading ? (
          <p className="text-[10px] text-amber-300/90 font-mono leading-relaxed bg-amber-900/10 p-2 rounded border border-amber-900/30">
            Checking the current CelesTrak catalog.
          </p>
        ) : tleData.stale && readiness.satelliteTle ? (
          <p className="text-[10px] text-amber-300/90 font-mono leading-relaxed bg-amber-900/10 p-2 rounded border border-amber-900/30">
            The TLE catalog is available from the last-good cache.
          </p>
        ) : readiness.allAvailable ? (
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
