'use client';

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Database,
  Gauge,
  RadioTower,
  Radar,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';

type TabId = 'pipeline' | 'events' | 'validation';

const TABS: Array<{ id: TabId; label: string; icon: typeof Bot }> = [
  { id: 'pipeline', label: 'Data pipeline', icon: Database },
  { id: 'events', label: 'Driver events', icon: Radar },
  { id: 'validation', label: 'Validation & Studies', icon: ShieldCheck },
];

// --- Payload types (mirror /api/new-version-claude/validation) --------------------------

interface Attribution {
  sourceId: string;
  provider: string;
  dataset: string;
  url: string;
  cadenceSeconds: number | null;
  notes?: string;
}

interface QualitySummary {
  sampleCount: number;
  samplesWithFlags: number;
  flags: Array<{ flag: string; count: number }>;
}

interface SourceBlock {
  sampleCount: number;
  attribution: Attribution[];
  warnings: string[];
  errors: string[];
  quality: QualitySummary;
  distanceKm?: number;
  distanceBasis?: string;
  cadenceMinutes?: number | null;
}

interface DriverEvent {
  eventId: string;
  eventType: string;
  severity: 'minor' | 'moderate' | 'strong' | 'severe';
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  peakValues: {
    maxSpeedKmS: number | null;
    minBzGsmNt: number | null;
    maxBtNt: number | null;
    maxDensityCm3: number | null;
    maxPdynNpa: number | null;
    maxEmMvM: number | null;
  };
  integratedSouthwardBz: number | null;
  integratedEm: number | null;
  sourceSamples: number;
  estimatedResponseWindow: {
    basis: string;
    ballisticDelayMinutes: number | null;
    arrivalStartUtc: string | null;
  };
}

interface ValidationRecord {
  eventId: string;
  eventType: string;
  severity: DriverEvent['severity'];
  startUtc: string;
  windows: { arrivalUtc: string; arrivalBasis: string };
  geo: { maxHpDisturbanceNt: number | null; baselineHpNt: number | null; maxProtonFlux: number | null; hpResponseDelayMinutes: number | null };
  ground: { maxKp6h: number | null; minDst12h: number | null; kpResponseDelayMinutes: number | null };
  groundResponseObserved: boolean;
  geoDisturbanceObserved: boolean;
  responseConsistent: boolean;
  isGeoeffectivePrediction: boolean;
}

interface FractionSummary {
  count: number;
  total: number;
  fraction: number | null;
}

interface ValidationSummary {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  highCouplingFollowedByKp5: FractionSummary;
  severeBzFollowedByKp6: FractionSummary;
  highPdynFollowedByGeoDisturbance: FractionSummary;
  predictionCount: number;
  truePositives: number;
  falsePositives: number;
  precision: number | null;
  recall: number | null;
  falseAlarmRate: number | null;
  missedResponseEvents: number;
  observedStormOnsets: number;
  medianGroundResponseDelayMinutes: number | null;
}

interface Payload {
  generatedAtUtc: string;
  window: string;
  l1: SourceBlock;
  goes: SourceBlock;
  ground: SourceBlock;
  gRiskProxy: { maxKp: number | null; level: number; label: string };
  events: DriverEvent[];
  validation: { records: ValidationRecord[]; summary: ValidationSummary };
}

// --- Formatting helpers ----------------------------------------------------------------

function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) !== 0 && (Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3)) return value.toExponential(2);
  return Number(value.toFixed(digits)).toString();
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

