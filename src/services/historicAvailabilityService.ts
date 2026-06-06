import fs from 'node:fs';
import { getNceiGoesCheckpointPath, NCEI_GOES_SOURCE_ID } from './pipeline/nceiGoesArchiveConnector';

interface NceiGoesArchiveDailyCoverage {
  date_utc: string;
  spacecraft_id: string;
  product: string;
  observed_samples: number;
  expected_samples: number;
}

interface NceiGoesArchiveCheckpoint {
  daily_coverage?: Record<string, NceiGoesArchiveDailyCoverage>;
}

export interface HistoricAvailabilityDay {
  dateUtc: string;
  observedSamples: number;
  expectedSamples: number;
  coveragePercent: number | null;
}

export interface HistoricAvailabilitySource {
  sourceId: string;
  coverageKind: 'daily-indexed';
  startDateUtc: string;
  stopDateUtc: string;
  expectedSamplesPerDay: number;
  days: HistoricAvailabilityDay[];
}

export interface HistoricAvailabilitySnapshot {
  generatedAtUtc: string;
  sources: HistoricAvailabilitySource[];
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function buildGoesRArchiveAvailability(): HistoricAvailabilitySource | null {
  const checkpoint = readJsonFile<NceiGoesArchiveCheckpoint>(getNceiGoesCheckpointPath());
  const dailyCoverage = Object.values(checkpoint?.daily_coverage ?? {});

  if (dailyCoverage.length === 0) {
    return null;
  }

  const byDate = new Map<string, { observedSamples: number; expectedSamples: number }>();

  dailyCoverage.forEach(entry => {
    const current = byDate.get(entry.date_utc) ?? { observedSamples: 0, expectedSamples: 0 };
    current.observedSamples += Number.isFinite(entry.observed_samples) ? entry.observed_samples : 0;
    current.expectedSamples += Number.isFinite(entry.expected_samples) ? entry.expected_samples : 0;
    byDate.set(entry.date_utc, current);
  });

  const days = Array.from(byDate.entries())
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .map(([dateUtc, coverage]) => ({
      dateUtc,
      observedSamples: coverage.observedSamples,
      expectedSamples: coverage.expectedSamples,
      coveragePercent: coverage.expectedSamples > 0
        ? Math.min(100, (coverage.observedSamples / coverage.expectedSamples) * 100)
        : null,
    }));

  const positiveExpectedSamples = days
    .map(day => day.expectedSamples)
    .filter(expectedSamples => expectedSamples > 0)
    .sort((left, right) => left - right);
  const expectedSamplesPerDay =
    positiveExpectedSamples[Math.floor(positiveExpectedSamples.length / 2)] ?? 0;

  return {
    sourceId: NCEI_GOES_SOURCE_ID,
    coverageKind: 'daily-indexed',
    startDateUtc: days[0]?.dateUtc ?? '',
    stopDateUtc: days.at(-1)?.dateUtc ?? '',
    expectedSamplesPerDay,
    days,
  };
}

export function buildHistoricAvailabilitySnapshot(): HistoricAvailabilitySnapshot {
  const sources = [
    buildGoesRArchiveAvailability(),
  ].filter((source): source is HistoricAvailabilitySource => Boolean(source));

  return {
    generatedAtUtc: new Date().toISOString(),
    sources,
  };
}
