import { NextResponse } from 'next/server';
import {
  ExperimentRequestError,
  getActiveTrainingExperiment,
} from '@/services/trainingExperimentStore';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

export async function GET() {
  try {
    const experiment = await getActiveTrainingExperiment();

    return NextResponse.json({ experiment }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
