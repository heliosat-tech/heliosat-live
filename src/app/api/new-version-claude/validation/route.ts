import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import { detectPhysicalDriverEvents } from '@/services/dataProcessing';
import { fetchGoesContextSamples } from '@/services/dataSources/goes';
import { fetchGroundIndexSamples } from '@/services/dataSources/ground';
import { fetchSwpcRtswL1Samples } from '@/services/dataSources/l1';
import {
  MAX_RELIABLE_L1_KM,
  MIN_RELIABLE_L1_KM,
  NOMINAL_L1_DISTANCE_KM,
  type L1EphemerisSample,
} from '@/services/dataSources/types';
import { gLevelFromKp, summarizeSourceQuality, validatePhysicalDriverEvents } from '@/services/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * New Version Claude — operational-relevance validation (no OMNI).
 *
 * Ingests live L1 (NOAA SWPC RTSW), GEO context (GOES) and ground geomagnetic-response
 * indices (Kp/Dst), detects hazardous physical-driver intervals at L1, estimates the
 * terrestrial response window, and checks whether a real GEO + ground response followed.
 */

function resolveL1Distance(ephemeris: L1EphemerisSample[]): { km: number; basis: 'ephemeris' | 'nominal' } {
  for (let i = ephemeris.length - 1; i >= 0; i -= 1) {
    const { xGseKm, yGseKm, zGseKm } = ephemeris[i];
    if (xGseKm === null || yGseKm === null || zGseKm === null) continue;
    const magnitude = Math.sqrt(xGseKm * xGseKm + yGseKm * yGseKm + zGseKm * zGseKm);
    if (magnitude >= MIN_RELIABLE_L1_KM && magnitude <= MAX_RELIABLE_L1_KM) {
      return { km: magnitude, basis: 'ephemeris' };
    }
  }
  return { km: NOMINAL_L1_DISTANCE_KM, basis: 'nominal' };
}

export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const generatedAtUtc = new Date().toISOString();

  const [l1, goes, ground] = await Promise.all([
    fetchSwpcRtswL1Samples({ window: '7-day', includeEphemeris: true }),
    fetchGoesContextSamples({ window: '7-day' }),
    fetchGroundIndexSamples({}),
  ]);

  const distance = resolveL1Distance(l1.ephemerisSamples);
  const detection = detectPhysicalDriverEvents(l1.samples, {
    l1DistanceKm: distance.km,
    distanceBasis: distance.basis,
  });
  const validation = validatePhysicalDriverEvents(detection.events, goes.samples, ground.samples);

  const maxKp = validation.records.reduce<number | null>((max, record) => {
    const kp = record.ground.maxKp6h;
    if (kp === null) return max;
    return max === null ? kp : Math.max(max, kp);
  }, null);
  const gRiskProxy = { maxKp, ...gLevelFromKp(maxKp) };

  return NextResponse.json(
    {
      generatedAtUtc,
      window: '7-day',
      principles: {
        omni: 'not used',
        goes: 'GEO context, not L1 truth',
        kpG: 'derived ground-response proxy, not an in-situ variable',
      },
      l1: {
        sampleCount: l1.samples.length,
        distanceKm: Math.round(distance.km),
        distanceBasis: distance.basis,
        cadenceMinutes: detection.cadenceMs ? Math.round((detection.cadenceMs / 60_000) * 10) / 10 : null,
        attribution: l1.sourceAttribution,
        warnings: l1.warnings,
        errors: l1.errors,
        quality: summarizeSourceQuality(l1.samples),
      },
      goes: {
        sampleCount: goes.samples.length,
        attribution: goes.sourceAttribution,
        warnings: goes.warnings,
        errors: goes.errors,
        quality: summarizeSourceQuality(goes.samples),
      },
      ground: {
        sampleCount: ground.samples.length,
        attribution: ground.sourceAttribution,
        warnings: ground.warnings,
        errors: ground.errors,
        quality: summarizeSourceQuality(ground.samples),
      },
      gRiskProxy,
      events: detection.events,
      validation,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
