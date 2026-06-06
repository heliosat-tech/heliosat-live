"use client";
import React from 'react';
import * as THREE from 'three';
import { Line, Html } from '@react-three/drei';
import type { NoaaServiceResponse, NoaaMagnetometerData, NoaaPlasmaData } from '@/services/noaaSolarWindService';

interface SolarWindVectorProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
}

export const SolarWindVector: React.FC<SolarWindVectorProps> = ({ noaaMagData, noaaPlasmaData }) => {
  // Only render if real data is available
  const hasWind = noaaPlasmaData.isConnected && noaaPlasmaData.latestData && noaaPlasmaData.latestData.speed !== null;
  const hasMag = noaaMagData.isConnected && noaaMagData.latestData;
  const bx = hasMag ? noaaMagData.latestData?.bx_gsm : null;
  const by = hasMag ? noaaMagData.latestData?.by_gsm : null;
  const bz = hasMag ? noaaMagData.latestData?.bz_gsm : null;
  const hasB = bx !== null && by !== null && bz !== null && bx !== undefined && by !== undefined && bz !== undefined;

  return (
    <group position={[2.5, 0, 0]}>
      {hasWind && (
        <group position={[0, -0.2, 0]}>
          <Line points={[[0, 0, 0], [-0.8, 0, 0]]} color="#f472b6" lineWidth={2} />
          <mesh position={[-0.8, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <coneGeometry args={[0.04, 0.1, 8]} />
            <meshBasicMaterial color="#f472b6" />
          </mesh>
          <Html distanceFactor={10} position={[-0.4, -0.15, 0]} center>
             <div className="text-[10px] font-mono text-pink-300 pointer-events-none">Vsw</div>
          </Html>
        </group>
      )}
      
      {hasB && (
        <group position={[0, 0.2, 0]}>
           {(() => {
             const v = new THREE.Vector3(Number(bx), Number(bz), -Number(by)).normalize().multiplyScalar(0.6);
             return (
               <group>
                 <Line points={[[0, 0, 0], [v.x, v.y, v.z]]} color="#38bdf8" lineWidth={2} />
                 <Html distanceFactor={10} position={[v.x/2, v.y/2 + 0.1, v.z/2]} center>
                    <div className="text-[10px] font-mono text-cyan-300 pointer-events-none">B-Field</div>
                 </Html>
               </group>
             )
           })()}
        </group>
      )}
    </group>
  );
};
