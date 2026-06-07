/**
 * Append-only-ish persistence for the live event log. Each detection "tick"
 * re-runs the detector over the current L1 window and merges results into a JSON
 * store, so the history ACCUMULATES across days and verification verdicts are
 * retained even after an event scrolls out of the live feed.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { writeJsonFileBestEffort } from '@/lib/fsCache';
import type { LiveEvent } from './liveEventService';

const STORE_DIR = path.join(process.cwd(), 'data', 'live-events');
const STORE_PATH = path.join(STORE_DIR, 'events.json');
const CATALOG_PATH = path.join(STORE_DIR, 'catalog.json');

const MAX_EVENTS = 250;
const PRUNE_OLDER_THAN_MS = 60 * 24 * 60 * 60 * 1000; // keep ~60 days of history

export async function loadStoredEvents(): Promise<LiveEvent[]> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LiveEvent[]) : [];
  } catch {
    return [];
  }
}

async function saveStoredEvents(events: LiveEvent[]): Promise<void> {
  await writeJsonFileBestEffort(STORE_PATH, events, { pretty: true });
}

/**
 * The OMNI year-long catalog is regenerated wholesale from a single OMNI fetch, so
 * it's persisted (not merged) and read back for the year-history list / chart bands
 * even when a short range is being viewed.
 */
export async function loadEventCatalog(): Promise<LiveEvent[]> {
  try {
    const raw = await fs.readFile(CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LiveEvent[]) : [];
  } catch {
    return [];
  }
}

export async function saveEventCatalog(events: LiveEvent[]): Promise<void> {
  const sorted = events.slice().sort((a, b) => new Date(b.detectedAtL1Utc).getTime() - new Date(a.detectedAtL1Utc).getTime());
  await writeJsonFileBestEffort(CATALOG_PATH, sorted, { pretty: true });
}

/**
 * Merge freshly-detected events into the stored set:
 *  - new id            -> insert (keep its first loggedAt)
 *  - existing id       -> refresh drivers/predictions from the latest detection,
 *                         but preserve the original loggedAt and any verified verdict
 *                         (re-detection shouldn't downgrade a settled result).
 * `verify` is applied to every (merged) event so pending ones can settle on later ticks.
 */
export async function mergeAndVerifyEvents(
  detected: LiveEvent[],
  verify: (event: LiveEvent) => LiveEvent['verification'],
  nowMs: number,
): Promise<LiveEvent[]> {
  const stored = await loadStoredEvents();
  const byId = new Map<string, LiveEvent>();
  for (const event of stored) byId.set(event.id, event);

  for (const fresh of detected) {
    const prior = byId.get(fresh.id);
    if (!prior) {
      byId.set(fresh.id, fresh);
    } else {
      byId.set(fresh.id, {
        ...fresh,
        loggedAtUtc: prior.loggedAtUtc,
        // Keep a settled verification rather than resetting it to pending.
        verification: prior.verification.status === 'verified' ? prior.verification : fresh.verification,
      });
    }
  }

  // (Re)run verification on everything so pending events settle once Kp is in.
  let merged = [...byId.values()].map(event => ({ ...event, verification: verify(event) }));

  // Prune very old entries and cap the store size (newest first).
  merged = merged
    .filter(event => nowMs - new Date(event.detectedAtL1Utc).getTime() <= PRUNE_OLDER_THAN_MS)
    .sort((a, b) => new Date(b.detectedAtL1Utc).getTime() - new Date(a.detectedAtL1Utc).getTime())
    .slice(0, MAX_EVENTS);

  await saveStoredEvents(merged);
  return merged;
}
