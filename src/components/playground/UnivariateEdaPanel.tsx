"use client";

import { useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Download,
  Gauge,
  RefreshCw,
  Sigma,
  Waves,
} from 'lucide-react';
import type {
  EdaStratum,
  UnivariateEdaSnapshot,
  VariableEdaCard,
} from '@/services/univariateEdaService';

interface UnivariateEdaPanelProps {
  snapshot: UnivariateEdaSnapshot | null;
  isLoading: boolean;
  error: string | null;
  selectedVariable: string;
  selectedStratum: EdaStratum;
  onVariableChange: (variable: string) => void;
  onStratumChange: (stratum: EdaStratum) => void;
  onRefresh: () => void;
}

type CardTab = 'distribution' | 'series' | 'stationarity' | 'autocorrelation';
type ContextOverlay = 'none' | 'kp' | 'dst';

const CARD_TABS: Array<{
  id: CardTab;
  label: string;
  icon: typeof BarChart3;
}> = [
  { id: 'distribution', label: 'Distribucion', icon: BarChart3 },
  { id: 'series', label: 'Serie temporal', icon: Activity },
  { id: 'stationarity', label: 'Estacionariedad', icon: Waves },
  { id: 'autocorrelation', label: 'Autocorrelacion', icon: Gauge },
];

const STRATUM_LABELS: Record<EdaStratum, string> = {
  all: 'All',
  solar_min: 'Solar min',
  solar_max: 'Solar max',
  quiet: 'Quiet',
  storm: 'Storm',
};

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

