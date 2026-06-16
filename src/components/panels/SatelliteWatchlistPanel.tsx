"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  MapPin,
  Plus,
  Settings2,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';
import { getSatelliteKey, useSatelliteConfig } from '@/contexts/SatelliteConfigContext';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import {
  useSatelliteWatch,
  type Comparator,
  type EnvVariable,
  type Instrument,
} from '@/contexts/SatelliteWatchContext';
import { propagateSatelliteFromTle } from '@/services/satellitePropagationService';
import {
  buildLiveEnv,
  COMPARATORS,
  ENV_VARIABLE_ORDER,
  ENV_VARS,
  evaluateWatchAlerts,
  formatEnvValue,
  type LiveEnv,
} from '@/services/watchAlertService';
import type { NoaaMagnetometerData, NoaaPlasmaData, NoaaServiceResponse } from '@/services/noaaSolarWindService';
import type { SatelliteTLE } from '@/services/celestrakService';

interface SatelliteWatchlistPanelProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  kp: number | null;
  compact?: boolean;
}

const formatCoord = (value: number | null | undefined, positive: string, negative: string) => {
  if (value == null) return 'n/a';
  return `${Math.abs(value).toFixed(2)}° ${value >= 0 ? positive : negative}`;
};

const selectClass =
  'rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[10px] text-slate-200 outline-none focus:border-cyan-500/60';

const ThresholdRow: React.FC<{
  satelliteKey: string;
  instrumentId: string;
  threshold: Instrument['thresholds'][number];
  live: LiveEnv;
  active: boolean;
}> = ({ satelliteKey, instrumentId, threshold, live, active }) => {
  const { updateThreshold, removeThreshold } = useSatelliteWatch();
  const current = live[threshold.variable];

  return (
    <div className={`flex flex-wrap items-center gap-1.5 rounded border px-1.5 py-1 ${active ? 'border-amber-500/40 bg-amber-500/10' : 'border-slate-800 bg-slate-950/40'}`}>
      <select
        value={threshold.variable}
        onChange={event => {
          const variable = event.target.value as EnvVariable;
          const def = ENV_VARS[variable];
          updateThreshold(satelliteKey, instrumentId, threshold.id, {
            variable,
            comparator: def.defaultComparator,
            value: def.defaultValue,
          });
        }}
        className={selectClass}
        aria-label="Variable"
      >
        {ENV_VARIABLE_ORDER.map(variable => (
          <option key={variable} value={variable}>{ENV_VARS[variable].label}</option>
        ))}
      </select>

      <select
        value={threshold.comparator}
        onChange={event => updateThreshold(satelliteKey, instrumentId, threshold.id, { comparator: event.target.value as Comparator })}
        className={selectClass}
        aria-label="Comparator"
      >
        {(['gt', 'gte', 'lt', 'lte'] as Comparator[]).map(comparator => (
          <option key={comparator} value={comparator}>{COMPARATORS[comparator]}</option>
        ))}
      </select>

      <input
        type="number"
        inputMode="decimal"
        value={Number.isFinite(threshold.value) ? threshold.value : ''}
        onChange={event => updateThreshold(satelliteKey, instrumentId, threshold.id, { value: Number(event.target.value) })}
        className={`${selectClass} w-16`}
        aria-label="Threshold value"
      />
      <span className="font-mono text-[9px] text-slate-500">{ENV_VARS[threshold.variable].unit}</span>

      <span className="ml-auto font-mono text-[9px] text-slate-500">
        now: <span className={active ? 'text-amber-300' : 'text-slate-300'}>
          {current == null ? 'n/a' : formatEnvValue(threshold.variable, current)}
        </span>
      </span>

      <button
        type="button"
        onClick={() => removeThreshold(satelliteKey, instrumentId, threshold.id)}
        className="flex h-5 w-5 items-center justify-center rounded border border-slate-700 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-400"
        aria-label="Remove threshold"
      >
        <Trash2 className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
};

const InstrumentBlock: React.FC<{
  satelliteKey: string;
  instrument: Instrument;
  live: LiveEnv;
  activeThresholdIds: Set<string>;
}> = ({ satelliteKey, instrument, live, activeThresholdIds }) => {
  const { renameInstrument, removeInstrument, addThreshold } = useSatelliteWatch();

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <input
          value={instrument.name}
          onChange={event => renameInstrument(satelliteKey, instrument.id, event.target.value)}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[11px] font-medium text-slate-100 outline-none hover:border-slate-700 focus:border-cyan-500/60"
          aria-label="Instrument name"
        />
        <button
          type="button"
          onClick={() => removeInstrument(satelliteKey, instrument.id)}
          className="flex h-5 w-5 items-center justify-center rounded border border-slate-700 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-400"
          aria-label="Remove instrument"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      <div className="space-y-1">
        {instrument.thresholds.length === 0 ? (
          <div className="rounded border border-dashed border-slate-800 px-2 py-1 text-[9px] font-mono text-slate-600">
            No thresholds yet
          </div>
        ) : (
          instrument.thresholds.map(threshold => (
            <ThresholdRow
              key={threshold.id}
              satelliteKey={satelliteKey}
              instrumentId={instrument.id}
              threshold={threshold}
              live={live}
              active={activeThresholdIds.has(threshold.id)}
            />
          ))
        )}
      </div>

      <button
        type="button"
        onClick={() => addThreshold(satelliteKey, instrument.id)}
        className="mt-1.5 flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-cyan-400/80 transition-colors hover:text-cyan-300"
      >
        <Plus className="h-3 w-3" aria-hidden="true" /> Add threshold
      </button>
    </div>
  );
};

