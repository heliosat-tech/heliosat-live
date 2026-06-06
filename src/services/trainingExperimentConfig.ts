export const EXPERIMENT_POLL_INTERVAL_MS = 30_000;

export const EXPERIMENT_STATUSES = [
  'draft',
  'active',
  'training',
  'completed',
  'failed',
  'archived',
] as const;

export const L1_SOURCE_OPTIONS = [
  {
    value: 'omni_hro_1min',
    label: 'OMNI HRO 1 min',
    description: 'Merged L1 solar wind and IMF reference stream at one-minute cadence.',
  },
  {
    value: 'dscovr_archive',
    label: 'DSCOVR archive',
    description: 'NOAA DSCOVR plasma and magnetic field archive for operational L1 coverage.',
  },
  {
    value: 'ace_archive',
    label: 'ACE archive',
    description: 'ACE SWEPAM/MAG archive for longer historical L1 model baselines.',
  },
] as const;

export const TARGET_SOURCE_OPTIONS = [
  {
    value: 'goes_nccei',
    label: 'GOES NCEI',
    description: 'NOAA/NCEI GOES archive target series.',
  },
] as const;

export const TARGET_SPACECRAFT_OPTIONS = [
  { value: 'goes16', label: 'GOES-16', description: 'GOES East historical spacecraft.' },
  { value: 'goes17', label: 'GOES-17', description: 'GOES West historical spacecraft.' },
  { value: 'goes18', label: 'GOES-18', description: 'Current GOES West spacecraft.' },
  { value: 'goes19', label: 'GOES-19', description: 'Current GOES East spacecraft.' },
  { value: 'primary', label: 'Primary', description: 'Operational primary GOES satellite selection.' },
] as const;

export const TARGET_VARIABLE_OPTIONS = [
  {
    value: 'goes_mag_h_magnitude',
    label: 'GOES MAG |H|',
    description: 'Magnetic field vector magnitude from GOES magnetometer components.',
  },
  {
    value: 'goes_electrons_2mev',
    label: 'Electrons >2 MeV',
    description: 'Integral high-energy electron flux target.',
  },
  {
    value: 'goes_protons_10mev',
    label: 'Protons >10 MeV',
    description: 'Integral proton flux used for radiation storm monitoring.',
  },
  {
    value: 'goes_xrs_short_flux',
    label: 'XRS short flux',
    description: 'GOES X-ray short channel flux.',
  },
  {
    value: 'goes_xrs_long_flux',
    label: 'XRS long flux',
    description: 'GOES X-ray long channel flux.',
  },
] as const;

export const HORIZON_MINUTE_OPTIONS = [15, 30, 45, 60, 90, 120] as const;
export const VALIDATION_STRATEGY_OPTIONS = [
  {
    value: 'walk_forward',
    label: 'Walk-forward',
    description: 'Chronological folds that preserve temporal ordering.',
  },
  {
    value: 'holdout',
    label: 'Holdout',
    description: 'Single validation window separated from the training period.',
  },
] as const;

export type ExperimentStatus = typeof EXPERIMENT_STATUSES[number];
export type L1Source = typeof L1_SOURCE_OPTIONS[number]['value'];
export type TargetSource = typeof TARGET_SOURCE_OPTIONS[number]['value'];
export type TargetSpacecraft = typeof TARGET_SPACECRAFT_OPTIONS[number]['value'];
export type TargetVariable = typeof TARGET_VARIABLE_OPTIONS[number]['value'];
export type HorizonMinutes = typeof HORIZON_MINUTE_OPTIONS[number];
export type ValidationStrategy = typeof VALIDATION_STRATEGY_OPTIONS[number]['value'];

export type TrainingExperimentConfig = {
  l1_source: L1Source;
  target: {
    source: TargetSource;
    spacecraft: TargetSpacecraft;
    variable: TargetVariable;
  };
  horizon_minutes: HorizonMinutes;
  training_window: {
    start_utc: string;
    stop_utc: string;
  };
  validation: {
    strategy: ValidationStrategy;
    n_folds: number | null;
    event_holdout: boolean;
    event_holdout_dst_threshold: number | null;
  };
  features: {
    lag_features: boolean;
    lag_steps_minutes: number[];
    rolling_stats: boolean;
    rolling_windows_minutes: number[];
    derived_physics: boolean;
    spectral: boolean;
  };
  seed: number;
};

export type TrainingExperimentRecord = {
  id: string;
  owner_id?: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  status: ExperimentStatus;
  is_active: boolean;
  config_hash: string;
  parent_id: string | null;
  config: TrainingExperimentConfig;
  n_runs: number;
  last_score: number | null;
};

export type TrainingExperimentPayload = {
  name: string;
  description?: string | null;
  config: TrainingExperimentConfig;
};

export const TRAINING_MODEL_OPTIONS = [
  {
    value: 'mru_propagation',
    label: 'MRU propagation',
    description: 'Propagates L1 measurements to Earth using solar wind speed and constant rectilinear motion.',
  },
  {
    value: 'persistence',
    label: 'Persistence',
    description: 'Predicts the future target from the current target value.',
  },
  {
    value: 'ridge',
    label: 'Ridge',
    description: 'Linear baseline with StandardScaler and alpha grid search.',
  },
  {
    value: 'lightgbm',
    label: 'LightGBM',
    description: 'Gradient boosted trees with early stopping on validation folds.',
  },
] as const;

export const EXPERIMENT_RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;