function exportFigureJson(card: VariableEdaCard) {
  const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = `${card.seriesId}-${card.stratum}-univariate-eda.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function StatsOverlay({ card }: { card: VariableEdaCard }) {
  const stats = card.distribution.stats;

  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Mean</div>
        <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.mean)}</div>
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Median</div>
        <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.median)}</div>
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Std</div>
        <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.std)}</div>
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">JB p</div>
        <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.jarqueBeraPValueApprox, 3)}</div>
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Skew</div>
        <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.skew)}</div>
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Kurtosis</div>
        <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.kurtosis)}</div>
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">P05/P95</div>
        <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.p05)} / {formatNumber(stats.p95)}</div>
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">P01/P99</div>
        <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(stats.p01)} / {formatNumber(stats.p99)}</div>
      </div>
    </div>
  );
}

function DistributionChart({ card }: { card: VariableEdaCard }) {
  const width = 320;
  const height = 150;
  const maxDensity = Math.max(
    ...card.distribution.histogram.map(bin => bin.density),
    ...card.distribution.kde.map(point => point.density),
    1,
  );
  const xMin = card.distribution.histogram[0]?.min ?? 0;
  const xMax = card.distribution.histogram.at(-1)?.max ?? 1;
  const xRange = xMax - xMin || 1;
  const barWidth = width / Math.max(1, card.distribution.histogram.length);
  const kdePoints = card.distribution.kde.map(point => {
    const x = ((point.x - xMin) / xRange) * width;
    const y = height - (point.density / maxDensity) * (height - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg
      aria-hidden="true"
      className="h-40 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      {card.distribution.histogram.map((bin, index) => {
        const barHeight = (bin.density / maxDensity) * (height - 12);

        return (
          <rect
            key={`${bin.min}-${bin.max}`}
            fill="#38bdf8"
            height={barHeight}
            opacity={0.5}
            width={Math.max(1, barWidth - 1)}
            x={index * barWidth}
            y={height - barHeight - 6}
          />
        );
      })}
      <polyline
        fill="none"
        points={kdePoints}
        stroke="#e879f9"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function SeriesChart({
  card,
  overlay,
}: {
  card: VariableEdaCard;
  overlay: ContextOverlay;
}) {
  if (card.timeSeries.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No series
      </div>
    );
  }

  const width = 320;
  const height = 150;
  const values = card.timeSeries.map(point => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const linePoints = card.timeSeries.map((point, index) => {
    const x = (index / (card.timeSeries.length - 1)) * width;
    const y = height - ((point.value - minValue) / range) * (height - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const overlayValues = card.timeSeries
    .map(point => overlay === 'kp' ? point.kp : overlay === 'dst' ? point.dst : null)
    .filter((value): value is number => value !== null);
  const overlayMin = overlayValues.length > 0 ? Math.min(...overlayValues) : 0;
  const overlayMax = overlayValues.length > 0 ? Math.max(...overlayValues) : 1;
  const overlayRange = overlayMax - overlayMin || 1;
  const overlayPoints = overlay === 'none'
    ? ''
    : card.timeSeries.map((point, index) => {
      const overlayValue = overlay === 'kp' ? point.kp : point.dst;

      if (overlayValue === null) {
        return null;
      }

      const x = (index / (card.timeSeries.length - 1)) * width;
      const y = height - ((overlayValue - overlayMin) / overlayRange) * (height - 12) - 6;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).filter(Boolean).join(' ');

  return (
    <svg
      aria-hidden="true"
      className="h-40 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      {overlayPoints && (
        <polyline
          fill="none"
          opacity="0.5"
          points={overlayPoints}
          stroke={overlay === 'kp' ? '#f59e0b' : '#a78bfa'}
          strokeLinejoin="round"
          strokeWidth="2"
        />
      )}
      <polyline
        fill="none"
        points={linePoints}
        stroke="#22d3ee"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function StationarityChart({ card }: { card: VariableEdaCard }) {
  if (card.stationarity.rolling.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No rolling stats
      </div>
    );
  }

  const width = 320;
  const height = 150;
  const rolling = card.stationarity.rolling;
  const values = rolling.flatMap(point => [point.mean30d, point.mean1y]).filter((value): value is number => value !== null);
  const minValue = values.length > 0 ? Math.min(...values) : 0;
  const maxValue = values.length > 0 ? Math.max(...values) : 1;
  const range = maxValue - minValue || 1;
  const makeLine = (key: 'mean30d' | 'mean1y') => rolling
    .map((point, index) => {
      const value = point[key];

      if (value === null) {
        return null;
      }

      const x = (index / (rolling.length - 1)) * width;
      const y = height - ((value - minValue) / range) * (height - 12) - 6;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');
  const startMs = new Date(rolling[0].timestampUtc).getTime();
  const stopMs = new Date(rolling[rolling.length - 1].timestampUtc).getTime();
  const spanMs = stopMs - startMs || 1;

  return (
    <svg
      aria-hidden="true"
      className="h-40 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      {card.stationarity.regimeChanges.map(changeTimestamp => {
        const changeMs = new Date(changeTimestamp).getTime();
        const x = ((changeMs - startMs) / spanMs) * width;

        return (
          <line
            key={changeTimestamp}
            opacity="0.55"
            stroke="#fb7185"
            strokeDasharray="3 3"
            x1={x}
            x2={x}
            y1="5"
            y2={height - 5}
          />
        );
      })}
      <polyline fill="none" points={makeLine('mean30d')} stroke="#22d3ee" strokeWidth="2" />
      <polyline fill="none" opacity="0.75" points={makeLine('mean1y')} stroke="#f59e0b" strokeWidth="2" />
    </svg>
  );
}

function AutocorrelationChart({ card }: { card: VariableEdaCard }) {
  const width = 320;
  const height = 150;
  const acf = card.autocorrelation.acf;
  const pacf = card.autocorrelation.pacf;

  if (acf.length < 2 || pacf.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
        No ACF
      </div>
    );
  }

  const drawBars = (values: typeof acf, offset: number, color: string) => {
    const segmentWidth = width / 2;
    const barWidth = segmentWidth / values.length;

    return values.map((point, index) => {
      const x = offset + index * barWidth;
      const zeroY = height / 2;
      const barHeight = Math.max(1, Math.abs(point.value) * (height / 2 - 8));
      const y = point.value >= 0 ? zeroY - barHeight : zeroY;

      return (
        <rect
          key={`${offset}-${point.lagHours}`}
          fill={color}
          height={barHeight}
          opacity={0.78}
          width={Math.max(1, barWidth - 1)}
          x={x}
          y={y}
        />
      );
    });
  };

  return (
    <svg
      aria-hidden="true"
      className="h-40 w-full rounded border border-slate-800 bg-slate-950/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      <line stroke="#334155" x1="0" x2={width} y1={height / 2} y2={height / 2} />
      {drawBars(acf, 0, '#38bdf8')}
      {drawBars(pacf, width / 2, '#e879f9')}
      {card.autocorrelation.decorrelationTimeHours !== null && (
        <text fill="#94a3b8" fontSize="10" x="8" y="14">
          decor {formatNumber(card.autocorrelation.decorrelationTimeHours, 1)}h
        </text>
      )}
    </svg>
  );
}

function VariableCard({ card }: { card: VariableEdaCard }) {
  const [activeTab, setActiveTab] = useState<CardTab>('distribution');
  const [overlay, setOverlay] = useState<ContextOverlay>('none');

  return (
    <article className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/45 p-4">
      <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100">{card.variable}</h3>
          <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
            {card.source} · {card.unit} · {STRATUM_LABELS[card.stratum]}
          </div>
        </div>
        <button
          type="button"
          aria-label="Export figure data"
          onClick={() => exportFigureJson(card)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-100"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mb-3 grid grid-cols-4 gap-1 rounded-md border border-slate-800 bg-slate-950/50 p-1">
        {CARD_TABS.map(tab => {
          const Icon = tab.icon;
          const isSelected = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              aria-label={tab.label}
              aria-pressed={isSelected}
              onClick={() => setActiveTab(tab.id)}
              className={`flex h-8 items-center justify-center rounded transition ${
                isSelected
                  ? 'bg-cyan-400/15 text-cyan-100'
                  : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-200'
              }`}
              title={tab.label}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      {activeTab === 'distribution' && (
        <div className="grid gap-3">
          <DistributionChart card={card} />
          <StatsOverlay card={card} />
        </div>
      )}

      {activeTab === 'series' && (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-1">
            {(['none', 'kp', 'dst'] as ContextOverlay[]).map(nextOverlay => (
              <button
                key={nextOverlay}
                type="button"
                aria-pressed={overlay === nextOverlay}
                onClick={() => setOverlay(nextOverlay)}
                className={`h-7 rounded border px-2 font-mono text-[9px] uppercase tracking-widest transition ${
                  overlay === nextOverlay
                    ? 'border-cyan-300/50 bg-cyan-300/10 text-cyan-100'
                    : 'border-slate-700 bg-slate-950 text-slate-500 hover:text-slate-200'
                }`}
              >
                {nextOverlay}
              </button>
            ))}
          </div>
          <SeriesChart card={card} overlay={overlay} />
          <div className="truncate font-mono text-[10px] text-slate-500">
            {formatTimestamp(card.timeSeries[0]?.timestampUtc)} · {formatTimestamp(card.timeSeries.at(-1)?.timestampUtc)}
          </div>
        </div>
      )}

      {activeTab === 'stationarity' && (
        <div className="grid gap-3">
          <StationarityChart card={card} />
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">ADF</div>
              <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(card.stationarity.adfStatisticApprox)}</div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">KPSS</div>
              <div className="mt-1 truncate font-mono text-xs text-slate-100">{formatNumber(card.stationarity.kpssStatisticApprox)}</div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Changes</div>
              <div className="mt-1 truncate font-mono text-xs text-slate-100">{card.stationarity.regimeChanges.length}</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'autocorrelation' && (
        <div className="grid gap-3">
          <AutocorrelationChart card={card} />
          <div className="rounded border border-slate-800 bg-slate-950/60 p-2 font-mono text-xs text-slate-100">
            Decorrelation: {card.autocorrelation.decorrelationTimeHours === null ? 'NA' : `${formatNumber(card.autocorrelation.decorrelationTimeHours, 1)} h`}
          </div>
        </div>
      )}
    </article>
  );
}

export function UnivariateEdaPanel({
  snapshot,
  isLoading,
  error,
  selectedVariable,
  selectedStratum,
  onVariableChange,
  onStratumChange,
  onRefresh,
}: UnivariateEdaPanelProps) {
  const variables = useMemo(
    () => Array.from(new Set(snapshot?.cards.map(card => card.variable) ?? [])).sort(),
    [snapshot],
  );
  const visibleCards = useMemo(
    () => (snapshot?.cards ?? []).filter(card => (
      card.stratum === selectedStratum &&
      (selectedVariable === 'all' || card.variable === selectedVariable)
    )),
    [selectedStratum, selectedVariable, snapshot],
  );

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto pr-1 xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="grid content-start gap-4">
        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="mb-3 flex items-center gap-2">
            <Sigma className="h-4 w-4 text-cyan-300" aria-hidden="true" />
            <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
              Univariate EDA
            </h2>
          </div>
          <div className="grid gap-3">
            <label className="grid gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Variable</span>
              <select
                value={selectedVariable}
                onChange={event => onVariableChange(event.target.value)}
                className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60"
              >
                <option value="all">All variables</option>
                {variables.map(variable => (
                  <option key={variable} value={variable}>{variable}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Stratum</span>
              <select
                value={selectedStratum}
                onChange={event => onStratumChange(event.target.value as EdaStratum)}
                className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60"
              >
                {(snapshot?.availableStrata ?? ['all']).map(stratum => (
                  <option key={stratum} value={stratum}>{STRATUM_LABELS[stratum]}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className="flex h-10 items-center justify-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-wait disabled:text-slate-500"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{isLoading ? 'Analyzing' : 'Refresh'}</span>
            </button>
          </div>
        </section>

        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            Context indices
          </div>
          <div className="grid gap-2">
            <div className="rounded border border-slate-800 bg-slate-950/50 p-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Generated</div>
              <div className="mt-1 truncate font-mono text-xs text-slate-200">
                {snapshot ? formatTimestamp(snapshot.context.generatedAtUtc) : 'NA'}
              </div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-950/50 p-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-600">Points</div>
              <div className="mt-1 truncate font-mono text-xs text-slate-200">
                {snapshot?.context.points.length ?? 0}
              </div>
            </div>
            {snapshot?.context.errors.map(errorItem => (
              <div
                key={`${errorItem.kind}-${errorItem.message}`}
                className="rounded border border-amber-300/30 bg-amber-300/10 p-2 font-mono text-[10px] text-amber-100"
              >
                {errorItem.kind}: {errorItem.message}
              </div>
            ))}
          </div>
        </section>
      </aside>

      <section className="min-w-0 space-y-4">
        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <BarChart3 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
              <div className="min-w-0">
                <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                  Variable cards
                </h2>
                <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  {snapshot ? `${visibleCards.length} cards · ${snapshot.variableStats.length} stats rows` : 'Not available'}
                </div>
              </div>
            </div>
            {error && (
              <div className="max-w-80 truncate font-mono text-[10px] uppercase tracking-widest text-rose-300" title={error}>
                {error}
              </div>
            )}
          </div>

          {snapshot ? (
            visibleCards.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {visibleCards.map(card => (
                  <VariableCard
                    key={`${card.seriesId}-${card.stratum}`}
                    card={card}
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-h-[300px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                No cards for selected stratum
              </div>
            )
          ) : (
            <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/50 font-mono text-[10px] uppercase tracking-widest text-slate-600">
              {isLoading ? 'Analyzing' : 'Not available'}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
