"use client";

import { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, Line, OrbitControls, Stars } from '@react-three/drei';
import { ChevronDown, Orbit, RadioTower, Satellite, Sun } from 'lucide-react';
import * as THREE from 'three';
import type {
  SpacecraftConnectionStatus,
  SpacecraftId,
  SpacecraftTelemetry,
} from '@/services/spacecraftTelemetryService';
import type { NearEarthTelemetryFeed } from '@/services/nearEarthTelemetryService';

export const EARTH_RADIUS = 1;
export const GEO_RADIUS = 2.16;
export const L1_X = 3.18;
const EARTH_RADIUS_KM = 6371;
const GEO_ALTITUDE_KM = 35786;
const GEO_RADIUS_KM = EARTH_RADIUS_KM + GEO_ALTITUDE_KM;
const GEOMETRY_REFRESH_MS = 60_000;
const EARTH_DAY_TEXTURE_URL = '/earth/earth-blue-marble.jpg';
const EARTH_NIGHT_TEXTURE_URL = '/earth/earth-night.jpg';
const EARTH_BUMP_TEXTURE_URL = '/earth/earth-topology.png';
const EARTH_CLOUDS_TEXTURE_URL = '/earth/clouds.png';
const EARTH_TEXTURE_ANISOTROPY = 12;
const EARTH_SEGMENTS = 128;
const EARTH_CLOUD_OPACITY = 0.22;

const GOES_NOMINAL_LONGITUDE_DEG: Record<string, number> = {
  'GOES-18': -137.0,
  'GOES-19': -75.2,
};

const STATUS_RANK: Record<SpacecraftConnectionStatus, number> = {
  off: 0,
  stale: 1,
  live: 2,
};

const L1_STYLE_BY_ID: Record<SpacecraftId, { color: string; phase: number; yRadius: number; zRadius: number; tilt: number }> = {
  DSCOVR: { color: '#22d3ee', phase: 0.2, yRadius: 0.32, zRadius: 0.18, tilt: 0.12 },
  ACE: { color: '#a78bfa', phase: 1.45, yRadius: 0.24, zRadius: 0.13, tilt: -0.28 },
  WIND: { color: '#f472b6', phase: 2.8, yRadius: 0.38, zRadius: 0.2, tilt: 0.42 },
  IMAP: { color: '#34d399', phase: 4.05, yRadius: 0.29, zRadius: 0.16, tilt: -0.08 },
  ASE: { color: '#94a3b8', phase: 5.2, yRadius: 0.2, zRadius: 0.1, tilt: 0.22 },
};

type L1OrbitObject = {
  id: SpacecraftId;
  name: string;
  source: string;
  status: SpacecraftConnectionStatus;
  isSelected: boolean;
  color: string;
  phase: number;
  yRadius: number;
  zRadius: number;
  tilt: number;
  geometry: OrbitGeometrySnapshot;
};

type GeoOrbitObject = {
  name: string;
  source: string;
  status: SpacecraftConnectionStatus;
  isSelected: boolean;
  color: string;
  phase: number;
  geometry: OrbitGeometrySnapshot;
};

type OrbitGeometrySnapshot = {
  frame: 'GSE' | 'GEO nominal';
  distanceKm: number | null;
  heightKm: number | null;
  sunAxisAngleDeg: number | null;
  xKm: number | null;
  yKm: number | null;
  zKm: number | null;
  longitudeDeg: number | null;
  timestamp: string | null;
  note: string;
};

type EarthTextureSet = {
  day: THREE.Texture | null;
  night: THREE.Texture | null;
  bump: THREE.Texture | null;
  clouds: THREE.Texture | null;
};

const EMPTY_EARTH_TEXTURES: EarthTextureSet = {
  day: null,
  night: null,
  bump: null,
  clouds: null,
};

let earthTextureCache: EarthTextureSet | null = null;
let earthTexturePromise: Promise<EarthTextureSet> | null = null;

