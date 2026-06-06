"use client";
import React, { createContext, useContext, useState } from 'react';
import type { SatelliteTLE } from '@/services/celestrakService';

interface SatelliteSelectionContextType {
  selectedTle: SatelliteTLE | null;
  setSelectedTle: (tle: SatelliteTLE | null) => void;
}

const SatelliteSelectionContext = createContext<SatelliteSelectionContextType>({
  selectedTle: null,
  setSelectedTle: () => {},
});

export const SatelliteSelectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedTle, setSelectedTle] = useState<SatelliteTLE | null>(null);
  return (
    <SatelliteSelectionContext.Provider value={{ selectedTle, setSelectedTle }}>
      {children}
    </SatelliteSelectionContext.Provider>
  );
};

export const useSatelliteSelection = () => useContext(SatelliteSelectionContext);
