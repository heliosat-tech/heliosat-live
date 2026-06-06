"use client";

import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, Line, OrbitControls, Stars } from '@react-three/drei';
import { ChevronDown, Clock3, Orbit, RadioTower, Satellite, Sun } from 'lucide-react';
import type {
  HistoricOrbitTrack,
  HistoricOrbitTrackPoint,
  HistoricPlotsSnapshot,
} from '@/services/historicPlotService';
import {
  EARTH_RADIUS,
  GEO_RADIUS,
  L1_X,
  EarthModel,
  SunVector,
  circlePoints,
} from './InSituOrbitScene';

interface HistoricOrbitSceneProps {
  snapshot: HistoricPlotsSnapshot | null;
  isLoading: boolean;
}

type TimelineBounds = {
  startMs: number;
  stopMs: number;
};

type HistoricTrackRenderItem = {
  track: HistoricOrbitTrack;
  point: HistoricOrbitTrackPoint;
  position: [number, number, number];
};

type GseVisualLayout = {
  centerXKm: number;
  centerYKm: number;
  centerZKm: number;
  scaleKm: number;
};

type TrackVisualLayout =
  | ({ kind: 'L1_GSE' } & GseVisualLayout)
  | {
      kind: 'GEO_GSE';
    }
  | {
      kind: 'GEO_NOMINAL';
      firstMs: number;
      longitudeDeg: number;
    };

type HistoricTrackVisual = {
  track: HistoricOrbitTrack;
  layout: TrackVisualLayout;
  linePoints: Array<[number, number, number]>;
};

const SIDEREAL_DAY_MS = 86_164_090.5;
const FULL_CIRCLE_RADIANS = Math.PI * 2;
const L1_VISUAL_X_RADIUS = 0.5;
const L1_VISUAL_Y_RADIUS = 0.78;
const L1_VISUAL_Z_RADIUS = 0.96;
const GEO_RADIUS_KM = 42157;
const GEO_SCENE_SCALE = GEO_RADIUS / GEO_RADIUS_KM;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, stop: number, t: number) {
  return start + (stop - start) * t;
}

function degreesToRadians(value: number) {
  return value * (Math.PI / 180);
}

function radiansToDegrees(value: number) {
  return value * (180 / Math.PI);
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized).getTime();

  return Number.isNaN(parsed) ? null : parsed;
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

