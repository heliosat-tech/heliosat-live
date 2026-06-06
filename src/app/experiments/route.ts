import { NextRequest, NextResponse } from 'next/server';
import {
  createTrainingExperimentDraft,
  ExperimentRequestError,
  listTrainingExperiments,
} from '@/services/trainingExperimentStore';
import type { ExperimentStatus, TrainingExperimentPayload } from '@/services/trainingExperimentConfig';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function jsonError(error: unknown) {
  if (error instanceof ExperimentRequestError) {
    return NextResponse.json(
      {
        error: error.message,
        issues: error.issues ?? [],
      },
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

export async function GET(request: NextRequest) {
  try {
    const response = await listTrainingExperiments({
      status: request.nextUrl.searchParams.get('status') as ExperimentStatus | null,
      l1Source: request.nextUrl.searchParams.get('l1_source'),
      targetVariable: request.nextUrl.searchParams.get('target'),
    });

    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json() as TrainingExperimentPayload;
    const experiment = await createTrainingExperimentDraft(payload);

    return NextResponse.json(experiment, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
