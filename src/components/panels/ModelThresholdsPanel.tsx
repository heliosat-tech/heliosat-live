import React from 'react';
import { Gauge, ListChecks } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';

interface ModelThresholdsPanelProps {
  compact?: boolean;
}

const Section: React.FC<{
  title: string;
  children: React.ReactNode;
  compact?: boolean;
}> = ({ title, children, compact = false }) => (
  <details className={`rounded border border-slate-800/80 bg-slate-950/35 ${compact ? 'p-2.5' : 'p-3'}`} open={!compact}>
    <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase tracking-widest text-slate-400">
      {title}
    </summary>
    <div className="mt-2 space-y-1.5">
      {children}
    </div>
  </details>
);

const ThresholdRow: React.FC<{
  label: string;
  value: string;
  status?: 'implemented' | 'not_implemented';
}> = ({ label, value, status = 'implemented' }) => (
  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-slate-800/60 py-1.5 last:border-b-0">
    <div className="min-w-0 text-[10px] leading-snug text-slate-300">{label}</div>
    <div className="flex flex-col items-end gap-1">
      <span className="whitespace-nowrap font-mono text-[10px] text-cyan-200">{value}</span>
      {status === 'not_implemented' && (
        <span className="rounded border border-slate-700 bg-slate-900/70 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-slate-500">
          Not implemented
        </span>
      )}
    </div>
  </div>
);

export const ModelThresholdsPanel: React.FC<ModelThresholdsPanelProps> = ({ compact = false }) => {
  return (
    <GlassCard
      title="Model Assumptions"
      className="h-full"
      bodyClassName={compact ? 'p-3' : 'p-4'}
      headerClassName={compact ? 'px-3 py-2' : undefined}
    >
      <div className={`flex h-full flex-col overflow-hidden ${compact ? 'gap-2.5' : 'gap-3'}`}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-800/60 pb-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-cyan-300">
              <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
              Transparent Thresholds
            </div>
            <div className="mt-1 text-[9px] leading-snug text-slate-600">
              These are transparent heuristic thresholds, not validated anomaly probabilities.
            </div>
          </div>
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-amber-300">
            HEURISTIC
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-2.5">
            <Section title="MRU Arrival Model" compact={compact}>
              <ThresholdRow label="Nominal L1 distance" value="1,500,000 km" />
              <ThresholdRow label="NOAA ephemeris accepted range" value="500,000-2,500,000 km" />
              <ThresholdRow label="Solar-wind speed validity" value="> 0 km/s" />
              <ThresholdRow label="Confidence ceiling" value="PARTIAL; MEDIUM not implemented" />
            </Section>

            <Section title="Physical Flags" compact={compact}>
              <ThresholdRow label="Southward Bz" value="Bz GSM < 0 nT" />
              <ThresholdRow label="Strong southward Bz" value="Bz GSM < -5 nT" status="not_implemented" />
              <ThresholdRow label="Elevated speed" value="Vsw >= 500 km/s" />
              <ThresholdRow label="High speed" value="Vsw >= 700 km/s" status="not_implemented" />
              <ThresholdRow label="Elevated density" value="n >= 10 cm^-3" />
              <ThresholdRow label="High-inclination LEO" value="inclination >= 60 deg" />
            </Section>

            <Section title="Orbit Classification" compact={compact}>
              <ThresholdRow label="LEO" value="altitude < 1200 km" />
              <ThresholdRow label="MEO" value="1200-30000 km" />
              <ThresholdRow label="GEO-like" value="30000-37000 km" />
              <ThresholdRow label="HEO" value="> 37000 km" />
            </Section>

            <div className="rounded border border-blue-500/20 bg-blue-500/10 p-2.5">
              <div className="flex items-center gap-2 text-[9px] uppercase tracking-widest text-blue-300">
                <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
                Scope
              </div>
              <p className="mt-1 text-[10px] leading-snug text-slate-300">
                No fake data, no random values, no numerical risk score, and no radiation dose are generated.
              </p>
            </div>
          </div>
        </div>
      </div>
    </GlassCard>
  );
};
