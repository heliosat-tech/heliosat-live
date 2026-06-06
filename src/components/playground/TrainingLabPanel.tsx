"use client";

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  CalendarRange,
  Check,
  Copy,
  Database,
  Eye,
  FlaskConical,
  Hash,
  Lock,
  Play,
  RefreshCw,
  Save,
  Table2,
  X,
} from 'lucide-react';
import {
  calculateExperimentConfigHash,
  createDefaultExperimentConfig,
  EXPERIMENT_STATUSES,
  getExperimentStatusLabel,
  HORIZON_MINUTE_OPTIONS,
  L1_SOURCE_OPTIONS,
  slugifyExperimentName,
  TARGET_SOURCE_OPTIONS,
  TARGET_SPACECRAFT_OPTIONS,
  TARGET_VARIABLE_OPTIONS,
  VALIDATION_STRATEGY_OPTIONS,
  validateExperimentPayload,
  type ExperimentStatus,
  type L1Source,
  type TargetSource,
  type TargetSpacecraft,
  type TargetVariable,
  type TrainingExperimentConfig,
  type TrainingExperimentPayload,
  type TrainingExperimentRecord,
  type ValidationStrategy,
} from '@/services/trainingExperimentConfig';

interface TrainingLabPanelProps {
  experiments: TrainingExperimentRecord[];
  activeExperiment: TrainingExperimentRecord | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onCreateDraft: (payload: TrainingExperimentPayload) => Promise<TrainingExperimentRecord>;
  onUpdateDraft: (id: string, payload: TrainingExperimentPayload) => Promise<TrainingExperimentRecord>;
  onActivate: (id: string) => Promise<TrainingExperimentRecord>;
  onClone: (id: string) => Promise<TrainingExperimentRecord>;
  onArchive: (id: string) => Promise<TrainingExperimentRecord>;
  onViewRuns: () => void;
}

type SortKey = 'name' | 'status' | 'created_at' | 'n_runs' | 'last_score';
type SortDirection = 'asc' | 'desc';

const EMPTY_FILTER = 'all';

function toDatetimeLocal(value: string) {
  return value.slice(0, 16);
}

function fromDatetimeLocal(value: string) {
  return `${value.length === 16 ? `${value}:00` : value}.000Z`;
}

