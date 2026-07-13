import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LEO_CONTRACT_VERSION,
  type LeoArchiveDataset,
  type LeoAvailabilityStatus,
  type LeoCoveragePhase,
  type LeoCoverageRange,
  type LeoCoverageSummary,
  type LeoInventoryResponse,
  type LeoMissionId,
  type LeoProcessingStatus,
} from '../../lib/leo/contracts';

export const THERMOSPHERE_MANIFEST_RELATIVE_PATH = 'data/processed/thermosphere/manifest.v1.json' as const;

interface ThermosphereManifestEntry {
  baseline_status?: unknown;
  checksum_sha256?: unknown;
  driver_join_status?: unknown;
  end_utc?: unknown;
  error?: unknown;
  info_file?: unknown;
  last_ingestion_utc?: unknown;
  mission?: unknown;
  mission_label?: unknown;
  native_cadence_seconds?: unknown;
  processed_cadence_seconds?: unknown;
  processed_files?: unknown;
  processing_status?: unknown;
  product_family?: unknown;
  provenance?: unknown;
  research_stage?: unknown;
  quality_anomalous_rows?: unknown;
  quality_nominal_rows?: unknown;
  quality_not_provided_rows?: unknown;
  raw_file?: unknown;
  row_count_processed?: unknown;
  row_count_raw?: unknown;
  role_coverage?: unknown;
  schema_version?: unknown;
  source_product?: unknown;
  source_url?: unknown;
  source_version?: unknown;
  spacecraft_id?: unknown;
  start_utc?: unknown;
  storage_bytes?: unknown;
  training_role?: unknown;
}

export interface ThermosphereManifest {
  coverage_summary?: unknown;
  entries?: unknown;
  errors?: unknown;
  generated_at_utc?: unknown;
  schema_version?: unknown;
  source?: unknown;
}

interface MissionDefinition {
  id: LeoMissionId;
  mission: LeoArchiveDataset['mission'];
  spacecraftId: string;
  displayName: string;
  productIds: string[];
  catalogNote?: string;
}

const MISSIONS: readonly MissionDefinition[] = [
  {
    id: 'swarm-a',
    mission: 'Swarm',
    spacecraftId: 'A',
    displayName: 'Swarm A',
    productIds: ['SW_OPER_DNSAPOD_2_', 'SW_OPER_DNSAACC_2_'],
  },
  {
    id: 'swarm-b',
    mission: 'Swarm',
    spacecraftId: 'B',
    displayName: 'Swarm B',
    productIds: ['SW_OPER_DNSBPOD_2_', 'SW_OPER_DNSBACC_2_'],
  },
  {
    id: 'swarm-c',
    mission: 'Swarm',
    spacecraftId: 'C',
    displayName: 'Swarm C',
    productIds: ['SW_OPER_DNSCPOD_2_', 'SW_OPER_DNSCACC_2_'],
  },
  {
    id: 'grace-fo-1',
    mission: 'GRACE-FO',
    spacecraftId: '1',
    displayName: 'GRACE-FO 1',
    productIds: ['GF_OPER_DNS1ACC_2_'],
  },
  {
    id: 'grace-fo-2',
    mission: 'GRACE-FO',
    spacecraftId: '2',
    displayName: 'GRACE-FO 2',
    productIds: [],
    catalogNote: 'No official GRACE-FO 2 density collection is currently advertised by the verified VirES HAPI catalog.',
  },
] as const;

const EMPTY_COVERAGE = (): Record<LeoCoveragePhase, LeoCoverageRange> => ({
  raw: { status: 'unavailable', start_utc: null, end_utc: null, rows: null },
  processed: { status: 'unavailable', start_utc: null, end_utc: null, rows: null },
  joined: { status: 'unavailable', start_utc: null, end_utc: null, rows: null },
  train: { status: 'unavailable', start_utc: null, end_utc: null, rows: null },
  validation: { status: 'unavailable', start_utc: null, end_utc: null, rows: null },
  test: { status: 'unavailable', start_utc: null, end_utc: null, rows: null },
});

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function safeRelativePath(value: unknown): string | null {
  const text = asString(value);
  if (!text || path.isAbsolute(text) || text.includes('\0')) return null;
  const normalized = text.replaceAll('\\', '/');
  return normalized.split('/').includes('..') ? null : normalized;
}

function safeRelativePaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(safeRelativePath).filter((item): item is string => item !== null)
    : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isEntry(value: unknown): value is ThermosphereManifestEntry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function minIso(values: Array<string | null>): string | null {
  const valid = values.filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)));
  return valid.length ? valid.reduce((a, b) => Date.parse(a) <= Date.parse(b) ? a : b) : null;
}

function maxIso(values: Array<string | null>): string | null {
  const valid = values.filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)));
  return valid.length ? valid.reduce((a, b) => Date.parse(a) >= Date.parse(b) ? a : b) : null;
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

function cadenceLabel(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  if (seconds < 60) return `${seconds} s`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function processingStatus(value: unknown, hasOutput: boolean): LeoProcessingStatus {
  const normalized = asString(value)?.toLowerCase();
  if (normalized === 'error' || normalized === 'failed') return 'error';
  if (normalized === 'pending' || normalized === 'not_started') return 'pending';
  if (normalized === 'partial') return 'partial';
  if (normalized === 'complete' || normalized === 'processed' || normalized === 'joined' || hasOutput) return 'complete';
  return 'unavailable';
}

function aggregateProcessingStatus(entries: ThermosphereManifestEntry[], field: 'processing_status' | 'baseline_status' | 'driver_join_status', hasOutput: boolean): LeoProcessingStatus {
  if (!entries.length) return 'unavailable';
  const statuses = entries.map(entry => processingStatus(entry[field], hasOutput));
  if (statuses.every(status => status === 'complete')) return 'complete';
  if (statuses.some(status => status === 'error')) return statuses.some(status => status === 'complete') ? 'partial' : 'error';
  if (statuses.some(status => status === 'complete')) return 'partial';
  if (statuses.some(status => status === 'pending')) return 'pending';
  return 'unavailable';
}

function coverageFor(
  entries: ThermosphereManifestEntry[],
  phase: 'raw' | 'processed',
): LeoCoverageRange {
  const rows = entries.map(entry => asFiniteNumber(phase === 'raw' ? entry.row_count_raw : entry.row_count_processed));
  const files = phase === 'raw'
    ? entries.filter(entry => asString(entry.raw_file) !== null).length
    : entries.reduce((total, entry) => total + asStringArray(entry.processed_files).length, 0);
  const rowCount = sumKnown(rows);
  if (files === 0 && (rowCount === null || rowCount === 0)) {
    return { status: 'unavailable', start_utc: null, end_utc: null, rows: rowCount };
  }
  const errors = entries.filter(entry => asString(entry.error) !== null).length;
  return {
    status: errors ? 'partial' : 'available',
    start_utc: minIso(entries.map(entry => asString(entry.start_utc))),
    end_utc: maxIso(entries.map(entry => asString(entry.end_utc))),
    rows: rowCount,
  };
}

function derivedCoverage(
  entries: ThermosphereManifestEntry[],
  phase: 'joined' | 'train' | 'validation' | 'test',
  processed: LeoCoverageRange,
): LeoCoverageRange {
  if (!entries.length) return { status: 'unavailable', start_utc: null, end_utc: null, rows: null };
  if (phase === 'joined') {
    const state = aggregateProcessingStatus(entries, 'driver_join_status', false);
    if (state !== 'complete' && state !== 'partial') return { status: state === 'error' ? 'error' : 'unavailable', start_utc: null, end_utc: null, rows: null };
    return { status: state === 'complete' ? 'available' : 'partial', start_utc: processed.start_utc, end_utc: processed.end_utc, rows: null };
  }

  const matching = entries.filter(entry => asString(entry.training_role)?.toLowerCase() === phase);
  const explicit = entries
    .map(entry => asObject(asObject(entry.role_coverage)?.[phase]))
    .filter((value): value is Record<string, unknown> => value !== null);
  if (explicit.length) {
    return {
      status: 'available',
      start_utc: minIso(explicit.map(value => asString(value.start_utc))),
      end_utc: maxIso(explicit.map(value => asString(value.end_utc))),
      rows: sumKnown(explicit.map(value => asFiniteNumber(value.rows))),
    };
  }
  if (!matching.length) return { status: 'unavailable', start_utc: null, end_utc: null, rows: null };
  return {
    status: matching.some(entry => asString(entry.error)) ? 'partial' : 'available',
    start_utc: minIso(matching.map(entry => asString(entry.start_utc))),
    end_utc: maxIso(matching.map(entry => asString(entry.end_utc))),
    rows: sumKnown(matching.map(entry => asFiniteNumber(entry.row_count_processed))),
  };
}

function entryMatchesMission(entry: ThermosphereManifestEntry, definition: MissionDefinition): boolean {
  const product = asString(entry.source_product);
  if (product && definition.productIds.includes(product)) return true;
  const mission = asString(entry.mission)?.toLowerCase();
  const spacecraft = asString(entry.spacecraft_id)?.toUpperCase();
  const expectedMission = definition.mission === 'Swarm' ? 'swarm' : 'grace_fo';
  return mission === expectedMission && spacecraft === definition.spacecraftId;
}

function buildDataset(definition: MissionDefinition, allEntries: ThermosphereManifestEntry[]): LeoArchiveDataset {
  const entries = allEntries.filter(entry => entryMatchesMission(entry, definition));
  const coverage = EMPTY_COVERAGE();
  coverage.raw = coverageFor(entries, 'raw');
  coverage.processed = coverageFor(entries, 'processed');
  coverage.joined = derivedCoverage(entries, 'joined', coverage.processed);
  coverage.train = derivedCoverage(entries, 'train', coverage.processed);
  coverage.validation = derivedCoverage(entries, 'validation', coverage.processed);
  coverage.test = derivedCoverage(entries, 'test', coverage.processed);

  const rawFiles = entries.filter(entry => asString(entry.raw_file) !== null).length;
  const processedFiles = entries.reduce((total, entry) => total + asStringArray(entry.processed_files).length, 0);
  const errors = entries.map(entry => asString(entry.error)).filter((value): value is string => value !== null);
  const status: LeoAvailabilityStatus = entries.length === 0
    ? 'unavailable'
    : errors.length > 0 || rawFiles === 0 || processedFiles === 0
      ? 'partial'
      : 'available';

  const nominalQuality = sumKnown(entries.map(entry => asFiniteNumber(entry.quality_nominal_rows)));
  const anomalousQuality = sumKnown(entries.map(entry => asFiniteNumber(entry.quality_anomalous_rows)));
  const qualityTotal = nominalQuality !== null || anomalousQuality !== null
    ? (nominalQuality ?? 0) + (anomalousQuality ?? 0)
    : null;
  const qualityPct = qualityTotal !== null && qualityTotal > 0 && nominalQuality !== null
    ? nominalQuality / qualityTotal * 100
    : null;

  const nativeCadences = [...new Set(entries.map(entry => asFiniteNumber(entry.native_cadence_seconds)).filter((value): value is number => value !== null))];
  const processedCadences = [...new Set(entries.map(entry => asFiniteNumber(entry.processed_cadence_seconds)).filter((value): value is number => value !== null))];
  const products = [...new Set([...definition.productIds, ...entries.map(entry => asString(entry.source_product)).filter((value): value is string => value !== null)])];

  return {
    id: definition.id,
    mission: definition.mission,
    spacecraft_id: definition.spacecraftId,
    display_name: definition.displayName,
    product_ids: products,
    source_provider: 'ESA VirES',
    source_access_url: 'https://vires.services/hapi/',
    status,
    status_message: status === 'available'
      ? 'Official density observations are present in the local raw and processed archive.'
      : definition.catalogNote ?? (entries.length
        ? 'The local archive is incomplete; inspect processing status and errors below.'
        : 'No official density files for this spacecraft have been imported into the local archive.'),
    coverage,
    native_cadence: nativeCadences.length === 1 ? cadenceLabel(nativeCadences[0]) : nativeCadences.length > 1 ? nativeCadences.map(cadenceLabel).join(' / ') : null,
    processed_cadence: processedCadences.length === 1 ? cadenceLabel(processedCadences[0]) : processedCadences.length > 1 ? processedCadences.map(cadenceLabel).join(' / ') : null,
    raw_files: rawFiles,
    processed_files: processedFiles,
    row_count_raw: sumKnown(entries.map(entry => asFiniteNumber(entry.row_count_raw))),
    row_count_processed: sumKnown(entries.map(entry => asFiniteNumber(entry.row_count_processed))),
    storage_bytes: sumKnown(entries.map(entry => asFiniteNumber(entry.storage_bytes))),
    quality_pass_count: nominalQuality,
    quality_reject_count: anomalousQuality,
    quality_pass_pct: qualityPct,
    last_ingestion_utc: maxIso(entries.map(entry => asString(entry.last_ingestion_utc))),
    processing_status: aggregateProcessingStatus(entries, 'processing_status', processedFiles > 0),
    baseline_status: aggregateProcessingStatus(entries, 'baseline_status', false),
    driver_join_status: aggregateProcessingStatus(entries, 'driver_join_status', false),
    lineage: entries.map(entry => ({
      source_product: asString(entry.source_product) ?? 'unknown',
      source_version: asString(entry.source_version),
      source_file: safeRelativePath(entry.raw_file),
      checksum_sha256: asString(entry.checksum_sha256),
      processed_files: safeRelativePaths(entry.processed_files),
      provenance: asObject(entry.provenance),
    })),
    errors,
  };
}

function coverageSummary(
  manifest: ThermosphereManifest | null,
  datasets: LeoArchiveDataset[],
  coverage: LeoInventoryResponse['coverage'],
): LeoCoverageSummary {
  const explicit = asObject(manifest?.coverage_summary);
  const storms = asObject(explicit?.storm_events);
  const moderateStorms = asFiniteNumber(storms?.moderate ?? explicit?.moderate_storms);
  const severeStorms = asFiniteNumber(storms?.severe ?? explicit?.severe_storms);
  const years = Array.isArray(explicit?.calendar_years)
    ? explicit.calendar_years
      .map(asFiniteNumber)
      .filter((value): value is number => value !== null && Number.isInteger(value) && value >= 1900 && value <= 2200)
    : [];
  const observed = datasets.filter(dataset => dataset.status === 'available' || dataset.status === 'partial');
  const spacecraftIds = asStringArray(explicit?.spacecraft_ids);
  const start = asString(explicit?.start_utc) ?? coverage.processed?.start_utc ?? null;
  const end = asString(explicit?.end_utc) ?? coverage.processed?.end_utc ?? null;
  return {
    start_utc: start && Number.isFinite(Date.parse(start)) ? start : null,
    end_utc: end && Number.isFinite(Date.parse(end)) ? end : null,
    effective_observation_days: asFiniteNumber(explicit?.effective_observation_days),
    calendar_years: [...new Set(years)].sort((a, b) => a - b),
    mission_count: asFiniteNumber(explicit?.mission_count) ?? new Set(observed.map(dataset => dataset.mission)).size,
    spacecraft_count: asFiniteNumber(explicit?.spacecraft_count) ?? observed.length,
    spacecraft_ids: spacecraftIds.length ? spacecraftIds : observed.map(dataset => dataset.display_name),
    quiet_interval_count: asFiniteNumber(explicit?.quiet_interval_count),
    storm_events: {
      total: asFiniteNumber(storms?.total ?? explicit?.storm_count)
        ?? (moderateStorms !== null || severeStorms !== null ? (moderateStorms ?? 0) + (severeStorms ?? 0) : null),
      moderate: moderateStorms,
      severe: severeStorms,
    },
  };
}

function aggregateCoverage(datasets: LeoArchiveDataset[]): LeoInventoryResponse['coverage'] {
  const result: LeoInventoryResponse['coverage'] = {};
  const phases: LeoCoveragePhase[] = ['raw', 'processed', 'joined', 'train', 'validation', 'test'];
  for (const phase of phases) {
    const ranges = datasets.map(dataset => dataset.coverage[phase]);
    const start = minIso(ranges.map(range => range.start_utc));
    const end = maxIso(ranges.map(range => range.end_utc));
    if (start && end) result[phase] = { start_utc: start, end_utc: end };
  }
  return result;
}

export function buildLeoInventoryFromManifest(
  manifest: ThermosphereManifest | null,
  options: { generatedAtUtc?: string; readError?: string | null } = {},
): LeoInventoryResponse {
  const generatedAtUtc = options.generatedAtUtc ?? new Date().toISOString();
  const rawEntries = manifest && Array.isArray(manifest.entries) ? manifest.entries : [];
  const entries = rawEntries.filter(isEntry);
  const manifestErrors = manifest && Array.isArray(manifest.errors)
    ? manifest.errors.filter((error): error is string => typeof error === 'string')
    : [];
  const datasets = MISSIONS.map(definition => buildDataset(definition, entries));
  const coverage = aggregateCoverage(datasets);
  const readError = options.readError ?? null;
  const manifestStatus: LeoAvailabilityStatus = readError
    ? 'error'
    : !manifest
      ? 'unavailable'
      : manifestErrors.length || rawEntries.length !== entries.length
        ? 'partial'
        : entries.length
          ? 'available'
          : 'unavailable';

  const warnings: string[] = [];
  if (!manifest && !readError) warnings.push(`No local thermosphere manifest exists at ${THERMOSPHERE_MANIFEST_RELATIVE_PATH}.`);
  if (manifest && rawEntries.length !== entries.length) warnings.push('Malformed manifest entries were ignored.');
  if (!entries.some(entry => asString(entry.mission)?.toLowerCase() === 'swarm')) warnings.push('No local Swarm density observations are currently inventoried.');
  if (!entries.some(entry => asString(entry.mission)?.toLowerCase() === 'grace_fo')) warnings.push('No local GRACE-FO density observations are currently inventoried.');

  return {
    schema_version: LEO_CONTRACT_VERSION,
    generated_at_utc: generatedAtUtc,
    evidence_class: 'observed',
    research_stage: entries.some(entry => entry.research_stage === 'multi_year_study') ? 'multi_year_study' : 'pilot',
    manifest: {
      path: THERMOSPHERE_MANIFEST_RELATIVE_PATH,
      schema_version: manifest ? asString(manifest.schema_version) : null,
      generated_at_utc: manifest ? asString(manifest.generated_at_utc) : null,
      status: manifestStatus,
    },
    datasets,
    coverage,
    coverage_summary: coverageSummary(manifest, datasets, coverage),
    source: {
      provider: 'ESA VirES',
      access_url: 'https://vires.services/hapi/',
      attribution: 'Data provided by the European Space Agency.',
      licensing_status: 'Internal research use; review ESA/VirES terms before redistribution or commercial use.',
    },
    warnings,
    errors: [...manifestErrors, ...(readError ? [readError] : [])],
  };
}

function configuredDataRoot(): string {
  const configured = process.env.HELIOSAT_LEO_DATA_ROOT?.trim();
  return configured ? path.resolve(process.cwd(), configured) : path.join(process.cwd(), 'data');
}

export async function buildLeoInventory(): Promise<LeoInventoryResponse> {
  const manifestPath = path.join(configuredDataRoot(), 'processed', 'thermosphere', 'manifest.v1.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return buildLeoInventoryFromManifest(null, { readError: 'The thermosphere manifest root must be a JSON object.' });
    }
    return buildLeoInventoryFromManifest(parsed as ThermosphereManifest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return buildLeoInventoryFromManifest(null);
    const message = error instanceof SyntaxError
      ? 'The local thermosphere manifest is not valid JSON.'
      : 'The local thermosphere manifest could not be read.';
    return buildLeoInventoryFromManifest(null, { readError: message });
  }
}
