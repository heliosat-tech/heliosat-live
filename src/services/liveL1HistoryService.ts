/**
 * Live L1 solar-wind history, resilient to NOAA pipeline gaps.
 *
 * Raw L1 comes from a few government spacecraft through two largely independent
 * real-time pipelines:
 *   - NOAA SWPC — current multi-spacecraft RTSW JSON object products. Retired
 *     table products are not queried. See ./l1/swpcRtswSource.
 *   - NASA IMAP I-ALiRT — its own ground path, behind a swappable adapter. See
 *     ./l1/imapIalirtSource.
 *
 * Each connector normalizes to one internal sample schema; the selection layer
 * picks the freshest valid stream per poll and reports the live source name and
 * sample age. The downstream forecast math is unchanged — this only governs which
 * samples feed it. No fabricated samples; gaps stay visible.
 */

import { fetchImapIalirt } from './l1/imapIalirtSource';
import { selectFreshestSource } from './l1/sourceSelection';
import { fetchSwpc } from './l1/swpcRtswSource';
import type { L1HistoryResult } from './l1/types';

export type { L1HistoryResult, ResolvedL1EventSample, L1SourceId, FeedFreshness, ConsideredSource } from './l1/types';
export { classifyFeedAgeMinutes, FEED_DEGRADED_AFTER_MIN, FEED_STALE_AFTER_MIN } from './l1/sourceSelection';

export async function fetchLiveL1History(): Promise<L1HistoryResult> {
  const nowMs = Date.now();
  // Both pipelines are queried in parallel; each resolves to an (possibly empty)
  // result rather than throwing, so one being down never blocks the other.
  const [swpc, imap] = await Promise.all([
    fetchSwpc(),
    fetchImapIalirt(nowMs),
  ]);
  return selectFreshestSource([swpc, imap], nowMs);
}
