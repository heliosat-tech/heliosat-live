"use client";
import React, { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect } from 'react';
import * as THREE from 'three';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { feature } from 'topojson-client';
import type { GlobeMethods, GlobeProps } from 'react-globe.gl';
import type { GeometryObject, Topology } from 'topojson-specification';
import type { SatelliteTLE } from '@/services/celestrakService';
import type { PropagatedSatelliteData } from '@/services/satellitePropagationService';
import { getSubsolarPoint, normalizeLongitude } from '@/services/solarPositionService';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';

const EARTH_RADIUS_KM = 6371;
const MIN_CANVAS_SIZE = 1;
// Earth's axial tilt (obliquity of the ecliptic): the angle between the spin axis and the
// normal to the orbital (ecliptic) plane.
const EARTH_OBLIQUITY_DEG = 23.44;
// Drag sensitivity (radians of spin about the tilted axis per pixel) in axial-tilt mode.
const AXIAL_DRAG_SENSITIVITY = 0.008;

// Day/night illumination: a custom globe material that blends a daytime texture on the
// Sun-facing hemisphere with the night-lights texture on the dark side, smoothly across the
// terminator. The shader uses the sphere's local normal so the shadow stays locked to the
// texture/geography as the presentation rotates. three-globe internally rotates the base
// Earth mesh -90deg around Y to put Greenwich on its geographic +Z axis; compensate for that
// when passing the subsolar longitude into the shader.
const DAY_TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';
const NIGHT_TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-night.jpg';
const THREE_GLOBE_MESH_LONGITUDE_OFFSET_DEG = 90;

const DAY_NIGHT_VERTEX_SHADER = `
  varying vec3 vLocalNormal;
  varying vec2 vUv;
  void main() {
    vLocalNormal = normalize(normal); // object-space normal (the geographic direction)
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DAY_NIGHT_FRAGMENT_SHADER = `
  #define PI 3.141592653589793
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform vec2 sunPosition;
  varying vec3 vLocalNormal;
  varying vec2 vUv;

  float toRad(in float a) { return a * PI / 180.0; }

  vec3 Polar2Cartesian(in vec2 c) { // [lng, lat]
    float theta = toRad(90.0 - c.x);
    float phi = toRad(90.0 - c.y);
    return vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
  }

  void main() {
    // Both vectors are in the globe's geographic frame, so the lit hemisphere is anchored to
    // the real subsolar point and is invariant to camera orbit and to the globe's tilt/spin.
    float intensity = dot(normalize(vLocalNormal), Polar2Cartesian(sunPosition));
    vec4 dayColor = texture2D(dayTexture, vUv);
    vec4 nightColor = texture2D(nightTexture, vUv);
    float blendFactor = smoothstep(-0.12, 0.12, intensity);
    gl_FragColor = mix(nightColor, dayColor, blendFactor);
  }
