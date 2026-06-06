import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCurrentAdminContext } from '@/lib/supabase/admin';
import {
  canonicalizeJson,
  slugifyExperimentName,
  type ExperimentStatus,
  type ExperimentRunRecord,
  type TrainingExperimentConfig,
  type TrainingExperimentPayload,
  type TrainingExperimentRecord,
  validateExperimentPayload,
} from './trainingExperimentConfig';

type ExperimentDbRow = Omit<TrainingExperimentRecord, 'n_runs' | 'last_score'>;

type ExperimentRunDbRow = {
  experiment_id: string;
  model_name?: string;
  status?: string;
  metrics_global?: { rmse?: number } | null;
  score: number | null;
  completed_at?: string | null;
  created_at: string;
};

type AdminExperimentContext = {
  supabase: SupabaseClient;
  userId: string;
  email: string | null;
  isAdmin: true;
};

export type ExperimentFilters = {
  status?: ExperimentStatus | null;
  l1Source?: string | null;
  targetVariable?: string | null;
};

export type ExperimentListResponse = {
  experiments: TrainingExperimentRecord[];
  activeExperiment: TrainingExperimentRecord | null;
};

export class ExperimentRequestError extends Error {
  status: number;
  issues?: string[];

  constructor(message: string, status = 400, issues?: string[]) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

function calculateServerConfigHash(config: TrainingExperimentConfig) {
  return createHash('sha256')
    .update(canonicalizeJson(config))
    .digest('hex');
}

async function getAdminContext(): Promise<AdminExperimentContext> {
  const context = await getCurrentAdminContext();

  if (!context.supabase) {
    throw new ExperimentRequestError('Supabase is not configured', 503);
  }

  if (!context.isAdmin || !context.userId) {
    throw new ExperimentRequestError('Admin required', 403);
  }

  return {
    supabase: context.supabase,
    userId: context.userId,
    email: context.email,
    isAdmin: true,
  };
}

function normalizePayload(payload: TrainingExperimentPayload): TrainingExperimentPayload {
  return {
    name: slugifyExperimentName(payload.name),
    description: payload.description?.trim() ? payload.description.trim() : null,
    config: payload.config,
  };
}

function assertValidPayload(payload: TrainingExperimentPayload) {
  const normalizedPayload = normalizePayload(payload);
  const issues = validateExperimentPayload(normalizedPayload);

  if (issues.length > 0) {
    throw new ExperimentRequestError('Experiment config is invalid', 422, issues);
  }

  return normalizedPayload;
}

function applyFilters(rows: ExperimentDbRow[], filters: ExperimentFilters) {
  return rows.filter(row => {
    if (filters.status && row.status !== filters.status) {
      return false;
    }

    if (filters.l1Source && row.config.l1_source !== filters.l1Source) {
      return false;
    }

    if (filters.targetVariable && row.config.target.variable !== filters.targetVariable) {
      return false;
    }

    return true;
  });
}

function attachRunStats(rows: ExperimentDbRow[], runs: ExperimentRunDbRow[] | null): TrainingExperimentRecord[] {
  const runStats = new Map<string, { n_runs: number; last_score: number | null; last_created_at: string | null }>();

  runs?.forEach(run => {
    const lastScore = run.score ?? run.metrics_global?.rmse ?? null;
    const trainedAt = run.completed_at ?? run.created_at;
    const current = runStats.get(run.experiment_id) ?? {
      n_runs: 0,
      last_score: null,
      last_created_at: null,
    };

    current.n_runs += 1;

    if (!current.last_created_at || trainedAt > current.last_created_at) {
      current.last_created_at = trainedAt;
      current.last_score = lastScore;
    }

    runStats.set(run.experiment_id, current);
  });

  return rows.map(row => {
    const stats = runStats.get(row.id);

    return {
      ...row,
      n_runs: stats?.n_runs ?? 0,
      last_score: stats?.last_score ?? null,
    };
  });
}

async function fetchRunRows(supabase: SupabaseClient, experimentIds: string[]) {
  if (experimentIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from('experiment_runs')
    .select('experiment_id, model_name, status, metrics_global, score, completed_at, created_at')
    .in('experiment_id', experimentIds)
    .returns<ExperimentRunDbRow[]>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  return data ?? [];
}

export async function listTrainingExperiments(filters: ExperimentFilters = {}): Promise<ExperimentListResponse> {
  const { supabase, userId } = await getAdminContext();
  const { data, error } = await supabase
    .from('experiments')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .returns<ExperimentDbRow[]>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  const allRows = data ?? [];
  const runs = await fetchRunRows(supabase, allRows.map(row => row.id));
  const rowsWithStats = attachRunStats(applyFilters(allRows, filters), runs);
  const activeExperiment = attachRunStats(allRows.filter(row => row.is_active), runs)[0] ?? null;

  return {
    experiments: rowsWithStats,
    activeExperiment,
  };
}

export async function getActiveTrainingExperiment() {
  const { activeExperiment } = await listTrainingExperiments();

  return activeExperiment;
}

export async function getTrainingExperiment(id: string) {
  const { supabase, userId } = await getAdminContext();
  const { data, error } = await supabase
    .from('experiments')
    .select('*')
    .eq('owner_id', userId)
    .eq('id', id)
    .maybeSingle<ExperimentDbRow>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  if (!data) {
    throw new ExperimentRequestError('Experiment not found', 404);
  }

  const runs = await fetchRunRows(supabase, [data.id]);

  return attachRunStats([data], runs)[0];
}

export async function createTrainingExperimentDraft(payload: TrainingExperimentPayload) {
  const { supabase, userId } = await getAdminContext();
  const normalizedPayload = assertValidPayload(payload);
  const { data, error } = await supabase
    .from('experiments')
    .insert({
      owner_id: userId,
      name: normalizedPayload.name,
      description: normalizedPayload.description,
      status: 'draft',
      is_active: false,
      config: normalizedPayload.config,
      config_hash: calculateServerConfigHash(normalizedPayload.config),
      parent_id: null,
    })
    .select('*')
    .single<ExperimentDbRow>();

  if (error) {
    throw new ExperimentRequestError(error.message, error.code === '23505' ? 409 : 500);
  }

  return attachRunStats([data], [])[0];
}

export async function listExperimentRuns(experimentId: string) {
  const { supabase, userId } = await getAdminContext();
  const { data, error } = await supabase
    .from('experiment_runs')
    .select('*')
    .eq('owner_id', userId)
    .eq('experiment_id', experimentId)
    .order('created_at', { ascending: false })
    .returns<ExperimentRunRecord[]>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  return data ?? [];
}

export async function getExperimentRun(experimentId: string, runId: string) {
  const { supabase, userId } = await getAdminContext();
  const { data, error } = await supabase
    .from('experiment_runs')
    .select('*')
    .eq('owner_id', userId)
    .eq('experiment_id', experimentId)
    .eq('id', runId)
    .maybeSingle<ExperimentRunRecord>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  if (!data) {
    throw new ExperimentRequestError('Run not found', 404);
  }

  return data;
}

export async function deleteExperimentRun(experimentId: string, runId: string) {
  const { supabase, userId } = await getAdminContext();
  const { error: predictionError } = await supabase
    .from('predictions')
    .delete()
    .eq('owner_id', userId)
    .eq('experiment_id', experimentId)
    .eq('run_id', runId);

  if (predictionError) {
    throw new ExperimentRequestError(predictionError.message, 500);
  }

  const { error } = await supabase
    .from('experiment_runs')
    .delete()
    .eq('owner_id', userId)
    .eq('experiment_id', experimentId)
    .eq('id', runId);

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }
}

export async function listExperimentPredictions(experimentId: string, runId: string, limit = 5000) {
  const { supabase, userId } = await getAdminContext();
  const { data, error } = await supabase
    .from('predictions')
    .select('id, run_id, experiment_id, timestamp_utc, split, fold, y_true, y_pred, residual')
    .eq('owner_id', userId)
    .eq('experiment_id', experimentId)
    .eq('run_id', runId)
    .order('timestamp_utc', { ascending: true })
    .limit(limit);

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  return data ?? [];
}

export async function updateTrainingExperimentDraft(id: string, payload: TrainingExperimentPayload) {
  const { supabase, userId } = await getAdminContext();
  const existing = await getTrainingExperiment(id);

  if (existing.status !== 'draft') {
    throw new ExperimentRequestError('Only draft experiments can be edited. Clone this experiment to change it.', 409);
  }

  const normalizedPayload = assertValidPayload(payload);
  const { data, error } = await supabase
    .from('experiments')
    .update({
      name: normalizedPayload.name,
      description: normalizedPayload.description,
      config: normalizedPayload.config,
      config_hash: calculateServerConfigHash(normalizedPayload.config),
    })
    .eq('owner_id', userId)
    .eq('id', id)
    .eq('status', 'draft')
    .select('*')
    .single<ExperimentDbRow>();

  if (error) {
    throw new ExperimentRequestError(error.message, error.code === '23505' ? 409 : 500);
  }

  return attachRunStats([data], [])[0];
}

async function buildCloneName(supabase: SupabaseClient, ownerId: string, sourceName: string) {
  const baseName = slugifyExperimentName(`${sourceName}_clone`) || 'experiment_clone';
  const { data, error } = await supabase
    .from('experiments')
    .select('name')
    .eq('owner_id', ownerId)
    .like('name', `${baseName}%`)
    .returns<Array<{ name: string }>>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  const existingNames = new Set((data ?? []).map(row => row.name));

  if (!existingNames.has(baseName)) {
    return baseName;
  }

  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${baseName}_${index}`;

    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }

  throw new ExperimentRequestError('Could not allocate a clone name', 500);
}

export async function cloneTrainingExperiment(id: string) {
  const { supabase, userId } = await getAdminContext();
  const source = await getTrainingExperiment(id);
  const cloneName = await buildCloneName(supabase, userId, source.name);
  const { data, error } = await supabase
    .from('experiments')
    .insert({
      owner_id: userId,
      name: cloneName,
      description: source.description,
      status: 'draft',
      is_active: false,
      config: source.config,
      config_hash: source.config_hash,
      parent_id: source.id,
    })
    .select('*')
    .single<ExperimentDbRow>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  return attachRunStats([data], [])[0];
}

export async function activateTrainingExperiment(id: string) {
  const { supabase } = await getAdminContext();
  const { data, error } = await supabase
    .rpc('activate_experiment', { target_experiment_id: id })
    .single<ExperimentDbRow>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  if (!data) {
    throw new ExperimentRequestError('Experiment not found', 404);
  }

  return getTrainingExperiment(data.id);
}

export async function archiveTrainingExperiment(id: string) {
  const { supabase, userId } = await getAdminContext();
  const existing = await getTrainingExperiment(id);

  if (existing.status === 'archived') {
    return existing;
  }

  const { data, error } = await supabase
    .from('experiments')
    .update({
      status: 'archived',
      is_active: false,
    })
    .eq('owner_id', userId)
    .eq('id', id)
    .select('*')
    .single<ExperimentDbRow>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  return attachRunStats([data], [])[0];
}
