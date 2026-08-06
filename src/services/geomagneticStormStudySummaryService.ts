import { promises as fs } from 'fs';
import path from 'path';

const STUDY_PATH = path.join(process.cwd(), 'data', 'console', 'geomagnetic-storm-study.json');
let cachedStudy: { mtimeMs: number; value: G3StudySummary | null } | null = null;

export interface G3StudySummary {
  modelVersion: string;
  status: string;
  evaluationStartUtc: string;
  evaluationStopUtc: string;
  observedEvents: number;
  precisionPct: number;
  recallPct: number;
  falseAlarmRatioPct: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function normalizeG3StudySummary(value: unknown): G3StudySummary | null {
  const root = record(value);
  const scope = record(root?.scope);
  const results = record(root?.results);
  const g3Event = record(results?.g3Event);
  const modelVersion = text(root?.modelVersion);
  const status = text(root?.status);
  const evaluationStartUtc = text(scope?.evaluationStartUtc);
  const evaluationStopUtc = text(scope?.evaluationStopUtc);
  const observedEvents = finite(g3Event?.observedEvents);
  const precisionPct = finite(g3Event?.precisionPct);
  const recallPct = finite(g3Event?.recallPct);
  const falseAlarmRatioPct = finite(g3Event?.falseAlarmRatioPct);
  if (!modelVersion || !status || !evaluationStartUtc || !evaluationStopUtc || observedEvents === null || precisionPct === null || recallPct === null || falseAlarmRatioPct === null) return null;
  return { modelVersion, status, evaluationStartUtc, evaluationStopUtc, observedEvents, precisionPct, recallPct, falseAlarmRatioPct };
}

export async function loadG3StudySummary(): Promise<G3StudySummary | null> {
  try {
    const stat = await fs.stat(STUDY_PATH);
    if (cachedStudy?.mtimeMs === stat.mtimeMs) return cachedStudy.value;
    const value = normalizeG3StudySummary(JSON.parse(await fs.readFile(STUDY_PATH, 'utf8')));
    cachedStudy = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return null;
  }
}
