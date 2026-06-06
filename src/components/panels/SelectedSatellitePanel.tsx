"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { CircleOff, MapPinned, Settings2 } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';
import { propagateSatelliteFromTle, PropagatedSatelliteData } from '@/services/satellitePropagationService';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import { useSatelliteConfig } from '@/contexts/SatelliteConfigContext';

const Field: React.FC<{ label: string; value?: string | number | null; unit?: string }> = ({ label, value, unit }) => {
  const has = value != null && value !== '';
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className={`text-sm font-mono ${has ? 'text-slate-100' : 'text-slate-600'}`}>
        {has ? `${value}${unit ? ' ' + unit : ''}` : 'Not available'}
      </span>
    </div>
  );
};

const formatCoordinate = (value: number | null | undefined, positive: string, negative: string) => {
  if (value == null) return null;
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
};

const LocationBlock: React.FC<{ data: PropagatedSatelliteData | null }> = ({ data }) => {
  const latitude = data?.positionAvailable ? formatCoordinate(data.latitude, 'N', 'S') : null;
  const longitude = data?.positionAvailable ? formatCoordinate(data.longitude, 'E', 'W') : null;
  const hemisphere = data?.positionAvailable && data.latitude != null && data.longitude != null
    ? `${data.latitude >= 0 ? 'Northern' : 'Southern'} / ${data.longitude >= 0 ? 'Eastern' : 'Western'} hemisphere`
    : 'Location not available';

  return (
    <div className="rounded border border-cyan-500/20 bg-cyan-500/10 p-3">
      <div className="flex items-center gap-2 text-[9px] uppercase tracking-widest text-cyan-300/80">
        <MapPinned className="h-3.5 w-3.5" aria-hidden="true" />
        Ground Location
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded border border-slate-700/50 bg-slate-950/30 px-2.5 py-2">
          <div className="text-[8px] uppercase tracking-widest text-slate-500">Latitude</div>
          <div className={`mt-1 text-sm font-mono ${latitude ? 'text-slate-100' : 'text-slate-600'}`}>
            {latitude ?? 'Not available'}
          </div>
        </div>
        <div className="rounded border border-slate-700/50 bg-slate-950/30 px-2.5 py-2">
          <div className="text-[8px] uppercase tracking-widest text-slate-500">Longitude</div>
          <div className={`mt-1 text-sm font-mono ${longitude ? 'text-slate-100' : 'text-slate-600'}`}>
            {longitude ?? 'Not available'}
          </div>
        </div>
      </div>
      <div className="mt-2 text-[9px] font-mono text-slate-500">{hemisphere}</div>
    </div>
  );
};

export const SelectedSatellitePanel: React.FC = () => {
  const { selectedTle, setSelectedTle } = useSatelliteSelection();
  const { openModal } = useSatelliteConfig();
  // Stable initial value so SSR and the first client render match (avoids a
  // hydration mismatch); the real clock is set right after mount.
  const [telemetryTime, setTelemetryTime] = useState(0);

  // Live-update propagated telemetry every second
  useEffect(() => {
    const initial = window.setTimeout(() => setTelemetryTime(Date.now()), 0);
    const id = setInterval(() => setTelemetryTime(Date.now()), 1000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(id);
    };
  }, []);

  const prop: PropagatedSatelliteData | null = useMemo(() => {
    if (!selectedTle) return null;
    return propagateSatelliteFromTle(selectedTle, new Date(telemetryTime));
  }, [selectedTle, telemetryTime]);

  return (
    <GlassCard title="Selected Satellite" className="h-full flex flex-col">
      <div className="flex flex-col gap-4 flex-1 overflow-hidden">

        {/* Header: name + configure button */}
        <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-700/50">
          <div className="flex-1 min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">Designator</div>
            <div className={`text-sm font-mono font-medium truncate ${selectedTle ? 'text-slate-100' : 'text-slate-600'}`}>
              {selectedTle?.name ?? 'None selected'}
            </div>
          </div>
          <button
            onClick={openModal}
            title="Configure satellite map"
            className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800/60 border border-slate-700/50 rounded text-[9px] font-mono text-slate-400 hover:text-cyan-300 hover:border-cyan-700/50 transition-colors"
          >
            <Settings2 className="w-3 h-3" aria-hidden="true" />
            Configure
          </button>
        </div>

        {/* Propagated telemetry */}
        {selectedTle ? (
          <div className="flex flex-col gap-4 flex-1 overflow-y-auto">
            <LocationBlock data={prop} />

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Velocity"
                value={prop?.velocityAvailable && prop.velocityKmS != null ? prop.velocityKmS.toFixed(3) : null}
                unit="km/s"
              />
              <Field
                label="Inclination"
                value={prop?.inclinationAvailable && prop.inclinationDeg != null ? prop.inclinationDeg.toFixed(2) : null}
                unit="°"
              />
              <Field label="Source" value={selectedTle.source} />
            </div>

            {/* Position method notice */}
            <div className="text-[9px] font-mono text-slate-600 leading-relaxed border-t border-slate-800/50 pt-3">
              <span className="text-slate-500">Method:</span> Current propagated position from latest
              CelesTrak TLE using SGP4
            </div>

            {prop && (
              <div className="text-[9px] font-mono text-slate-600">
                Propagated: {new Date(prop.timestamp).toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' })} UTC
              </div>
            )}

            {/* Clear button */}
            <button
              onClick={() => setSelectedTle(null)}
              className="mt-auto text-[9px] font-mono text-slate-600 hover:text-red-400 transition-colors text-left"
            >
              Clear active
            </button>
          </div>
        ) : (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center py-4">
            <div className="w-12 h-12 rounded-full border border-slate-700/50 flex items-center justify-center">
              <CircleOff className="w-5 h-5 text-slate-600" aria-hidden="true" />
            </div>
            <div>
              <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">
                No active satellite
              </div>
            </div>
            <button
              onClick={openModal}
              className="px-4 py-2 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[10px] font-mono rounded hover:bg-cyan-500/20 transition-colors"
            >
              Satellite Settings
            </button>
          </div>
        )}

      </div>
    </GlassCard>
  );
};
