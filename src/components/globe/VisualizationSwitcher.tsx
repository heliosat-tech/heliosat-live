"use client";
import React, { useState, useEffect, useMemo } from 'react';
import { Globe2, Orbit, Settings2, Sun, TriangleAlert } from 'lucide-react';
import { GlobeView } from './GlobeView';
import { SunEarthView } from './SunEarthView';
import { SatelliteConfigModal } from './SatelliteConfigModal';
import { propagateSatelliteFromTle } from '@/services/satellitePropagationService';
import type { NoaaServiceResponse, NoaaEphemerisData, NoaaMagnetometerData, NoaaPlasmaData } from '@/services/noaaSolarWindService';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import { getSatelliteKey, useSatelliteConfig } from '@/contexts/SatelliteConfigContext';

type ViewMode = 'earth' | 'sunearth';

const EARTH_RADIUS_KM = 6371;
const PROPAGATION_INTERVAL_MS = 30_000;
const ORBIT_STEPS = 90;
const ORBIT_STEP_MS = 90_000;

interface Props {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  noaaEphemerisData: NoaaServiceResponse<NoaaEphemerisData>;
  className?: string;
}

const GlobeFailureNotice: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_center,rgba(14,116,144,0.12),rgba(2,6,23,0.96)_58%)] p-6">
    <div className="max-w-md rounded border border-amber-500/25 bg-slate-950/70 p-5 text-center shadow-2xl shadow-black/30">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded border border-amber-500/35 bg-amber-500/10 text-amber-300">
        <TriangleAlert className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-amber-300">
        Earth Orbit View Unavailable
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">
        {message}
      </p>
      <div className="mt-4 text-[10px] font-mono uppercase tracking-widest text-slate-600">
        Switch to Sun-Earth for the connected NOAA view.
      </div>
    </div>
  </div>
);

class GlobeRenderBoundary extends React.Component<
  { children: React.ReactNode },
  { message: string | null }
> {
  state = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      message: error instanceof Error ? error.message : 'The 3D globe renderer failed.',
    };
  }

  componentDidCatch(error: Error) {
    console.error('Earth orbit view failed', error);
  }

  render() {
    if (this.state.message) {
      return <GlobeFailureNotice message={this.state.message} />;
    }

    return this.props.children;
  }
}

export const VisualizationSwitcher: React.FC<Props> = ({ noaaMagData, noaaPlasmaData, noaaEphemerisData, className = '' }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('earth');
  // Stable initial value so SSR and the first client render match (avoids a
  // hydration mismatch); the real clock is set right after mount.
  const [propagationTime, setPropagationTime] = useState(0);

  const { selectedTle } = useSatelliteSelection();
  const {
    trackedTles,
    tleData,
    orbitPropagationEnabled,
    setOrbitPropagationEnabled,
    openModal,
  } = useSatelliteConfig();

  const selectedTrackedTle = selectedTle && trackedTles.some(tle => getSatelliteKey(tle) === getSatelliteKey(selectedTle))
    ? selectedTle
    : null;

  const mapStatus = trackedTles.length === 0
    ? 'No satellites selected on map'
    : `Showing ${trackedTles.length} selected satellite${trackedTles.length === 1 ? '' : 's'} on map${
      orbitPropagationEnabled && selectedTrackedTle ? ' · orbit path propagated' : ''
    }`;

  const catalogStatus = tleData.isConnected
    ? `${tleData.tles.length} catalog objects available`
    : tleData.errorMessage ?? 'CelesTrak unavailable';

  useEffect(() => {
    const initial = window.setTimeout(() => setPropagationTime(Date.now()), 0);
    const id = setInterval(() => setPropagationTime(Date.now()), PROPAGATION_INTERVAL_MS);
    return () => {
      window.clearTimeout(initial);
      clearInterval(id);
    };
  }, []);

  const propagated = useMemo(() => {
    const now = new Date(propagationTime);
    return trackedTles.map(tle => propagateSatelliteFromTle(tle, now));
  }, [trackedTles, propagationTime]);

  const orbitPathPoints = useMemo(() => {
    if (!orbitPropagationEnabled || !selectedTrackedTle) return [];
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= ORBIT_STEPS; i++) {
      const d = propagateSatelliteFromTle(selectedTrackedTle, new Date(propagationTime + i * ORBIT_STEP_MS));
      if (d.positionAvailable && d.latitude != null && d.longitude != null && d.altitudeKm != null) {
        pts.push([d.latitude, d.longitude, Math.max(0.02, d.altitudeKm / EARTH_RADIUS_KM)]);
      }
    }
    return pts.length > 1 ? pts : [];
  }, [orbitPropagationEnabled, selectedTrackedTle, propagationTime]);

  return (
    <>
      {/* Modal (renders at fixed overlay level) */}
      <SatelliteConfigModal />

      <div className={`flex h-full min-h-0 min-w-0 flex-col gap-2 ${className}`}>
        {/* Slim toolbar: view mode + satellite config button */}
        <div className="flex min-w-0 shrink-0 items-center gap-2 overflow-x-auto">

          {/* View mode toggle */}
          <div className="flex bg-slate-800/50 border border-slate-700/50 rounded-md overflow-hidden">
            {(['earth', 'sunearth'] as ViewMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest transition-colors border-r border-slate-700/50 last:border-r-0 ${
                  viewMode === mode
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {mode === 'earth' ? (
                  <>
                    <Globe2 className="w-3 h-3" aria-hidden="true" />
                    Earth Orbit
                  </>
                ) : (
                  <>
                    <Sun className="w-3 h-3" aria-hidden="true" />
                    Sun-Earth
                  </>
                )}
              </button>
            ))}
          </div>

          {/* Satellite config button — only in Earth mode */}
          {viewMode === 'earth' && (
            <button
              onClick={openModal}
              className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-md text-[10px] font-mono text-slate-400 hover:text-slate-200 hover:border-slate-600/70 transition-colors"
              title={catalogStatus}
            >
              <Settings2 className="w-3 h-3" aria-hidden="true" />
              Configure Satellites
            </button>
          )}

          {viewMode === 'earth' && (
            <button
              onClick={() => setOrbitPropagationEnabled(!orbitPropagationEnabled)}
              disabled={!selectedTrackedTle}
              title={selectedTrackedTle ? 'Toggle propagated orbit path' : 'Select an active tracked satellite to propagate its orbit'}
              className={`flex items-center gap-2 px-3 py-1.5 border rounded-md text-[10px] font-mono transition-colors ${
                orbitPropagationEnabled
                  ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-300'
                  : 'bg-slate-800/50 border-slate-700/50 text-slate-500 hover:text-slate-300'
              } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-500`}
            >
              <Orbit className="w-3 h-3" aria-hidden="true" />
              Orbit Path
            </button>
          )}

          {/* Satellite count badge */}
          {viewMode === 'earth' && (
            <span className="text-[10px] font-mono text-slate-600 ml-auto">
              {mapStatus}
            </span>
          )}
        </div>

        {/* Main visualization */}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-slate-700/50 bg-[#020617]">
          {viewMode === 'earth' ? (
            <GlobeRenderBoundary>
              <GlobeView
                tles={trackedTles}
                propagatedSatellites={propagated}
                orbitPathPoints={orbitPathPoints}
                showCount={mapStatus}
              />
            </GlobeRenderBoundary>
          ) : (
            <SunEarthView
              noaaMagData={noaaMagData}
              noaaPlasmaData={noaaPlasmaData}
              noaaEphemerisData={noaaEphemerisData}
            />
          )}
        </div>
      </div>
    </>
  );
};