export type TrainingModelName = typeof TRAINING_MODEL_OPTIONS[number]['value'];
export type ExperimentRunStatus = typeof EXPERIMENT_RUN_STATUSES[number];

export type ExperimentRunMetrics = {
  rmse?: number;
  mae?: number;
  r2?: number;
  bias?: number;
  median_absolute_error?: number;
  p95_absolute_error?: number;
  skill_vs_persistence?: number | null;
  peak_error?: number | null;
};

export type ExperimentRunRecord = {
  id: string;
  owner_id?: string;
  experiment_id: string;
  model_name: TrainingModelName;
  status: ExperimentRunStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  metrics_global: ExperimentRunMetrics | null;
  metrics_per_fold: Array<Record<string, unknown>> | null;
  metrics_events: Record<string, unknown> | null;
  hyperparams: Record<string, unknown> | null;
  model_artifact_path: string | null;
  feature_importance: Array<{ feature: string; importance: number }> | null;
  n_train_samples: number | null;
  n_val_samples: number | null;
  log_uri: string | null;
  prediction_uri: string | null;
  score: number | null;
};

export type PredictionRecord = {
  id?: string;
  run_id: string;
  experiment_id: string;
  timestamp_utc: string;
  split: string;
  fold: number | null;
  y_true: number;
  y_pred: number;
  residual: number;
};

const DEFAULT_STOP_UTC = '2024-05-08T00:00:00.000Z';
const DEFAULT_START_UTC = '2024-05-01T00:00:00.000Z';

export function createDefaultExperimentConfig(): TrainingExperimentConfig {
  return {
    l1_source: 'omni_hro_1min',
    target: {
      source: 'goes_nccei',
      spacecraft: 'primary',
      variable: 'goes_mag_h_magnitude',
    },
    horizon_minutes: 60,
    training_window: {
      start_utc: DEFAULT_START_UTC,
      stop_utc: DEFAULT_STOP_UTC,
    },
    validation: {
      strategy: 'walk_forward',
      n_folds: 5,
      event_holdout: true,
      event_holdout_dst_threshold: -50,
    },
    features: {
      lag_features: true,
      lag_steps_minutes: [15, 30, 60, 120],
      rolling_stats: true,
      rolling_windows_minutes: [60, 180, 360],
      derived_physics: true,
      spectral: false,
    },
    seed: 42,
  };
}

export function slugifyExperimentName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalizeJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`);

  return `{${entries.join(',')}}`;
}

export async function calculateExperimentConfigHash(config: TrainingExperimentConfig) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeJson(config)));

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isOneOf<T extends readonly unknown[]>(value: unknown, options: T): value is T[number] {
  return options.includes(value);
}

function parseUtc(value: string) {
  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function validateIntegerList(values: number[], fieldName: string, errors: string[]) {
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${fieldName} must contain at least one value`);
    return;
  }

  values.forEach(value => {
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`${fieldName} values must be positive integers`);
    }
  });
}

export function validateExperimentPayload(payload: TrainingExperimentPayload) {
  const errors: string[] = [];
  const name = slugifyExperimentName(payload.name);
  const config = payload.config;

  if (!name) {
    errors.push('Experiment name is required');
  }

  if (!config) {
    errors.push('Experiment config is required');
    return errors;
  }

  if (!isOneOf(config.l1_source, L1_SOURCE_OPTIONS.map(option => option.value))) {
    errors.push('Invalid L1 source');
  }

  if (!isOneOf(config.target?.source, TARGET_SOURCE_OPTIONS.map(option => option.value))) {
    errors.push('Invalid target source');
  }

  if (!isOneOf(config.target?.spacecraft, TARGET_SPACECRAFT_OPTIONS.map(option => option.value))) {
    errors.push('Invalid target spacecraft');
  }

  if (!isOneOf(config.target?.variable, TARGET_VARIABLE_OPTIONS.map(option => option.value))) {
    errors.push('Invalid target variable');
  }

  if (!isOneOf(config.horizon_minutes, HORIZON_MINUTE_OPTIONS)) {
    errors.push('Invalid prediction horizon');
  }

  const start = parseUtc(config.training_window?.start_utc);
  const stop = parseUtc(config.training_window?.stop_utc);

  if (!start || !stop) {
    errors.push('Training window must use valid UTC datetimes');
  } else if (start >= stop) {
    errors.push('Training window start must be before stop');
  }

  if (!isOneOf(config.validation?.strategy, VALIDATION_STRATEGY_OPTIONS.map(option => option.value))) {
    errors.push('Invalid validation strategy');
  }

  if (config.validation.strategy === 'walk_forward') {
    if (!Number.isInteger(config.validation.n_folds) || (config.validation.n_folds ?? 0) < 2) {
      errors.push('Walk-forward validation requires at least 2 folds');
    }
  }

  if (config.validation.event_holdout) {
    if (!Number.isInteger(config.validation.event_holdout_dst_threshold)) {
      errors.push('Event holdout requires a DST threshold');
    }
  }

  if (config.features.lag_features) {
    validateIntegerList(config.features.lag_steps_minutes, 'Lag steps', errors);
  }

  if (config.features.rolling_stats) {
    validateIntegerList(config.features.rolling_windows_minutes, 'Rolling windows', errors);
  }

  if (!Number.isInteger(config.seed) || config.seed < 0) {
    errors.push('Seed must be a non-negative integer');
  }

  return Array.from(new Set(errors));
}

export function getExperimentStatusLabel(status: ExperimentStatus) {
  if (status === 'active') {
    return 'CONFIGURED';
  }

  return status.toUpperCase();
}
