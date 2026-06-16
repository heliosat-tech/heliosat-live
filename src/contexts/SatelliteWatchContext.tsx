"use client";
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

// Operator-declared watch configuration: per tracked satellite (keyed by getSatelliteKey), a list
// of instruments, each with environment-variable thresholds. When a live value crosses a
// threshold a satellite/instrument-specific alert fires (see watchAlertService). Persisted to
// localStorage so an operator's instruments survive reloads.

export type Comparator = 'gt' | 'lt' | 'gte' | 'lte';
export type EnvVariable = 'speed' | 'bz' | 'density' | 'bt' | 'kp' | 'dynamicPressure';

export interface Threshold {
  id: string;
  variable: EnvVariable;
  comparator: Comparator;
  value: number;
}

export interface Instrument {
  id: string;
  name: string;
  thresholds: Threshold[];
}

export type WatchConfig = Record<string, Instrument[]>;

interface SatelliteWatchCtx {
  config: WatchConfig;
  hydrated: boolean;
  /** Replace the whole config at once (used to hydrate from saved/remote config). */
  replaceConfig: (config: WatchConfig) => void;
  addInstrument: (satelliteKey: string) => void;
  renameInstrument: (satelliteKey: string, instrumentId: string, name: string) => void;
  removeInstrument: (satelliteKey: string, instrumentId: string) => void;
  addThreshold: (satelliteKey: string, instrumentId: string) => void;
  updateThreshold: (satelliteKey: string, instrumentId: string, thresholdId: string, patch: Partial<Threshold>) => void;
  removeThreshold: (satelliteKey: string, instrumentId: string, thresholdId: string) => void;
}

const STORAGE_KEY = 'helios.watchConfig.v1';

const SatelliteWatchContext = createContext<SatelliteWatchCtx | null>(null);

export const useSatelliteWatch = () => {
  const ctx = useContext(SatelliteWatchContext);
  if (!ctx) throw new Error('useSatelliteWatch must be used within SatelliteWatchProvider');
  return ctx;
};

const newId = () => Math.random().toString(36).slice(2, 10);

export const SatelliteWatchProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<WatchConfig>({});
  const [hydrated, setHydrated] = useState(false);

  // Load persisted config once after mount (localStorage is client-only). Until then config stays
  // empty, which matches the server render and avoids a hydration mismatch.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) setConfig(JSON.parse(raw) as WatchConfig);
      } catch {
        /* ignore unreadable/corrupt storage */
      }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  // Persist on change — but only after hydration, so the empty initial state can't clobber a
  // previously saved config before it has loaded.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* ignore quota/serialization failures */
    }
  }, [config, hydrated]);

  const replaceConfig = useCallback((next: WatchConfig) => {
    setConfig(next);
  }, []);

  const updateInstruments = useCallback(
    (satelliteKey: string, fn: (instruments: Instrument[]) => Instrument[]) => {
      setConfig(current => ({ ...current, [satelliteKey]: fn(current[satelliteKey] ?? []) }));
    },
    [],
  );

  const addInstrument = useCallback((satelliteKey: string) => {
    updateInstruments(satelliteKey, instruments => [
      ...instruments,
      { id: newId(), name: `Instrument ${instruments.length + 1}`, thresholds: [] },
    ]);
  }, [updateInstruments]);

  const renameInstrument = useCallback((satelliteKey: string, instrumentId: string, name: string) => {
    updateInstruments(satelliteKey, instruments =>
      instruments.map(instrument => (instrument.id === instrumentId ? { ...instrument, name } : instrument)),
    );
  }, [updateInstruments]);

  const removeInstrument = useCallback((satelliteKey: string, instrumentId: string) => {
    updateInstruments(satelliteKey, instruments => instruments.filter(instrument => instrument.id !== instrumentId));
  }, [updateInstruments]);

  const addThreshold = useCallback((satelliteKey: string, instrumentId: string) => {
    updateInstruments(satelliteKey, instruments =>
      instruments.map(instrument =>
        instrument.id === instrumentId
          ? { ...instrument, thresholds: [...instrument.thresholds, { id: newId(), variable: 'speed', comparator: 'gt', value: 600 }] }
          : instrument,
      ),
    );
  }, [updateInstruments]);

  const updateThreshold = useCallback(
    (satelliteKey: string, instrumentId: string, thresholdId: string, patch: Partial<Threshold>) => {
      updateInstruments(satelliteKey, instruments =>
        instruments.map(instrument =>
          instrument.id === instrumentId
            ? {
                ...instrument,
                thresholds: instrument.thresholds.map(threshold =>
                  threshold.id === thresholdId ? { ...threshold, ...patch } : threshold,
                ),
              }
            : instrument,
        ),
      );
    },
    [updateInstruments],
  );

  const removeThreshold = useCallback((satelliteKey: string, instrumentId: string, thresholdId: string) => {
    updateInstruments(satelliteKey, instruments =>
      instruments.map(instrument =>
        instrument.id === instrumentId
          ? { ...instrument, thresholds: instrument.thresholds.filter(threshold => threshold.id !== thresholdId) }
          : instrument,
      ),
    );
  }, [updateInstruments]);

  return (
    <SatelliteWatchContext.Provider
      value={{
        config,
        hydrated,
        replaceConfig,
        addInstrument,
        renameInstrument,
        removeInstrument,
        addThreshold,
        updateThreshold,
        removeThreshold,
      }}
    >
      {children}
    </SatelliteWatchContext.Provider>
  );
};
