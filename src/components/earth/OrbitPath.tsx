"use client";
import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { SatelliteTLE } from '@/services/celestrakService';
import { propagateSatelliteFromTle } from '@/services/satellitePropagationService';

const EARTH_RADIUS_KM = 6371;

export const OrbitPath: React.FC<{ tle: SatelliteTLE }> = ({ tle }) => {
  const points = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const now = new Date().getTime();
    
    // Simulate one full orbit approximately (or ~100 minutes for LEO)
    const stepMs = 60000; // 1 minute steps
    const numSteps = 100;
    
    for (let i = 0; i <= numSteps; i++) {
      const t = new Date(now + i * stepMs);
      const data = propagateSatelliteFromTle(tle, t);
      if (data.positionAvailable && data.latitude !== null && data.longitude !== null && data.altitudeKm !== null) {
        const r = (EARTH_RADIUS_KM + data.altitudeKm) / EARTH_RADIUS_KM;
        const latRad = data.latitude * (Math.PI / 180);
        const lonRad = data.longitude * (Math.PI / 180);

        const x = r * Math.cos(latRad) * Math.cos(lonRad);
        const y = r * Math.sin(latRad);
        const z = -r * Math.cos(latRad) * Math.sin(lonRad);
        pts.push(new THREE.Vector3(x, y, z));
      }
    }
    return pts;
  }, [tle]);

  if (points.length === 0) return null;

  return (
    <Line
      points={points}
      color="#22d3ee"
      lineWidth={1.5}
      transparent
      opacity={0.4}
    />
  );
};
