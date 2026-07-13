"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, Gauge, Loader2, Orbit, RefreshCw, Satellite, ShieldAlert, Wind } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { LeoForecastResponse } from '@/lib/leo/contracts';

type TleGroup = LeoForecastResponse['selector']['group'];

function fmtUtc(value: string | null, short = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unavailable';
  if (short) return new Date(value).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  return value.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function fmtNumber(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  const abs = Math.abs(value);
  return abs !== 0 && (abs < 0.001 || abs >= 100_000) ? value.toExponential(digits) : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function StatusBadge({ value }: { value: string }) {
  const style = value === 'available' || value === 'fresh'
    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
    : value === 'partial' || value === 'degraded'
      ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
      : value === 'error' || value === 'stale'
        ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
        : 'border-slate-700 bg-slate-900/70 text-slate-500';
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest ${style}`}>{value}</span>;
}

function SummaryCard({ label, value, unit, evidence = 'experimental forecast' }: { label: string; value: number | null; unit?: string; evidence?: string }) {
  const available = value !== null && Number.isFinite(value);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${available ? 'text-slate-100' : 'text-slate-600'}`}>{fmtNumber(value)}{available && unit ? <span className="ml-1 text-[10px] font-normal text-slate-500">{unit}</span> : null}</div>
      <div className="mt-1 font-mono text-[7px] uppercase tracking-widest text-slate-600">{available ? evidence : 'not computed'}</div>
    </div>
  );
}