const CLOUD_VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUD_FRAGMENT_SHADER = `
  uniform sampler2D cloudMap;
  uniform vec3 cloudColor;
  uniform float opacity;
  varying vec2 vUv;

  void main() {
    float cloudMask = 1.0 - texture2D(cloudMap, vUv).r;
    float alpha = smoothstep(0.08, 0.82, cloudMask) * opacity;

    if (alpha < 0.01) {
      discard;
    }

    gl_FragColor = vec4(cloudColor, alpha);
  }
`;

interface InSituOrbitSceneProps {
  spacecraftTelemetry: SpacecraftTelemetry[];
  selectedSpacecraftIds: SpacecraftId[];
  nearEarthTelemetry: NearEarthTelemetryFeed[];
  selectedLiveNearEarthSourceIds: string[];
  selectedNearEarthSpacecraft: string[];
}

function mergeStatus(current: SpacecraftConnectionStatus, next: SpacecraftConnectionStatus) {
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

function getStatusMeta(status: SpacecraftConnectionStatus) {
  if (status === 'live') {
    return {
      label: 'Live',
      className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
      opacity: 1,
    };
  }

  if (status === 'stale') {
    return {
      label: 'Stale',
      className: 'border-amber-300/30 bg-amber-300/10 text-amber-100',
      opacity: 0.7,
    };
  }

  return {
    label: 'Off',
    className: 'border-slate-700 bg-slate-800/60 text-slate-500',
    opacity: 0.28,
  };
}

function toFiniteNumber(value: string | number | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (!value) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getLatestNumericChartPoint(chart: SpacecraftTelemetry['charts'][number] | undefined) {
  if (!chart) {
    return null;
  }

  return chart.data.reduce<{ value: number; time: string | null; timeMs: number } | null>((latest, point) => {
    const value = toFiniteNumber(point.value);

    if (value === null) {
      return latest;
    }

    const parsed = parseTimestamp(point.time_tag);
    const timeMs = parsed?.getTime() ?? 0;

    if (!latest || timeMs >= latest.timeMs) {
      return {
        value,
        time: parsed ? parsed.toISOString() : point.time_tag || null,
        timeMs,
      };
    }

    return latest;
  }, null);
}

function getLatestGsePosition(mission: SpacecraftTelemetry) {
  const x = getLatestNumericChartPoint(mission.charts.find(chart => chart.id.endsWith('-x-gse')));
  const y = getLatestNumericChartPoint(mission.charts.find(chart => chart.id.endsWith('-y-gse')));
  const z = getLatestNumericChartPoint(mission.charts.find(chart => chart.id.endsWith('-z-gse')));

  if (!x || !y || !z) {
    return null;
  }

  const timestamp = [x, y, z].reduce((latest, point) => {
    if (!point.time) {
      return latest;
    }

    const pointTime = parseTimestamp(point.time)?.getTime() ?? 0;
    const latestTime = latest ? parseTimestamp(latest)?.getTime() ?? 0 : 0;

    return pointTime > latestTime ? point.time : latest;
  }, null as string | null);

  return {
    xKm: x.value,
    yKm: y.value,
    zKm: z.value,
    timestamp,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function radiansToDegrees(value: number) {
  return value * (180 / Math.PI);
}

function degreesToRadians(value: number) {
  return value * (Math.PI / 180);
}

function normalizeDegrees(value: number) {
  const normalized = value % 360;

  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeLongitude(value: number) {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;

  return normalized === -180 ? 180 : normalized;
}

function getSunAxisAngleFromVector(xKm: number, yKm: number, zKm: number) {
  const distanceKm = Math.sqrt(xKm ** 2 + yKm ** 2 + zKm ** 2);

  if (distanceKm <= 0) {
    return null;
  }

  return radiansToDegrees(Math.acos(clamp(xKm / distanceKm, -1, 1)));
}

function buildL1Geometry(mission: SpacecraftTelemetry): OrbitGeometrySnapshot {
  const position = getLatestGsePosition(mission);

  if (!position) {
    return {
      frame: 'GSE',
      distanceKm: null,
      heightKm: null,
      sunAxisAngleDeg: null,
      xKm: null,
      yKm: null,
      zKm: null,
      longitudeDeg: null,
      timestamp: mission.lastSampleTime,
      note: 'This feed does not expose a live GSE position vector in the current playground request.',
    };
  }

  const distanceKm = Math.sqrt(position.xKm ** 2 + position.yKm ** 2 + position.zKm ** 2);

  return {
    frame: 'GSE',
    distanceKm,
    heightKm: Math.max(0, distanceKm - EARTH_RADIUS_KM),
    sunAxisAngleDeg: getSunAxisAngleFromVector(position.xKm, position.yKm, position.zKm),
    xKm: position.xKm,
    yKm: position.yKm,
    zKm: position.zKm,
    longitudeDeg: null,
    timestamp: position.timestamp,
    note: 'Angle is measured from +X GSE, the Earth-to-Sun axis used by the L1 ephemeris feeds.',
  };
}

function getJulianDate(date: Date) {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

function getSubsolarPoint(date: Date) {
  const julianDate = getJulianDate(date);
  const daysSinceJ2000 = julianDate - 2_451_545.0;
  const meanLongitude = normalizeDegrees(280.460 + 0.9856474 * daysSinceJ2000);
  const meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * daysSinceJ2000);
  const meanAnomalyRad = degreesToRadians(meanAnomaly);
  const eclipticLongitude = normalizeDegrees(
    meanLongitude +
      1.915 * Math.sin(meanAnomalyRad) +
      0.020 * Math.sin(2 * meanAnomalyRad),
  );
  const obliquity = 23.439 - 0.0000004 * daysSinceJ2000;
  const eclipticLongitudeRad = degreesToRadians(eclipticLongitude);
  const obliquityRad = degreesToRadians(obliquity);
  const declination = Math.asin(Math.sin(obliquityRad) * Math.sin(eclipticLongitudeRad));
  const rightAscension = Math.atan2(
    Math.cos(obliquityRad) * Math.sin(eclipticLongitudeRad),
    Math.cos(eclipticLongitudeRad),
  );
  const greenwichMeanSiderealTime = normalizeDegrees(
    280.46061837 + 360.98564736629 * (julianDate - 2_451_545.0),
  );

  return {
    latitudeDeg: radiansToDegrees(declination),
    longitudeDeg: normalizeLongitude(radiansToDegrees(rightAscension) - greenwichMeanSiderealTime),
  };
}

function getGeoSunAxisAngle(longitudeDeg: number, date: Date) {
  const subsolar = getSubsolarPoint(date);
  const satelliteLongitudeRad = degreesToRadians(longitudeDeg);
  const subsolarLatitudeRad = degreesToRadians(subsolar.latitudeDeg);
  const subsolarLongitudeRad = degreesToRadians(subsolar.longitudeDeg);
  const satelliteVector = new THREE.Vector3(
    Math.cos(satelliteLongitudeRad),
    Math.sin(satelliteLongitudeRad),
    0,
  );
  const sunVector = new THREE.Vector3(
    Math.cos(subsolarLatitudeRad) * Math.cos(subsolarLongitudeRad),
    Math.cos(subsolarLatitudeRad) * Math.sin(subsolarLongitudeRad),
    Math.sin(subsolarLatitudeRad),
  );

  return radiansToDegrees(Math.acos(clamp(satelliteVector.dot(sunVector), -1, 1)));
}

function buildGeoGeometry(spacecraftName: string, date: Date): OrbitGeometrySnapshot {
  const longitudeDeg = GOES_NOMINAL_LONGITUDE_DEG[spacecraftName] ?? null;

  return {
    frame: 'GEO nominal',
    distanceKm: GEO_RADIUS_KM,
    heightKm: GEO_ALTITUDE_KM,
    sunAxisAngleDeg: longitudeDeg === null ? null : getGeoSunAxisAngle(longitudeDeg, date),
    xKm: null,
    yKm: null,
    zKm: null,
    longitudeDeg,
    timestamp: date.toISOString(),
    note: longitudeDeg === null
      ? 'The NOAA GOES JSON feed identifies the spacecraft but does not include a live GEO longitude in this request.'
      : 'GEO angle uses the current subsolar point and NOAA nominal GOES operational longitude.',
  };
}

function formatNumber(value: number | null, maximumFractionDigits = 0) {
  if (value === null) {
    return 'Not available';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function formatKm(value: number | null) {
  return value === null ? 'Not available' : `${formatNumber(value, Math.abs(value) < 100 ? 1 : 0)} km`;
}

function formatAngle(value: number | null) {
  return value === null ? 'Not available' : `${formatNumber(value, 1)} deg`;
}

function formatLongitude(value: number | null) {
  if (value === null) {
    return 'Not available';
  }

  return `${formatNumber(Math.abs(value), 1)} deg ${value >= 0 ? 'E' : 'W'}`;
}

function formatTimestamp(value: string | null) {
  const parsed = parseTimestamp(value);

  if (!parsed) {
    return 'Not available';
  }

  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function hashPhase(value: string) {
  const seed = value.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return (seed % 360) * (Math.PI / 180);
}

export function circlePoints(radius: number, plane: 'xz' | 'yz', segments = 160) {
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    if (plane === 'yz') {
      return [0, Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number, number];
    }

    return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius] as [number, number, number];
  });
}

function haloPoints({
  x,
  yRadius,
  zRadius,
  tilt,
  phase,
  segments = 128,
}: {
  x: number;
  yRadius: number;
  zRadius: number;
  tilt: number;
  phase: number;
  segments?: number;
}) {
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2 + phase;
    const y = Math.cos(angle) * yRadius;
    const z = Math.sin(angle) * zRadius;
    const tiltedY = y * Math.cos(tilt) - z * Math.sin(tilt);
    const tiltedZ = y * Math.sin(tilt) + z * Math.cos(tilt);

    return [x, tiltedY, tiltedZ] as [number, number, number];
  });
}

const StatusPill = ({ status }: { status: SpacecraftConnectionStatus }) => {
  const meta = getStatusMeta(status);

  return (
    <span className={`rounded border px-2 py-0.5 text-[9px] font-mono uppercase ${meta.className}`}>
      {meta.label}
    </span>
  );
};

function prepareEarthTexture(texture: THREE.Texture, colorSpace: THREE.ColorSpace = THREE.NoColorSpace) {
  texture.colorSpace = colorSpace;
  texture.anisotropy = EARTH_TEXTURE_ANISOTROPY;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return texture;
}

function loadEarthTexture(loader: THREE.TextureLoader, url: string, colorSpace: THREE.ColorSpace = THREE.NoColorSpace) {
  return new Promise<THREE.Texture | null>((resolve) => {
    loader.load(
      url,
      texture => resolve(prepareEarthTexture(texture, colorSpace)),
      undefined,
      () => resolve(null),
    );
  });
}

function getEarthTextureSet() {
  if (earthTextureCache) {
    return Promise.resolve(earthTextureCache);
  }

  if (!earthTexturePromise) {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    earthTexturePromise = Promise.all([
      loadEarthTexture(loader, EARTH_DAY_TEXTURE_URL, THREE.SRGBColorSpace),
      loadEarthTexture(loader, EARTH_NIGHT_TEXTURE_URL, THREE.SRGBColorSpace),
      loadEarthTexture(loader, EARTH_BUMP_TEXTURE_URL),
      loadEarthTexture(loader, EARTH_CLOUDS_TEXTURE_URL),
    ]).then(([day, night, bump, clouds]) => {
      earthTextureCache = {
        day,
        night,
        bump,
        clouds,
      };

      return earthTextureCache;
    });
  }

  return earthTexturePromise;
}

function useEarthTextures() {
  const [textures, setTextures] = useState<EarthTextureSet>(() => earthTextureCache ?? EMPTY_EARTH_TEXTURES);

  useEffect(() => {
    let isCancelled = false;

    getEarthTextureSet().then(nextTextures => {
      if (!isCancelled) {
        setTextures(nextTextures);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  return textures;
}

function EarthReferenceLines() {
  return (
    <>
      <Line
        points={circlePoints(EARTH_RADIUS + 0.014, 'yz')}
        color="#fde68a"
        lineWidth={1}
        transparent
        opacity={0.24}
      />
      <Line
        points={circlePoints(EARTH_RADIUS + 0.024, 'xz')}
        color="#38bdf8"
        lineWidth={1}
        transparent
        opacity={0.14}
      />

      <mesh>
        <sphereGeometry args={[EARTH_RADIUS + 0.06, 64, 64]} />
        <meshBasicMaterial
          color="#60a5fa"
          transparent
          opacity={0.06}
          side={THREE.BackSide}
        />
      </mesh>
    </>
  );
}

function EarthCloudLayer({ texture }: { texture: THREE.Texture }) {
  const uniforms = useMemo(
    () => ({
      cloudMap: { value: texture },
      cloudColor: { value: new THREE.Color('#f8fbff') },
      opacity: { value: EARTH_CLOUD_OPACITY },
    }),
    [texture],
  );

  return (
    <mesh>
      <sphereGeometry args={[EARTH_RADIUS + 0.024, EARTH_SEGMENTS, EARTH_SEGMENTS]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={CLOUD_VERTEX_SHADER}
        fragmentShader={CLOUD_FRAGMENT_SHADER}
        transparent
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </mesh>
  );
}

export function EarthModel() {
  const textures = useEarthTextures();

  return (
    <group>
      <group>
        <mesh>
          <sphereGeometry args={[EARTH_RADIUS, EARTH_SEGMENTS, EARTH_SEGMENTS]} />
          <meshStandardMaterial
            color={textures.day ? '#dceafe' : '#0b2545'}
            map={textures.day}
            bumpMap={textures.bump}
            bumpScale={textures.bump ? 0.012 : 0}
            emissive="#020617"
            emissiveMap={textures.night}
            emissiveIntensity={textures.night ? 0.16 : 0.08}
            roughness={0.92}
            metalness={0}
          />
        </mesh>
      </group>

      {textures.clouds && (
        <EarthCloudLayer texture={textures.clouds} />
      )}

      <EarthReferenceLines />
    </group>
  );
}

export function SunVector() {
  return (
    <group>
      <pointLight position={[5.4, 1.4, 0.8]} intensity={3.2} color="#ffffff" distance={8} />
      <directionalLight position={[5.4, 1.4, 0.8]} intensity={1.25} color="#f8fbff" />
      <group position={[4.15, 1.08, 0.22]}>
        <mesh>
          <sphereGeometry args={[0.075, 24, 24]} />
          <meshBasicMaterial color="#facc15" />
        </mesh>
        <Html distanceFactor={7} position={[0.12, 0.06, 0]} center>
          <div className="rounded border border-amber-300/30 bg-slate-950/85 px-2 py-1 text-[9px] font-mono uppercase text-amber-100 shadow-lg shadow-black/30">
            Sun side
          </div>
        </Html>
      </group>
      <Line
        points={[[3.72, 0.88, 0.16], [1.12, 0.36, 0.04]]}
        color="#fbbf24"
        lineWidth={1.5}
        transparent
        opacity={0.42}
      />
    </group>
  );
}

function L1Marker() {
  return (
    <group position={[L1_X, 0, 0]}>
      <mesh>
        <sphereGeometry args={[0.035, 18, 18]} />
        <meshBasicMaterial color="#facc15" transparent opacity={0.9} />
      </mesh>
      <Html distanceFactor={8} position={[0, -0.38, 0]} center>
        <div className="rounded border border-amber-300/25 bg-slate-950/85 px-2 py-1 text-[9px] font-mono uppercase text-amber-100 shadow-lg shadow-black/30">
          L1
        </div>
      </Html>
    </group>
  );
}

function L1SatelliteMarker({ item, index }: { item: L1OrbitObject; index: number }) {
  const statusMeta = getStatusMeta(item.status);
  const y = Math.cos(item.phase) * item.yRadius;
  const z = Math.sin(item.phase) * item.zRadius;
  const tiltedY = y * Math.cos(item.tilt) - z * Math.sin(item.tilt);
  const tiltedZ = y * Math.sin(item.tilt) + z * Math.cos(item.tilt);
  const position = [L1_X, tiltedY, tiltedZ] as [number, number, number];

  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[item.isSelected ? 0.045 : 0.032, 20, 20]} />
        <meshBasicMaterial color={item.color} transparent opacity={item.isSelected ? statusMeta.opacity : statusMeta.opacity * 0.54} />
      </mesh>
      <Html distanceFactor={7} position={[0, -0.18 - (index % 2) * 0.04, 0]} center>
        <div
          className={`whitespace-nowrap rounded border px-2 py-1 text-[9px] font-mono shadow-lg shadow-black/25 ${
            item.isSelected
              ? 'border-cyan-300/35 bg-slate-950/90 text-slate-100'
              : 'border-slate-700/70 bg-slate-950/75 text-slate-500'
          }`}
        >
          {item.name}
        </div>
      </Html>
    </group>
  );
}

function GeoSatelliteMarker({ item, index }: { item: GeoOrbitObject; index: number }) {
  const statusMeta = getStatusMeta(item.status);
  const position = [
    Math.cos(item.phase) * GEO_RADIUS,
    0,
    Math.sin(item.phase) * GEO_RADIUS,
  ] as [number, number, number];

  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[item.isSelected ? 0.05 : 0.036, 20, 20]} />
        <meshBasicMaterial color={item.color} transparent opacity={item.isSelected ? statusMeta.opacity : statusMeta.opacity * 0.55} />
      </mesh>
      <Html distanceFactor={7} position={[0, -0.2 - (index % 2) * 0.04, 0]} center>
        <div
          className={`whitespace-nowrap rounded border px-2 py-1 text-[9px] font-mono shadow-lg shadow-black/25 ${
            item.isSelected
              ? 'border-emerald-300/35 bg-slate-950/90 text-slate-100'
              : 'border-slate-700/70 bg-slate-950/75 text-slate-500'
          }`}
        >
          {item.name}
        </div>
      </Html>
    </group>
  );
}

function OrbitScene({
  l1Objects,
  geoObjects,
}: {
  l1Objects: L1OrbitObject[];
  geoObjects: GeoOrbitObject[];
}) {
  return (
    <Canvas camera={{ position: [0.1, 1.1, 6.1], fov: 45 }}>
      <color attach="background" args={['#020617']} />
      <Stars radius={80} depth={40} count={1000} factor={3} saturation={0} fade speed={0} />
      <ambientLight intensity={0.2} color="#bae6fd" />
      <SunVector />
      <EarthModel />

      <Line
        points={circlePoints(GEO_RADIUS, 'xz')}
        color="#34d399"
        lineWidth={1.15}
        transparent
        opacity={0.34}
      />
      <Html distanceFactor={8} position={[-GEO_RADIUS, 0.18, 0]} center>
        <div className="rounded border border-emerald-300/25 bg-slate-950/85 px-2 py-1 text-[9px] font-mono uppercase text-emerald-100 shadow-lg shadow-black/30">
          GEO
        </div>
      </Html>

      {l1Objects.map(item => (
        <Line
          key={`l1-orbit-${item.id}`}
          points={haloPoints({ x: L1_X, ...item })}
          color={item.color}
          lineWidth={1}
          transparent
          opacity={item.isSelected ? 0.44 : 0.16}
        />
      ))}

      <L1Marker />
      {l1Objects.map((item, index) => (
        <L1SatelliteMarker key={item.id} item={item} index={index} />
      ))}
      {geoObjects.map((item, index) => (
        <GeoSatelliteMarker key={item.name} item={item} index={index} />
      ))}

      <OrbitControls
        enablePan={false}
        minDistance={3.1}
        maxDistance={8}
      />
    </Canvas>
  );
}

function OrbitObjectRow({
  color,
  title,
  subtitle,
  status,
  isSelected,
  geometry,
}: {
  color: string;
  title: string;
  subtitle: string;
  status: SpacecraftConnectionStatus;
  isSelected: boolean;
  geometry: OrbitGeometrySnapshot;
}) {
  return (
    <details className={`group min-w-0 rounded-md border ${
      isSelected
        ? 'border-cyan-400/35 bg-cyan-400/10'
        : 'border-slate-800 bg-slate-950/45'
    }`}>
      <summary className="flex min-w-0 cursor-pointer list-none items-start justify-between gap-3 p-3 marker:hidden">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_12px_currentColor]"
            style={{ color, backgroundColor: color }}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-100">{title}</div>
            <div className="mt-1 truncate font-mono text-[10px] text-slate-500" title={subtitle}>
              {subtitle}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill status={status} />
          <ChevronDown className="h-3.5 w-3.5 text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" />
        </div>
      </summary>

      <div className="border-t border-slate-800/80 px-3 pb-3 pt-2">
        <div className="grid grid-cols-2 gap-2">
          <GeometryField label="Height" value={formatKm(geometry.heightKm)} />
          <GeometryField label="Sun-axis angle" value={formatAngle(geometry.sunAxisAngleDeg)} />
          <GeometryField label="Earth center" value={formatKm(geometry.distanceKm)} />
          <GeometryField label="Frame" value={geometry.frame} />
        </div>

        {geometry.frame === 'GSE' ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <GeometryField label="X GSE" value={formatKm(geometry.xKm)} />
            <GeometryField label="Y GSE" value={formatKm(geometry.yKm)} />
            <GeometryField label="Z GSE" value={formatKm(geometry.zKm)} />
          </div>
        ) : (
          <div className="mt-2">
            <GeometryField label="Longitude" value={formatLongitude(geometry.longitudeDeg)} />
          </div>
        )}

        <div className="mt-2 rounded border border-slate-800 bg-slate-950/55 p-2">
          <div className="font-mono text-[9px] uppercase text-slate-600">
            Geometry time
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-slate-400">
            {formatTimestamp(geometry.timestamp)}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {geometry.note}
          </p>
        </div>
      </div>
    </details>
  );
}

function GeometryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-slate-800 bg-slate-950/55 p-2">
      <div className="truncate font-mono text-[8px] uppercase text-slate-600">{label}</div>
      <div className="mt-1 truncate font-mono text-[10px] text-slate-200" title={value}>
        {value}
      </div>
    </div>
  );
}

export function InSituOrbitScene({
  spacecraftTelemetry,
  selectedSpacecraftIds,
  nearEarthTelemetry,
  selectedLiveNearEarthSourceIds,
  selectedNearEarthSpacecraft,
}: InSituOrbitSceneProps) {
  // Start at a stable value so the server and the first client render produce
  // identical HTML; the real clock is set right after mount. Initialising with
  // Date.now() (even lazily) runs on both server and client and captures
  // different seconds, which causes a hydration mismatch.
  const [geometryTimeMs, setGeometryTimeMs] = useState(0);
  const selectedSpacecraftSet = useMemo(() => new Set(selectedSpacecraftIds), [selectedSpacecraftIds]);
  const selectedNearEarthSet = useMemo(() => new Set(selectedNearEarthSpacecraft), [selectedNearEarthSpacecraft]);
  const geometryTime = useMemo(() => new Date(geometryTimeMs), [geometryTimeMs]);

  useEffect(() => {
    const initialTimeout = window.setTimeout(() => setGeometryTimeMs(Date.now()), 0);
    const interval = window.setInterval(() => setGeometryTimeMs(Date.now()), GEOMETRY_REFRESH_MS);

    return () => {
      window.clearTimeout(initialTimeout);
      window.clearInterval(interval);
    };
  }, []);

  const l1Objects = useMemo<L1OrbitObject[]>(() => {
    return spacecraftTelemetry
      .filter(mission => mission.status !== 'off' || selectedSpacecraftSet.has(mission.id))
      .map(mission => {
        const style = L1_STYLE_BY_ID[mission.id];

        return {
          id: mission.id,
          name: mission.displayName,
          source: mission.source,
          status: mission.status,
          isSelected: selectedSpacecraftSet.has(mission.id),
          geometry: buildL1Geometry(mission),
          ...style,
        };
      });
  }, [selectedSpacecraftSet, spacecraftTelemetry]);

  const geoObjects = useMemo<GeoOrbitObject[]>(() => {
    const activeFeeds = nearEarthTelemetry.filter(feed => selectedLiveNearEarthSourceIds.includes(feed.sourceId));
    const byName = new Map<string, GeoOrbitObject>();
    const palette = ['#34d399', '#fbbf24', '#fb7185', '#60a5fa'];

    activeFeeds.forEach(feed => {
      feed.charts.forEach(chart => {
        if (!chart.spacecraft.toUpperCase().startsWith('GOES')) return;

        const current = byName.get(chart.spacecraft);
        const paletteIndex = byName.size % palette.length;
        const geometry = buildGeoGeometry(chart.spacecraft, geometryTime);

        byName.set(chart.spacecraft, {
          name: chart.spacecraft,
          source: feed.source,
          status: current ? mergeStatus(current.status, feed.status) : feed.status,
          isSelected: selectedNearEarthSet.size === 0 || selectedNearEarthSet.has(chart.spacecraft),
          color: current?.color ?? palette[paletteIndex],
          phase: current?.phase ?? (geometry.longitudeDeg === null ? hashPhase(chart.spacecraft) : degreesToRadians(geometry.longitudeDeg)),
          geometry,
        });
      });
    });

    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [geometryTime, nearEarthTelemetry, selectedLiveNearEarthSourceIds, selectedNearEarthSet]);

  const selectedCount = l1Objects.filter(item => item.isSelected).length + geoObjects.filter(item => item.isSelected).length;
  const totalCount = l1Objects.length + geoObjects.length;

  return (
    <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Orbit className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold uppercase text-slate-300">
              Real-time orbit context
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] uppercase text-slate-500">
              Sun-facing Earth, L1 monitors, and operational GEO feeds
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 font-mono text-[10px] uppercase text-cyan-100">
            {selectedCount} plotted
          </span>
          <span className="rounded border border-slate-700 bg-slate-950/70 px-2 py-1 font-mono text-[10px] uppercase text-slate-400">
            {totalCount} spacecraft
          </span>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="h-[380px] min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950 sm:h-[440px]">
          <OrbitScene l1Objects={l1Objects} geoObjects={geoObjects} />
        </div>

        <aside className="min-w-0 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center gap-1.5 text-[10px] uppercase text-slate-500">
                <RadioTower className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />
                L1
              </div>
              <div className="mt-2 font-mono text-lg text-slate-100">{l1Objects.length}</div>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center gap-1.5 text-[10px] uppercase text-slate-500">
                <Satellite className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
                GEO
              </div>
              <div className="mt-2 font-mono text-lg text-slate-100">{geoObjects.length}</div>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center gap-1.5 text-[10px] uppercase text-slate-500">
                <Sun className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                Light
              </div>
              <div className="mt-2 font-mono text-lg text-amber-100">L1</div>
            </div>
          </div>

          <div className="rounded-md border border-slate-800 bg-slate-950/45 p-3">
            <div className="text-[10px] uppercase text-slate-500">Scale</div>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              L1 distance is compressed so the upstream solar-wind monitors fit beside Earth; GEO is shown as the operational equatorial ring.
            </p>
          </div>

          <div className="space-y-2">
            {l1Objects.map(item => (
              <OrbitObjectRow
                key={item.id}
                color={item.color}
                title={item.name}
                subtitle={`L1 halo - ${item.source}`}
                status={item.status}
                isSelected={item.isSelected}
                geometry={item.geometry}
              />
            ))}
            {geoObjects.map(item => (
              <OrbitObjectRow
                key={item.name}
                color={item.color}
                title={item.name}
                subtitle={`GEO ring - ${item.source}`}
                status={item.status}
                isSelected={item.isSelected}
                geometry={item.geometry}
              />
            ))}
            {totalCount === 0 && (
              <div className="rounded-md border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-500">
                No real-time in situ spacecraft are available for the current feed selection.
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
