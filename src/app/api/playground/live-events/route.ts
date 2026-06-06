import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { fetchLiveL1History } from '@/services/liveL1HistoryService';
import { fetchPlanetaryKpSeries } from '@/services/noaaStormScalesService';
import {
  buildModelPrediction,
  detectLiveEvents,
  verifyEvent,
  type LiveEvent,
} from '@/services/liveEventService';
import { mergeAndVerifyEvents } from '@/services/liveEventStore';
import { mergingFieldMvM } from '@/services/stormScaleService';
import { loadMlModel, predictAtTimes } from '@/services/mlModelService';
import type { L1EarthSample } from '@/services/l1EarthData';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

function mean(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

/**
 * Add the ML model's arrival + intensity prediction to a detected event, using
 * the trained artifact to correct speed/Bz across the event's L1 samples. Returns
 * the event unchanged if ML can't produce a finite prediction.
 */
function withMlPrediction(event: LiveEvent, mlSamples: L1EarthSample[], artifact: NonNullable<Awaited<ReturnType<typeof loadMlModel>>>): LiveEvent {
  const startMs = new Date(event.detectedAtL1Utc).getTime();
  const endMs = new Date(event.endAtL1Utc).getTime();
  const members = mlSamples.filter(s => s.ms >= startMs && s.ms <= endMs && s.speed !== null && (s.speed as number) > 0);
  if (members.length === 0) return event;

  // Each member parcel arrives at Earth at memberTime + distance/speed (MRU grid);
  // ask ML for the corrected speed/Bz at those arrival times.
  const arrivalTimes = members.map(s => s.ms + (event.l1DistanceKm / (s.speed as number)) * 1000);
  const mlSpeeds = predictAtTimes(artifact, mlSamples, 'speed', arrivalTimes, { anchorToInput: true });
  const mlBz = predictAtTimes(artifact, mlSamples, 'bz', arrivalTimes, { anchorToInput: true });

  const onsetMlSpeed = mlSpeeds.find(v => typeof v === 'number' && Number.isFinite(v) && v > 0) ?? null;
  if (onsetMlSpeed === null) return event;

  // Peak (most geoeffective) ML member by merging field.
  let peakIdx = 0;
  let peakEm = -1;
  const emPerMember: Array<number | null> = members.map((_, i) => {
    const speed = mlSpeeds[i];
    const bz = mlBz[i];
    if (typeof speed !== 'number' || typeof bz !== 'number') return null;
    const em = mergingFieldMvM(speed, bz);
    if (em > peakEm) {
      peakEm = em;
      peakIdx = i;
    }
    return em;
  });

  const meanEm = mean(emPerMember) ?? 0;
  const meanSpeed = mean(mlSpeeds);
  const prediction = buildModelPrediction(
    'ML',
    startMs,
    event.l1DistanceKm,
    onsetMlSpeed,
    typeof mlSpeeds[peakIdx] === 'number' ? (mlSpeeds[peakIdx] as number) : meanSpeed,
    typeof mlBz[peakIdx] === 'number' ? (mlBz[peakIdx] as number) : null,
    // Use the mean coupling for the trailing-equivalent intensity, but never below
    // the single peak member when the structure is short.
    Math.max(meanEm, peakEm > 0 ? peakEm * 0.6 : 0),
  );

  return { ...event, predictions: [...event.predictions, prediction] };
}

/**
 * Live event log tick: detect L1 disturbances, predict their Earth arrival +
 * intensity under each model, merge into the persistent store, and verify settled
 * events against the real planetary Kp. Returns the accumulated, sorted log.
 */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const [history, kpSeries] = await Promise.all([fetchLiveL1History(), fetchPlanetaryKpSeries()]);
  const nowMs = Date.now();

  let detected = detectLiveEvents(history.samples, history.distanceKm);

  // Enrich with the ML model when a trained artifact is available.
  let mlAvailable = false;
  try {
    const artifact = await loadMlModel();
    if (artifact) {
      mlAvailable = true;
      const mlSamples: L1EarthSample[] = history.samples.map(s => ({
        ms: s.ms,
        speed: s.speedKmS,
        density: s.densityPerCm3,
        bt: s.btNt,
        bz: s.bzNt,
      }));
      detected = detected.map(event => withMlPrediction(event, mlSamples, artifact));
    }
  } catch {
    // ML enrichment is best-effort; MRU predictions still stand.
  }

  const events = await mergeAndVerifyEvents(
    detected,
    event => verifyEvent(event, kpSeries, nowMs),
    nowMs,
  );

  // Skill summary per model over verified events.
  const summary = { total: events.length, verified: 0, pending: 0, unverifiable: 0, mru: { checked: 0, hits: 0 }, ml: { checked: 0, hits: 0 } };
  for (const event of events) {
    if (event.verification.status === 'verified') summary.verified += 1;
    else if (event.verification.status === 'pending') summary.pending += 1;
    else summary.unverifiable += 1;
    for (const verdict of event.verification.verdicts) {
      const bucket = verdict.model === 'ML' ? summary.ml : summary.mru;
      if (verdict.hit !== null) {
        bucket.checked += 1;
        if (verdict.hit) bucket.hits += 1;
      }
    }
  }

  return NextResponse.json(
    {
      events,
      summary,
      mlAvailable,
      distanceKm: Math.round(history.distanceKm),
      distanceIsMeasured: history.distanceIsMeasured,
      kpAvailable: kpSeries.length > 0,
      generatedAtUtc: new Date(nowMs).toISOString(),
      warnings: [history.errorMessage].filter(Boolean),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
