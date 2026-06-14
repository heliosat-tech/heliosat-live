"use client";
import React, { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect } from 'react';
import * as THREE from 'three';
import { TriangleAlert } from 'lucide-react';
import { feature } from 'topojson-client';
import type { GlobeMethods, GlobeProps } from 'react-globe.gl';
import type { GeometryObject, Topology } from 'topojson-specification';
import type { SatelliteTLE } from '@/services/celestrakService';
import type { PropagatedSatelliteData } from '@/services/satellitePropagationService';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';

const EARTH_RADIUS_KM = 6371;
const MIN_CANVAS_SIZE = 1;

// Day/night illumination: a custom globe material that blends a daytime texture on the
// Sun-facing hemisphere with the night-lights texture on the dark side, smoothly across
// the terminator. The lit hemisphere tracks the real subsolar point (updated each minute);
// `globeRotation` corrects for the camera's current point-of-view so the terminator stays
// fixed to the actual geography. Recipe follows the react-globe.gl earth-day-night example.
const DAY_TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';
const NIGHT_TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-night.jpg';

const DAY_NIGHT_VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DAY_NIGHT_FRAGMENT_SHADER = `
  #define PI 3.141592653589793
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform vec2 sunPosition;
  uniform vec2 globeRotation;
  varying vec3 vNormal;
  varying vec2 vUv;

  float toRad(in float a) { return a * PI / 180.0; }

  vec3 Polar2Cartesian(in vec2 c) { // [lng, lat]
    float theta = toRad(90.0 - c.x);
    float phi = toRad(90.0 - c.y);
    return vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
  }

  void main() {
    float invLon = toRad(globeRotation.x);
    float invLat = -toRad(globeRotation.y);
    mat3 rotX = mat3(1, 0, 0, 0, cos(invLat), -sin(invLat), 0, sin(invLat), cos(invLat));
    mat3 rotY = mat3(cos(invLon), 0, sin(invLon), 0, 1, 0, -sin(invLon), 0, cos(invLon));
    vec3 rotatedSunDirection = rotX * rotY * Polar2Cartesian(sunPosition);
    float intensity = dot(normalize(vNormal), normalize(rotatedSunDirection));
    vec4 dayColor = texture2D(dayTexture, vUv);
    vec4 nightColor = texture2D(nightTexture, vUv);
    float blendFactor = smoothstep(-0.12, 0.12, intensity);
    gl_FragColor = mix(nightColor, dayColor, blendFactor);
  }
`;

/** Subsolar point [lng, lat] in degrees: where the Sun is directly overhead right now. */
function subsolarPoint(date: Date): [number, number] {
  const dayMs = 86_400_000;
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - yearStart) / dayMs; // fractional, 1..366
  const declination = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10)); // latitude
  const b = (2 * Math.PI / 364) * (dayOfYear - 81);
  const equationOfTimeMin = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let longitude = -15 * (utcHours - 12 + equationOfTimeMin / 60);
  longitude = ((longitude + 180) % 360 + 360) % 360 - 180; // normalize to [-180, 180]
  return [longitude, declination];
}

const canCreateWebGLContext = () => {
  if (typeof document === 'undefined') return false;

  const canvas = document.createElement('canvas');

  try {
    const context = (
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')
    ) as WebGLRenderingContext | WebGL2RenderingContext | null;

    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
};

type GlobeComponentType = React.ComponentType<
  GlobeProps & { ref?: React.MutableRefObject<GlobeMethods | undefined> }
>;

type SatellitePoint = {
  name: string;
  lat: number;
  lng: number;
  alt: number;
  isSelected: boolean;
  tle: SatelliteTLE | null;
};

type OrbitPathPoint = [number, number, number];
type OrbitPathDatum = { coords: OrbitPathPoint[] };
type WorldAtlasTopology = Topology<{ countries: GeometryObject }>;

interface GlobeViewProps {
  tles: SatelliteTLE[];
  propagatedSatellites: PropagatedSatelliteData[];
  orbitPathPoints: OrbitPathPoint[];
  showCount: string;
}

const GlobeUnavailable: React.FC<{ message: string; showCount: string }> = ({ message, showCount }) => (
  <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_center,rgba(14,116,144,0.12),rgba(2,6,23,0.96)_58%)] p-6">
    <div className="max-w-md rounded border border-amber-500/25 bg-slate-950/70 p-5 text-center shadow-2xl shadow-black/30">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded border border-amber-500/35 bg-amber-500/10 text-amber-300">
        <TriangleAlert className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-amber-300">
        Earth Orbit View Unavailable
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">
        {message}
      </p>
      <div className="mt-4 rounded border border-slate-800 bg-slate-950/70 px-3 py-2 text-[10px] font-mono text-slate-500">
        {showCount}
      </div>
    </div>
  </div>
);

