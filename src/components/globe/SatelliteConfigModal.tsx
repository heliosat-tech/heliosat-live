"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, MapPin, Orbit, Search, Satellite, Trash2, X } from 'lucide-react';
import { getSatelliteKey, useSatelliteConfig, TleGroup } from '@/contexts/SatelliteConfigContext';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import { propagateSatelliteFromTle } from '@/services/satellitePropagationService';
import type { PropagatedSatelliteData } from '@/services/satellitePropagationService';
import type { SatelliteTLE } from '@/services/celestrakService';

const GROUP_LABELS: Record<TleGroup, string> = {
  stations: 'Space Stations',
  weather: 'Weather Satellites',
  starlink: 'Starlink',
  active: 'All Active Satellites',
};

const formatCoord = (value: number | null | undefined, positive: string, negative: string) => {
  if (value == null) return 'Not available';
  return `${Math.abs(value).toFixed(2)}° ${value >= 0 ? positive : negative}`;
};

const formatLocation = (data: PropagatedSatelliteData | null) => {
  if (!data?.positionAvailable) return 'Location not available';
  return `${formatCoord(data.latitude, 'N', 'S')} / ${formatCoord(data.longitude, 'E', 'W')}`;
};

export const SatelliteConfigModal: React.FC = () => {
  const {
    group, setGroup,
    search, setSearch,
    orbitPropagationEnabled, setOrbitPropagationEnabled,
    tleData, filteredTles, tleLoading,
    trackedTles, trackedKeys, toggleTrackedTle, removeTrackedTle, clearTrackedTles,
    isModalOpen, closeModal,
  } = useSatelliteConfig();

  const { selectedTle, setSelectedTle } = useSatelliteSelection();
  // Stable initial value so SSR and the first client render match (avoids a
  // hydration mismatch); the real clock is set right after mount.
  const [propagationTime, setPropagationTime] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeKey = selectedTle ? getSatelliteKey(selectedTle) : null;

  useEffect(() => {
    if (isModalOpen) setTimeout(() => searchRef.current?.focus(), 50);
  }, [isModalOpen]);

  useEffect(() => {
    if (!isModalOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isModalOpen, closeModal]);

  useEffect(() => {
    if (!isModalOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isModalOpen]);

  useEffect(() => {
    const initial = window.setTimeout(() => setPropagationTime(Date.now()), 0);
    return () => window.clearTimeout(initial);
  }, []);

  useEffect(() => {
    if (!isModalOpen) return;
    const interval = setInterval(() => setPropagationTime(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [isModalOpen]);

  const trackedTelemetry = useMemo(() => {
    const now = new Date(propagationTime);
    return new Map(trackedTles.map(tle => [getSatelliteKey(tle), propagateSatelliteFromTle(tle, now)]));
  }, [trackedTles, propagationTime]);

  const activeTelemetry = selectedTle ? trackedTelemetry.get(getSatelliteKey(selectedTle)) ?? null : null;

  if (!isModalOpen || typeof document === 'undefined') return null;

  const trackAndActivate = (tle: SatelliteTLE) => {
    if (!trackedKeys.has(getSatelliteKey(tle))) {
      toggleTrackedTle(tle);
    }
    setSelectedTle(tle);
  };

  const removeTracked = (tle: SatelliteTLE) => {
    const removedKey = getSatelliteKey(tle);
    removeTrackedTle(tle);
    if (activeKey === removedKey) {
      setSelectedTle(trackedTles.find(item => getSatelliteKey(item) !== removedKey) ?? null);
    }
  };

  const clearAll = () => {
    clearTrackedTles();
    setSelectedTle(null);
  };

  const modal = (
    <div
      className="flex items-center justify-center bg-slate-950/90 px-4 py-4 backdrop-blur-sm"
      style={{ position: 'fixed', inset: 0, zIndex: 2147483647 }}
      role="dialog"
      aria-modal="true"
      aria-label="Satellite tracker"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeModal();
      }}
    >
      <div
        className="flex overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-slate-200 shadow-2xl"
        style={{
          width: 'min(1080px, calc(100vw - 32px))',
          height: 'min(740px, calc(100vh - 32px))',
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-slate-800 px-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
                <Satellite className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold uppercase tracking-widest text-slate-100">
                  Satellite Tracker
                </h2>
                <p className="truncate text-[10px] font-mono text-slate-500">
                  Track map objects, switch active satellite, and inspect current location
                </p>
              </div>
            </div>
            <button
              onClick={closeModal}
              className="rounded p-1 text-slate-500 transition-colors hover:text-slate-200"
              aria-label="Close"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </header>

          <div
            className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] overflow-hidden"
            style={{ minHeight: 0 }}
          >
            <section className="flex min-w-0 flex-col overflow-hidden border-r border-slate-800" style={{ minHeight: 0 }}>
              <div className="flex h-24 flex-shrink-0 items-end gap-3 border-b border-slate-800 bg-slate-900/50 px-4 pb-4">
                <div className="w-56 flex-shrink-0">
                  <label className="mb-1 block text-[9px] uppercase tracking-widest text-slate-500">
                    Catalog
                  </label>
                  <select
                    value={group}
                    onChange={event => setGroup(event.target.value as TleGroup)}
                    className="h-9 w-full rounded border border-slate-700 bg-slate-950 px-2 text-[11px] font-mono text-slate-200 outline-none focus:border-cyan-500/60"
                  >
                    {(Object.keys(GROUP_LABELS) as TleGroup[]).map(key => (
                      <option key={key} value={key}>{GROUP_LABELS[key]}</option>
                    ))}
                  </select>
                </div>

                <div className="min-w-0 flex-1">
                  <label className="mb-1 block text-[9px] uppercase tracking-widest text-slate-500">
                    Search
                  </label>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600" aria-hidden="true" />
                    <input
                      ref={searchRef}
                      value={search}
                      onChange={event => setSearch(event.target.value)}
                      placeholder="ISS, NOAA, GOES..."
                      className="h-9 w-full rounded border border-slate-700 bg-slate-950 py-1 pl-8 pr-3 text-[11px] font-mono text-slate-200 outline-none placeholder:text-slate-600 focus:border-cyan-500/60"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={orbitPropagationEnabled}
                  onClick={() => setOrbitPropagationEnabled(!orbitPropagationEnabled)}
                  className={`flex h-9 w-40 flex-shrink-0 items-center justify-between rounded border px-3 text-[10px] font-mono transition-colors ${
                    orbitPropagationEnabled
                      ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                      : 'border-slate-700 bg-slate-950 text-slate-500 hover:text-slate-300'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Orbit className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                    <span className="truncate">Orbit path</span>
                  </span>
                  <span className={`h-2.5 w-2.5 rounded-full ${orbitPropagationEnabled ? 'bg-cyan-300' : 'bg-slate-600'}`} />
                </button>
              </div>

              <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-slate-800 px-4">
                {tleLoading ? (
                  <span className="text-[10px] font-mono uppercase tracking-widest text-cyan-400/70">
                    Fetching from CelesTrak...
                  </span>
                ) : tleData.errorMessage ? (
                  <span className="text-[10px] font-mono text-red-400">{tleData.errorMessage}</span>
                ) : (
                  <span className="text-[10px] font-mono text-slate-500">
                    Showing <span className="text-slate-300">{filteredTles.length}</span> of{' '}
                    <span className="text-slate-300">{tleData.tles.length}</span>
                  </span>
                )}
                <span className="text-[10px] font-mono text-cyan-400/80">
                  {trackedTles.length} tracked
                </span>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3" style={{ minHeight: 0, overflowY: 'auto' }}>
                {filteredTles.length === 0 && !tleLoading ? (
                  <div className="flex h-28 items-center justify-center rounded border border-dashed border-slate-800 text-[11px] font-mono uppercase tracking-widest text-slate-600">
                    {tleData.errorMessage ?? 'No satellite data available'}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {filteredTles.map(tle => {
                      const key = getSatelliteKey(tle);
                      const isTracked = trackedKeys.has(key);
                      const isActive = activeKey === key;

                      return (
                        <div
                          key={key}
                          className={`grid h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded border px-3 transition-colors ${
                            isActive
                              ? 'border-cyan-500/50 bg-cyan-950/35'
                              : isTracked
                                ? 'border-cyan-500/25 bg-cyan-950/20'
                                : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => trackAndActivate(tle)}
                            className="min-w-0 text-left"
                            title={tle.name}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-[11px] font-mono font-medium text-slate-100">
                                {tle.name}
                              </span>
                              {isActive && (
                                <span className="flex-shrink-0 rounded bg-cyan-500/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-cyan-300">
                                  Active
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-[9px] text-slate-600">{tle.source}</span>
                          </button>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => trackAndActivate(tle)}
                              className={`flex h-7 items-center gap-1 rounded border px-2 text-[9px] font-mono transition-colors ${
                                isActive
                                  ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                                  : isTracked
                                  ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                                  : 'border-slate-700 text-slate-500 hover:text-slate-200'
                              }`}
                            >
                              {isTracked ? <Check className="h-3 w-3" aria-hidden="true" /> : <Satellite className="h-3 w-3" aria-hidden="true" />}
                              {isActive ? 'Active' : isTracked ? 'Select' : 'Track'}
                            </button>
                            {isTracked && (
                              <button
                                type="button"
                                onClick={() => removeTracked(tle)}
                                className="flex h-7 w-7 items-center justify-center rounded border border-slate-700 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-400"
                                aria-label={`Remove ${tle.name}`}
                              >
                                <X className="h-3 w-3" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <aside className="flex min-w-0 flex-col overflow-hidden bg-slate-950" style={{ minHeight: 0 }}>
              <div className="border-b border-slate-800 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-slate-500">Active satellite</div>
                    <div className="mt-1 max-w-56 truncate text-sm font-mono font-semibold text-slate-100">
                      {selectedTle?.name ?? 'None selected'}
                    </div>
                  </div>
                  {selectedTle && (
                    <button
                      type="button"
                      onClick={() => setSelectedTle(null)}
                      className="rounded border border-slate-700 px-2 py-1 text-[9px] font-mono text-slate-500 transition-colors hover:text-slate-200"
                    >
                      Clear active
                    </button>
                  )}
                </div>

                <div className="mt-4 rounded border border-cyan-500/20 bg-cyan-500/10 p-3">
                  <div className="flex items-center gap-2 text-[9px] uppercase tracking-widest text-cyan-300/80">
                    <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                    Current location
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
                      <div className="text-[8px] uppercase tracking-widest text-slate-500">Latitude</div>
                      <div className="mt-1 text-xs font-mono text-slate-100">
                        {activeTelemetry?.positionAvailable ? formatCoord(activeTelemetry.latitude, 'N', 'S') : 'Not available'}
                      </div>
                    </div>
                    <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
                      <div className="text-[8px] uppercase tracking-widest text-slate-500">Longitude</div>
                      <div className="mt-1 text-xs font-mono text-slate-100">
                        {activeTelemetry?.positionAvailable ? formatCoord(activeTelemetry.longitude, 'E', 'W') : 'Not available'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-slate-800 px-4">
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-slate-500">Satellites on map</div>
                </div>
                {trackedTles.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[9px] font-mono text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                    Clear
                  </button>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3" style={{ minHeight: 0, overflowY: 'auto' }}>
                {trackedTles.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded border border-dashed border-slate-800 px-4 text-center text-[10px] font-mono text-slate-600">
                    Track satellites from the catalog to show them on the map
                  </div>
                ) : (
                  <div className="space-y-2">
                    {trackedTles.map(tle => {
                      const key = getSatelliteKey(tle);
                      const telemetry = trackedTelemetry.get(key) ?? null;
                      const isActive = activeKey === key;
                      return (
                        <div
                          key={key}
                          className={`rounded border p-2 transition-colors ${
                            isActive
                              ? 'border-cyan-500/50 bg-cyan-950/35'
                              : 'border-slate-800 bg-slate-900/45 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <button
                              onClick={() => setSelectedTle(tle)}
                              className="min-w-0 flex-1 text-left"
                              title={tle.name}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-[11px] font-mono font-medium text-slate-100">{tle.name}</span>
                                {isActive && (
                                  <span className="flex-shrink-0 rounded bg-cyan-500/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-cyan-300">
                                    Active
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 text-[9px] font-mono text-slate-600">{formatLocation(telemetry)}</div>
                            </button>
                            <div className="flex flex-shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setSelectedTle(tle)}
                                className={`flex h-7 items-center justify-center rounded border px-2 text-[9px] font-mono transition-colors ${
                                  isActive
                                    ? 'border-cyan-500/50 text-cyan-300'
                                    : 'border-slate-700 text-slate-500 hover:text-cyan-300'
                                }`}
                                aria-label={`Select ${tle.name}`}
                              >
                                {isActive ? 'Active' : 'Select'}
                              </button>
                              <button
                                type="button"
                                onClick={() => removeTracked(tle)}
                                className="flex h-7 w-7 items-center justify-center rounded border border-slate-700 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-400"
                                aria-label={`Remove ${tle.name}`}
                              >
                                <X className="h-3 w-3" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex h-12 flex-shrink-0 items-center justify-end border-t border-slate-800 px-4">
                <button
                  onClick={closeModal}
                  className="rounded border border-cyan-500/30 bg-cyan-500/10 px-4 py-1.5 text-[10px] font-mono text-cyan-300 transition-colors hover:bg-cyan-500/20"
                >
                  Apply & Close
                </button>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
