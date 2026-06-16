"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { BellRing, ClipboardList, TriangleAlert } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';
import { useSatelliteConfig } from '@/contexts/SatelliteConfigContext';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import { useSatelliteWatch } from '@/contexts/SatelliteWatchContext';
import { estimateEarthArrival } from '@/services/arrivalTimeService';
import { classifyOrbitFromPropagation, derivePhysicalFluxState } from '@/services/satelliteExposureService';
import { propagateSatelliteFromTle } from '@/services/satellitePropagationService';
import { buildLiveEnv, evaluateWatchAlerts, formatEnvValue, formatThreshold } from '@/services/watchAlertService';
import type { NoaaEphemerisData, NoaaMagnetometerData, NoaaPlasmaData, NoaaServiceResponse } from '@/services/noaaSolarWindService';
import type { OrbitClassification } from '@/types/spaceWeather';

interface SatelliteOperatorReportProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  noaaEphemerisData: NoaaServiceResponse<NoaaEphemerisData>;
  kp: number | null;
  compact?: boolean;
}

const REPORT_REFRESH_MS = 30_000;

type Condition = 'calm' | 'active' | 'no-data';

const conditionStyles: Record<Condition, { dot: string; text: string }> = {
  calm: { dot: 'bg-emerald-400', text: 'text-emerald-300' },
  active: { dot: 'bg-amber-400', text: 'text-amber-300' },
  'no-data': { dot: 'bg-slate-500', text: 'text-slate-400' },
};

/** Plain-language watch item for the orbit class — what disturbed space weather tends to do here. */
function orbitWatch(orbit: OrbitClassification): string {
  switch (orbit.orbitClass) {
    case 'LEO':
      return orbit.isHighInclinationLeo
        ? 'Atmospheric drag and orbit-determination uncertainty; plus polar/auroral exposure (high inclination).'
        : 'Atmospheric drag and orbit-determination uncertainty.';
    case 'MEO':
      return 'Radiation-belt and energetic-particle exposure.';
    case 'GEO-like':
      return 'Surface and deep-dielectric charging; possible comms anomalies.';
    case 'HEO':
      return 'Radiation exposure on high-altitude magnetospheric passes.';
    default:
      return 'Select an active satellite to see its exposure context.';
  }
}

const DetailBlock: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="rounded border border-slate-800/80 bg-slate-950/35 p-3">
    <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{title}</h3>
    {children}
  </section>
);