export const GlobeView: React.FC<GlobeViewProps> = ({
  tles,
  propagatedSatellites,
  orbitPathPoints,
  showCount,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [GlobeComponent, setGlobeComponent] = useState<GlobeComponentType | null>(null);
  const [globeError, setGlobeError] = useState<string | null>(null);
  const [worldPolygons, setWorldPolygons] = useState<object[]>([]);
  const [worldError, setWorldError] = useState<string | null>(null);
  const [dims, setDims] = useState({ w: 900, h: 620 });
  // Day/night material is created once, on the client only (TextureLoader needs the browser).
  const [globeMaterial] = useState<THREE.ShaderMaterial | null>(() => {
    if (typeof window === 'undefined') return null;
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';
    return new THREE.ShaderMaterial({
      uniforms: {
        dayTexture: { value: loader.load(DAY_TEXTURE_URL) },
        nightTexture: { value: loader.load(NIGHT_TEXTURE_URL) },
        sunPosition: { value: new THREE.Vector2() },
        globeRotation: { value: new THREE.Vector2(60, 12) }, // matches the initial point-of-view
      },
      vertexShader: DAY_NIGHT_VERTEX_SHADER,
      fragmentShader: DAY_NIGHT_FRAGMENT_SHADER,
    });
  });
  const materialRef = useRef<THREE.ShaderMaterial | null>(globeMaterial);
  const { selectedTle, setSelectedTle } = useSatelliteSelection();

  // Dynamic import — globe.gl requires browser APIs
  useEffect(() => {
    let isMounted = true;

    if (!canCreateWebGLContext()) {
      const timeout = window.setTimeout(() => {
        if (isMounted) {
          setGlobeError('The browser could not create a WebGL context for the 3D globe.');
        }
      }, 0);

      return () => {
        isMounted = false;
        window.clearTimeout(timeout);
      };
    }

    import('react-globe.gl')
      .then(mod => {
        if (isMounted) setGlobeComponent(() => mod.default as GlobeComponentType);
      })
      .catch(() => {
        if (isMounted) setGlobeError('The 3D globe renderer could not be loaded.');
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Load world-atlas TopoJSON from CDN (static dataset, one-time load)
  useEffect(() => {
    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(topo => {
        const topoData = topo as WorldAtlasTopology;
        const geo = feature(topoData, topoData.objects.countries);
        setWorldPolygons('features' in geo ? geo.features : [geo]);
      })
      .catch(() => setWorldError('Country borders unavailable'));
  }, []);

  // Keep the lit hemisphere on the real subsolar point, refreshed each minute.
  useEffect(() => {
    if (!globeMaterial) return;
    const applySun = () => {
      const [lng, lat] = subsolarPoint(new Date());
      globeMaterial.uniforms.sunPosition.value.set(lng, lat);
    };
    applySun();
    const intervalId = window.setInterval(applySun, 60_000);
    return () => {
      window.clearInterval(intervalId);
      globeMaterial.dispose();
    };
  }, [globeMaterial]);

  const updateDimensions = useCallback(() => {
    const el = containerRef.current;
    if (!el) return null;

    const rect = el.getBoundingClientRect();
    const next = {
      w: Math.max(MIN_CANVAS_SIZE, Math.floor(rect.width)),
      h: Math.max(MIN_CANVAS_SIZE, Math.floor(rect.height)),
    };

    setDims(prev => (prev.w === next.w && prev.h === next.h ? prev : next));
    return next;
  }, []);

  // Resize observer
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    updateDimensions();
    const animationFrame = requestAnimationFrame(() => updateDimensions());

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      const next = {
        w: Math.max(MIN_CANVAS_SIZE, Math.floor(width)),
        h: Math.max(MIN_CANVAS_SIZE, Math.floor(height)),
      };
      setDims(prev => (prev.w === next.w && prev.h === next.h ? prev : next));
    });

    ro.observe(el);
    return () => {
      cancelAnimationFrame(animationFrame);
      ro.disconnect();
    };
    // GlobeComponent is in the deps so this re-runs once the globe finishes its dynamic
    // import and the container mounts — otherwise the observer never attaches and the
    // canvas keeps the initial 900px width (rendering the globe pinned to the left).
  }, [updateDimensions, GlobeComponent]);

  const cameraAltitude = useMemo(() => {
    const aspect = dims.w / Math.max(dims.h, MIN_CANVAS_SIZE);
    if (aspect >= 1.8) return 1.6;
    if (aspect >= 1.35) return 1.85;
    return 2.05;
  }, [dims.h, dims.w]);

  const frameGlobe = useCallback((transitionMs = 0) => {
    const globe = globeRef.current;
    if (!globe) return;

    const controls = globe.controls();
    controls.enablePan = false;
    controls.enableDamping = true;
    globe.pointOfView({ lat: 12, lng: 60, altitude: cameraAltitude }, transitionMs);
  }, [cameraAltitude]);

  useEffect(() => {
    frameGlobe(350);
  }, [dims.h, dims.w, frameGlobe]);

  // Build satellite point objects from propagated data
  const satellitePoints = useMemo(() => {
    return propagatedSatellites
      .filter(d => d.positionAvailable && d.latitude !== null && d.longitude !== null && d.altitudeKm !== null)
      .map(d => ({
        name: d.satelliteName,
        lat: d.latitude as number,
        lng: d.longitude as number,
        // Normalize altitude: scale up slightly for visual clarity
        alt: Math.max(0.02, (d.altitudeKm as number) / EARTH_RADIUS_KM),
        isSelected: selectedTle?.name === d.satelliteName,
        tle: tles.find(t => t.name === d.satelliteName) ?? null,
      }));
  }, [propagatedSatellites, selectedTle, tles]);

  // Orbit path for selected satellite only
  const pathsData = useMemo(() => {
    if (orbitPathPoints.length < 2) return [];
    return [{ coords: orbitPathPoints.map(([lat, lng, alt]) => [lat, lng, alt]) }];
  }, [orbitPathPoints]) satisfies OrbitPathDatum[];

  const handlePointClick = useCallback((point: SatellitePoint) => {
    if (point?.tle) setSelectedTle(point.tle);
  }, [setSelectedTle]);

  const readPathCoordinate = (point: unknown, index: number) => {
    return Array.isArray(point) && typeof point[index] === 'number' ? point[index] : 0;
  };

  if (globeError) {
    return <GlobeUnavailable message={globeError} showCount={showCount} />;
  }

  if (!GlobeComponent) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <span className="text-xs font-mono text-slate-500 uppercase tracking-widest">Initialising globe…</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full min-w-0 overflow-hidden">
      {worldError && (
        <div className="absolute top-2 left-2 z-20 text-[10px] font-mono text-amber-400 bg-slate-900/90 px-2 py-1 rounded border border-amber-800/50">
          {worldError}
        </div>
      )}

      {/* Satellite count label */}
      <div className="absolute bottom-2 left-2 z-20 text-[10px] font-mono text-slate-400 bg-slate-900/80 px-2 py-1 rounded">
        {showCount}
      </div>

      {/* Orbit path disclaimer */}
      {orbitPathPoints.length > 0 && (
        <div className="absolute bottom-2 right-2 z-20 text-[10px] font-mono text-cyan-400/60 bg-slate-900/80 px-2 py-1 rounded">
          TLE-derived propagated path
        </div>
      )}

      <GlobeComponent
        ref={globeRef}
        width={dims.w}
        height={dims.h}
        globeOffset={[0, 0]}
        backgroundColor="rgba(2,6,23,1)"
        globeMaterial={globeMaterial ?? undefined}
        onZoom={(pov: { lat: number; lng: number; altitude: number }) => {
          const material = materialRef.current;
          if (material && pov) material.uniforms.globeRotation.value.set(pov.lng, pov.lat);
        }}
        atmosphereColor="#1e4080"
        atmosphereAltitude={0.18}
        polygonsData={worldPolygons}
        // Transparent cap/side + a small lift keep country borders as thin outlines floating
        // just above the surface — no fill over the day/night texture, and no z-fighting flicker.
        polygonCapColor={() => 'rgba(0,0,0,0)'}
        polygonSideColor={() => 'rgba(0,0,0,0)'}
        polygonStrokeColor={() => 'rgba(140,180,255,0.45)'}
        polygonAltitude={0.006}
        onGlobeReady={() => frameGlobe(0)}
        pointsData={satellitePoints}
        pointLat="lat"
        pointLng="lng"
        pointAltitude="alt"
        pointColor={(point) => (point as SatellitePoint).isSelected ? '#22d3ee' : '#38bdf8'}
        pointRadius={(point) => (point as SatellitePoint).isSelected ? 0.7 : 0.35}
        pointLabel={(point) => {
          const satellite = point as SatellitePoint;
          return `<div style="background:#0f172a;border:1px solid #334155;padding:4px 8px;border-radius:4px;font-family:monospace;font-size:11px;color:#e2e8f0">${satellite.name}</div>`;
        }}
        onPointClick={(point) => handlePointClick(point as SatellitePoint)}
        pathsData={pathsData}
        pathPoints="coords"
        pathPointLat={(point) => readPathCoordinate(point, 0)}
        pathPointLng={(point) => readPathCoordinate(point, 1)}
        pathPointAlt={(point) => readPathCoordinate(point, 2)}
        pathColor={() => '#22d3ee50'}
        pathStroke={1.5}
        enablePointerInteraction={true}
      />
    </div>
  );
};
