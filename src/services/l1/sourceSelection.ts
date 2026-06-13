/**
 * Source selection (STEP 3): per poll, pick the freshest valid sample across the
 * independent pipelines and classify the feed's age. No fabricated samples — when
 * nothing is fresh the gap stays visible and the age is reported as-is.
 */

import { bowShockDistanceKm } from '../mruForecastService';
import { NOMINAL_L1_DISTANCE_KM } from './normalize';
import type { ConsideredSource, FeedFreshness, L1HistoryResult, L1SourceResult } from './types';

export const FEED_DEGRADED_AFTER_MIN = 20;
export const FEED_STALE_AFTER_MIN = 60;

/** fresh < 20 min · degraded 20–60 · stale > 60 (or unknown age). */
export function classifyFeedAgeMinutes(minutes: number | null): FeedFreshness {
  if (minutes === null) return 'stale';
  if (minutes > FEED_STALE_AFTER_MIN) return 'stale';
  if (minutes > FEED_DEGRADED_AFTER_MIN) return 'degraded';
  return 'fresh';
}

/**
 * Choose the source whose newest valid sample is the freshest. Ties or empties
 * degrade gracefully: if no source produced samples, returns an empty history
 * carrying the first error message and a stale classification.
 */
export function selectFreshestSource(results: L1SourceResult[], nowMs: number): L1HistoryResult {
  const consideredSources: ConsideredSource[] = results.map(result => ({
    sourceId: result.sourceId,
    sourceLabel: result.sourceLabel,
    latestSampleMs: result.latestSampleMs,
    sampleCount: result.samples.length,
    errorMessage: result.errorMessage,
  }));

  const selected = results
    .filter(result => result.samples.length > 0 && result.latestSampleMs !== null)
    .reduce<L1SourceResult | null>(
      (best, result) =>
        best === null || (result.latestSampleMs as number) > (best.latestSampleMs as number) ? result : best,
      null,
    );

  if (!selected) {
    const errorMessage = results.map(result => result.errorMessage).find(Boolean) ?? 'No live L1 source returned samples.';
    return {
      samples: [],
      distanceKm: NOMINAL_L1_DISTANCE_KM,
      distanceIsMeasured: false,
      mruDistanceKm: bowShockDistanceKm(null),
      scPositionGseKm: null,
      errorMessage,
      sourceId: null,
      sourceLabel: null,
      latestSampleMs: null,
      latestSampleAgeMinutes: null,
      freshness: 'stale',
      consideredSources,
    };
  }

  const latestSampleMs = selected.latestSampleMs as number;
  const latestSampleAgeMinutes = Math.max(0, Math.round((nowMs - latestSampleMs) / 60000));

  return {
    samples: selected.samples,
    distanceKm: selected.distanceKm,
    distanceIsMeasured: selected.distanceIsMeasured,
    mruDistanceKm: bowShockDistanceKm(selected.scPositionGseKm?.x ?? null),
    scPositionGseKm: selected.scPositionGseKm,
    errorMessage: selected.errorMessage,
    sourceId: selected.sourceId,
    sourceLabel: selected.sourceLabel,
    latestSampleMs,
    latestSampleAgeMinutes,
    freshness: classifyFeedAgeMinutes(latestSampleAgeMinutes),
    consideredSources,
  };
}