function TimeCard({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${value ? 'text-slate-200' : 'text-slate-600'}`}>{fmtUtc(value)}</div>
      <div className="mt-1 font-mono text-[7px] uppercase tracking-widest text-slate-600">UTC · experimental forecast</div>
    </div>
  );
}

interface ChartLine {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
  yAxisId?: string;
}

function ResearchLineChart({ title, subtitle, data, lines, nowMarkerMs = null }: {
  title: string;
  subtitle: string;
  data: Array<Record<string, unknown>>;
  lines: ChartLine[];
  nowMarkerMs?: number | null;
}) {
  if (!data.length) return null;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{title}</h3><p className="mt-1 text-[9px] text-slate-600">{subtitle}</p></div>
        <div className="flex flex-wrap gap-2">{lines.map(line => <span key={line.key} className="inline-flex items-center gap-1 font-mono text-[8px] text-slate-500"><span className={`h-0 w-3 border-t ${line.dashed ? 'border-dashed' : ''}`} style={{ borderColor: line.color }} />{line.label}</span>)}</div>
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="timestamp" type="number" domain={['dataMin', 'dataMax']} tickFormatter={value => fmtUtc(new Date(Number(value)).toISOString(), true)} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={{ stroke: '#334155' }} tickLine={false} />
            <YAxis yAxisId="left" width={52} tickFormatter={value => Number(value).toExponential(1)} tick={{ fill: '#64748b', fontSize: 8 }} axisLine={false} tickLine={false} />
            {lines.some(line => line.yAxisId === 'right') && <YAxis yAxisId="right" orientation="right" width={48} tickFormatter={value => Number(value).toPrecision(2)} tick={{ fill: '#64748b', fontSize: 8 }} axisLine={false} tickLine={false} />}
            <Tooltip labelFormatter={value => fmtUtc(new Date(Number(value)).toISOString())} formatter={(value, name) => [typeof value === 'number' ? fmtNumber(value, 5) : 'Unavailable', name]} contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} />
            {nowMarkerMs !== null && <ReferenceLine x={nowMarkerMs} stroke="#94a3b8" strokeDasharray="2 4" label={{ value: 'now', fill: '#64748b', fontSize: 8 }} />}
            {lines.map(line => <Line key={line.key} yAxisId={line.yAxisId ?? 'left'} type="monotone" dataKey={line.key} name={line.label} stroke={line.color} strokeWidth={1.5} strokeDasharray={line.dashed ? '5 4' : undefined} dot={false} connectNulls={false} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DensityChart({ data, nowMarkerMs, calibrationStatus }: { data: Array<Record<string, unknown>>; nowMarkerMs: number | null; calibrationStatus: string }) {
  if (!data.length) return null;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Density forecast</h3><p className="mt-1 text-[9px] text-slate-600">kg m⁻³ · p10–p90 only with held-out calibration · {calibrationStatus}</p></div><div className="flex gap-2 font-mono text-[8px] text-slate-500"><span>baseline</span><span className="text-cyan-300">corrected p50</span><span className="text-violet-300">assumption extension</span></div></div>
      <div className="h-56 w-full"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#1e293b" strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="timestamp" type="number" domain={['dataMin', 'dataMax']} tickFormatter={value => fmtUtc(new Date(Number(value)).toISOString(), true)} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={{ stroke: '#334155' }} tickLine={false} />
        <YAxis width={52} tickFormatter={value => Number(value).toExponential(1)} tick={{ fill: '#64748b', fontSize: 8 }} axisLine={false} tickLine={false} />
        <Tooltip labelFormatter={value => fmtUtc(new Date(Number(value)).toISOString())} formatter={(value, name) => [typeof value === 'number' ? Number(value).toExponential(4) : 'Unavailable', name]} contentStyle={{ background: '#020617', border: '1px solid #334155', borderRadius: 8, fontSize: 10 }} />
        <Area type="monotone" dataKey="rhoP90" name="p90" stroke="none" fill="#22d3ee" fillOpacity={0.08} connectNulls={false} isAnimationActive={false} />
        <Area type="monotone" dataKey="rhoP10" name="p10" stroke="none" fill="#020617" fillOpacity={0.85} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="rhoBaseline" name="baseline" stroke="#94a3b8" strokeWidth={1.2} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="rhoConfirmed" name="p50 confirmed inbound" stroke="#22d3ee" strokeWidth={1.8} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="rhoAssumption" name="p50 assumption extension" stroke="#a78bfa" strokeWidth={1.8} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />
        {nowMarkerMs !== null && <ReferenceLine x={nowMarkerMs} stroke="#94a3b8" strokeDasharray="2 4" />}
      </AreaChart></ResponsiveContainer></div>
    </div>
  );
}

export function LeoRealtimePanel() {
  const [group, setGroup] = useState<TleGroup>('stations');
  const [selectedNorad, setSelectedNorad] = useState<string | null>(null);
  const [forecast, setForecast] = useState<LeoForecastResponse | null>(null);
  const [nowMarkerMs, setNowMarkerMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setRequestError(null);
    try {
      const params = new URLSearchParams({ group, horizon_minutes: '180', cadence_minutes: '5' });
      if (selectedNorad) params.set('norad_id', selectedNorad);
      const response = await fetch(`/api/console/leo/forecast?${params}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 403 ? 'Admin access is required.' : 'Experimental forecast request failed.');
      const next = (await response.json()) as LeoForecastResponse;
      if (activeRequest.current !== controller) return;
      setForecast(next);
      setNowMarkerMs(Date.now());
      setSelectedNorad(next.selector.selected_norad_id);
    } catch (error) {
      if (controller.signal.aborted) return;
      setRequestError(error instanceof Error ? error.message : 'Experimental forecast request failed.');
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [group, selectedNorad]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(() => void load(), 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(poll); activeRequest.current?.abort(); };
  }, [load]);

  const densityData = useMemo(() => forecast?.timeline?.map(point => ({
    timestamp: Date.parse(point.timestamp_utc),
    rhoBaseline: point.rho_baseline_kg_m3,
    rhoP10: point.rho_p10_kg_m3,
    rhoP90: point.rho_p90_kg_m3,
    rhoConfirmed: point.forcing_mode === 'confirmed_inbound' ? point.rho_p50_kg_m3 : null,
    rhoAssumption: point.forcing_mode === 'assumption_extension' ? point.rho_p50_kg_m3 : null,
    dragBaseline: point.drag_acceleration_baseline_m_s2,
    dragConfirmed: point.forcing_mode === 'confirmed_inbound' ? point.drag_acceleration_p50_m_s2 : null,
    dragAssumption: point.forcing_mode === 'assumption_extension' ? point.drag_acceleration_p50_m_s2 : null,
    deltaVBaseline: point.cumulative_delta_v_baseline_m_s,
    deltaVP50: point.cumulative_delta_v_p50_m_s,
    alongBaseline: point.along_track_baseline_m,
    alongP50: point.along_track_p50_m,
    altitude: point.altitude_km,
    latitude: point.latitude_deg,
    localSolarTime: point.local_solar_time_h,
  })) ?? [], [forecast]);

  const forcingData = useMemo(() => forecast?.forcing.timeline.map(point => ({
    timestamp: Date.parse(point.arrival_time_bow_shock_utc),
    bzConfirmed: point.forcing_mode === 'confirmed_inbound' ? point.bz_gsm_nt : null,
    bzAssumption: point.forcing_mode === 'assumption_extension' ? point.bz_gsm_nt : null,
    emConfirmed: point.forcing_mode === 'confirmed_inbound' ? point.em_mv_m : null,
    emAssumption: point.forcing_mode === 'assumption_extension' ? point.em_mv_m : null,
  })) ?? [], [forecast]);

  const trajectoryData = useMemo(() => forecast?.trajectory.points.map(point => ({
    timestamp: Date.parse(point.timestamp_utc),
    altitude: point.altitude_km,
    latitude: point.latitude_deg,
    localSolarTime: point.local_solar_time_h,
  })) ?? [], [forecast]);

  const summary = forecast?.summary;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-fuchsia-400/30 bg-fuchsia-400/[0.06] px-4 py-3">
        <div className="flex items-center gap-3"><ShieldAlert className="h-5 w-5 text-fuchsia-300" aria-hidden="true" /><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-sm font-semibold text-fuchsia-100">Research model, not operational</h1><span className="rounded border border-fuchsia-300/25 px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-widest text-fuchsia-200">experimental live</span></div><p className="mt-0.5 text-[10px] text-fuchsia-100/60">Experimental thermospheric density and first-order drag advisory. Do not use for precise orbit determination or conjunction operations.</p></div></div>
        {forecast && <StatusBadge value={forecast.status} />}
      </div>

      <header className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3"><Satellite className="mt-0.5 h-5 w-5 text-cyan-300" aria-hidden="true" /><div><h2 className="text-lg font-semibold text-slate-100">LEO density and drag forecast</h2><p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-slate-500">experimental forecast density · scenario orbital impact · UTC</p></div></div>
          <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1.5 rounded border border-slate-700/70 px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-400 transition hover:text-cyan-200 disabled:cursor-wait">{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} refresh</button>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[10rem_minmax(0,1fr)]">
          <label className="font-mono text-[8px] uppercase tracking-widest text-slate-600">CelesTrak group<select value={group} onChange={event => { setGroup(event.target.value === 'weather' ? 'weather' : 'stations'); setSelectedNorad(null); }} className="mt-1 block h-9 w-full rounded border border-slate-700 bg-slate-950 px-2 text-[10px] normal-case tracking-normal text-slate-300 outline-none focus:border-cyan-400/50"><option value="stations">stations</option><option value="weather">weather</option></select></label>
          <label className="font-mono text-[8px] uppercase tracking-widest text-slate-600">Selected TLE object<select value={selectedNorad ?? ''} onChange={event => setSelectedNorad(event.target.value || null)} disabled={!forecast?.selector.options.length} className="mt-1 block h-9 w-full rounded border border-slate-700 bg-slate-950 px-2 text-[10px] normal-case tracking-normal text-slate-300 outline-none focus:border-cyan-400/50 disabled:text-slate-600"><option value="">{forecast?.selector.options.length ? 'Choose an object' : 'No real TLE catalog available'}</option>{forecast?.selector.options.map(option => <option key={option.norad_id} value={option.norad_id}>{option.name} · NORAD {option.norad_id} · TLE {option.tle_freshness}</option>)}</select></label>
        </div>

        {forecast && <div className="mt-3 grid grid-cols-2 gap-2 text-[9px] sm:grid-cols-4 lg:grid-cols-6"><div><div className="font-mono uppercase tracking-widest text-slate-600">generated</div><div className="mt-1 text-slate-300">{fmtUtc(forecast.generated_at_utc)}</div></div><div><div className="font-mono uppercase tracking-widest text-slate-600">horizon</div><div className="mt-1 text-slate-300">{forecast.trajectory.horizon_minutes} min · {forecast.trajectory.cadence_minutes} min steps</div></div><div><div className="font-mono uppercase tracking-widest text-slate-600">model</div><div className="mt-1 text-slate-300">{forecast.model.version ?? 'Unavailable'}</div></div><div><div className="font-mono uppercase tracking-widest text-slate-600">trajectory</div><div className="mt-1"><StatusBadge value={forecast.trajectory.status} /></div></div><div><div className="font-mono uppercase tracking-widest text-slate-600">TLE age</div><div className="mt-1 text-slate-300">{forecast.trajectory.satellite?.tle_age_hours === null || forecast.trajectory.satellite?.tle_age_hours === undefined ? 'Unknown' : `${forecast.trajectory.satellite.tle_age_hours.toFixed(1)} h`}</div></div><div><div className="font-mono uppercase tracking-widest text-slate-600">validated altitude</div><div className="mt-1 text-slate-300">{forecast.validated_domain?.altitude_min_km === null || forecast.validated_domain?.altitude_min_km === undefined ? 'Unavailable' : `${forecast.validated_domain.altitude_min_km.toFixed(0)}–${forecast.validated_domain.altitude_max_km?.toFixed(0)} km`}</div></div></div>}
      </header>

      {loading && !forecast ? <div className="flex h-48 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/30 font-mono text-[10px] uppercase tracking-widest text-slate-600"><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> resolving TLE, L1 queue and local model artifact…</div> : requestError && !forecast ? <div className="flex h-40 items-center justify-center rounded-xl border border-rose-400/25 bg-rose-400/[0.05] px-5 text-center font-mono text-[10px] uppercase tracking-widest text-rose-200/80">{requestError}</div> : forecast ? <>
        {forecast.out_of_distribution.is_out_of_domain && <div className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-400/[0.06] px-4 py-3 text-[10px] text-rose-100/80"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><div><div className="font-mono uppercase tracking-widest text-rose-200">out of validated domain</div><div className="mt-1">{forecast.out_of_distribution.reasons.join(' · ')}</div></div></div>}

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5"><SummaryCard label="baseline density" value={summary?.rho_baseline_kg_m3 ?? null} unit="kg m⁻³" /><SummaryCard label="corrected density p50" value={summary?.rho_p50_kg_m3 ?? null} unit="kg m⁻³" /><SummaryCard label="density enhancement" value={summary?.density_enhancement ?? null} unit="× baseline" /><SummaryCard label="drag acceleration p50" value={summary?.drag_acceleration_p50_m_s2 ?? null} unit="m s⁻²" evidence="scenario impact" /><SummaryCard label="cumulative Δv" value={summary?.cumulative_delta_v_m_s ?? null} unit="m s⁻¹" evidence="scenario impact" /><SummaryCard label="along-track estimate" value={summary?.along_track_estimate_m ?? null} unit="m" evidence="first-order scenario" /><TimeCard label="expected onset" value={summary?.expected_onset_utc ?? null} /><TimeCard label="expected peak" value={summary?.expected_peak_utc ?? null} /><TimeCard label="expected recovery" value={summary?.expected_recovery_utc ?? null} /><div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">forecast confidence</div><div className={`mt-1 text-lg font-semibold ${summary?.forecast_confidence ? 'text-slate-100' : 'text-slate-600'}`}>{summary?.forecast_confidence ?? 'Unavailable'}</div><div className="mt-1 font-mono text-[7px] uppercase tracking-widest text-slate-600">versioned uncertainty only</div></div></div>

        {!forecast.timeline && <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-4"><div className="flex items-center gap-2"><Activity className="h-4 w-4 text-amber-300" aria-hidden="true" /><h2 className="text-xs font-semibold uppercase tracking-widest text-amber-100/90">Physical context available; density model output unavailable</h2></div><p className="mt-2 max-w-4xl text-[10px] leading-relaxed text-slate-400">The selected orbit and propagated solar-wind context below are real current inputs. No fresh, versioned density forecast snapshot matched this NORAD object, so density, drag and impact fields remain null rather than being filled by persistence, climatology or test fixtures.</p></div>}

        <div className="grid gap-3 xl:grid-cols-2"><DensityChart data={densityData} nowMarkerMs={nowMarkerMs} calibrationStatus={forecast.model.uncertainty.status} /><ResearchLineChart title="Drag acceleration" subtitle="m s⁻² · generic ballistic-coefficient scenario, never inferred from TLE" data={densityData} nowMarkerMs={nowMarkerMs} lines={[{ key: 'dragBaseline', label: 'baseline', color: '#94a3b8' }, { key: 'dragConfirmed', label: 'p50 confirmed', color: '#22d3ee' }, { key: 'dragAssumption', label: 'p50 assumption', color: '#a78bfa', dashed: true }]} /></div>
        <div className="grid gap-3 xl:grid-cols-2"><ResearchLineChart title="Cumulative drag Δv" subtitle="m s⁻¹ · first-order integrated scenario" data={densityData} lines={[{ key: 'deltaVBaseline', label: 'baseline', color: '#94a3b8' }, { key: 'deltaVP50', label: 'corrected p50', color: '#22d3ee' }]} /><ResearchLineChart title="Along-track displacement proxy" subtitle="m · first-order estimate, not precise orbit determination" data={densityData} lines={[{ key: 'alongBaseline', label: 'baseline', color: '#94a3b8' }, { key: 'alongP50', label: 'corrected p50', color: '#f59e0b' }]} /></div>
        <div className="grid gap-3 xl:grid-cols-2"><ResearchLineChart title="Physical forcing at bow shock" subtitle="Bz GSM [nT] and Em [mV/m] · solid measured inbound, dashed persistence extension" data={forcingData} nowMarkerMs={nowMarkerMs} lines={[{ key: 'bzConfirmed', label: 'Bz confirmed', color: '#38bdf8' }, { key: 'bzAssumption', label: 'Bz assumption', color: '#a78bfa', dashed: true }, { key: 'emConfirmed', label: 'Em confirmed', color: '#f59e0b', yAxisId: 'right' }, { key: 'emAssumption', label: 'Em assumption', color: '#fb7185', dashed: true, yAxisId: 'right' }]} /><ResearchLineChart title="Trajectory context" subtitle="TLE-derived SGP4 trajectory · altitude [km], latitude [deg], local solar time [h]" data={trajectoryData} lines={[{ key: 'altitude', label: 'altitude', color: '#22d3ee' }, { key: 'latitude', label: 'latitude', color: '#a78bfa', yAxisId: 'right' }, { key: 'localSolarTime', label: 'local solar time', color: '#f59e0b', yAxisId: 'right' }]} /></div>

        <div className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4"><div className="flex items-center gap-2"><Orbit className="h-4 w-4 text-cyan-300" aria-hidden="true" /><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Orbit and spacecraft scenario</h2></div><dl className="mt-3 space-y-2 text-[10px]"><div><dt className="font-mono uppercase tracking-widest text-slate-600">selected object</dt><dd className="mt-0.5 text-slate-300">{forecast.trajectory.satellite?.name ?? 'Unavailable'}{forecast.trajectory.satellite ? ` · NORAD ${forecast.trajectory.satellite.norad_id}` : ''}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">orbit source</dt><dd className="mt-0.5 text-slate-300">{forecast.assumptions.orbit_source ?? 'Unavailable'} · {forecast.trajectory.propagator}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">ballistic coefficient B = CdA/m</dt><dd className="mt-0.5 text-slate-300">{forecast.spacecraft_parameters.direct_ballistic_coefficient_m2_kg} m²/kg</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">parameter provenance</dt><dd className="mt-0.5 text-slate-400">{forecast.spacecraft_parameters.parameter_source}</dd></div></dl></div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4"><div className="flex items-center gap-2"><Wind className="h-4 w-4 text-violet-300" aria-hidden="true" /><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Atmosphere assumptions</h2></div><dl className="mt-3 space-y-2 text-[10px]"><div><dt className="font-mono uppercase tracking-widest text-slate-600">baseline</dt><dd className="mt-0.5 text-slate-300">{forecast.baseline.model_name ?? 'Unavailable'}{forecast.baseline.model_version ? ` · ${forecast.baseline.model_version}` : ''} <StatusBadge value={forecast.baseline.status} /></dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">co-rotation</dt><dd className="mt-0.5 text-slate-300">{forecast.assumptions.atmosphere_corotation}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">neutral winds</dt><dd className="mt-0.5 text-slate-300">{forecast.assumptions.neutral_winds}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">licensing</dt><dd className="mt-0.5 text-amber-100/70">{forecast.baseline.licensing_status}</dd></div></dl></div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4"><div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-amber-300" aria-hidden="true" /><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Model and evidence</h2></div><dl className="mt-3 space-y-2 text-[10px]"><div><dt className="font-mono uppercase tracking-widest text-slate-600">density model</dt><dd className="mt-0.5 text-slate-300">{forecast.model.version ?? 'Unavailable'} <StatusBadge value={forecast.model.status} /></dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">training range</dt><dd className="mt-0.5 text-slate-300">{forecast.model.training_range ? `${forecast.model.training_range.start_utc.slice(0, 10)} → ${forecast.model.training_range.end_utc.slice(0, 10)}` : 'Unavailable'}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">evidence classes</dt><dd className="mt-0.5 text-slate-300">{forecast.evidence_classes.join(' · ')}</dd></div><div><dt className="font-mono uppercase tracking-widest text-slate-600">orbital impact</dt><dd className="mt-0.5 text-slate-300">{forecast.assumptions.orbital_impact}</dd></div></dl></div>
        </div>

        <details className="rounded-xl border border-slate-800 bg-slate-950/35 px-4 py-3"><summary className="cursor-pointer font-mono text-[9px] uppercase tracking-widest text-slate-400">data source health and machine-readable status</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] leading-relaxed text-slate-500">{JSON.stringify(forecast.data_health, null, 2)}</pre></details>
        {forecast.warnings.length > 0 && <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-3 text-[10px] leading-relaxed text-amber-100/75">{forecast.warnings.join(' · ')}</div>}
        {forecast.errors.length > 0 && <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.05] px-4 py-3 text-[10px] leading-relaxed text-rose-100/75">{forecast.errors.join(' · ')}</div>}
      </> : null}
      {requestError && forecast && <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">Refresh failed; showing the previous forecast context. {requestError}</div>}
    </section>
  );
}
