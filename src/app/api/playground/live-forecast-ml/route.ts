import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import type { L1EarthSample } from '@/services/l1EarthData';
import { loadMlModel, predictAtTimes } from '@/services/mlModelService';
import { fetchPlaygroundTelemetry } from '@/services/playgroundTelemetryService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NOMINAL_L1_DISTANCE_KM = 1_500_000;

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * ML-corrected live forecast: applies the trained ML artifact to the CURRENT L1
 * (DSCOVR) feed, returning predicted Earth values at the in-transit arrival times
 * so the Live Forecast can overlay ML next to the MRU baseline.
 */
export async function GET() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const artifact = await loadMlModel();
  if (!artifact) {
    return NextResponse.json({ available: false, trainedAtUtc: null, points: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const telemetry = await fetchPlaygroundTelemetry();
  const magByTime = new Map(telemetry.noaaMagData.timeSeries.map(sample => [sample.time_tag, sample]));
  const samples: L1EarthSample[] = telemetry.noaaPlasmaData.timeSeries
    .map(plasma => {
      const mag = magByTime.get(plasma.time_tag);
      const ms = new Date(`${plasma.time_tag.replace(' ', 'T')}Z`).getTime();
      return {
        ms,
        speed: toNumber(plasma.speed),
        density: toNumber(plasma.density),
        bt: toNumber(mag?.bt),
        bz: toNumber(mag?.bz_gsm),
      };
    })
    .filter(sample => !Number.isNaN(sample.ms));

  const ephemeris = telemetry.noaaEphemerisData.latestData;
  const x = toNumber(ephemeris?.x_gse);
  const y = toNumber(ephemeris?.y_gse);
  const z = toNumber(ephemeris?.z_gse);
  let distanceKm = NOMINAL_L1_DISTANCE_KM;
  if (x !== null && y !== null && z !== null) {
    const measured = Math.sqrt(x * x + y * y + z * z);
    if (measured >= 500_000 && measured <= 2_500_000) distanceKm = measured;
  }

  // Each measured L1 parcel arrives at Earth at l1Time + distance/speed.
  const arrivalTimesMs = samples
    .filter(sample => sample.speed !== null && sample.speed > 0)
    .map(sample => sample.ms + (distanceKm / (sample.speed as number)) * 1000);

  // imputeMissing -> same future horizon as MRU; anchorToInput -> correction over
  // the live DSCOVR baseline (avoids the ACE->OMNI calibration bias).
  const opts = { imputeMissing: true, anchorToInput: true };
  const speed = predictAtTimes(artifact, samples, 'speed', arrivalTimesMs, opts);
  const bz = predictAtTimes(artifact, samples, 'bz', arrivalTimesMs, opts);
  const points = arrivalTimesMs
    .map((t, index) => ({ t, speed: speed[index], bz: bz[index] }))
    .filter(point => point.speed !== null || point.bz !== null);

  return NextResponse.json(
    { available: true, trainedAtUtc: artifact.trainedAtUtc, points },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
