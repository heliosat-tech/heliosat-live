import { NextRequest, NextResponse } from 'next/server';
import {
  deleteExperimentRun,
  ExperimentRequestError,
  getExperimentRun,
  listExperimentPredictions,
} from '@/services/trainingExperimentStore';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ id: string; runId: string }>;
};

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

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id, runId } = await context.params;
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? 5000);
    const [run, predictions] = await Promise.all([
      getExperimentRun(id, runId),
      listExperimentPredictions(id, runId, Number.isFinite(limit) ? limit : 5000),
    ]);

    return NextResponse.json({ run, predictions }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id, runId } = await context.params;
    await deleteExperimentRun(id, runId);

    return NextResponse.json({ ok: true }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
