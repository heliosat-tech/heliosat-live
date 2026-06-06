"use client";
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { SatelliteTLE, CelesTrakResponse } from '@/services/celestrakService';

export type TleGroup = 'stations' | 'weather' | 'starlink' | 'active';

export const getSatelliteKey = (tle: SatelliteTLE) => `${tle.source}:${tle.name}`;

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

const parseTleText = (text: string, group: string): SatelliteTLE[] => {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tles: SatelliteTLE[] = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const cur = lines[i], n1 = lines[i + 1], n2 = lines[i + 2];
    if (!cur.startsWith('1 ') && !cur.startsWith('2 ') && n1.startsWith('1 ') && n2.startsWith('2 ')) {
      tles.push({ name: cur, line1: n1, line2: n2, source: `celestrak-${group}` });
      i += 2;
    }
  }
  return tles;
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

  // Re-fetch when group changes (skip initial stations load — already server-fetched)
  useEffect(() => {
    if (group === 'stations' && tleData === initialTleData) return;
    let cancelled = false;
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(); return r.text(); })
      .then(text => {
        const tles = parseTleText(text, group);
        if (cancelled) return;
        setTleData({
          isConnected: tles.length > 0,
          lastUpdated: new Date().toISOString(),
          errorMessage: tles.length === 0 ? 'No satellite data available' : null,
          tles,
        });
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

  return (
    <SatelliteConfigContext.Provider value={{
      group, setGroup, search, setSearch,
      orbitPropagationEnabled, setOrbitPropagationEnabled,
      tleData, filteredTles,
      trackedTles, trackedKeys, toggleTrackedTle, removeTrackedTle, clearTrackedTles,
      tleLoading,
      isModalOpen, openModal, closeModal,
    }}>
      {children}
    </SatelliteConfigContext.Provider>
  );
};
