"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardList, Orbit, Satellite, ShieldAlert } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';
import { useSatelliteSelection } from '@/contexts/SatelliteSelectionContext';
import { estimateEarthArrival } from '@/services/arrivalTimeService';
import { buildSatelliteOperatorReport, derivePhysicalFluxState } from '@/services/satelliteExposureService';
import { propagateSatelliteFromTle } from '@/services/satellitePropagationService';
import type { NoaaEphemerisData, NoaaMagnetometerData, NoaaPlasmaData, NoaaServiceResponse } from '@/services/noaaSolarWindService';
import type { MissionBadge } from '@/types/spaceWeather';

interface SatelliteOperatorReportProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  noaaEphemerisData: NoaaServiceResponse<NoaaEphemerisData>;
  compact?: boolean;
}

const REPORT_REFRESH_MS = 30_000;

const badgeClass: Record<MissionBadge, string> = {
  AVAILABLE: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  PARTIAL: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  UNAVAILABLE: 'border-slate-700/60 bg-slate-900/60 text-slate-500',
  MEASURED: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  DERIVED: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  HEURISTIC: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  'DECISION SUPPORT ONLY': 'border-blue-500/30 bg-blue-500/10 text-blue-300',
};

const Badge: React.FC<{ value: MissionBadge }> = ({ value }) => (
  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest ${badgeClass[value]}`}>
    {value}
  </span>
);

export const SatelliteOperatorReport: React.FC<SatelliteOperatorReportProps> = ({
  noaaMagData,
  noaaPlasmaData,
  noaaEphemerisData,
  compact = false,
}) => {
  const { selectedTle } = useSatelliteSelection();
  const [reportTime, setReportTime] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setReportTime(Date.now()), REPORT_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const report = useMemo(() => {
    const generatedAt = new Date(reportTime);
    const propagatedData = selectedTle ? propagateSatelliteFromTle(selectedTle, generatedAt) : null;
    const arrivalEstimate = estimateEarthArrival(noaaPlasmaData, noaaEphemerisData, generatedAt);
    const physicalFluxState = derivePhysicalFluxState(noaaMagData, noaaPlasmaData);

    return buildSatelliteOperatorReport({
      satelliteName: selectedTle?.name ?? null,
      satelliteSource: selectedTle?.source ?? null,
      propagatedData,
      arrivalEstimate,
      physicalFluxState,
      generatedAt,
    });
  }, [noaaEphemerisData, noaaMagData, noaaPlasmaData, reportTime, selectedTle]);

  const reportBadge: MissionBadge = report.satelliteName
    ? report.missingData.length > 3
      ? 'PARTIAL'
      : 'AVAILABLE'
    : 'UNAVAILABLE';

  return (
    <GlassCard
      title="Satellite Operator Report"
      className="h-full"
      bodyClassName={compact ? 'p-3' : 'p-4'}
      headerClassName={compact ? 'px-3 py-2' : undefined}
    >
      <div className={`flex h-full flex-col overflow-hidden ${compact ? 'gap-2.5' : 'gap-3'}`}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-800/60 pb-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-cyan-300">
              <ClipboardList className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">Decision-Support Advisory</span>
            </div>
            <div className="mt-1 truncate text-[9px] text-slate-600" title={report.satelliteName ?? 'No active satellite'}>
              {report.satelliteName ?? 'No active satellite selected'}
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-col items-end gap-1">
            <Badge value="DECISION SUPPORT ONLY" />
            <Badge value={reportBadge} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className={`rounded border border-slate-800 bg-slate-950/45 ${compact ? 'p-1.5' : 'p-2'}`}>
            <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-widest text-slate-500">
              <Satellite className="h-3 w-3" aria-hidden="true" />
              Orbit
            </div>
            <div className="mt-1 font-mono text-sm text-slate-100">{report.orbit.orbitClass}</div>
            <div className="mt-1 text-[9px] text-slate-600">
              {report.orbit.altitudeKm === null ? 'Altitude not available' : `${report.orbit.altitudeKm.toFixed(0)} km`}
            </div>
          </div>
          <div className={`rounded border border-slate-800 bg-slate-950/45 ${compact ? 'p-1.5' : 'p-2'}`}>
            <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-widest text-slate-500">
              <Orbit className="h-3 w-3" aria-hidden="true" />
              Channels
            </div>
            <div className="mt-1 text-[10px] font-mono text-slate-200">
              {report.exposureChannels.length > 0 ? report.exposureChannels.length : 'None'}
            </div>
            <div className="mt-1 truncate text-[9px] text-slate-600" title={report.exposureChannels.map(channel => channel.label).join(', ')}>
              {report.exposureChannels.map(channel => channel.label).join(', ') || 'Not available'}
            </div>
          </div>
          <div className={`rounded border border-slate-800 bg-slate-950/45 ${compact ? 'p-1.5' : 'p-2'}`}>
            <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-widest text-slate-500">
              <ShieldAlert className="h-3 w-3" aria-hidden="true" />
              Missing
            </div>
            <div className="mt-1 font-mono text-sm text-slate-100">{report.missingData.length}</div>
            <div className="mt-1 text-[9px] text-slate-600">Explicitly listed below</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
            {report.sections.map(section => (
              <section key={section.title} className={`rounded border border-slate-800/80 bg-slate-950/35 ${compact ? 'p-2.5' : 'p-3'}`}>
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                  {section.title}
                </h3>
                <ul className="space-y-1.5">
                  {section.items.map((item, index) => (
                    <li key={`${section.title}-${index}`} className={`text-[10px] text-slate-300 ${compact ? 'leading-snug' : 'leading-relaxed'}`}>
                      <span className="mr-2 text-slate-600">-</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>

        <div className="border-t border-slate-800/60 pt-2 text-[9px] font-mono text-slate-600">
          {reportTime === null
            ? 'Waiting for client clock sync.'
            : `Generated ${new Date(report.generatedAtUtc).toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' })} UTC from connected NOAA/CelesTrak inputs.`}
        </div>
      </div>
    </GlassCard>
  );
};
