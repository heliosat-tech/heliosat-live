import { NextRequest, NextResponse } from 'next/server';
import {
  archiveTrainingExperiment,
  ExperimentRequestError,
} from '@/services/trainingExperimentStore';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ id: string }>;
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
    { error: 'Experiment request failed' },
    {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const experiment = await archiveTrainingExperiment(id);

    return NextResponse.json(experiment, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
