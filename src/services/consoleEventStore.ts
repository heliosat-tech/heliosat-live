/**
 * Persistent event log for the Internal Console — independent from the Playground
 * store. Holds MRU-only detections so the simplified console owns its own history,
 * and keeps verifications (which can land many hours later, once near-Earth data
 * for the arrival window exists) even after an event scrolls out of the live feed.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { LiveEvent } from './liveEventService';

const STORE_DIR = path.join(process.cwd(), 'data', 'console');
const STORE_PATH = path.join(STORE_DIR, 'events.json');

const MAX_EVENTS = 300;
const PRUNE_OLDER_THAN_MS = 90 * 24 * 60 * 60 * 1000; // ~90 days of history

export async function loadConsoleEvents(): Promise<LiveEvent[]> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LiveEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * Merge fresh detections into the store and (re)verify everything so pending
 * events settle whenever the near-Earth data finally arrives — however late.
 */
export async function mergeAndVerifyConsoleEvents(
  detected: LiveEvent[],
  verify: (event: LiveEvent) => LiveEvent['verification'],
  nowMs: number,
): Promise<LiveEvent[]> {
  const stored = await loadConsoleEvents();
  const byId = new Map<string, LiveEvent>();
  for (const event of stored) byId.set(event.id, event);

  for (const fresh of detected) {
    const prior = byId.get(fresh.id);
    byId.set(fresh.id, prior
      ? { ...fresh, loggedAtUtc: prior.loggedAtUtc, verification: prior.verification.status === 'verified' ? prior.verification : fresh.verification }
      : fresh);
  }

  let merged = [...byId.values()].map(event => ({ ...event, verification: verify(event) }));
  merged = merged
    .filter(event => nowMs - new Date(event.detectedAtL1Utc).getTime() <= PRUNE_OLDER_THAN_MS)
    .sort((a, b) => new Date(b.detectedAtL1Utc).getTime() - new Date(a.detectedAtL1Utc).getTime())
    .slice(0, MAX_EVENTS);

  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}
