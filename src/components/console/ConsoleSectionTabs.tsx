"use client";

import type { ConsoleSectionDomain, ConsoleSectionId } from '@/lib/leo/navigation';

export const CONSOLE_SECTION_TAB_LABELS: Readonly<Record<ConsoleSectionId, Record<ConsoleSectionDomain, string>>> = Object.freeze({
  realtime: {
    l1: 'L1 to Bow Shock',
    leo: 'LEO Density and Drag',
    geomagnetic: 'Geomagnetic Storms',
  },
  archive: {
    l1: 'L1 and Bow Shock',
    leo: 'Thermosphere and LEO',
    geomagnetic: 'Geomagnetic Storms',
  },
  validation: {
    l1: 'L1 Arrival Time',
    leo: 'Thermospheric Density and Drag',
    geomagnetic: 'Geomagnetic Storms',
  },
});

const CONSOLE_SECTION_DOMAINS: Readonly<Record<ConsoleSectionId, readonly ConsoleSectionDomain[]>> = Object.freeze({
  realtime: ['l1', 'leo'],
  archive: ['l1', 'leo'],
  validation: ['l1', 'leo', 'geomagnetic'],
});

export function ConsoleSectionTabs({
  section,
  value,
  onChange,
}: {
  section: ConsoleSectionId;
  value: ConsoleSectionDomain;
  onChange: (value: ConsoleSectionDomain) => void;
}) {
  return (
    <div
      className="inline-flex max-w-full self-start overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/50 p-1"
      role="tablist"
      aria-label={`${section} scientific domain`}
    >
      {CONSOLE_SECTION_DOMAINS[section].map(domain => (
        <button
          key={domain}
          type="button"
          role="tab"
          aria-selected={value === domain}
          onClick={() => onChange(domain)}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
            value === domain
              ? 'bg-cyan-500/20 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.18)]'
              : 'text-slate-500 hover:bg-slate-900/70 hover:text-slate-300'
          }`}
        >
          {CONSOLE_SECTION_TAB_LABELS[section][domain]}
        </button>
      ))}
    </div>
  );
}