export const SatelliteOperatorReport: React.FC<SatelliteOperatorReportProps> = ({
  noaaMagData,
  noaaPlasmaData,
  noaaEphemerisData,
  kp,
  compact = false,
}) => {
  const { selectedTle } = useSatelliteSelection();
  const { trackedTles } = useSatelliteConfig();
  const { config: watchConfig } = useSatelliteWatch();
  // Keep the server and first client render stable; the live clock starts after mount.
  const [reportTime, setReportTime] = useState<number | null>(null);

  useEffect(() => {
    const initial = window.setTimeout(() => setReportTime(Date.now()), 0);
    const interval = setInterval(() => setReportTime(Date.now()), REPORT_REFRESH_MS);
    return () => {
      window.clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  const digest = useMemo(() => {
    const generatedAt = new Date(reportTime ?? 0);
    const propagatedData = selectedTle ? propagateSatelliteFromTle(selectedTle, generatedAt) : null;
    const arrivalEstimate = estimateEarthArrival(noaaPlasmaData, noaaEphemerisData, generatedAt);
    const flux = derivePhysicalFluxState(noaaMagData, noaaPlasmaData);
    const orbit = classifyOrbitFromPropagation(propagatedData);

    const activeFlags = flux.flags.filter(flag => flag.isActive === true).map(flag => flag.label);
    const hasLiveWind = flux.flags.some(flag => flag.isActive !== null);
    const condition: Condition = !hasLiveWind ? 'no-data' : activeFlags.length > 0 ? 'active' : 'calm';

    const driver = (id: string) => {
      const quantity = flux.quantities.find(q => q.id === id);
      return quantity ? `${quantity.formattedValue} ${quantity.unit}`.trim() : 'Not available';
    };

    const arrivalMinutes = arrivalEstimate.isAvailable ? arrivalEstimate.travelTimeMinutes : null;

    return {
      name: selectedTle?.name ?? null,
      orbit,
      condition,
      activeFlags,
      drivers: { bz: driver('bz_gsm'), speed: driver('speed'), density: driver('density') },
      arrivalMinutes,
      generatedAtUtc: generatedAt.toISOString(),
    };
  }, [noaaEphemerisData, noaaMagData, noaaPlasmaData, reportTime, selectedTle]);

  // Operator-declared threshold crossings across all watched satellites. The watch-list panel keeps
  // only a discreet per-satellite badge; the prominent notice surfaces here, the decision hub.
  const watchAlerts = useMemo(
    () => evaluateWatchAlerts(watchConfig, trackedTles, buildLiveEnv(noaaMagData, noaaPlasmaData, kp)),
    [watchConfig, trackedTles, noaaMagData, noaaPlasmaData, kp],
  );

  const { orbit } = digest;
  const tone = conditionStyles[digest.condition];

  const orbitLine = orbit.orbitClass === 'Unavailable'
    ? 'No satellite selected'
    : [
        orbit.orbitClass,
        orbit.altitudeKm === null ? null : `${orbit.altitudeKm.toFixed(0)} km`,
        orbit.inclinationDeg === null ? null : `${orbit.inclinationDeg.toFixed(1)}°`,
      ].filter(Boolean).join(' · ');

  const conditionLabel = digest.condition === 'no-data'
    ? 'Live solar-wind data unavailable'
    : digest.condition === 'active'
      ? `Active: ${digest.activeFlags.join(', ')}`
      : 'Quiet — no active solar-wind flags';

  return (
    <GlassCard
      title="Satellite Operator Report"
      className="h-full"
      bodyClassName={compact ? 'p-3' : 'p-4'}
      headerClassName={compact ? 'px-3 py-2' : undefined}
    >
      <div className="flex h-full flex-col gap-3">
        {/* At-a-glance digest (shown in both compact and expanded views) */}
        <div className="flex flex-col gap-2 border-b border-slate-800/60 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-cyan-300">
              <ClipboardList className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">Selected satellite advisory</span>
            </div>
            <span className="flex-shrink-0 rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-blue-300">
              Decision support
            </span>
          </div>

          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-100" title={digest.name ?? undefined}>
              {digest.name ?? 'No satellite selected'}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-slate-400">{orbitLine}</div>
          </div>

          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 flex-shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
            <span className={`text-[11px] ${tone.text}`}>{conditionLabel}</span>
          </div>

          <div className="text-[11px] leading-snug text-slate-400">
            <span className="text-slate-500">Watch: </span>{orbitWatch(orbit)}
          </div>
        </div>

        {/* Operator-declared threshold alerts (from the Selected Satellite watch-list) */}
        {watchAlerts.length > 0 && (
          <section className="rounded border border-amber-500/40 bg-amber-500/10 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-amber-300">
              <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
              My Alerts
              <span className="ml-auto">{watchAlerts.length} active</span>
            </div>
            <ul className="space-y-1">
              {watchAlerts.map(alert => (
                <li
                  key={`${alert.satelliteKey}-${alert.threshold.id}`}
                  className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1"
                >
                  <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-300" aria-hidden="true" />
                  <div className="min-w-0 text-[10px] leading-snug text-amber-100/90">
                    <span className="font-mono font-semibold text-amber-200">{alert.satelliteName}</span>
                    <span className="text-amber-100/70"> · {alert.instrumentName}</span>
                    <div className="font-mono text-[9px] text-amber-100/70">
                      {formatThreshold(alert.threshold)} — now {formatEnvValue(alert.threshold.variable, alert.currentValue)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Expanded view only: concise drivers, interpretation, suggested checks. */}
        {!compact && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <DetailBlock title="Conditions now">
              <dl className="grid grid-cols-3 gap-2 text-[11px]">
                {[
                  { label: 'Bz GSM', value: digest.drivers.bz },
                  { label: 'Wind speed', value: digest.drivers.speed },
                  { label: 'Density', value: digest.drivers.density },
                ].map(item => (
                  <div key={item.label} className="rounded border border-slate-800 bg-slate-950/45 p-2">
                    <dt className="text-[8px] uppercase tracking-widest text-slate-500">{item.label}</dt>
                    <dd className="mt-1 font-mono text-slate-200">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </DetailBlock>

            <DetailBlock title="Suggested checks">
              <ul className="space-y-1.5 text-[11px] leading-relaxed text-slate-300">
                <li className="flex gap-2">
                  <span className="text-slate-600">–</span>
                  {digest.arrivalMinutes !== null
                    ? `Solar-wind transit to Earth ≈ ${digest.arrivalMinutes.toFixed(0)} min. Review safe-mode readiness before that window if your mission defines one.`
                    : 'Review safe-mode readiness per your mission flight rules.'}
                </li>
                <li className="flex gap-2">
                  <span className="text-slate-600">–</span>
                  Check tracking, comms and anomaly monitoring per your procedures.
                </li>
              </ul>
            </DetailBlock>

            <p className="text-[10px] leading-relaxed text-slate-600">
              Decision-support only — no radiation dose, internal-charging or anomaly-probability model is
              computed. Mission-specific flight rules remain authoritative.
            </p>
          </div>
        )}

        <div className="border-t border-slate-800/60 pt-2 text-[9px] font-mono text-slate-600">
          {reportTime === null
            ? 'Waiting for client clock sync.'
            : `Updated ${new Date(digest.generatedAtUtc).toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' })} UTC · NOAA + CelesTrak`}
        </div>
      </div>
    </GlassCard>
  );
};