function dt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(5, 16).replace('T', ' ')}Z`;
}

const SEVERITY_STYLE: Record<DriverEvent['severity'], string> = {
  minor: 'text-slate-300 border-slate-600',
  moderate: 'text-amber-200 border-amber-500/50',
  strong: 'text-orange-200 border-orange-500/50',
  severe: 'text-red-200 border-red-500/50',
};

const EVENT_LABELS: Record<string, string> = {
  high_speed_stream: 'High-speed stream',
  southward_imf: 'Southward IMF',
  high_bt: 'High |B|',
  high_density: 'High density',
  high_dynamic_pressure: 'High dynamic pressure',
  high_coupling: 'High coupling',
  compound_geoeffective: 'Compound geoeffective',
  compression: 'Compression',
};

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-slate-100">{value}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function SourceCard({ title, block, icon: Icon }: { title: string; block: SourceBlock; icon: typeof Bot }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-2 flex items-center gap-2 text-slate-200">
        <Icon className="h-4 w-4 text-cyan-300" aria-hidden="true" />
        <span className="text-sm font-semibold">{title}</span>
        <span className="ml-auto text-xs text-slate-400">{block.sampleCount} samples</span>
      </div>
      {block.distanceBasis && (
        <p className="text-xs text-slate-400">
          L1 distance {fmt(block.distanceKm, 0)} km ({block.distanceBasis})
          {block.cadenceMinutes ? ` · cadence ~${block.cadenceMinutes} min` : ''}
        </p>
      )}
      <ul className="mt-2 space-y-1">
        {block.attribution.map(a => (
          <li key={a.dataset} className="text-xs text-slate-400">
            <span className="text-slate-300">{a.provider}</span> · {a.dataset}
          </li>
        ))}
      </ul>
      {block.errors.length > 0 && (
        <p className="mt-2 text-xs text-red-300">{block.errors.length} source error(s): {block.errors[0]}</p>
      )}
      {block.quality.flags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {block.quality.flags.slice(0, 6).map(f => (
            <span key={f.flag} className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
              {f.flag} ({f.count})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * New Version Claude — a self-contained MVP screen built without OMNI. It detects hazardous
 * physical L1 drivers, estimates the terrestrial response window, and validates operational
 * relevance against real GEO (GOES) and ground geomagnetic-response indices (Kp, Dst).
 */
export function NewVersionClaudeScreen() {
  const [tab, setTab] = useState<TabId>('validation');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/new-version-claude/validation', { cache: 'no-store' });
        if (!res.ok) throw new Error(`Validation request failed (${res.status})`);
        const json = (await res.json()) as Payload;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const refresh = () => {
    setLoading(true);
    setReloadKey(key => key + 1);
  };

  const summary = data?.validation.summary;
  const records = data?.validation.records ?? [];

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4" aria-label="New Version Claude">
      <header className="rounded-lg border border-slate-800 bg-slate-950/60 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 text-cyan-200">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-100">New Version Claude</h1>
            <p className="text-xs text-slate-400">
              L1 physical-driver detection · terrestrial response window · GEO + ground response validation · no OMNI
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="ml-auto flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{loading ? 'Loading' : 'Refresh'}</span>
          </button>
        </div>

        <nav className="mt-4 flex flex-wrap gap-2" aria-label="Sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition ${
                tab === id
                  ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-100'
                  : 'border-slate-700 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-100'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
          {data && (
            <span className="ml-auto self-center text-[11px] text-slate-500">
              {data.window} window · generated {dt(data.generatedAtUtc)}
            </span>
          )}
        </nav>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-5">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> {error}
          </div>
        )}
        {!data && loading && <p className="text-sm text-slate-400">Ingesting L1, GEO and ground sources…</p>}
        {!data && !loading && !error && <p className="text-sm text-slate-400">No data.</p>}

        {data && tab === 'pipeline' && (
          <div className="grid gap-4 md:grid-cols-3">
            <SourceCard title="L1 solar wind (input)" block={data.l1} icon={RadioTower} />
            <SourceCard title="GOES (GEO context)" block={data.goes} icon={Radar} />
            <SourceCard title="Ground response (Kp/Dst)" block={data.ground} icon={Gauge} />
          </div>
        )}

        {data && tab === 'events' && (
          <div>
            <p className="mb-3 text-sm text-slate-300">
              {data.events.length} hazardous physical-driver interval(s) detected at L1.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="text-slate-400">
                  <tr className="border-b border-slate-800">
                    <th className="px-2 py-1.5">Type</th>
                    <th className="px-2 py-1.5">Severity</th>
                    <th className="px-2 py-1.5">Start (UTC)</th>
                    <th className="px-2 py-1.5">Dur (min)</th>
                    <th className="px-2 py-1.5">max V</th>
                    <th className="px-2 py-1.5">min Bz</th>
                    <th className="px-2 py-1.5">max Pdyn</th>
                    <th className="px-2 py-1.5">max Em</th>
                    <th className="px-2 py-1.5">∫Bs</th>
                    <th className="px-2 py-1.5">Arrival (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map(event => (
                    <tr key={event.eventId} className="border-b border-slate-900">
                      <td className="px-2 py-1.5 text-slate-200">{EVENT_LABELS[event.eventType] ?? event.eventType}</td>
                      <td className={`px-2 py-1.5`}>
                        <span className={`rounded border px-1.5 py-0.5 ${SEVERITY_STYLE[event.severity]}`}>{event.severity}</span>
                      </td>
                      <td className="px-2 py-1.5 text-slate-400">{dt(event.startUtc)}</td>
                      <td className="px-2 py-1.5 text-slate-300">{fmt(event.durationMinutes, 0)}</td>
                      <td className="px-2 py-1.5 text-slate-300">{fmt(event.peakValues.maxSpeedKmS, 0)}</td>
                      <td className="px-2 py-1.5 text-slate-300">{fmt(event.peakValues.minBzGsmNt, 1)}</td>
                      <td className="px-2 py-1.5 text-slate-300">{fmt(event.peakValues.maxPdynNpa, 1)}</td>
                      <td className="px-2 py-1.5 text-slate-300">{fmt(event.peakValues.maxEmMvM, 1)}</td>
                      <td className="px-2 py-1.5 text-slate-300">{fmt(event.integratedSouthwardBz, 0)}</td>
                      <td className="px-2 py-1.5 text-slate-400">{dt(event.estimatedResponseWindow.arrivalStartUtc)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.events.length === 0 && <p className="text-sm text-slate-500">No hazardous driver intervals in this window.</p>}
          </div>
        )}

        {data && tab === 'validation' && summary && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              <Gauge className="h-5 w-5 text-cyan-300" aria-hidden="true" />
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Derived G-risk indicator (proxy, from observed Kp)</div>
                <div className="text-xl font-semibold text-slate-100">{data.gRiskProxy.label}</div>
              </div>
              <div className="ml-auto text-right text-xs text-slate-500">
                max observed Kp (6 h post-arrival): <span className="text-slate-200">{fmt(data.gRiskProxy.maxKp, 1)}</span>
              </div>
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-200">Physical-driver event statistics</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                <StatCard label="Events" value={String(summary.totalEvents)} />
                <StatCard label="Predictions" value={String(summary.predictionCount)} hint="geoeffective rule" />
                <StatCard label="Precision" value={pct(summary.precision)} hint={`${summary.truePositives}/${summary.predictionCount}`} />
                <StatCard label="Recall" value={pct(summary.recall)} hint={`${summary.observedStormOnsets - summary.missedResponseEvents}/${summary.observedStormOnsets} storms`} />
                <StatCard label="False alarm" value={pct(summary.falseAlarmRate)} hint={`${summary.falsePositives} FP`} />
                <StatCard label="Missed" value={String(summary.missedResponseEvents)} hint="Kp storms" />
                <StatCard label="Median delay" value={`${fmt(summary.medianGroundResponseDelayMinutes, 0)} min`} hint="L1→Kp peak" />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <ConsistencyCard label="High coupling → Kp ≥ 5" f={summary.highCouplingFollowedByKp5} />
              <ConsistencyCard label="Severe Bz → Kp ≥ 6" f={summary.severeBzFollowedByKp6} />
              <ConsistencyCard label="High Pdyn → GEO disturbance" f={summary.highPdynFollowedByGeoDisturbance} />
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-200">GEO + ground response consistency (per event)</h2>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="text-slate-400">
                    <tr className="border-b border-slate-800">
                      <th className="px-2 py-1.5">Driver</th>
                      <th className="px-2 py-1.5">Sev</th>
                      <th className="px-2 py-1.5">Arrival (UTC)</th>
                      <th className="px-2 py-1.5">max Kp 6h</th>
                      <th className="px-2 py-1.5">min Dst 12h</th>
                      <th className="px-2 py-1.5">max |Hp| dist.</th>
                      <th className="px-2 py-1.5">GEO</th>
                      <th className="px-2 py-1.5">Ground</th>
                      <th className="px-2 py-1.5">Consistent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(record => (
                      <tr key={record.eventId} className="border-b border-slate-900">
                        <td className="px-2 py-1.5 text-slate-200">{EVENT_LABELS[record.eventType] ?? record.eventType}</td>
                        <td className="px-2 py-1.5"><span className={`rounded border px-1.5 py-0.5 ${SEVERITY_STYLE[record.severity]}`}>{record.severity}</span></td>
                        <td className="px-2 py-1.5 text-slate-400">{dt(record.windows.arrivalUtc)}</td>
                        <td className="px-2 py-1.5 text-slate-300">{fmt(record.ground.maxKp6h, 1)}</td>
                        <td className="px-2 py-1.5 text-slate-300">{fmt(record.ground.minDst12h, 0)}</td>
                        <td className="px-2 py-1.5 text-slate-300">{fmt(record.geo.maxHpDisturbanceNt, 0)} nT</td>
                        <td className="px-2 py-1.5">{record.geoDisturbanceObserved ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-slate-600" />}</td>
                        <td className="px-2 py-1.5">{record.groundResponseObserved ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-slate-600" />}</td>
                        <td className="px-2 py-1.5">{record.responseConsistent ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-slate-600" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {records.length === 0 && <p className="text-sm text-slate-500">No events to validate in this window.</p>}
            </div>

            <p className="text-[11px] text-slate-500">
              Response consistency, not causality. GOES is GEO context, not L1 truth. Kp/G is a derived ground-response
              proxy, not an in-situ variable. OMNI is not used.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}

function ConsistencyCard({ label, f }: { label: string; f: FractionSummary }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-lg font-semibold text-slate-100">{f.fraction === null ? '—' : `${(f.fraction * 100).toFixed(0)}%`}</span>
        <span className="text-xs text-slate-500">{f.count}/{f.total}</span>
      </div>
    </div>
  );
}
