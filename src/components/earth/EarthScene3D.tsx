"use client";
import React from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Sphere, Stars } from '@react-three/drei';
import { SatelliteMarker } from './SatelliteMarker';
import { L1MonitorMarker } from './L1MonitorMarker';
import { SolarWindVector } from './SolarWindVector';
import { OrbitPath } from './OrbitPath';
import type { NoaaServiceResponse, NoaaMagnetometerData, NoaaPlasmaData } from '@/services/noaaSolarWindService';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import { useSatelliteConfig } from '@/contexts/SatelliteConfigContext';

interface EarthScene3DProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
}

const EarthSphere = () => {
  return (
    <group>
      <Sphere args={[1, 64, 64]}>
        <meshStandardMaterial 
          color="#0f172a" 
          emissive="#020617" 
          roughness={0.8}
          wireframe={true}
          transparent={true}
          opacity={0.3}
        />
      </Sphere>
      <Sphere args={[0.99, 64, 64]}>
         <meshBasicMaterial color="#020617" />
      </Sphere>
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 3, 5]} intensity={1} color="#e0f2fe" />
    </group>
  );
};

export const EarthScene3D: React.FC<EarthScene3DProps> = ({ noaaMagData, noaaPlasmaData }) => {
  const { selectedTle } = useSatelliteSelection();
  const { trackedTles } = useSatelliteConfig();

  return (
    <div className="w-full h-full bg-slate-950 relative rounded overflow-hidden">
      {trackedTles.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <span className="text-sm font-mono text-slate-500 uppercase tracking-widest bg-slate-900/80 px-4 py-2 rounded">
            No satellites selected on map
          </span>
        </div>
      )}
      
      <Canvas camera={{ position: [0, 0, 4], fov: 45 }}>
        <color attach="background" args={['#020617']} />
        <Stars radius={100} depth={50} count={2000} factor={4} saturation={0} fade speed={1} />
        
        <EarthSphere />
        
        {trackedTles.map((tle) => (
          <SatelliteMarker 
            key={tle.name} 
            tle={tle} 
            isSelected={selectedTle?.name === tle.name} 
          />
        ))}
        
        {selectedTle && (
          <OrbitPath tle={selectedTle} />
        )}
        
        <L1MonitorMarker />
        <SolarWindVector noaaMagData={noaaMagData} noaaPlasmaData={noaaPlasmaData} />
        
        <OrbitControls enablePan={false} maxDistance={10} minDistance={1.2} />
      </Canvas>
    </div>
  );
};
