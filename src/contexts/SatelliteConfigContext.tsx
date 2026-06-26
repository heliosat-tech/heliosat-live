"use client";
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { SatelliteTLE, CelesTrakResponse } from '@/services/celestrakService';

export type TleGroup = 'stations' | 'weather' | 'starlink' | 'active';

// NORAD catalog number (TLE line 1, cols 3-7) — unique per object. The full "active"
// catalog repeats names (e.g. several "HULIANWANG JISHU SHIYAN*"), so keying by name
// collided as React keys; the catalog number never does.
const noradId = (tle: SatelliteTLE): string => {
  const id = tle.line1?.slice(2, 7).trim();
  return id && /^\d+$/.test(id) ? id : tle.name;
};
export const getSatelliteKey = (tle: SatelliteTLE) => `${tle.source}:${noradId(tle)}`;

interface SatelliteConfigCtx {
  group: TleGroup;
  setGroup: (g: TleGroup) => void;
  search: string;
  setSearch: (s: string) => void;
  orbitPropagationEnabled: boolean;
  setOrbitPropagationEnabled: (enabled: boolean) => void;
  tleData: CelesTrakResponse;
  filteredTles: SatelliteTLE[];
  trackedTles: SatelliteTLE[];
  trackedKeys: Set<string>;
  toggleTrackedTle: (tle: SatelliteTLE) => void;
  removeTrackedTle: (tle: SatelliteTLE) => void;
  clearTrackedTles: () => void;
  /** Replace the whole tracked set at once (used to hydrate from saved/remote config). */
  replaceTrackedTles: (tles: SatelliteTLE[]) => void;
  tleLoading: boolean;
  isModalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
}

const SatelliteConfigContext = createContext<SatelliteConfigCtx | null>(null);

export const useSatelliteConfig = () => {
  const ctx = useContext(SatelliteConfigContext);
  if (!ctx) throw new Error('useSatelliteConfig must be used within SatelliteConfigProvider');
  return ctx;
};

interface ProviderProps {
  children: React.ReactNode;
  initialTleData: CelesTrakResponse;
}

export const SatelliteConfigProvider: React.FC<ProviderProps> = ({ children, initialTleData }) => {
  const [group, setGroupState] = useState<TleGroup>('stations');
  const [search, setSearch] = useState('');
  const [orbitPropagationEnabled, setOrbitPropagationEnabled] = useState(false);
  const [tleData, setTleData] = useState<CelesTrakResponse>(initialTleData);
  const [trackedTles, setTrackedTles] = useState<SatelliteTLE[]>([]);
  const [tleLoading, setTleLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openModal = useCallback(() => setIsModalOpen(true), []);
  const closeModal = useCallback(() => setIsModalOpen(false), []);

  const setGroup = useCallback((nextGroup: TleGroup) => {
    if (nextGroup === group) return;
    setGroupState(nextGroup);
    setSearch('');
    setTleLoading(!(nextGroup === 'stations' && tleData === initialTleData));
  }, [group, initialTleData, tleData]);

  // Re-fetch when group changes (skip initial stations load — already server-fetched).
  // Goes through our same-origin /api/tle proxy, which adds retry + last-good-cache resilience
  // server-side; the 15s ceiling covers the worst-case server retry without hanging forever.
  useEffect(() => {
    if (group === 'stations' && tleData === initialTleData) return;
    let cancelled = false;
    fetch(`/api/tle?group=${group}`, { signal: AbortSignal.timeout(15_000) })
      .then(r => { if (!r.ok) throw new Error(); return r.json() as Promise<CelesTrakResponse>; })
      .then(data => {
        if (!cancelled) setTleData(data);
      })
      .catch(() => {
        if (!cancelled) {
          setTleData({ isConnected: false, lastUpdated: null, errorMessage: 'CelesTrak unavailable', tles: [] });
        }
      })
      .finally(() => {
        if (!cancelled) setTleLoading(false);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  const filteredTles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? tleData.tles.filter(t => t.name.toLowerCase().includes(q)) : tleData.tles;
  }, [tleData.tles, search]);

  const trackedKeys = useMemo(() => {
    return new Set(trackedTles.map(getSatelliteKey));
  }, [trackedTles]);

  const toggleTrackedTle = useCallback((tle: SatelliteTLE) => {
    setTrackedTles(current => {
      const key = getSatelliteKey(tle);
      if (current.some(item => getSatelliteKey(item) === key)) {
        return current.filter(item => getSatelliteKey(item) !== key);
      }
      return [...current, tle];
    });
  }, []);

  const removeTrackedTle = useCallback((tle: SatelliteTLE) => {
    const key = getSatelliteKey(tle);
    setTrackedTles(current => current.filter(item => getSatelliteKey(item) !== key));
  }, []);

  const clearTrackedTles = useCallback(() => {
    setTrackedTles([]);
  }, []);

  const replaceTrackedTles = useCallback((tles: SatelliteTLE[]) => {
    setTrackedTles(tles);
  }, []);

  return (
    <SatelliteConfigContext.Provider value={{
      group, setGroup, search, setSearch,
      orbitPropagationEnabled, setOrbitPropagationEnabled,
      tleData, filteredTles,
      trackedTles, trackedKeys, toggleTrackedTle, removeTrackedTle, clearTrackedTles, replaceTrackedTles,
      tleLoading,
      isModalOpen, openModal, closeModal,
    }}>
      {children}
    </SatelliteConfigContext.Provider>
  );
};
