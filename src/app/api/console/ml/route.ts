import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { getCurrentAdminState } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CONSOLE_DATA_DIR = path.join(process.cwd(), 'data', 'console');

async function readJson<T>(fileName: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(CONSOLE_DATA_DIR, fileName), 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * ML arrival-time residual model artifacts, generated offline by
 * `python -m ml.arrival_residual.train`:
 *  - ml_metrics.json     benchmark-vs-ML evaluation (overall, per regime, histogram, ...)
 *  - ml_data_split.json  datasets, roles, exact train/validation date ranges, variables
 * Both are read as-is; this route never invents values. Missing files surface as nulls
 * so the UI can say "model not trained yet" instead of fabricating numbers.
 */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const [metrics, split] = await Promise.all([
    readJson<Record<string, unknown>>('ml_metrics.json'),
    readJson<Record<string, unknown>>('ml_data_split.json'),
  ]);

  return NextResponse.json(
    {
      metrics,
      split,
      error: metrics && split ? undefined : 'ML artifacts not found. Run: python -m ml.arrival_residual.train',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