`;

function globeMeshSunPosition(date: Date): [number, number] {
  const subsolar = getSubsolarPoint(date);
  return [
    normalizeLongitude(subsolar.longitudeDeg + THREE_GLOBE_MESH_LONGITUDE_OFFSET_DEG),
    subsolar.latitudeDeg,
  ];
}

// Geographic (lng, lat) → unit direction in the globe's local frame, using the same convention
// as the day/night shader's Polar2Cartesian (and three-globe's vertex normals). This lets us
// orient the globe so the real subsolar direction lands exactly where the texture is lit.
function geoToLocalDirection(lng: number, lat: number): THREE.Vector3 {
  const theta = THREE.MathUtils.degToRad(90 - lng);
  const phi = THREE.MathUtils.degToRad(90 - lat);
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  );
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
interface OrbitPath { coords: OrbitPathPoint[]; isSelected: boolean }
type WorldAtlasTopology = Topology<{ countries: GeometryObject }>;

interface GlobeViewProps {
  tles: SatelliteTLE[];
  propagatedSatellites: PropagatedSatelliteData[];
  orbitPaths: OrbitPath[];
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
  orbitPaths = [],
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
      },
      vertexShader: DAY_NIGHT_VERTEX_SHADER,
      fragmentShader: DAY_NIGHT_FRAGMENT_SHADER,
    });
  });
  // Axis-lock mode: 'off' = free orbit; 'tilted' = real obliquity (23.44°); 'vertical' = 0°
  // (upright axis → the day-side terminator shows perfectly vertical).
  const [axialMode, setAxialMode] = useState<'off' | 'tilted' | 'vertical'>('off');
  const axisLineRef = useRef<THREE.Line | null>(null);
  const spinAngleRef = useRef(0);
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
      const [lng, lat] = globeMeshSunPosition(new Date());
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

  // Axial-tilt mode: tilt the globe to the real obliquity (visible + fixed) and let the user
  // spin it ONLY about that tilted axis by dragging horizontally — the axis stays put and a
  // thin line marks it. Free orbiting is disabled while active and restored on toggle off.
  useEffect(() => {
    let cached: THREE.Object3D | null = null;
    const getGlobeObject = (): THREE.Object3D | null => {
      if (cached) return cached;
      const scene = globeRef.current?.scene();
      if (!scene) return null;
      // The three-globe object is the scene descendant exposing a globeMaterial() method.
      scene.traverse(child => {
        if (!cached && typeof (child as { globeMaterial?: unknown }).globeMaterial === 'function') {
          cached = child;
        }
      });
      return cached;
    };
    const removeAxisLine = () => {
      const line = axisLineRef.current;
      if (line?.parent) line.parent.remove(line);
    };
    const controls = globeRef.current?.controls();

    if (axialMode === 'off') {
      getGlobeObject()?.quaternion.identity();
      removeAxisLine();
      if (controls) controls.enableRotate = true;
      return;
    }

    if (controls) controls.enableRotate = false; // the drag below provides the constrained spin
    spinAngleRef.current = 0;

    const isVertical = axialMode === 'vertical';
    const { longitudeDeg: sunLng, latitudeDeg: sunLat } = getSubsolarPoint(new Date());

    // Camera alignment so the day/night terminator splits the disc cleanly:
    //  - 'tilted': look edge-on to the terminator longitude (the line ends up rolled by the season).
    //  - 'vertical': look straight on (+Z); paired with the orientation below the terminator lands
    //    exactly vertical and centred.
    const globeForAlign = globeRef.current;
    if (globeForAlign) {
      const current = globeForAlign.pointOfView();
      globeForAlign.pointOfView(
        isVertical
          ? { lat: 0, lng: 0, altitude: current.altitude }
          : { lat: 0, lng: sunLng + 90, altitude: current.altitude },
        800,
      );
    }

    // Orientation strategy:
    //  - 'tilted': fixed obliquity tilt about Z; the user spins about the (tilted) local Y axis.
    //  - 'vertical': rotate so the subsolar direction faces world +X (camera right) → the
    //    terminator falls in the YZ plane = an exactly vertical day/night line; the user then
    //    spins about the world Y axis, so the lit geography rides along with the spin.
    const tilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      THREE.MathUtils.degToRad(EARTH_OBLIQUITY_DEG),
    );
    const alignToTerminator = (() => {
      const sun = geoToLocalDirection(sunLng, sunLat); // local subsolar direction
      const pole = new THREE.Vector3(0, 1, 0);
      const polePerp = pole.clone().addScaledVector(sun, -pole.dot(sun)).normalize();
      // makeBasis maps world {X,Y,Z} → {sun, polePerp, sun×polePerp}; its inverse rotates the
      // local subsolar direction to +X while keeping the north pole pointing upward.
      const basis = new THREE.Matrix4().makeBasis(
        sun, polePerp, new THREE.Vector3().crossVectors(sun, polePerp),
      );
      return new THREE.Quaternion().setFromRotationMatrix(basis.invert());
    })();
    const spinAxis = new THREE.Vector3(0, 1, 0);
    const spinQuat = new THREE.Quaternion();

    const ensureAxisLine = (parent: THREE.Object3D) => {
      if (!axisLineRef.current) {
        const radius = globeRef.current?.getGlobeRadius() ?? 100;
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, -1.35 * radius, 0),
          new THREE.Vector3(0, 1.35 * radius, 0),
        ]);
        const material = new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.75 });
        axisLineRef.current = new THREE.Line(geometry, material);
      }
      if (axisLineRef.current.parent !== parent) parent.add(axisLineRef.current);
    };

    let frame = 0;
    const tick = () => {
      // Re-assert each frame so a globe re-render can't re-enable free orbit while active.
      const liveControls = globeRef.current?.controls();
      if (liveControls) liveControls.enableRotate = false;
      const globeObject = getGlobeObject();
      if (globeObject) {
        spinQuat.setFromAxisAngle(spinAxis, spinAngleRef.current);
        if (isVertical) {
          // q = spin(worldY) * align → vertical terminator at angle 0; spinning turns the globe
          // (and its geography-locked day/night) about the world vertical axis.
          globeObject.quaternion.copy(spinQuat).multiply(alignToTerminator);
          // Spin axis is world Y, so the axis line lives in world space (the scene) and stays
          // vertical while the globe turns under it — marking the vertical day/night line.
          const scene = globeRef.current?.scene();
          if (scene) ensureAxisLine(scene);
        } else {
          // q = tilt * spin(userAngle) → the user spins about the local (tilted) Y axis only.
          globeObject.quaternion.copy(tilt).multiply(spinQuat);
          ensureAxisLine(globeObject);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    // Horizontal drag over the globe spins it about the tilted axis (vertical drag ignored).
    let dragging = false;
    let lastX = 0;
    const onDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) return;
      dragging = true;
      lastX = e.clientX;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      spinAngleRef.current += (e.clientX - lastX) * AXIAL_DRAG_SENSITIVITY;
      lastX = e.clientX;
    };
    const onUp = () => { dragging = false; };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      getGlobeObject()?.quaternion.identity();
      removeAxisLine();
      if (controls) controls.enableRotate = true;
    };
  }, [axialMode]);

  // Persistent marker objects keyed by satellite name. three-globe keys points by datum object
  // identity, so to make a marker glide between the ~1 Hz position updates we hand it back the
  // same object reference each update and mutate its lat/lng/alt. This cache is not render state;
  // useState only gives it a stable lifetime without reading a ref during render.
  const [pointCache] = useState(() => new Map<string, SatellitePoint>());

  // Build satellite point objects from propagated data, reusing cached references so motion is
  // continuous. A new array is returned each tick (so react-globe.gl re-digests) but it holds the
  // SAME per-satellite objects, which is what lets three-globe tween position instead of re-entering.
  const satellitePoints = useMemo(() => {
    const cache = pointCache;
    const live = new Set<string>();
    const points: SatellitePoint[] = [];

    for (const d of propagatedSatellites) {
      if (!d.positionAvailable || d.latitude === null || d.longitude === null || d.altitudeKm === null) continue;
      const lat = d.latitude;
      const lng = d.longitude;
      // Normalize altitude: scale up slightly for visual clarity.
      const alt = Math.max(0.02, d.altitudeKm / EARTH_RADIUS_KM);

      const existing = cache.get(d.satelliteName);
      // Antimeridian guard: a >180° longitude jump means the ground track wrapped past the date
      // line. Tweening across it would streak the marker over the whole globe in one second, so
      // we drop the cached object and let a fresh one re-appear at the new spot (a brief snap on
      // that rare crossing, instead of a long sweep). Normal updates always reuse → smooth glide.
      const wrapped = existing && Math.abs(lng - existing.lng) > 180;
      const point: SatellitePoint = existing && !wrapped
        ? existing
        : { name: d.satelliteName, lat, lng, alt, isSelected: false, tle: null };

      point.lat = lat;
      point.lng = lng;
      point.alt = alt;
      point.isSelected = selectedTle?.name === d.satelliteName;
      point.tle = tles.find(t => t.name === d.satelliteName) ?? null;

      cache.set(d.satelliteName, point);
      live.add(d.satelliteName);
      points.push(point);
    }

    // Forget markers for satellites that are no longer tracked so three-globe removes their meshes.
    for (const name of cache.keys()) {
      if (!live.has(name)) cache.delete(name);
    }

    return points;
  }, [pointCache, propagatedSatellites, selectedTle, tles]);

  // One orbit loop per tracked satellite; keep only paths with enough points to draw.
  // Defensive against an undefined prop / partial coords (e.g. a stale HMR state).
  const pathsData = useMemo(
    () => (orbitPaths ?? []).filter(path => (path?.coords?.length ?? 0) >= 2),
    [orbitPaths],
  );

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

      {/* Axis-lock toggles: spin about a fixed axis (tilted 23.44° or vertical 0°), aligned to
          the day/night terminator. Selecting one deselects the other. */}
      <div className="absolute right-2 top-2 z-20 flex flex-col items-stretch gap-1.5">
        <button
          type="button"
          onClick={() => setAxialMode(mode => (mode === 'tilted' ? 'off' : 'tilted'))}
          aria-pressed={axialMode === 'tilted'}
          title="Inclina la Tierra a su oblicuidad real (23.44°) y fija el eje: arrastra para girarla solo sobre ese eje. Vuelve a pulsar para rotación libre."
          className={`flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors ${axialMode === 'tilted' ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200' : 'border-slate-700/60 bg-slate-900/80 text-slate-400 hover:border-slate-600/70 hover:text-slate-200'}`}
        >
          <RotateCw className={`h-3 w-3 ${axialMode === 'tilted' ? 'text-cyan-300' : ''}`} aria-hidden="true" />
          Eje 23.4°
        </button>
        <button
          type="button"
          onClick={() => setAxialMode(mode => (mode === 'vertical' ? 'off' : 'vertical'))}
          aria-pressed={axialMode === 'vertical'}
          title="Eje vertical (0°): encara la cara diurna con el terminador perfectamente vertical. Arrastra para girarla sobre el eje vertical. Vuelve a pulsar para rotación libre."
          className={`flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors ${axialMode === 'vertical' ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200' : 'border-slate-700/60 bg-slate-900/80 text-slate-400 hover:border-slate-600/70 hover:text-slate-200'}`}
        >
          <RotateCw className={`h-3 w-3 ${axialMode === 'vertical' ? 'text-cyan-300' : ''}`} aria-hidden="true" />
          Eje 0°
        </button>
      </div>

      {/* Satellite count label */}
      <div className="absolute bottom-2 left-2 z-20 text-[10px] font-mono text-slate-400 bg-slate-900/80 px-2 py-1 rounded">
        {showCount}
      </div>

      {/* Orbit path disclaimer */}
      {orbitPaths.length > 0 && (
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
        // Tween each marker's position between the ~1 Hz updates so it glides along the orbit as a
        // continuous motion. Relies on the stable per-satellite objects above (matched by identity).
        pointsTransitionDuration={1000}
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
        pathColor={(path: object) => ((path as OrbitPath).isSelected ? 'rgba(103,232,249,0.85)' : 'rgba(56,189,248,0.32)')}
        pathStroke={0.8}
        // Orbits are stable; draw instantly (no per-update redraw animation).
        pathTransitionDuration={0}
        enablePointerInteraction={true}
      />
    </div>
  );
};