const WatchRow: React.FC<{
  tle: SatelliteTLE;
  live: LiveEnv;
  activeThresholdIds: Set<string>;
  alertCount: number;
  telemetryTime: number;
}> = ({ tle, live, activeThresholdIds, alertCount, telemetryTime }) => {
  const satelliteKey = getSatelliteKey(tle);
  const { config, addInstrument } = useSatelliteWatch();
  const { selectedTle, setSelectedTle } = useSatelliteSelection();
  const [open, setOpen] = useState(false);

  const isFocused = selectedTle ? getSatelliteKey(selectedTle) === satelliteKey : false;
  const instruments = config[satelliteKey] ?? [];
  const telemetry = useMemo(() => propagateSatelliteFromTle(tle, new Date(telemetryTime)), [tle, telemetryTime]);

  return (
    <div className={`rounded border transition-colors ${isFocused ? 'border-cyan-500/50 bg-cyan-950/30' : 'border-slate-800 bg-slate-900/40'}`}>
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-slate-500 hover:text-slate-200"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>

        <button type="button" onClick={() => setSelectedTle(tle)} className="min-w-0 flex-1 text-left" title="Focus on map">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-[11px] font-medium text-slate-100">{tle.name}</span>
            {isFocused && <Crosshair className="h-3 w-3 flex-shrink-0 text-cyan-300" aria-hidden="true" />}
          </div>
          <div className="mt-0.5 truncate font-mono text-[9px] text-slate-600">
            {instruments.length} instrument{instruments.length === 1 ? '' : 's'}
          </div>
        </button>

        {alertCount > 0 && (
          <span className="flex flex-shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-mono text-amber-300">
            <TriangleAlert className="h-3 w-3" aria-hidden="true" />
            {alertCount}
          </span>
        )}
      </div>

      {open && (
        <div className="space-y-2 border-t border-slate-800/70 p-2">
          {/* Live position for context */}
          <div className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5 font-mono text-[9px] text-slate-400">
            <MapPin className="h-3 w-3 flex-shrink-0 text-cyan-400/70" aria-hidden="true" />
            {telemetry.positionAvailable
              ? `${formatCoord(telemetry.latitude, 'N', 'S')} / ${formatCoord(telemetry.longitude, 'E', 'W')}`
              : 'Position n/a'}
            <span className="ml-auto text-slate-500">
              {telemetry.velocityAvailable && telemetry.velocityKmS != null ? `${telemetry.velocityKmS.toFixed(2)} km/s` : ''}
              {telemetry.inclinationAvailable && telemetry.inclinationDeg != null ? ` · ${telemetry.inclinationDeg.toFixed(1)}°` : ''}
            </span>
          </div>

          {instruments.map(instrument => (
            <InstrumentBlock
              key={instrument.id}
              satelliteKey={satelliteKey}
              instrument={instrument}
              live={live}
              activeThresholdIds={activeThresholdIds}
            />
          ))}

          <button
            type="button"
            onClick={() => addInstrument(satelliteKey)}
            className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-700 py-1.5 text-[9px] font-mono uppercase tracking-wider text-slate-400 transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
          >
            <Plus className="h-3 w-3" aria-hidden="true" /> Add instrument
          </button>
        </div>
      )}
    </div>
  );
};

