"use client";
import React from 'react';
import { Html } from '@react-three/drei';

export const L1MonitorMarker: React.FC = () => {
  return (
    <group position={[3, 0, 0]}>
      <mesh>
        <sphereGeometry args={[0.04, 16, 16]} />
        <meshBasicMaterial color="#fcd34d" transparent opacity={0.6} />
      </mesh>
      <Html distanceFactor={10} position={[0, 0.2, 0]} center>
        <div className="text-[10px] font-mono whitespace-nowrap text-amber-200 bg-slate-900/80 px-2 py-1 border border-amber-900/50 rounded pointer-events-none">
          L1 upstream solar wind region
        </div>
      </Html>
    </group>
  );
};
