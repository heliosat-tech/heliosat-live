"use client";

import React from 'react';
import { ChevronDown, Info, Layers } from 'lucide-react';
import type {
  NoaaServiceResponse,
  NoaaEphemerisData,
  NoaaMagnetometerData,
  NoaaPlasmaData,
  NoaaRtswSpacecraftStatus,
} from '@/services/noaaSolarWindService';

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

interface DisplaySpacecraft extends NoaaRtswSpacecraftStatus {
  products: string[];
}

const leoDensitySources = [
  { name: 'Swarm A', detail: 'POD density', status: 'Archive' },
  { name: 'Swarm B', detail: 'POD density', status: 'Archive' },
  { name: 'Swarm C', detail: 'POD density', status: 'Archive' },
  { name: 'GRACE-FO 1', detail: 'ACC density', status: 'Archive' },
] as const;

const groundSources = [
  'GFZ Kp',
  'NOAA / Kyoto Dst',
  'NOAA F10.7 · Kp / Ap',
  'NASA SPDF OMNI2',
] as const;

function mergeSpacecraft(
  sources: Array<{ product: string; spacecraft: NoaaRtswSpacecraftStatus[] }>,
): DisplaySpacecraft[] {
  const merged = new Map<string, DisplaySpacecraft>();

  for (const source of sources) {
    for (const spacecraft of source.spacecraft) {
      const current = merged.get(spacecraft.name);
      if (!current) {
        merged.set(spacecraft.name, { ...spacecraft, products: [source.product] });
        continue;
      }

      current.active ||= spacecraft.active;
      if (spacecraft.lastUpdated > current.lastUpdated) current.lastUpdated = spacecraft.lastUpdated;
      if (!current.products.includes(source.product)) current.products.push(source.product);
    }
  }

  return [...merged.values()]
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export const SunEarthView: React.FC<SunEarthViewProps> = ({ noaaMagData, noaaPlasmaData, noaaEphemerisData }) => {
  const [spacecraftOpen, setSpacecraftOpen] = React.useState(false);
  const [layersOpen, setLayersOpen] = React.useState(false);
  const spacecraftPopoverRef = React.useRef<HTMLDivElement>(null);
  const layersTriggerRef = React.useRef<HTMLButtonElement>(null);
  const layersPanelRef = React.useRef<HTMLDivElement>(null);
  const mag = noaaMagData.latestData;
  const plasma = noaaPlasmaData.latestData;
  const ephemeris = noaaEphemerisData.latestData;
  const bz = mag?.bz_gsm != null ? Number(mag.bz_gsm) : null;
  const hasWind = plasma?.speed != null;
  const hasMag = mag?.bx_gsm != null && mag?.by_gsm != null && mag?.bz_gsm != null;
  const spacecraft = React.useMemo(() => mergeSpacecraft([
    { product: 'MAG', spacecraft: noaaMagData.spacecraft ?? [] },
    { product: 'PLASMA', spacecraft: noaaPlasmaData.spacecraft ?? [] },
    { product: 'EPHEMERIS', spacecraft: noaaEphemerisData.spacecraft ?? [] },
  ]), [noaaEphemerisData.spacecraft, noaaMagData.spacecraft, noaaPlasmaData.spacecraft]);
  const activeSpacecraft = spacecraft.find(item => item.active)?.name ?? null;

  React.useEffect(() => {
    if (!spacecraftOpen && !layersOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (spacecraftOpen && spacecraftPopoverRef.current && !spacecraftPopoverRef.current.contains(target)) {
        setSpacecraftOpen(false);
      }
      if (
        layersOpen
        && !layersTriggerRef.current?.contains(target)
        && !layersPanelRef.current?.contains(target)
      ) setLayersOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSpacecraftOpen(false);
        setLayersOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [layersOpen, spacecraftOpen]);

  return (
    <div className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded bg-slate-950 select-none">
      <div className="flex items-center justify-between border-b border-slate-800/60 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="hidden text-[9px] font-mono uppercase tracking-widest text-slate-600 sm:inline">
            Operational schematic
          </span>
          <button
            ref={layersTriggerRef}
            type="button"
            onClick={() => {
              setLayersOpen(open => !open);
              setSpacecraftOpen(false);
            }}
            aria-expanded={layersOpen}
            aria-controls="measurement-layers-panel"
            className={`flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[8px] uppercase tracking-widest transition-colors ${
              layersOpen
                ? 'border-violet-400/40 bg-violet-400/10 text-violet-200'
                : 'border-slate-700/70 bg-slate-900/40 text-slate-500 hover:border-violet-400/35 hover:text-violet-300'
            }`}
          >
            <Layers className="h-3 w-3" aria-hidden="true" />
            Data layers
            <ChevronDown className={`h-3 w-3 transition-transform ${layersOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        </div>
        <div className="relative" ref={spacecraftPopoverRef}>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-mono uppercase tracking-widest text-slate-600">
              Sun-Earth L1
            </span>
            <button
              type="button"
              onClick={() => {
                setSpacecraftOpen(open => !open);
                setLayersOpen(false);
              }}
              aria-label="Show available L1 spacecraft"
              aria-expanded={spacecraftOpen}
              aria-controls="l1-spacecraft-popover"
              className={`flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
                spacecraftOpen
                  ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-200'
                  : 'border-slate-700/70 text-slate-500 hover:border-cyan-400/40 hover:text-cyan-300'
              }`}
            >
              <Info className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>

          {spacecraftOpen && (
            <div
              id="l1-spacecraft-popover"
              role="region"
              aria-label="Available L1 spacecraft"
              className="absolute right-0 top-full z-30 mt-2 w-64 rounded-md border border-slate-700 bg-slate-950/95 p-3 shadow-2xl shadow-black/50 backdrop-blur"
            >
              <div className="font-mono text-[9px] uppercase tracking-widest text-cyan-300">
                SWPC RTSW spacecraft
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                Spacecraft currently present in the live L1 products.
              </p>

              <div className="mt-3 space-y-1.5">
                {spacecraft.length > 0 ? spacecraft.map(item => (
                  <div key={item.name} className="flex items-center justify-between gap-3 rounded border border-slate-800 bg-slate-900/50 px-2.5 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-slate-200">{item.name}</div>
                      <div className="mt-0.5 truncate font-mono text-[8px] uppercase tracking-wider text-slate-600">
                        {item.products.join(' · ')}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[8px] uppercase tracking-wider ${
                      item.active
                        ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-300'
                        : 'border-slate-700 bg-slate-800/70 text-slate-400'
                    }`}>
                      {item.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                )) : (
                  <div className="rounded border border-slate-800 bg-slate-900/40 px-3 py-4 text-center font-mono text-[9px] uppercase tracking-wider text-slate-600">
                    No live spacecraft metadata
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {layersOpen && (
        <div
          ref={layersPanelRef}
          id="measurement-layers-panel"
          role="region"
          aria-label="Near-Earth, LEO and ground data layers"
          className="absolute left-4 right-4 top-11 z-40 max-h-[calc(100%-4rem)] overflow-y-auto rounded-md border border-slate-700 bg-slate-950/95 p-3 shadow-2xl shadow-black/60 backdrop-blur"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-widest text-slate-300">Measurement layers</div>
              <p className="mt-0.5 text-[9px] text-slate-600">Sources and model geometry represented around Earth</p>
            </div>
            <span className="font-mono text-[8px] uppercase tracking-widest text-slate-600">L1 → LEO → ground</span>
          </div>

          <div className="grid gap-2 md:grid-cols-[0.8fr_1.45fr_1.25fr]">
            <section className="min-w-0 rounded border border-sky-500/15 bg-sky-500/[0.035] px-2.5 py-2">
              <div className="font-mono text-[8px] uppercase tracking-widest text-sky-300/80">Near-Earth boundary</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="rounded border border-cyan-400/20 bg-cyan-400/5 px-1.5 py-0.5 font-mono text-[8px] text-cyan-100/75">Bow shock</span>
                <span className="rounded border border-blue-400/20 bg-blue-400/5 px-1.5 py-0.5 font-mono text-[8px] text-blue-100/75">Magnetopause</span>
                <span className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[8px] text-slate-500">MRU / ML target</span>
              </div>
              <div className="mt-2 border-t border-sky-500/10 pt-1.5">
                <div className="font-mono text-[7px] uppercase tracking-widest text-slate-600">Historical reference</div>
                <span className="mt-1 inline-flex rounded border border-cyan-400/25 bg-cyan-400/5 px-1.5 py-0.5 font-mono text-[8px] text-cyan-100/80">
                  NASA SPDF OMNI · bow-shock shifted
                </span>
              </div>
              <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">
                OMNI propagates multi-spacecraft L1 data to the bow-shock nose · it is not an in-situ bow-shock sensor
              </p>
            </section>

            <section className="min-w-0 rounded border border-violet-500/15 bg-violet-500/[0.035] px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <div className="font-mono text-[8px] uppercase tracking-widest text-violet-300/80">LEO density · ESA / VirES</div>
                <span className="rounded-full border border-violet-400/20 px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-wider text-violet-300/70">Retrospective</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {leoDensitySources.map(source => (
                  <span
                    key={source.name}
                    title={`${source.name} · ${source.detail} · ${source.status}`}
                    className="rounded border border-violet-400/20 bg-violet-400/5 px-1.5 py-0.5 font-mono text-[8px] text-violet-100/80"
                  >
                    {source.name}
                  </span>
                ))}
                <span title="No official VirES density collection is currently available" className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[8px] text-slate-600">
                  GRACE-FO 2 · unavailable
                </span>
              </div>
              <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">POD / accelerometer density · CelesTrak + SGP4 supply orbit context</p>
            </section>

            <section className="min-w-0 rounded border border-amber-500/15 bg-amber-500/[0.035] px-2.5 py-2">
              <div className="font-mono text-[8px] uppercase tracking-widest text-amber-300/80">Ground &amp; atmosphere forcing</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {groundSources.map(source => (
                  <span key={source} className="rounded border border-amber-400/20 bg-amber-400/5 px-1.5 py-0.5 font-mono text-[8px] text-amber-100/75">
                    {source}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">Geomagnetic response and thermosphere drivers · observed / archived</p>
            </section>
          </div>
        </div>
      )}

      <div className="min-h-0 px-4 py-3">
        <svg
          viewBox="0 0 820 270"
          className="h-full min-h-0 w-full"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-labelledby="sun-earth-map-title sun-earth-map-description"
        >
          <title id="sun-earth-map-title">Sun to Earth measurement architecture</title>
          <desc id="sun-earth-map-description">
            Solar wind travels from the Sun past the active L1 spacecraft, through Earth&apos;s bow shock and magnetopause, to LEO density missions and ground indices.
          </desc>
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
            <linearGradient id="magnetosphereBody" x1="0%" y1="50%" x2="100%" y2="50%">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.13" />
              <stop offset="58%" stopColor="#3b82f6" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.025" />
            </linearGradient>
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
          <text x="515" y="107" textAnchor="middle" fill="#bae6fd" fontSize="9" fontFamily="monospace">
            {activeSpacecraft ? `${activeSpacecraft} ACTIVE` : 'SWPC ACTIVE'}
          </text>
          <text x="515" y="166" textAnchor="middle" fill="#fbbf24" fontSize="10" fontFamily="monospace" fontWeight="700">L1</text>

          <path
            d="M 690 72 C 654 82 630 105 630 135 C 630 165 654 188 690 198 C 742 193 780 166 810 135 C 780 104 742 77 690 72 Z"
            fill="url(#magnetosphereBody)"
            stroke="#38bdf8"
            strokeWidth="0.8"
            strokeOpacity="0.45"
          />
          <path
            d="M 678 54 C 621 65 592 96 592 135 C 592 174 621 205 678 216"
            fill="none"
            stroke="#67e8f9"
            strokeWidth="1.4"
            strokeDasharray="5 4"
            strokeOpacity="0.7"
          />
          <text x="606" y="48" fill="#67e8f9" fontSize="8" fontFamily="monospace" letterSpacing="1">BOW SHOCK</text>
          <text x="652" y="79" fill="#60a5fa" fontSize="7" fontFamily="monospace" letterSpacing="0.7">MAGNETOPAUSE</text>

          <circle cx="704" cy="135" r="47" fill="url(#earthBody)" />
          <circle cx="704" cy="135" r="24" fill="#1d4ed8" />
          <circle cx="704" cy="135" r="28" fill="none" stroke="#60a5fa" strokeWidth="1" opacity="0.45" />
          <ellipse cx="704" cy="135" rx="58" ry="53" fill="none" stroke="#a5b4fc" strokeWidth="0.8" strokeDasharray="3 4" opacity="0.7" />

          <g aria-label="LEO density spacecraft">
            <circle cx="704" cy="82" r="3.2" fill="#c4b5fd" />
            <circle cx="754" cy="116" r="3.2" fill="#c4b5fd" />
            <circle cx="739" cy="177" r="3.2" fill="#c4b5fd" />
            <circle cx="661" cy="171" r="3.2" fill="#f9a8d4" />
            <text x="704" y="76" textAnchor="middle" fill="#ddd6fe" fontSize="7" fontFamily="monospace">A</text>
            <text x="761" y="116" fill="#ddd6fe" fontSize="7" fontFamily="monospace">B</text>
            <text x="744" y="184" fill="#ddd6fe" fontSize="7" fontFamily="monospace">C</text>
            <text x="643" y="178" fill="#fbcfe8" fontSize="7" fontFamily="monospace">GF1</text>
            <text x="769" y="91" fill="#a5b4fc" fontSize="7" fontFamily="monospace" letterSpacing="0.8">LEO</text>
          </g>

          <g aria-label="Ground index stations">
            <circle cx="687" cy="163" r="1.8" fill="#fbbf24" />
            <circle cx="700" cy="169" r="1.8" fill="#fbbf24" />
            <circle cx="714" cy="166" r="1.8" fill="#fbbf24" />
          </g>
          <text x="704" y="211" textAnchor="middle" fill="#60a5fa" fontSize="12" fontFamily="monospace" fontWeight="700">EARTH</text>
          <text x="704" y="224" textAnchor="middle" fill="#fbbf24" fontSize="7" fontFamily="monospace" letterSpacing="1">GROUND</text>
        </svg>
      </div>

      <div className="grid max-h-40 grid-cols-3 gap-3 overflow-y-auto border-t border-slate-800/60 p-3">
        <section className="min-w-0">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-cyan-500/80">RTSW Source</div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Spacecraft" value={activeSpacecraft ? `${activeSpacecraft} · active` : 'SWPC active'} />
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
