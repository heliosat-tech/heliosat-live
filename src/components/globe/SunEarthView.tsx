"use client";

import React from 'react';
import type { NoaaServiceResponse, NoaaEphemerisData, NoaaMagnetometerData, NoaaPlasmaData } from '@/services/noaaSolarWindService';

interface SunEarthViewProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
  noaaEphemerisData: NoaaServiceResponse<NoaaEphemerisData>;
}

const Metric: React.FC<{ label: string; value: string | null | undefined; unit?: string }> = ({ label, value, unit }) => (
  <div className="min-w-0 rounded border border-slate-800/80 bg-slate-950/60 px-2.5 py-2">
    <div className="truncate text-[8px] uppercase tracking-widest text-slate-500">{label}</div>
    <div className={`mt-1 truncate text-[11px] font-mono ${value != null ? 'text-slate-100' : 'text-slate-600'}`}>
      {value != null ? `${value}${unit ? ` ${unit}` : ''}` : 'Not available'}
    </div>
  </div>
);

const formatKm = (value?: string | null) => {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

export const SunEarthView: React.FC<SunEarthViewProps> = ({ noaaMagData, noaaPlasmaData, noaaEphemerisData }) => {
  const mag = noaaMagData.latestData;
  const plasma = noaaPlasmaData.latestData;
  const ephemeris = noaaEphemerisData.latestData;
  const bz = mag?.bz_gsm != null ? Number(mag.bz_gsm) : null;
  const hasWind = plasma?.speed != null;
  const hasMag = mag?.bx_gsm != null && mag?.by_gsm != null && mag?.bz_gsm != null;

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded bg-slate-950 select-none">
      <div className="flex items-center justify-between border-b border-slate-800/60 px-4 py-2">
        <span className="text-[9px] font-mono uppercase tracking-widest text-slate-600">
          Operational schematic
        </span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-slate-600">
          Sun-Earth L1
        </span>
      </div>

      <div className="min-h-0 px-4 py-3">
        <svg viewBox="0 0 820 270" className="h-full w-full" preserveAspectRatio="xMidYMid meet">
          <defs>
            <radialGradient id="sunBody" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fde68a" stopOpacity="1" />
              <stop offset="55%" stopColor="#f59e0b" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#92400e" stopOpacity="0.25" />
            </radialGradient>
            <radialGradient id="earthBody" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.95" />
              <stop offset="65%" stopColor="#1d4ed8" stopOpacity="0.75" />
              <stop offset="100%" stopColor="#0f172a" stopOpacity="0.35" />
            </radialGradient>
            <marker id="windArrow" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
              <polygon points="0 0, 7 2.5, 0 5" fill="#f472b6" opacity="0.85" />
            </marker>
            <marker id="magArrow" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
              <polygon points="0 0, 7 2.5, 0 5" fill="#38bdf8" opacity="0.85" />
            </marker>
          </defs>

          {[[58,38],[124,72],[196,28],[282,58],[402,26],[524,58],[644,34],[736,68],
            [86,214],[178,230],[276,204],[380,236],[486,210],[598,222],[724,204]].map(([x, y], index) => (
            <circle key={index} cx={x} cy={y} r="0.9" fill="#475569" opacity="0.45" />
          ))}

          <line x1="122" y1="135" x2="684" y2="135" stroke="#1e293b" strokeWidth="1.5" strokeDasharray="7 6" />

          <circle cx="86" cy="135" r="54" fill="url(#sunBody)" />
          <circle cx="86" cy="135" r="27" fill="#f59e0b" />
          <text x="86" y="204" textAnchor="middle" fill="#fbbf24" fontSize="12" fontFamily="monospace" fontWeight="700">SUN</text>

          {hasWind && (
            <g>
              <line x1="250" y1="118" x2="474" y2="118" stroke="#f472b6" strokeWidth="2" opacity="0.85" markerEnd="url(#windArrow)" />
              <rect x="332" y="91" width="62" height="18" rx="4" fill="#0f172a" stroke="#4c1d95" strokeWidth="0.8" />
              <text x="363" y="104" textAnchor="middle" fill="#f9a8d4" fontSize="9" fontFamily="monospace">
                {plasma?.speed} km/s
              </text>
            </g>
          )}

          {hasMag && (
            <g>
              <line
                x1="402"
                y1="160"
                x2="402"
                y2={bz != null && bz >= 0 ? 185 : 136}
                stroke="#38bdf8"
                strokeWidth="2"
                opacity="0.85"
                markerEnd="url(#magArrow)"
              />
              <rect x="374" y="198" width="56" height="18" rx="4" fill="#0f172a" stroke="#155e75" strokeWidth="0.8" />
              <text x="402" y="211" textAnchor="middle" fill="#7dd3fc" fontSize="9" fontFamily="monospace">
                Bz {mag?.bz_gsm}
              </text>
            </g>
          )}

          <circle cx="515" cy="135" r="6" fill="#fbbf24" opacity="0.8" />
          <circle cx="515" cy="135" r="14" fill="none" stroke="#fbbf24" strokeWidth="0.9" strokeDasharray="4 4" opacity="0.5" />
          <rect x="477" y="93" width="76" height="20" rx="4" fill="#0f172a" stroke="#334155" strokeWidth="0.8" />
          <text x="515" y="107" textAnchor="middle" fill="#bae6fd" fontSize="9" fontFamily="monospace">SWPC ACTIVE</text>
          <text x="515" y="166" textAnchor="middle" fill="#fbbf24" fontSize="10" fontFamily="monospace" fontWeight="700">L1</text>

          <circle cx="704" cy="135" r="47" fill="url(#earthBody)" />
          <circle cx="704" cy="135" r="24" fill="#1d4ed8" />
          <circle cx="704" cy="135" r="28" fill="none" stroke="#60a5fa" strokeWidth="1" opacity="0.45" />
          <text x="704" y="204" textAnchor="middle" fill="#60a5fa" fontSize="12" fontFamily="monospace" fontWeight="700">EARTH</text>
        </svg>
      </div>

      <div className="grid max-h-40 grid-cols-3 gap-3 overflow-y-auto border-t border-slate-800/60 p-3">
        <section className="min-w-0">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-cyan-500/80">RTSW Source</div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Spacecraft" value="SWPC active" />
            <Metric label="Time" value={ephemeris?.time_tag} />
            <Metric label="X GSE" value={formatKm(ephemeris?.x_gse)} unit="km" />
            <Metric label="Y GSE" value={formatKm(ephemeris?.y_gse)} unit="km" />
          </div>
        </section>

        <section className="min-w-0">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-sky-500/80">Magnetometer</div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Bt" value={mag?.bt} unit="nT" />
            <Metric label="Bz" value={mag?.bz_gsm} unit="nT" />
            <Metric label="Bx" value={mag?.bx_gsm} unit="nT" />
            <Metric label="By" value={mag?.by_gsm} unit="nT" />
          </div>
        </section>

        <section className="min-w-0">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-pink-500/80">Plasma</div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Speed" value={plasma?.speed} unit="km/s" />
            <Metric label="Density" value={plasma?.density} unit="cm^-3" />
            <Metric label="Temp" value={plasma?.temperature} unit="K" />
            <Metric label="Time" value={plasma?.time_tag} />
          </div>
        </section>
      </div>
    </div>
  );
};
