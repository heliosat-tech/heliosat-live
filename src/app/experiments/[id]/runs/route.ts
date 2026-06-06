import { spawn } from 'child_process';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminContext } from '@/lib/supabase/admin';
import {
  ExperimentRequestError,
  getTrainingExperiment,
  listExperimentRuns,
} from '@/services/trainingExperimentStore';
import {
  TRAINING_MODEL_OPTIONS,
  type ExperimentRunRecord,
  type TrainingModelName,
} from '@/services/trainingExperimentConfig';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ id: string }>;
};

const MODEL_NAMES = TRAINING_MODEL_OPTIONS.map(option => option.value);

function jsonError(error: unknown) {
  if (error instanceof ExperimentRequestError) {
    return NextResponse.json(
      { error: error.message, issues: error.issues ?? [] },
      {
        status: error.status,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }

  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Run request failed' },
    {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

function parseModels(value: unknown): TrainingModelName[] {
  if (value === 'all' || value === undefined || value === null) {
    return MODEL_NAMES.slice();
  }

  const models = Array.isArray(value) ? value : [value];
  const parsed = models.filter((model): model is TrainingModelName => MODEL_NAMES.includes(model as TrainingModelName));

  if (parsed.length === 0) {
    throw new ExperimentRequestError('At least one supported model is required', 422);
  }

  return parsed;
}

async function createRunRows(experimentId: string, models: TrainingModelName[]) {
  const context = await getCurrentAdminContext();

  if (!context.supabase || !context.isAdmin || !context.userId) {
    throw new ExperimentRequestError('Admin required', 403);
  }

  const rows = models.map(model => ({
    owner_id: context.userId,
    experiment_id: experimentId,
    model_name: model,
    status: 'queued',
    hyperparams: {},
  }));
  const { data, error } = await context.supabase
    .from('experiment_runs')
    .insert(rows)
    .select('*')
    .returns<ExperimentRunRecord[]>();

  if (error) {
    throw new ExperimentRequestError(error.message, 500);
  }

  return {
    rows: data ?? [],
    accessToken: context.accessToken,
  };
}

function launchTrainingWorker(experimentId: string, models: TrainingModelName[], runs: ExperimentRunRecord[], accessToken: string | null | undefined) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey || !accessToken) {
    throw new ExperimentRequestError('Supabase auth environment is required to launch training', 503);
  }

  const runIds = Object.fromEntries(runs.map(run => [run.model_name, run.id]));
  const child = spawn(
    process.env.PYTHON_BIN ?? 'python',
    [
      '-m',
      'training.run',
      '--experiment-id',
      experimentId,
      '--models',
      models.join(','),
      '--run-ids',
      JSON.stringify(runIds),
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: supabaseKey,
        SUPABASE_ACCESS_TOKEN: accessToken,
      },
    },
  );

  child.unref();
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const runs = await listExperimentRuns(id);

    return NextResponse.json({ runs }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const experiment = await getTrainingExperiment(id);

    if (!experiment.is_active) {
      throw new ExperimentRequestError('Only the active experiment can launch training runs', 409);
    }

    const body = await request.json().catch(() => ({})) as { models?: unknown };
    const models = parseModels(body.models);
    const { rows, accessToken } = await createRunRows(id, models);

    launchTrainingWorker(id, models, rows, accessToken);

    return NextResponse.json({ runs: rows }, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