function formatTimestampMs(value: number | null) {
  if (value === null) {
    return 'Not available';
  }

  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function formatTimestamp(value: string | null | undefined) {
  return formatTimestampMs(parseTimestampMs(value));
}

function normalizeTrack(track: HistoricOrbitTrack): HistoricOrbitTrack {
  return {
    ...track,
    points: [...track.points].sort((a, b) => {
      const aMs = parseTimestampMs(a.time_tag) ?? 0;
      const bMs = parseTimestampMs(b.time_tag) ?? 0;

      return aMs - bMs;
    }),
  };
}

function getTimelineBounds(snapshot: HistoricPlotsSnapshot | null, tracks: HistoricOrbitTrack[]): TimelineBounds | null {
  const pointTimes = tracks.flatMap(track => track.points
    .map(point => parseTimestampMs(point.time_tag))
    .filter((value): value is number => value !== null));

  if (pointTimes.length > 0) {
    const startMs = Math.min(...pointTimes);
    const stopMs = Math.max(...pointTimes);

    if (stopMs > startMs) {
      return { startMs, stopMs };
    }
  }

  const rangeStartMs = parseTimestampMs(snapshot?.range.startUtc);
  const rangeStopMs = parseTimestampMs(snapshot?.range.stopUtc);

  if (rangeStartMs === null || rangeStopMs === null || rangeStopMs <= rangeStartMs) {
    return null;
  }

  return {
    startMs: rangeStartMs,
    stopMs: rangeStopMs,
  };
}

function interpolateTrackPoint(points: HistoricOrbitTrackPoint[], timeMs: number) {
  if (points.length === 0) {
    return null;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const firstMs = parseTimestampMs(first.time_tag) ?? 0;
  const lastMs = parseTimestampMs(last.time_tag) ?? firstMs;

  if (timeMs < firstMs || timeMs > lastMs) {
    return null;
  }

  if (timeMs === firstMs) {
    return first;
  }

  if (timeMs === lastMs) {
    return last;
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const currentMs = parseTimestampMs(current.time_tag);
    const nextMs = parseTimestampMs(next.time_tag);

    if (currentMs === null || nextMs === null || nextMs <= currentMs || timeMs < currentMs || timeMs > nextMs) {
      continue;
    }

    const ratio = (timeMs - currentMs) / (nextMs - currentMs);

    return {
      time_tag: new Date(timeMs).toISOString(),
      xKm: lerp(current.xKm, next.xKm, ratio),
      yKm: lerp(current.yKm, next.yKm, ratio),
      zKm: lerp(current.zKm, next.zKm, ratio),
      distanceKm: lerp(current.distanceKm, next.distanceKm, ratio),
      heightKm: lerp(current.heightKm, next.heightKm, ratio),
      sunAxisAngleDeg: lerp(current.sunAxisAngleDeg, next.sunAxisAngleDeg, ratio),
      longitudeDeg: current.longitudeDeg ?? next.longitudeDeg,
    };
  }

  return first;
}

function buildGseVisualLayout(tracks: HistoricOrbitTrack[]): GseVisualLayout | null {
  const points = tracks
    .filter(track => track.frame === 'GSE' && track.orbitRegime === 'L1')
    .flatMap(track => track.points);

  if (points.length === 0) {
    return null;
  }

  const centerXKm = points.reduce((sum, point) => sum + point.xKm, 0) / points.length;
  const centerYKm = points.reduce((sum, point) => sum + point.yKm, 0) / points.length;
  const centerZKm = points.reduce((sum, point) => sum + point.zKm, 0) / points.length;
  const scaleKm = Math.max(
    1,
    ...points.map(point => Math.max(
      Math.abs(point.xKm - centerXKm),
      Math.abs(point.yKm - centerYKm),
      Math.abs(point.zKm - centerZKm),
    )),
  );

  return {
    centerXKm,
    centerYKm,
    centerZKm,
    scaleKm,
  };
}

function buildTrackLayout(track: HistoricOrbitTrack, gseLayout: GseVisualLayout | null): TrackVisualLayout {
  if (track.orbitRegime === 'GEO' && track.frame === 'GSE') {
    return {
      kind: 'GEO_GSE',
    };
  }

  if (track.orbitRegime === 'GEO') {
    return {
      kind: 'GEO_NOMINAL',
      firstMs: parseTimestampMs(track.points[0]?.time_tag) ?? 0,
      longitudeDeg: track.points.find(point => point.longitudeDeg !== null)?.longitudeDeg
        ?? radiansToDegrees(Math.atan2(track.points[0]?.yKm ?? 0, track.points[0]?.xKm ?? 1)),
    };
  }

  return {
    kind: 'L1_GSE',
    ...(gseLayout ?? {
      centerXKm: track.points[0]?.xKm ?? 0,
      centerYKm: track.points[0]?.yKm ?? 0,
      centerZKm: track.points[0]?.zKm ?? 0,
      scaleKm: 1,
    }),
  };
}

function scenePositionFromPoint(visual: HistoricTrackVisual, point: HistoricOrbitTrackPoint): [number, number, number] {
  if (visual.layout.kind === 'GEO_NOMINAL') {
    const pointMs = parseTimestampMs(point.time_tag) ?? visual.layout.firstMs;
    const elapsedOrbitRadians = ((pointMs - visual.layout.firstMs) / SIDEREAL_DAY_MS) * FULL_CIRCLE_RADIANS;
    const longitudeRad = degreesToRadians(visual.layout.longitudeDeg) + elapsedOrbitRadians;

    return [
      Math.cos(longitudeRad) * GEO_RADIUS,
      0,
      Math.sin(longitudeRad) * GEO_RADIUS,
    ];
  }

  if (visual.layout.kind === 'GEO_GSE') {
    return [
      point.xKm * GEO_SCENE_SCALE,
      point.zKm * GEO_SCENE_SCALE,
      -point.yKm * GEO_SCENE_SCALE,
    ];
  }

  const dx = point.xKm - visual.layout.centerXKm;
  const dy = point.yKm - visual.layout.centerYKm;
  const dz = point.zKm - visual.layout.centerZKm;

  return [
    L1_X + clamp((dx / visual.layout.scaleKm) * L1_VISUAL_X_RADIUS, -L1_VISUAL_X_RADIUS, L1_VISUAL_X_RADIUS),
    clamp((dz / visual.layout.scaleKm) * L1_VISUAL_Y_RADIUS, -L1_VISUAL_Y_RADIUS, L1_VISUAL_Y_RADIUS),
    clamp((-dy / visual.layout.scaleKm) * L1_VISUAL_Z_RADIUS, -L1_VISUAL_Z_RADIUS, L1_VISUAL_Z_RADIUS),
  ];
}

function buildTrackVisual(track: HistoricOrbitTrack, gseLayout: GseVisualLayout | null): HistoricTrackVisual {
  const visual = {
    track,
    layout: buildTrackLayout(track, gseLayout),
    linePoints: [],
  } satisfies Omit<HistoricTrackVisual, 'linePoints'> & { linePoints: Array<[number, number, number]> };

  return {
    ...visual,
    linePoints: track.points.map(point => scenePositionFromPoint(visual, point)),
  };
}

function HistoricOrbitCanvas({
  visuals,
  items,
}: {
  visuals: HistoricTrackVisual[];
  items: HistoricTrackRenderItem[];
}) {
  const tracks = visuals.map(visual => visual.track);
  const hasL1Tracks = tracks.some(track => track.orbitRegime === 'L1');
  const hasGeoTracks = tracks.some(track => track.orbitRegime === 'GEO');

  return (
    <Canvas camera={{ position: [0.1, 1.1, 6.1], fov: 45 }}>
      <color attach="background" args={['#020617']} />
      <Stars radius={80} depth={40} count={1000} factor={3} saturation={0} fade speed={0} />
      <ambientLight intensity={0.2} color="#bae6fd" />
      <SunVector />
      <EarthModel />

      {(hasGeoTracks || tracks.length === 0) && (
        <>
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
        </>
      )}

      {hasL1Tracks && (
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
      )}

      {visuals
        .map(visual => (
          <Line
            key={`historic-track-${visual.track.id}`}
            points={visual.linePoints}
            color={visual.track.color}
            lineWidth={visual.track.orbitRegime === 'GEO' ? 1.55 : 1.35}
            transparent
            opacity={visual.track.orbitRegime === 'GEO' ? 0.58 : 0.52}
          />
        ))}

      {items.map((item, index) => (
        <group key={`historic-marker-${item.track.id}`} position={item.position}>
          <mesh>
            <sphereGeometry args={[item.track.orbitRegime === 'GEO' ? 0.052 : 0.045, 22, 22]} />
            <meshBasicMaterial color={item.track.color} transparent opacity={0.96} />
          </mesh>
          <Html distanceFactor={7} position={[0, -0.18 - (index % 2) * 0.04, 0]} center>
            <div className="whitespace-nowrap rounded border border-cyan-300/35 bg-slate-950/90 px-2 py-1 text-[9px] font-mono text-slate-100 shadow-lg shadow-black/25">
              {item.track.spacecraftName}
            </div>
          </Html>
        </group>
      ))}

      <mesh>
        <sphereGeometry args={[EARTH_RADIUS + 0.18, 48, 48]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.02} />
      </mesh>

      <OrbitControls
        enablePan={false}
        minDistance={3.1}
        maxDistance={8}
      />
    </Canvas>
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

function HistoricOrbitRow({ item }: { item: HistoricTrackRenderItem }) {
  const { track, point } = item;

  return (
    <details className="group min-w-0 rounded-md border border-slate-800 bg-slate-950/45">
      <summary className="flex min-w-0 cursor-pointer list-none items-start justify-between gap-3 p-3 marker:hidden">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_12px_currentColor]"
            style={{ color: track.color, backgroundColor: track.color }}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-100">{track.spacecraftName}</div>
            <div className="mt-1 truncate font-mono text-[10px] text-slate-500" title={track.source}>
              {track.frame} - {track.source}
            </div>
          </div>
        </div>
        <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>

      <div className="border-t border-slate-800/80 px-3 pb-3 pt-2">
        <div className="grid grid-cols-2 gap-2">
          <GeometryField label="Height" value={formatKm(point.heightKm)} />
          <GeometryField label="Sun-axis angle" value={formatAngle(point.sunAxisAngleDeg)} />
          <GeometryField label="Earth center" value={formatKm(point.distanceKm)} />
          <GeometryField label="Samples" value={formatNumber(track.points.length)} />
        </div>

        {track.frame === 'GSE' ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <GeometryField label="X GSE" value={formatKm(point.xKm)} />
            <GeometryField label="Y GSE" value={formatKm(point.yKm)} />
            <GeometryField label="Z GSE" value={formatKm(point.zKm)} />
          </div>
        ) : (
          <div className="mt-2">
            <GeometryField label="Longitude" value={formatLongitude(point.longitudeDeg)} />
          </div>
        )}

        <div className="mt-2 rounded border border-slate-800 bg-slate-950/55 p-2">
          <div className="font-mono text-[9px] uppercase text-slate-600">
            Replay time
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-slate-400">
            {formatTimestamp(point.time_tag)}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {track.note}
          </p>
        </div>
      </div>
    </details>
  );
}

function HistoricOrbitSceneContent({ snapshot, isLoading }: HistoricOrbitSceneProps) {
  const [sliderValue, setSliderValue] = useState(1000);
  const tracks = useMemo(
    () => (snapshot?.orbitTracks ?? [])
      .filter(track => track.points.length > 0)
      .map(normalizeTrack),
    [snapshot],
  );
  const gseLayout = useMemo(
    () => buildGseVisualLayout(tracks),
    [tracks],
  );
  const visuals = useMemo(
    () => tracks.map(track => buildTrackVisual(track, gseLayout)),
    [gseLayout, tracks],
  );
  const timeline = useMemo(() => getTimelineBounds(snapshot, tracks), [snapshot, tracks]);
  const currentTimeMs = timeline
    ? timeline.startMs + (timeline.stopMs - timeline.startMs) * (sliderValue / 1000)
    : null;
  const currentItems = useMemo(() => {
    if (currentTimeMs === null) {
      return [];
    }

    return visuals
      .map(visual => {
        const point = interpolateTrackPoint(visual.track.points, currentTimeMs);

        return point
          ? {
              track: visual.track,
              point,
              position: scenePositionFromPoint(visual, point),
            }
          : null;
      })
      .filter((item): item is HistoricTrackRenderItem => Boolean(item));
  }, [currentTimeMs, visuals]);
  const l1Count = tracks.filter(track => track.orbitRegime === 'L1').length;
  const geoCount = tracks.filter(track => track.orbitRegime === 'GEO').length;

  return (
    <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Orbit className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold uppercase text-slate-300">
              Historic orbit replay
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] uppercase text-slate-500">
              Selected UTC window, satellite tracks, and Sun-facing Earth
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 font-mono text-[10px] uppercase text-cyan-100">
            {tracks.length} tracks
          </span>
          <span className="rounded border border-slate-700 bg-slate-950/70 px-2 py-1 font-mono text-[10px] uppercase text-slate-400">
            {formatTimestampMs(currentTimeMs)}
          </span>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative h-[380px] min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950 sm:h-[440px]">
          <HistoricOrbitCanvas visuals={visuals} items={currentItems} />
          {isLoading && (
            <div className="absolute right-3 top-3 rounded border border-cyan-400/25 bg-slate-950/85 px-2 py-1 font-mono text-[10px] uppercase text-cyan-100 shadow-lg shadow-black/30">
              Loading orbit tracks
            </div>
          )}
        </div>

        <aside className="min-w-0 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center gap-1.5 text-[10px] uppercase text-slate-500">
                <RadioTower className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />
                L1
              </div>
              <div className="mt-2 font-mono text-lg text-slate-100">{l1Count}</div>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center gap-1.5 text-[10px] uppercase text-slate-500">
                <Satellite className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
                GEO
              </div>
              <div className="mt-2 font-mono text-lg text-slate-100">{geoCount}</div>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center gap-1.5 text-[10px] uppercase text-slate-500">
                <Sun className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                Light
              </div>
              <div className="mt-2 font-mono text-lg text-amber-100">UTC</div>
            </div>
          </div>

          <div className="rounded-md border border-slate-800 bg-slate-950/45 p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-slate-500">
              <Clock3 className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />
              Range
            </div>
            <div className="mt-2 grid gap-1 font-mono text-[10px] text-slate-400">
              <span>{formatTimestampMs(timeline?.startMs ?? null)}</span>
              <span>{formatTimestampMs(timeline?.stopMs ?? null)}</span>
            </div>
          </div>

          <div className="space-y-2">
            {currentItems.map(item => (
              <HistoricOrbitRow key={item.track.id} item={item} />
            ))}
            {tracks.length === 0 && (
              <div className="rounded-md border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-500">
                No historical orbit vectors are available for this source and time window.
              </div>
            )}
            {tracks.length > 0 && currentItems.length === 0 && (
              <div className="rounded-md border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100/80">
                No spacecraft has ephemeris coverage at this scrubber time.
              </div>
            )}
          </div>
        </aside>
      </div>

      {timeline && tracks.length > 0 && (
        <div className="mt-4 rounded-md border border-slate-800 bg-slate-950/45 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="font-mono text-[10px] uppercase text-slate-500">
              Orbit time scrubber
            </div>
            <div className="font-mono text-[10px] uppercase text-cyan-100">
              {formatTimestampMs(currentTimeMs)}
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={sliderValue}
            onChange={event => setSliderValue(Number(event.target.value))}
            className="h-2 w-full cursor-pointer accent-cyan-300"
            aria-label="Historic orbit time"
          />
          <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[9px] uppercase text-slate-500">
            <span className="truncate">{formatTimestampMs(timeline.startMs)}</span>
            <span className="truncate text-right">{formatTimestampMs(timeline.stopMs)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

export function HistoricOrbitScene(props: HistoricOrbitSceneProps) {
  return (
    <HistoricOrbitSceneContent
      key={props.snapshot?.generatedAtUtc ?? 'empty'}
      {...props}
    />
  );
}