function formatDate(value: string | null) {
  if (!value) {
    return 'NA';
  }

  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function formatScore(value: number | null) {
  return value === null ? 'NA' : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function parseIntegerList(value: string) {
  return value
    .split(',')
    .map(part => Number(part.trim()))
    .filter(value => Number.isInteger(value) && value > 0);
}

function getOptionDescription<T extends string>(
  options: readonly { value: T; description: string }[],
  value: T,
) {
  return options.find(option => option.value === value)?.description ?? '';
}

function cloneConfig(config: TrainingExperimentConfig): TrainingExperimentConfig {
  return JSON.parse(JSON.stringify(config)) as TrainingExperimentConfig;
}

function StatusPill({ status }: { status: ExperimentStatus }) {
  const className = status === 'active'
    ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100'
    : status === 'draft'
      ? 'border-slate-600 bg-slate-900 text-slate-300'
      : status === 'failed'
        ? 'border-rose-400/30 bg-rose-400/10 text-rose-100'
        : status === 'archived'
          ? 'border-slate-800 bg-slate-950 text-slate-500'
          : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100';

  return (
    <span className={`inline-flex rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-widest ${className}`}>
      {getExperimentStatusLabel(status)}
    </span>
  );
}

function ConfigSummary({ experiment }: { experiment: TrainingExperimentRecord }) {
  const config = experiment.config;

  return (
    <div className="grid gap-3 text-sm text-slate-300 md:grid-cols-2 xl:grid-cols-4">
      <SummaryItem label="L1 source" value={config.l1_source} />
      <SummaryItem label="Target" value={`${config.target.source}.${config.target.spacecraft}.${config.target.variable}`} />
      <SummaryItem label="Horizon" value={`${config.horizon_minutes} min`} />
      <SummaryItem label="Window" value={`${formatDate(config.training_window.start_utc)} -> ${formatDate(config.training_window.stop_utc)}`} />
      <SummaryItem label="Validation" value={config.validation.strategy} />
      <SummaryItem label="Folds" value={config.validation.strategy === 'walk_forward' ? String(config.validation.n_folds) : 'NA'} />
      <SummaryItem label="Event holdout" value={config.validation.event_holdout ? `DST ${config.validation.event_holdout_dst_threshold}` : 'Off'} />
      <SummaryItem label="Seed" value={String(config.seed)} />
      <SummaryItem label="Lag steps" value={config.features.lag_features ? config.features.lag_steps_minutes.join(', ') : 'Off'} />
      <SummaryItem label="Rolling windows" value={config.features.rolling_stats ? config.features.rolling_windows_minutes.join(', ') : 'Off'} />
      <SummaryItem label="Physics" value={config.features.derived_physics ? 'On' : 'Off'} />
      <SummaryItem label="Spectral" value={config.features.spectral ? 'On' : 'Off'} />
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-800 bg-slate-950/40 p-3">
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-1 break-words font-mono text-[10px] text-slate-200">{value}</div>
    </div>
  );
}

export function TrainingLabPanel({
  experiments,
  activeExperiment,
  isLoading,
  error,
  onRefresh,
  onCreateDraft,
  onUpdateDraft,
  onActivate,
  onClone,
  onArchive,
  onViewRuns,
}: TrainingLabPanelProps) {
  const [editingExperimentId, setEditingExperimentId] = useState<string | null>(null);
  const [isReadOnlyView, setIsReadOnlyView] = useState(false);
  const [name, setName] = useState('baseline_v1_goes_h_60min');
  const [description, setDescription] = useState('');
  const [config, setConfig] = useState<TrainingExperimentConfig>(() => createDefaultExperimentConfig());
  const [lagStepsInput, setLagStepsInput] = useState('15, 30, 60, 120');
  const [rollingWindowsInput, setRollingWindowsInput] = useState('60, 180, 360');
  const [hashPreview, setHashPreview] = useState<string>('calculating');
  const [statusFilter, setStatusFilter] = useState<ExperimentStatus | typeof EMPTY_FILTER>(EMPTY_FILTER);
  const [l1Filter, setL1Filter] = useState<L1Source | typeof EMPTY_FILTER>(EMPTY_FILTER);
  const [targetFilter, setTargetFilter] = useState<TargetVariable | typeof EMPTY_FILTER>(EMPTY_FILTER);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [pendingActivation, setPendingActivation] = useState<TrainingExperimentRecord | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const [isMutating, setIsMutating] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  const payload = useMemo<TrainingExperimentPayload>(() => ({
    name: slugifyExperimentName(name),
    description,
    config,
  }), [config, description, name]);
  const validationIssues = useMemo(() => validateExperimentPayload(payload), [payload]);
  const canEdit = !isReadOnlyView;

  useEffect(() => {
    let isCancelled = false;

    void calculateExperimentConfigHash(config).then(nextHash => {
      if (!isCancelled) {
        setHashPreview(nextHash);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [config]);

  const filteredExperiments = useMemo(() => {
    const rows = experiments.filter(experiment => {
      if (statusFilter !== EMPTY_FILTER && experiment.status !== statusFilter) {
        return false;
      }

      if (l1Filter !== EMPTY_FILTER && experiment.config.l1_source !== l1Filter) {
        return false;
      }

      if (targetFilter !== EMPTY_FILTER && experiment.config.target.variable !== targetFilter) {
        return false;
      }

      return true;
    });

    return rows.sort((a, b) => {
      const direction = sortDirection === 'asc' ? 1 : -1;
      const aValue = a[sortKey] ?? '';
      const bValue = b[sortKey] ?? '';

      if (typeof aValue === 'number' && typeof bValue === 'number') {
        return (aValue - bValue) * direction;
      }

      return String(aValue).localeCompare(String(bValue)) * direction;
    });
  }, [experiments, l1Filter, sortDirection, sortKey, statusFilter, targetFilter]);

  const loadExperimentIntoEditor = (experiment: TrainingExperimentRecord, readOnly = experiment.status !== 'draft') => {
    setEditingExperimentId(experiment.id);
    setIsReadOnlyView(readOnly);
    setName(experiment.name);
    setDescription(experiment.description ?? '');
    setConfig(cloneConfig(experiment.config));
    setLagStepsInput(experiment.config.features.lag_steps_minutes.join(', '));
    setRollingWindowsInput(experiment.config.features.rolling_windows_minutes.join(', '));
    setPanelError(null);
  };

  const startNewDraft = () => {
    const nextConfig = createDefaultExperimentConfig();

    setEditingExperimentId(null);
    setIsReadOnlyView(false);
    setName('baseline_v1_goes_h_60min');
    setDescription('');
    setConfig(nextConfig);
    setLagStepsInput(nextConfig.features.lag_steps_minutes.join(', '));
    setRollingWindowsInput(nextConfig.features.rolling_windows_minutes.join(', '));
    setPanelError(null);
  };

  const updateConfig = (updater: (current: TrainingExperimentConfig) => TrainingExperimentConfig) => {
    if (!canEdit) {
      return;
    }

    setConfig(current => updater(current));
  };

  const saveDraft = async () => {
    if (!canEdit) {
      throw new Error('This experiment is immutable. Clone it to edit the config.');
    }

    if (validationIssues.length > 0) {
      throw new Error(validationIssues[0]);
    }

    setIsMutating(true);
    setPanelError(null);

    try {
      const saved = editingExperimentId
        ? await onUpdateDraft(editingExperimentId, payload)
        : await onCreateDraft(payload);

      loadExperimentIntoEditor(saved, false);
      return saved;
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Save draft failed';

      setPanelError(message);
      throw saveError;
    } finally {
      setIsMutating(false);
    }
  };

  const handleSaveDraft = () => {
    void saveDraft().catch(() => undefined);
  };

  const handleSaveAndActivate = () => {
    void saveDraft()
      .then(saved => {
        setPendingActivation(saved);
        setConfirmationText('');
      })
      .catch(() => undefined);
  };

  const handleClone = async (experiment: TrainingExperimentRecord) => {
    setIsMutating(true);
    setPanelError(null);

    try {
      const clone = await onClone(experiment.id);
      loadExperimentIntoEditor(clone, false);
    } catch (cloneError) {
      setPanelError(cloneError instanceof Error ? cloneError.message : 'Clone failed');
    } finally {
      setIsMutating(false);
    }
  };

  const handleArchive = async (experiment: TrainingExperimentRecord) => {
    setIsMutating(true);
    setPanelError(null);

    try {
      await onArchive(experiment.id);

      if (editingExperimentId === experiment.id) {
        startNewDraft();
      }
    } catch (archiveError) {
      setPanelError(archiveError instanceof Error ? archiveError.message : 'Archive failed');
    } finally {
      setIsMutating(false);
    }
  };

  const activatePendingExperiment = async () => {
    if (!pendingActivation || confirmationText !== pendingActivation.name) {
      return;
    }

    setIsMutating(true);
    setPanelError(null);

    try {
      const activated = await onActivate(pendingActivation.id);
      setPendingActivation(null);
      setConfirmationText('');
      loadExperimentIntoEditor(activated, true);
    } catch (activateError) {
      setPanelError(activateError instanceof Error ? activateError.message : 'Activation failed');
    } finally {
      setIsMutating(false);
    }
  };

  const setSort = (nextSortKey: SortKey) => {
    if (sortKey === nextSortKey) {
      setSortDirection(current => current === 'asc' ? 'desc' : 'asc');
      return;
    }

    setSortKey(nextSortKey);
    setSortDirection('asc');
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="grid gap-4">
        <section className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-4 shadow-2xl shadow-cyan-950/10">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase tracking-widest text-cyan-100">
                  Experimento activo
                </h2>
              </div>
              <p className="mt-2 max-w-3xl text-sm text-slate-400">
                {activeExperiment
                  ? activeExperiment.name
                  : 'No hay experimento activo configurado.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onRefresh}
                className="flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
                disabled={isLoading}
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>Refresh</span>
              </button>
              {activeExperiment && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void handleClone(activeExperiment);
                    }}
                    className="flex h-9 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60"
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    <span>Clone to new experiment</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleArchive(activeExperiment);
                    }}
                    className="flex h-9 items-center gap-2 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 text-sm text-amber-100 transition hover:border-amber-200/60"
                  >
                    <Archive className="h-4 w-4" aria-hidden="true" />
                    <span>Archive</span>
                  </button>
                  <button
                    type="button"
                    onClick={onViewRuns}
                    className="flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
                  >
                    <Table2 className="h-4 w-4" aria-hidden="true" />
                    <span>View runs</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {activeExperiment ? (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={activeExperiment.status} />
                <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  activated {formatDate(activeExperiment.activated_at)}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  hash {activeExperiment.config_hash.slice(0, 16)}
                </span>
              </div>
              <ConfigSummary experiment={activeExperiment} />
            </div>
          ) : (
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-400">
              Crea un draft en el editor y actívalo para fijar el experimento que usarán los tabs posteriores.
            </div>
          )}
        </section>

        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                {isReadOnlyView ? (
                  <Lock className="h-4 w-4 text-amber-200" aria-hidden="true" />
                ) : (
                  <Save className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                )}
                <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">
                  Editor de borrador
                </h2>
              </div>
              <p className="mt-2 text-sm text-slate-400">
                {isReadOnlyView
                  ? 'Este experimento es inmutable. Clónalo para modificar la configuración.'
                  : 'Los cambios se guardan como draft hasta activarlos explícitamente.'}
              </p>
            </div>
            <button
              type="button"
              onClick={startNewDraft}
              className="flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
            >
              <FlaskConical className="h-4 w-4" aria-hidden="true" />
              <span>New draft</span>
            </button>
          </div>

          {(panelError || error || validationIssues.length > 0) && (
            <div className="mb-4 rounded-md border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="grid gap-1">
                  {panelError && <span>{panelError}</span>}
                  {error && <span>{error}</span>}
                  {validationIssues.slice(0, 3).map(issue => (
                    <span key={issue}>{issue}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(slugifyExperimentName(event.target.value))}
                    disabled={!canEdit}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Description</span>
                  <input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    disabled={!canEdit}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <SelectField
                  label="L1 source"
                  value={config.l1_source}
                  disabled={!canEdit}
                  options={L1_SOURCE_OPTIONS}
                  description={getOptionDescription(L1_SOURCE_OPTIONS, config.l1_source)}
                  onChange={(value) => updateConfig(current => ({ ...current, l1_source: value as L1Source }))}
                />
                <SelectField
                  label="Target source"
                  value={config.target.source}
                  disabled={!canEdit}
                  options={TARGET_SOURCE_OPTIONS}
                  description={getOptionDescription(TARGET_SOURCE_OPTIONS, config.target.source)}
                  onChange={(value) => updateConfig(current => ({
                    ...current,
                    target: { ...current.target, source: value as TargetSource },
                  }))}
                />
                <SelectField
                  label="Spacecraft"
                  value={config.target.spacecraft}
                  disabled={!canEdit}
                  options={TARGET_SPACECRAFT_OPTIONS}
                  description={getOptionDescription(TARGET_SPACECRAFT_OPTIONS, config.target.spacecraft)}
                  onChange={(value) => updateConfig(current => ({
                    ...current,
                    target: { ...current.target, spacecraft: value as TargetSpacecraft },
                  }))}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <SelectField
                  label="Target variable"
                  value={config.target.variable}
                  disabled={!canEdit}
                  options={TARGET_VARIABLE_OPTIONS}
                  description={getOptionDescription(TARGET_VARIABLE_OPTIONS, config.target.variable)}
                  onChange={(value) => updateConfig(current => ({
                    ...current,
                    target: { ...current.target, variable: value as TargetVariable },
                  }))}
                />
                <SelectField
                  label="Horizon"
                  value={String(config.horizon_minutes)}
                  disabled={!canEdit}
                  options={HORIZON_MINUTE_OPTIONS.map(value => ({
                    value: String(value),
                    label: `${value} minutes`,
                    description: `Predict target ${value} minutes ahead.`,
                  }))}
                  description={`Predict target ${config.horizon_minutes} minutes ahead.`}
                  onChange={(value) => updateConfig(current => ({
                    ...current,
                    horizon_minutes: Number(value) as TrainingExperimentConfig['horizon_minutes'],
                  }))}
                />
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Seed</span>
                  <input
                    type="number"
                    min="0"
                    value={config.seed}
                    disabled={!canEdit}
                    onChange={(event) => updateConfig(current => ({ ...current, seed: Number(event.target.value) }))}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Start UTC</span>
                  <input
                    type="datetime-local"
                    value={toDatetimeLocal(config.training_window.start_utc)}
                    disabled={!canEdit}
                    onChange={(event) => updateConfig(current => ({
                      ...current,
                      training_window: { ...current.training_window, start_utc: fromDatetimeLocal(event.target.value) },
                    }))}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Stop UTC</span>
                  <input
                    type="datetime-local"
                    value={toDatetimeLocal(config.training_window.stop_utc)}
                    disabled={!canEdit}
                    onChange={(event) => updateConfig(current => ({
                      ...current,
                      training_window: { ...current.training_window, stop_utc: fromDatetimeLocal(event.target.value) },
                    }))}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <SelectField
                  label="Validation"
                  value={config.validation.strategy}
                  disabled={!canEdit}
                  options={VALIDATION_STRATEGY_OPTIONS}
                  description={getOptionDescription(VALIDATION_STRATEGY_OPTIONS, config.validation.strategy)}
                  onChange={(value) => updateConfig(current => ({
                    ...current,
                    validation: {
                      ...current.validation,
                      strategy: value as ValidationStrategy,
                      n_folds: value === 'walk_forward' ? current.validation.n_folds ?? 5 : null,
                    },
                  }))}
                />
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Folds</span>
                  <input
                    type="number"
                    min="2"
                    value={config.validation.n_folds ?? ''}
                    disabled={!canEdit || config.validation.strategy !== 'walk_forward'}
                    onChange={(event) => updateConfig(current => ({
                      ...current,
                      validation: { ...current.validation, n_folds: Number(event.target.value) },
                    }))}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">DST threshold</span>
                  <input
                    type="number"
                    value={config.validation.event_holdout_dst_threshold ?? ''}
                    disabled={!canEdit || !config.validation.event_holdout}
                    onChange={(event) => updateConfig(current => ({
                      ...current,
                      validation: {
                        ...current.validation,
                        event_holdout_dst_threshold: Number(event.target.value),
                      },
                    }))}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <ToggleField
                  label="Event holdout"
                  checked={config.validation.event_holdout}
                  disabled={!canEdit}
                  onChange={(checked) => updateConfig(current => ({
                    ...current,
                    validation: {
                      ...current.validation,
                      event_holdout: checked,
                      event_holdout_dst_threshold: checked ? current.validation.event_holdout_dst_threshold ?? -50 : null,
                    },
                  }))}
                />
                <ToggleField
                  label="Derived physics"
                  checked={config.features.derived_physics}
                  disabled={!canEdit}
                  onChange={(checked) => updateConfig(current => ({
                    ...current,
                    features: { ...current.features, derived_physics: checked },
                  }))}
                />
                <ToggleField
                  label="Lag features"
                  checked={config.features.lag_features}
                  disabled={!canEdit}
                  onChange={(checked) => updateConfig(current => ({
                    ...current,
                    features: { ...current.features, lag_features: checked },
                  }))}
                />
                <ToggleField
                  label="Rolling stats"
                  checked={config.features.rolling_stats}
                  disabled={!canEdit}
                  onChange={(checked) => updateConfig(current => ({
                    ...current,
                    features: { ...current.features, rolling_stats: checked },
                  }))}
                />
                <ToggleField
                  label="Spectral"
                  checked={config.features.spectral}
                  disabled={!canEdit}
                  onChange={(checked) => updateConfig(current => ({
                    ...current,
                    features: { ...current.features, spectral: checked },
                  }))}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Lag steps minutes</span>
                  <input
                    value={lagStepsInput}
                    disabled={!canEdit || !config.features.lag_features}
                    onChange={(event) => {
                      setLagStepsInput(event.target.value);
                      updateConfig(current => ({
                        ...current,
                        features: { ...current.features, lag_steps_minutes: parseIntegerList(event.target.value) },
                      }));
                    }}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
                <label className="grid gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Rolling windows minutes</span>
                  <input
                    value={rollingWindowsInput}
                    disabled={!canEdit || !config.features.rolling_stats}
                    onChange={(event) => {
                      setRollingWindowsInput(event.target.value);
                      updateConfig(current => ({
                        ...current,
                        features: { ...current.features, rolling_windows_minutes: parseIntegerList(event.target.value) },
                      }));
                    }}
                    className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
                  />
                </label>
              </div>
            </div>

            <aside className="grid content-start gap-3">
              <div className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
                <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  <Hash className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>config_hash preview</span>
                </div>
                <div className="break-all font-mono text-[11px] leading-relaxed text-cyan-100">
                  {hashPreview}
                </div>
              </div>

              <div className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
                <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>current draft</span>
                </div>
                <ConfigSummary
                  experiment={{
                    id: editingExperimentId ?? 'draft-preview',
                    name: payload.name,
                    description: payload.description ?? null,
                    status: 'draft',
                    is_active: false,
                    config,
                    config_hash: hashPreview,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    activated_at: null,
                    parent_id: null,
                    n_runs: 0,
                    last_score: null,
                  }}
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {isReadOnlyView ? (
                  <button
                    type="button"
                    onClick={() => {
                      const experiment = experiments.find(row => row.id === editingExperimentId);

                      if (experiment) {
                        void handleClone(experiment);
                      }
                    }}
                    className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60"
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    <span>Clone to edit</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleSaveDraft}
                      disabled={isMutating || validationIssues.length > 0}
                      className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:text-slate-600"
                    >
                      <Save className="h-4 w-4" aria-hidden="true" />
                      <span>Save draft</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveAndActivate}
                      disabled={isMutating || validationIssues.length > 0}
                      className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-900 disabled:text-slate-600"
                    >
                      <Play className="h-4 w-4" aria-hidden="true" />
                      <span>Save & Activate</span>
                    </button>
                  </>
                )}
              </div>
            </aside>
          </div>
        </section>

        <section className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 shadow-2xl backdrop-blur-xl">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Database className="h-4 w-4 text-cyan-300" aria-hidden="true" />
              <h2 className="truncate text-xs font-semibold uppercase tracking-widest text-slate-300">
                Experimentos
              </h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <FilterSelect
                label="status"
                value={statusFilter}
                options={[EMPTY_FILTER, ...EXPERIMENT_STATUSES]}
                onChange={(value) => setStatusFilter(value as ExperimentStatus | typeof EMPTY_FILTER)}
              />
              <FilterSelect
                label="l1"
                value={l1Filter}
                options={[EMPTY_FILTER, ...L1_SOURCE_OPTIONS.map(option => option.value)]}
                onChange={(value) => setL1Filter(value as L1Source | typeof EMPTY_FILTER)}
              />
              <FilterSelect
                label="target"
                value={targetFilter}
                options={[EMPTY_FILTER, ...TARGET_VARIABLE_OPTIONS.map(option => option.value)]}
                onChange={(value) => setTargetFilter(value as TargetVariable | typeof EMPTY_FILTER)}
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/50">
            <table className="min-w-full border-collapse text-left font-mono text-[10px]">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500">
                  {[
                    ['name', 'name'],
                    ['status', 'status'],
                    ['created_at', 'created_at'],
                    ['n_runs', 'n_runs'],
                    ['last_score', 'last_score'],
                  ].map(([key, label]) => (
                    <th key={key} className="border-r border-slate-800 px-3 py-2 font-normal uppercase tracking-widest">
                      <button type="button" onClick={() => setSort(key as SortKey)} className="hover:text-cyan-200">
                        {label}{sortKey === key ? ` ${sortDirection}` : ''}
                      </button>
                    </th>
                  ))}
                  <th className="px-3 py-2 font-normal uppercase tracking-widest">actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredExperiments.map(experiment => (
                  <tr key={experiment.id} className="border-b border-slate-800/70 text-slate-300 last:border-b-0">
                    <td className="max-w-[260px] truncate border-r border-slate-800 px-3 py-2" title={experiment.name}>
                      {experiment.name}
                    </td>
                    <td className="border-r border-slate-800 px-3 py-2">
                      <StatusPill status={experiment.status} />
                    </td>
                    <td className="border-r border-slate-800 px-3 py-2 text-slate-500">{formatDate(experiment.created_at)}</td>
                    <td className="border-r border-slate-800 px-3 py-2">{experiment.n_runs}</td>
                    <td className="border-r border-slate-800 px-3 py-2">{formatScore(experiment.last_score)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        <IconButton label="View" onClick={() => loadExperimentIntoEditor(experiment)}>
                          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                        <IconButton label="Clone" onClick={() => { void handleClone(experiment); }}>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label="Activate"
                          disabled={experiment.status === 'archived' || experiment.is_active}
                          onClick={() => {
                            setPendingActivation(experiment);
                            setConfirmationText('');
                          }}
                        >
                          <Play className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label="Archive"
                          disabled={experiment.status === 'archived'}
                          onClick={() => { void handleArchive(experiment); }}
                        >
                          <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredExperiments.length === 0 && (
                  <tr>
                    <td className="px-3 py-8 text-center text-slate-500" colSpan={6}>
                      No experiments
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {pendingActivation && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
          <section className="w-full max-w-xl rounded-lg border border-cyan-400/30 bg-slate-950 p-5 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Change active experiment</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  You are about to activate the experiment &apos;{pendingActivation.name}&apos;. This has consequences:
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setPendingActivation(null)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <ul className="mb-4 grid gap-2 text-sm leading-relaxed text-slate-300">
              <li>- Models trained under the previous experiment are NOT deleted, but they remain linked to their original config and cannot be compared directly with new models without retraining.</li>
              <li>- The feature cache may be invalidated if the feature config changes.</li>
              <li>- Any production inference that depends on the previous experiment may point to a different model.</li>
            </ul>
            <label className="grid gap-2">
              <span className="text-sm text-slate-300">
                Type the experiment name (&apos;{pendingActivation.name}&apos;) to confirm
              </span>
              <input
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.target.value)}
                className="h-10 rounded-md border border-slate-700 bg-slate-900 px-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-400/60"
              />
            </label>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingActivation(null)}
                className="flex h-10 items-center gap-2 rounded-md border border-slate-700 px-4 text-sm text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                onClick={() => { void activatePendingExperiment(); }}
                disabled={confirmationText !== pendingActivation.name || isMutating}
                className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-4 text-sm text-cyan-100 transition hover:border-cyan-300/60 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-900 disabled:text-slate-600"
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                <span>Activate experiment</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function SelectField({
  label,
  value,
  options,
  description,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; description: string }[];
  description: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-md border border-slate-700 bg-slate-950/70 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-400/60 disabled:text-slate-500"
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <span className="min-h-8 text-xs leading-relaxed text-slate-500">{description}</span>
    </label>
  );
}

function ToggleField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/60 px-3">
      <span className="font-mono text-[10px] uppercase tracking-widest text-slate-400">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-cyan-300"
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex h-9 items-center gap-2 rounded-md border border-slate-800 bg-slate-950/70 px-2">
      <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 min-w-24 bg-transparent font-mono text-[10px] uppercase tracking-widest text-slate-300 outline-none"
      >
        {options.map(option => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-700"
    >
      {children}
    </button>
  );
}