export const SatelliteWatchlistPanel: React.FC<SatelliteWatchlistPanelProps> = ({
  noaaMagData,
  noaaPlasmaData,
  kp,
  compact = false,
}) => {
  const { trackedTles, openModal } = useSatelliteConfig();
  const { config } = useSatelliteWatch();

  // Live environment snapshot (static per page load) — the values thresholds are evaluated against.
  const liveEnv: LiveEnv = useMemo(
    () => buildLiveEnv(noaaMagData, noaaPlasmaData, kp),
    [noaaMagData, noaaPlasmaData, kp],
  );

  const alerts = useMemo(
    () => evaluateWatchAlerts(config, trackedTles, liveEnv),
    [config, trackedTles, liveEnv],
  );

  const activeThresholdIds = useMemo(() => new Set(alerts.map(alert => alert.threshold.id)), [alerts]);
  const alertCountByKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const alert of alerts) counts.set(alert.satelliteKey, (counts.get(alert.satelliteKey) ?? 0) + 1);
    return counts;
  }, [alerts]);

  // Slow clock so the expanded live-position readouts stay current without thrashing edits.
  const [telemetryTime, setTelemetryTime] = useState(0);
  useEffect(() => {
    const initial = window.setTimeout(() => setTelemetryTime(Date.now()), 0);
    const id = setInterval(() => setTelemetryTime(Date.now()), 5_000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(id);
    };
  }, []);

  return (
    <GlassCard
      title="Selected Satellite"
      className="h-full"
      bodyClassName={compact ? 'p-3' : 'p-4'}
      headerClassName="pr-12"
    >
      <div className="flex h-full flex-col gap-3">
        {/* The prominent "My Alerts" notice lives in the Satellite Operator Report; here each
            satellite just carries a discreet badge (alertCountByKey) so this panel stays tidy. */}
        {/* Tracked satellites = the watch-list */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {trackedTles.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-6 text-center">
              <div className="text-[10px] font-mono uppercase tracking-widest text-slate-600">No satellites tracked</div>
              <p className="max-w-[16rem] text-[10px] font-mono leading-relaxed text-slate-600">
                Track satellites on the map to watch them here and attach instrument thresholds.
              </p>
              <button
                onClick={openModal}
                className="flex items-center gap-1.5 rounded border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-[10px] font-mono text-cyan-400 transition-colors hover:bg-cyan-500/20"
              >
                <Settings2 className="h-3 w-3" aria-hidden="true" /> Configure satellites
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {trackedTles.map(tle => (
                <WatchRow
                  key={getSatelliteKey(tle)}
                  tle={tle}
                  live={liveEnv}
                  activeThresholdIds={activeThresholdIds}
                  alertCount={alertCountByKey.get(getSatelliteKey(tle)) ?? 0}
                  telemetryTime={telemetryTime}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </GlassCard>
  );
};
