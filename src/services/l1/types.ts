/**
 * Shared types for the multi-source live L1 connector.
 *
 * Raw L1 solar wind reaches us through two largely independent real-time
 * pipelines — NOAA SWPC (current multi-spacecraft RTSW JSON object products) and
 * NASA IMAP I-ALiRT (its own
 * ground path). Each connector normalizes to the SAME internal sample schema so a
 * single selection layer can pick the freshest valid sample per poll and report
 * which source is live.
 */

import type { L1EventSample } from '../liveEventService';
import type { PhysicalDriverSourceId, PhysicalDriverVariable } from '../physicalDriverResolutionService';

/** Spacecraft GSE position in km (the live ephemeris frame/units). */
export interface ScPositionGseKm {
  x: number;
  y: number;
  z: number;
}

/** One resolved 1-minute L1 sample with per-variable provenance. */
export interface ResolvedL1EventSample extends L1EventSample {
  /** By GSM (nT), carried for the ML residual model's clock-angle/By features. */
  byNt: number | null;
  sourceByVariable: Record<PhysicalDriverVariable, PhysicalDriverSourceId | null>;
  sourceLabelByVariable: Record<PhysicalDriverVariable, string | null>;
  sourceTimeByVariable: Record<PhysicalDriverVariable, string | null>;
  missingVariables: PhysicalDriverVariable[];
  qualityFlags: string[];
  riskAvailable: boolean;
  pdynNpa: number | null;
  emMvM: number | null;
  estimatedGLevel: number | null;
}

/** Which real-time pipeline produced a sample stream. Spacecraft-agnostic. */
export type L1SourceId = 'swpc_rtsw' | 'swpc_legacy' | 'imap_ialirt';

/** One pipeline's normalized history for a single poll. */
export interface L1SourceResult {
  sourceId: L1SourceId;
  /** Human label, including the active spacecraft when the feed exposes it (e.g. "SWPC · DSCOVR"). */
  sourceLabel: string;
  /** Ascending by ms; may be empty when the source is down or producing nothing. */
  samples: ResolvedL1EventSample[];
  distanceKm: number;
  distanceIsMeasured: boolean;
  /** Latest spacecraft GSE position (km), for the ML model's sc_* features. */
  scPositionGseKm: ScPositionGseKm | null;
  /** Newest sample time in this stream, used for freshest-wins selection. */
  latestSampleMs: number | null;
  errorMessage: string | null;
}

/** Feed age classification. fresh < 20 min · degraded 20–60 · stale > 60. */
export type FeedFreshness = 'fresh' | 'degraded' | 'stale';

/** A single considered source, surfaced to the UI for transparency. */
export interface ConsideredSource {
  sourceId: L1SourceId;
  sourceLabel: string;
  latestSampleMs: number | null;
  sampleCount: number;
  errorMessage: string | null;
}

/**
 * The selected live history plus source-selection metadata. Extends the legacy
 * shape (samples/distanceKm/distanceIsMeasured/errorMessage) so existing callers
 * keep working unchanged.
 */
export interface L1HistoryResult {
  samples: ResolvedL1EventSample[];
  /** Measured spacecraft distance |pos| (km) — the physical L1 distance, for display. */
  distanceKm: number;
  distanceIsMeasured: boolean;
  /** The raw-MRU propagation distance (km): bow-shock-nose basis, used by every surface. */
  mruDistanceKm: number;
  scPositionGseKm: ScPositionGseKm | null;
  errorMessage: string | null;
  // ---- source selection (STEP 3) ----
  sourceId: L1SourceId | null;
  sourceLabel: string | null;
  latestSampleMs: number | null;
  latestSampleAgeMinutes: number | null;
  freshness: FeedFreshness;
  consideredSources: ConsideredSource[];
}
