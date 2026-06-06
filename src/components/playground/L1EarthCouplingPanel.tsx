"use client";

import { useMemo } from 'react';
import {
  Activity,
  BarChart3,
  Download,
  Gauge,
  RefreshCw,
  Waves,
} from 'lucide-react';
import type {
  CcfMatrixRow,
  CoherencePoint,
  L1EarthCouplingPairDetail,
  L1EarthCouplingSnapshot,
  LagVariabilityPoint,
} from '@/services/l1EarthCouplingService';

interface L1EarthCouplingPanelProps {
  snapshot: L1EarthCouplingSnapshot | null;
  isLoading: boolean;
  error: string | null;
  selectedPairId: string | null;
  onSelectedPairChange: (pairId: string) => void;
  onRefresh: () => void;
}

function formatNumber(value: number | null, maximumFractionDigits = 2) {
  if (value === null) {
    return 'NA';
  }

  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function getHeatmapCellStyle(absCorrelation: number | null) {
  if (absCorrelation === null) {
    return {
      backgroundColor: 'rgba(15, 23, 42, 0.72)',
      borderColor: 'rgba(51, 65, 85, 0.85)',
      color: '#64748b',
    };
  }

  const clampedValue = Math.max(0, Math.min(1, absCorrelation));
  const hue = 8 + clampedValue * 135;
  const alpha = 0.16 + clampedValue * 0.46;

  return {
    backgroundColor: `hsla(${hue}, 78%, 43%, ${alpha})`,
    borderColor: `hsla(${hue}, 72%, 55%, ${0.3 + clampedValue * 0.35})`,
    color: clampedValue >= 0.55 ? '#f8fafc' : '#cbd5e1',
  };
}

function exportTopPairs(snapshot: L1EarthCouplingSnapshot) {
  const payload = {
    generatedAtUtc: snapshot.generatedAtUtc,
    range: snapshot.range,
    topPairs: snapshot.topPairs,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = 'l1-earth-coupling-top-pairs.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function getOptimalCcfPoint(rows: CcfMatrixRow[]) {
  return rows.reduce<CcfMatrixRow | null>((bestRow, row) => {
    if (row.corrPearson === null) {
      return bestRow;
    }

    if (!bestRow || bestRow.corrPearson === null) {
      return row;
    }

    return Math.abs(row.corrPearson) > Math.abs(bestRow.corrPearson) ? row : bestRow;
  }, null);
}

function HeatmapPanel({
  snapshot,
  selectedPairId,
  onSelectedPairChange,
}: {
  snapshot: L1EarthCouplingSnapshot;
  selectedPairId: string | null;
  onSelectedPairChange: (pairId: string) => void;
}) {
  const l1Variables = useMemo(
    () => Array.from(new Set(snapshot.heatmap.map(cell => `${cell.l1Source}.${cell.l1Variable}`))),
    [snapshot],
  );
  const earthVariables = useMemo(
    () => Array.from(new Set(snapshot.heatmap.map(cell => `${cell.earthOrbit}.${cell.earthSource}.${cell.earthVariable}`))),
    [snapshot],
  );
  const cellByCoordinates = useMemo(
    () => new Map(
      snapshot.heatmap.map(cell => [
        `${cell.l1Source}.${cell.l1Variable}|${cell.earthOrbit}.${cell.earthSource}.${cell.earthVariable}`,
        cell,
      ]),
    ),
    [snapshot],
  );

  return (
    <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
              Optimal correlation heatmap
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {snapshot.config.pairCount} configured pairs · {snapshot.config.gridCadenceSeconds}s grid
            </div>
          </div>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
          {formatTimestamp(snapshot.range.startUtc)} - {formatTimestamp(snapshot.range.stopUtc)}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/45">
        <div
          className="grid min-w-[760px]"
          style={{
            gridTemplateColumns: `180px repeat(${earthVariables.length}, minmax(150px, 1fr))`,
          }}
        >
          <div className="border-b border-r border-slate-800 p-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
            L1 variable
          </div>
          {earthVariables.map(earthVariable => (
            <div
              key={earthVariable}
              className="border-b border-r border-slate-800 p-3 text-center font-mono text-[10px] uppercase tracking-widest text-slate-400 last:border-r-0"
            >
              {earthVariable}
            </div>
          ))}

          {l1Variables.map(l1Variable => (
            <div key={l1Variable} className="contents">
              <div className="border-b border-r border-slate-800 p-3 font-mono text-[11px] text-slate-300">
                {l1Variable}
              </div>
              {earthVariables.map(earthVariable => {
                const cell = cellByCoordinates.get(`${l1Variable}|${earthVariable}`);
                const isSelected = cell?.pairId === selectedPairId;

                return (
                  <button
                    key={`${l1Variable}-${earthVariable}`}
                    type="button"
                    disabled={!cell}
                    onClick={() => {
                      if (cell) {
                        onSelectedPairChange(cell.pairId);
                      }
                    }}
                    className={`min-h-20 border-b border-r p-3 text-left transition last:border-r-0 disabled:cursor-not-allowed ${
                      isSelected ? 'ring-1 ring-inset ring-cyan-300/70' : 'hover:ring-1 hover:ring-inset hover:ring-cyan-400/30'
                    }`}
                    style={getHeatmapCellStyle(cell?.absCorrelation ?? null)}
                  >
                    {cell ? (
                      <span className="grid gap-1">
                        <span className="font-mono text-lg font-semibold tabular-nums">
                          {formatNumber(cell.absCorrelation, 2)}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-widest opacity-80">
                          lag {cell.optimalLagMinutes === null ? 'NA' : `${cell.optimalLagMinutes} min`}
                        </span>
                        <span className="font-mono text-[10px] opacity-70">
                          n={cell.sampleCount}
                        </span>
                      </span>
                    ) : (
                      <span className="font-mono text-[10px] uppercase tracking-widest">NA</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CcfChart({ detail }: { detail: L1EarthCouplingPairDetail }) {
  const ccf = detail.ccf;
  const optimal = getOptimalCcfPoint(ccf);

  if (ccf.length === 0 || !optimal) {
    return (
      <div className="flex h-72 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No CCF
      </div>
    );
  }

  const width = 620;
  const height = 230;
  const minLag = Math.min(...ccf.map(point => point.lag));
  const maxLag = Math.max(...ccf.map(point => point.lag));
  const xScale = (lag: number) => ((lag - minLag) / (maxLag - minLag || 1)) * (width - 32) + 16;
  const yScale = (corr: number) => height - ((corr + 1) / 2) * (height - 28) - 14;
  const buildLine = (key: 'corrPearson' | 'corrSpearman') => ccf
    .filter(point => point[key] !== null)
    .map(point => `${xScale(point.lag).toFixed(1)},${yScale(point[key] ?? 0).toFixed(1)}`)
    .join(' ');
  const confidenceRows = ccf.filter(point => point.confidenceLow !== null && point.confidenceHigh !== null);
  const confidencePolygon = confidenceRows.length > 1
    ? [
      ...confidenceRows.map(point => `${xScale(point.lag).toFixed(1)},${yScale(point.confidenceHigh ?? 0).toFixed(1)}`),
      ...confidenceRows.slice().reverse().map(point => `${xScale(point.lag).toFixed(1)},${yScale(point.confidenceLow ?? 0).toFixed(1)}`),
    ].join(' ')
    : '';
  const optimalX = xScale(optimal.lag);

  return (
    <div className="grid gap-3">
      <svg
        aria-hidden="true"
        className="h-72 w-full rounded border border-slate-800 bg-slate-950/50"
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <line stroke="#334155" x1="12" x2={width - 12} y1={yScale(0)} y2={yScale(0)} />
        {confidencePolygon && (
          <polygon fill="#38bdf8" opacity="0.13" points={confidencePolygon} />
        )}
        <polyline
          fill="none"
          points={buildLine('corrPearson')}
          stroke="#22d3ee"
          strokeLinejoin="round"
          strokeWidth="2.4"
        />
        <polyline
          fill="none"
          opacity="0.9"
          points={buildLine('corrSpearman')}
          stroke="#e879f9"
          strokeLinejoin="round"
          strokeWidth="2"
        />
        <line stroke="#f59e0b" strokeDasharray="4 4" strokeWidth="2" x1={optimalX} x2={optimalX} y1="10" y2={height - 10} />
        <text fill="#94a3b8" fontSize="10" x="18" y="18">+1</text>
        <text fill="#94a3b8" fontSize="10" x="18" y={height - 8}>-1</text>
        <text fill="#f59e0b" fontSize="10" x={Math.min(width - 110, optimalX + 6)} y="22">
          lag {optimal.lag} min
        </text>
      </svg>
      <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-widest">
        <span className="rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-cyan-100">
          Pearson {formatNumber(optimal.corrPearson, 3)}
        </span>
        <span className="rounded border border-fuchsia-400/30 bg-fuchsia-400/10 px-2 py-1 text-fuchsia-100">
          Spearman {formatNumber(optimal.corrSpearman, 3)}
        </span>
        <span className="rounded border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-amber-100">
          MI {formatNumber(optimal.mi, 3)}
        </span>
      </div>
    </div>
  );
}

function LagVariabilityChart({ points }: { points: LagVariabilityPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No rolling lag
      </div>
    );
  }

  const width = 620;
  const height = 230;
  const validLagValues = points.map(point => point.lagMinutes).filter((value): value is number => value !== null);
  const windValues = points.map(point => point.windSpeedKmS).filter((value): value is number => value !== null);
  const minLag = validLagValues.length > 0 ? Math.min(...validLagValues) : -30;
  const maxLag = validLagValues.length > 0 ? Math.max(...validLagValues) : 180;
  const minWind = windValues.length > 0 ? Math.min(...windValues) : 0;
  const maxWind = windValues.length > 0 ? Math.max(...windValues) : 1;
  const xScale = (index: number) => (index / Math.max(1, points.length - 1)) * (width - 32) + 16;
  const lagYScale = (value: number) => height - ((value - minLag) / (maxLag - minLag || 1)) * (height - 28) - 14;
  const windYScale = (value: number) => height - ((value - minWind) / (maxWind - minWind || 1)) * (height - 28) - 14;
  const lagLine = points
    .map((point, index) => point.lagMinutes === null ? null : `${xScale(index).toFixed(1)},${lagYScale(point.lagMinutes).toFixed(1)}`)
    .filter(Boolean)
    .join(' ');
  const windLine = points
    .map((point, index) => point.windSpeedKmS === null ? null : `${xScale(index).toFixed(1)},${windYScale(point.windSpeedKmS).toFixed(1)}`)
    .filter(Boolean)
    .join(' ');

  return (
    <div className="grid gap-3">
      <svg
        aria-hidden="true"
        className="h-72 w-full rounded border border-slate-800 bg-slate-950/50"
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <polyline fill="none" opacity="0.75" points={windLine} stroke="#f59e0b" strokeLinejoin="round" strokeWidth="2" />
        <polyline fill="none" points={lagLine} stroke="#22d3ee" strokeLinejoin="round" strokeWidth="2.4" />
        {points.map((point, index) => point.lagMinutes === null ? null : (
          <circle
            key={point.timestampUtc}
            cx={xScale(index)}
            cy={lagYScale(point.lagMinutes)}
            fill="#22d3ee"
            r="2.5"
          />
        ))}
        <text fill="#22d3ee" fontSize="10" x="18" y="18">lag min</text>
        <text fill="#f59e0b" fontSize="10" x={width - 92} y="18">wind km/s</text>
      </svg>
      <div className="truncate font-mono text-[10px] text-slate-500">
        {formatTimestamp(points[0]?.startUtc)} - {formatTimestamp(points.at(-1)?.stopUtc)}
      </div>
    </div>
  );
}

function CoherenceChart({ points }: { points: CoherencePoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No coherence
      </div>
    );
  }

  const width = 620;
  const height = 260;
  const magnitudeHeight = 118;
  const phaseTop = 145;
  const phaseHeight = 96;
  const logFrequencies = points.map(point => Math.log10(Math.max(0.0001, point.frequencyMilliHz)));
  const minLogFrequency = Math.min(...logFrequencies);
  const maxLogFrequency = Math.max(...logFrequencies);
  const xScale = (frequencyMilliHz: number) => {
    const logFrequency = Math.log10(Math.max(0.0001, frequencyMilliHz));
    return ((logFrequency - minLogFrequency) / (maxLogFrequency - minLogFrequency || 1)) * (width - 32) + 16;
  };
  const magnitudeYScale = (value: number) => magnitudeHeight - value * (magnitudeHeight - 16) + 8;
  const phaseYScale = (value: number) => phaseTop + (1 - ((value + Math.PI) / (2 * Math.PI))) * phaseHeight;
  const magnitudeLine = points
    .map(point => `${xScale(point.frequencyMilliHz).toFixed(1)},${magnitudeYScale(point.coherenceMagnitude).toFixed(1)}`)
    .join(' ');
  const phaseLine = points
    .map(point => `${xScale(point.frequencyMilliHz).toFixed(1)},${phaseYScale(point.phaseRadians).toFixed(1)}`)
    .join(' ');

  return (
    <svg
      aria-hidden="true"
      className="h-72 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      <line stroke="#334155" x1="12" x2={width - 12} y1={magnitudeYScale(0)} y2={magnitudeYScale(0)} />
      <line stroke="#334155" x1="12" x2={width - 12} y1={phaseYScale(0)} y2={phaseYScale(0)} />
      <polyline fill="none" points={magnitudeLine} stroke="#22d3ee" strokeLinejoin="round" strokeWidth="2.2" />
      <polyline fill="none" points={phaseLine} stroke="#e879f9" strokeLinejoin="round" strokeWidth="2" />
      {[1, 10].map(marker => {
        const x = xScale(marker);

        return (
          <g key={marker}>
            <line opacity="0.55" stroke="#475569" strokeDasharray="3 3" x1={x} x2={x} y1="8" y2={height - 10} />
            <text fill="#94a3b8" fontSize="10" x={Math.min(width - 70, x + 5)} y={height - 12}>
              {marker} mHz
            </text>
          </g>
        );
      })}
      <text fill="#22d3ee" fontSize="10" x="18" y="18">coherence</text>
      <text fill="#e879f9" fontSize="10" x="18" y={phaseTop + 14}>phase</text>
    </svg>
  );
}

function DetailPanels({ detail }: { detail: L1EarthCouplingPairDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-3">
      <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex min-w-0 items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
              CCF curve
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {detail.pair.label}
            </div>
          </div>
        </div>
        <CcfChart detail={detail} />
      </section>

      <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex min-w-0 items-center gap-2">
          <Gauge className="h-4 w-4 text-amber-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
              Lag variability
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Rolling 24h window · wind overlay
            </div>
          </div>
        </div>
        <LagVariabilityChart points={detail.lagVariability} />
      </section>

      <section className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex min-w-0 items-center gap-2">
          <Waves className="h-4 w-4 text-fuchsia-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
              Spectral coherence
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Magnitude and phase · log frequency
            </div>
          </div>
        </div>
        <CoherenceChart points={detail.coherence} />
      </section>
    </div>
  );
}

export function L1EarthCouplingPanel({
  snapshot,
  isLoading,
  error,
  selectedPairId,
  onSelectedPairChange,
  onRefresh,
}: L1EarthCouplingPanelProps) {
  const selectedDetail = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    return snapshot.pairDetails.find(detail => detail.pair.id === selectedPairId) ?? snapshot.pairDetails[0] ?? null;
  }, [selectedPairId, snapshot]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="space-y-4">
        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300">
                L1-Earth Coupling
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold text-slate-100">
                Statistical lead-lag coupling
              </h2>
              <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                {snapshot ? `${snapshot.ccfMatrix.length} CCF rows · ${snapshot.coherenceSummary.length} coherence rows` : 'Not available'}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {snapshot && (
                <button
                  type="button"
                  onClick={() => exportTopPairs(snapshot)}
                  className="flex h-10 items-center gap-2 rounded-md border border-slate-700 bg-slate-950/60 px-3 text-sm text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  <span>Top-N JSON</span>
                </button>
              )}
              <button
                type="button"
                onClick={onRefresh}
                disabled={isLoading}
                className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>{isLoading ? 'Analyzing' : 'Refresh'}</span>
              </button>
            </div>
          </div>

          {(error || (snapshot?.warnings.length ?? 0) > 0) && (
            <div className="mt-4 grid gap-2">
              {error && (
                <div className="rounded border border-rose-400/30 bg-rose-400/10 p-3 font-mono text-[10px] uppercase tracking-widest text-rose-100">
                  {error}
                </div>
              )}
              {snapshot?.warnings.slice(0, 4).map(warning => (
                <div
                  key={warning}
                  className="rounded border border-amber-300/30 bg-amber-300/10 p-3 font-mono text-[10px] text-amber-100"
                >
                  {warning}
                </div>
              ))}
            </div>
          )}
        </section>

        {snapshot ? (
          <>
            <HeatmapPanel
              snapshot={snapshot}
              selectedPairId={selectedDetail?.pair.id ?? selectedPairId}
              onSelectedPairChange={onSelectedPairChange}
            />
            {selectedDetail && <DetailPanels detail={selectedDetail} />}
          </>
        ) : (
          <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
            {isLoading ? 'Analyzing' : 'Not available'}
          </div>
        )}
      </div>
    </main>
  );
}
