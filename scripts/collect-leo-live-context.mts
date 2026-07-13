#!/usr/bin/env node
/** Collect real TLE trajectory and already-measured L1 parcels for the Python forecaster. */

import { fetchLiveL1History } from '../src/services/liveL1HistoryService';
import { selectLeoTrajectory, type LeoTleGroup } from '../src/services/leo/leoTrajectoryService';

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

const group: LeoTleGroup = argument('--group') === 'weather' ? 'weather' : 'stations';
const noradId = argument('--norad-id');
const horizonMinutes = boundedInteger(argument('--horizon-minutes'), 180, 30, 1_440);
const cadenceMinutes = boundedInteger(argument('--cadence-minutes'), 5, 1, 30);
const historyHours = boundedInteger(argument('--history-hours'), 13, 3, 48);

const [trajectoryResult, historyResult] = await Promise.allSettled([
  selectLeoTrajectory({ group, noradId, horizonMinutes, cadenceMinutes }),
  fetchLiveL1History(),
]);
const generatedAtUtc = new Date().toISOString();
const errors: string[] = [];
if (trajectoryResult.status === 'rejected') errors.push('Real CelesTrak TLE trajectory retrieval failed.');
if (historyResult.status === 'rejected') errors.push('Real L1 history retrieval failed.');

const trajectory = trajectoryResult.status === 'fulfilled' ? trajectoryResult.value : null;
const history = historyResult.status === 'fulfilled' ? historyResult.value : null;
const cutoffMs = Date.parse(generatedAtUtc) - historyHours * 3_600_000;
const drivers = (history?.samples ?? [])
  .filter(sample => sample.ms >= cutoffMs && sample.speedKmS !== null && sample.speedKmS > 0)
  .map(sample => {
    const lagSeconds = (history?.mruDistanceKm ?? 0) / (sample.speedKmS as number);
    return {
      source_measurement_time_l1_utc: new Date(sample.ms).toISOString(),
      available_at_utc: generatedAtUtc,
      arrival_time_bow_shock_utc: new Date(sample.ms + lagSeconds * 1_000).toISOString(),
      mru_distance_km: history?.mruDistanceKm ?? null,
      vsw_km_s: sample.speedKmS,
      np_cm3: sample.densityPerCm3,
      by_gsm_nt: sample.byNt,
      bz_gsm_nt: sample.bzNt,
      bmag_nt: sample.btNt,
      source_label: history?.sourceLabel ?? null,
      quality_flags: sample.qualityFlags,
      evidence_class: 'experimental_forecast',
    };
  });

const payload = {
  schema_version: 'leo-live-context-v1',
  generated_at_utc: generatedAtUtc,
  status: trajectory?.trajectory.points.length && drivers.length ? 'available' : errors.length ? 'error' : 'partial',
  selector: {
    group,
    selected_norad_id: trajectory?.selectedNoradId ?? null,
  },
  trajectory: trajectory?.trajectory ?? null,
  l1_drivers: drivers,
  data_health: {
    tle_connected: trajectory?.sourceConnected ?? false,
    tle_stale_cache: trajectory?.sourceStale ?? false,
    l1_source: history?.sourceLabel ?? null,
    l1_freshness: history?.freshness ?? 'stale',
    l1_latest_sample_utc: history?.latestSampleMs ? new Date(history.latestSampleMs).toISOString() : null,
  },
  warnings: [
    ...(trajectory?.warnings ?? []),
    ...(history?.errorMessage ? [history.errorMessage] : []),
  ],
  errors,
};

process.stdout.write(JSON.stringify(payload));
