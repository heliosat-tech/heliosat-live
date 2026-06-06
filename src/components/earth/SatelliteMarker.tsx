"use client";
import React, { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SatelliteTLE } from '@/services/celestrakService';
import { propagateSatelliteFromTle } from '@/services/satellitePropagationService';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';

const EARTH_RADIUS_KM = 6371;

export const SatelliteMarker: React.FC<{ tle: SatelliteTLE, isSelected: boolean }> = ({ tle, isSelected }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const { setSelectedTle } = useSatelliteSelection();
  const [hovered, setHovered] = useState(false);
  const [valid, setValid] = useState(true);

  useFrame(() => {
    const data = propagateSatelliteFromTle(tle, new Date());
    if (!data.positionAvailable || data.latitude === null || data.longitude === null || data.altitudeKm === null) {
      setValid(false);
      return;
    }
    setValid(true);

    const r = (EARTH_RADIUS_KM + data.altitudeKm) / EARTH_RADIUS_KM;
    const latRad = data.latitude * (Math.PI / 180);
    const lonRad = data.longitude * (Math.PI / 180);

    const x = r * Math.cos(latRad) * Math.cos(lonRad);
    const y = r * Math.sin(latRad);
    const z = -r * Math.cos(latRad) * Math.sin(lonRad); 

    if (meshRef.current) {
      meshRef.current.position.set(x, y, z);
    }
  });

  if (!valid) return null;

  return (
    <group>
      <mesh 
        ref={meshRef} 
        onClick={(e) => { e.stopPropagation(); setSelectedTle(tle); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerOut={(e) => { e.stopPropagation(); setHovered(false); }}
      >
        <sphereGeometry args={[isSelected ? 0.04 : 0.02, 16, 16]} />
        <meshBasicMaterial color={isSelected ? "#22d3ee" : hovered ? "#bae6fd" : "#38bdf8"} />
      </mesh>
    </group>
  );
};
