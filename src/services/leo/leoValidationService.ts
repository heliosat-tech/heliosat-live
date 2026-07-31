import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  LEO_CONTRACT_VERSION,
  type LeoArrivalComparability,
  type LeoArrivalMode,
  type LeoArrivalModeResult,
  type LeoAvailabilityStatus,
  type LeoCoverageSummary,
  type LeoLagExperiment,
  type LeoStudyMode,
  type LeoTransferExperiment,
  type LeoUncertaintyCalibration,
  type LeoValidationEventModeResult,
  type LeoValidationEventStudy,
  type LeoValidationLineage,
  type LeoValidationMetric,
  type LeoValidationModeResult,
  type LeoValidationModel,
  type LeoValidationRegimeDimension,
  type LeoValidationRegimeGroup,
  type LeoValidationResponse,
  type LeoValidationScientificArtifact,
  type LeoValidationStudy,
} from '../../lib/leo/contracts';

export const LEO_STUDY_SUMMARY_FILE = 'study-summary.v1.json' as const;
export const LEO_MULTIYEAR_STUDY_SUMMARY_FILE = 'study-summary.v2.json' as const;
const LEO_STUDY_SUMMARY_FILES = [LEO_MULTIYEAR_STUDY_SUMMARY_FILE, LEO_STUDY_SUMMARY_FILE] as const;
const ARTIFACT_ROUTE = '/api/console/leo/validation/artifact';
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_PLOT_FILE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,191}\.png$/;
const STUDY_MODES: readonly LeoStudyMode[] = ['reference_aligned', 'heliosat_predicted_arrival'];
const ARRIVAL_MODES: readonly LeoArrivalMode[] = ['omni_reference_aligned', 'mru', 'mru_ml'];

const REGIME_DIMENSIONS = [
  ['geomagnetic_regime', 'Geomagnetic regime'],
  ['altitude', 'Altitude band'],
  ['latitude', 'Latitude band'],
  ['local_solar_time', 'Local solar time'],
  ['mission', 'Mission'],
  ['solar_activity', 'Solar activity'],
] as const satisfies ReadonlyArray<readonly [LeoValidationRegimeDimension['id'], string]>;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function availability(value: unknown, fallback: LeoAvailabilityStatus = 'unavailable'): LeoAvailabilityStatus {
  return value === 'available' || value === 'partial' || value === 'unavailable' || value === 'error'
    ? value
    : fallback;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? Math.round(number) : null;
}

function validIso(value: unknown): string | null {
  const text = asString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function boundedString(value: unknown, maximumLength = 256): string | null {
  const text = asString(value);
  return text && text.length <= maximumLength ? text : null;
}

function arrivalMode(value: unknown): LeoArrivalMode | null {
  if (value === 'omni_reference_aligned' || value === 'reference_aligned' || value === 'omni') return 'omni_reference_aligned';
  if (value === 'mru' || value === 'mru_arrival') return 'mru';
  if (value === 'mru_ml' || value === 'mru_plus_ml' || value === 'mru_ml_arrival') return 'mru_ml';
  return null;
}

function normalizeCoverageSummary(study: Record<string, unknown>): LeoCoverageSummary {
  const explicit = asObject(study.coverage_summary) ?? asObject(study.coverage);
  const lineage = asObject(study.data_lineage);
  const storms = asObject(explicit?.storm_events) ?? asObject(explicit?.storms);
  const eventDefinitions = Array.isArray(study.event_definitions) ? study.event_definitions : [];
  const moderateStorms = nonNegativeInteger(storms?.moderate ?? storms?.moderate_count ?? explicit?.moderate_storms);
  const severeStorms = nonNegativeInteger(storms?.severe ?? storms?.severe_count ?? explicit?.severe_storms);
  const calendarYears = Array.isArray(explicit?.calendar_years)
    ? explicit.calendar_years
      .map(finite)
      .filter((year): year is number => year !== null && Number.isInteger(year) && year >= 1900 && year <= 2200)
    : [];
  const spacecraft = asStringArray(explicit?.spacecraft_ids ?? explicit?.spacecraft ?? lineage?.spacecraft);
  const missions = asStringArray(study.missions).length ? asStringArray(study.missions) : asStringArray(lineage?.missions);
  const start = validIso(explicit?.start_utc ?? explicit?.coverage_start_utc ?? lineage?.coverage_start_utc);
  const end = validIso(
    explicit?.end_utc
      ?? explicit?.stop_utc
      ?? explicit?.coverage_end_utc
      ?? explicit?.coverage_stop_utc
      ?? lineage?.coverage_end_utc
      ?? lineage?.coverage_stop_utc,
  );
  return {
    start_utc: start,
    end_utc: end,
    effective_observation_days: nonNegativeInteger(explicit?.effective_observation_days ?? explicit?.effective_days),
    calendar_years: [...new Set(calendarYears)].sort((a, b) => a - b),
    mission_count: nonNegativeInteger(explicit?.mission_count) ?? (missions.length ? new Set(missions).size : null),
    spacecraft_count: nonNegativeInteger(explicit?.spacecraft_count) ?? (spacecraft.length ? new Set(spacecraft).size : null),
    spacecraft_ids: [...new Set(spacecraft)],
    quiet_interval_count: nonNegativeInteger(explicit?.quiet_interval_count ?? explicit?.quiet_intervals),
    storm_events: {
      total: nonNegativeInteger(storms?.total ?? explicit?.storm_count)
        ?? (moderateStorms !== null || severeStorms !== null ? (moderateStorms ?? 0) + (severeStorms ?? 0) : null)
        ?? (eventDefinitions.length ? eventDefinitions.length : null),
      moderate: moderateStorms,
      severe: severeStorms,
    },
  };
}

function normalizeResearchStage(study: Record<string, unknown>): 'pilot' | 'multi_year_study' {
  const stage = study.research_stage ?? study.study_kind;
  if (stage === 'multi_year_study' || stage === 'multi_year') return 'multi_year_study';
  if (stage === 'pilot') return 'pilot';
  // The legacy artifact declares pilot_study_version explicitly. Unknown legacy
  // summaries fail conservatively to pilot and are never promoted to multi-year.
  return 'pilot';
}

function unavailableCalibration(reason: string): LeoUncertaintyCalibration {
  return {
    status: 'unavailable',
    method: null,
    calibration_start_utc: null,
    calibration_end_utc: null,
    sample_count: null,
    block_count: null,
    nominal_coverage: null,
    empirical_coverage: null,
    p10_coverage: null,
    p50_coverage: null,
    p90_coverage: null,
    reason,
  };
}

function normalizeUncertaintyCalibration(value: unknown): LeoUncertaintyCalibration {
  const record = asObject(value);
  if (!record) return unavailableCalibration('No held-out uncertainty calibration was published.');
  const calibration = asObject(record.calibration) ?? record;
  const metrics = asObject(record.metrics) ?? record;
  const interval = asObject(metrics.calibration_period) ?? asObject(calibration.calibration_period) ?? asObject(record.period);
  const status = record.status === 'calibrated' || record.status === 'uncalibrated'
    ? record.status
    : availability(record.status ?? metrics.status, boundedString(calibration.schema_version) ? 'available' : 'unavailable');
  return {
    status,
    method: boundedString(calibration.method ?? metrics.method),
    calibration_start_utc: validIso(calibration.calibration_start_utc ?? interval?.start_utc),
    calibration_end_utc: validIso(calibration.calibration_end_utc ?? calibration.calibration_stop_utc ?? interval?.end_utc ?? interval?.stop_utc),
    sample_count: nonNegativeInteger(metrics.sample_count ?? calibration.calibration_rows ?? interval?.rows),
    block_count: nonNegativeInteger(record.block_count ?? metrics.block_count),
    nominal_coverage: finite(metrics.nominal_coverage ?? metrics.central_interval_nominal_coverage),
    empirical_coverage: finite(metrics.empirical_coverage ?? metrics.central_interval_empirical_coverage),
    p10_coverage: finite(metrics.p10_coverage ?? metrics.observed_at_or_below_p10_fraction),
    p50_coverage: finite(metrics.p50_coverage ?? metrics.observed_at_or_below_p50_fraction),
    p90_coverage: finite(metrics.p90_coverage ?? metrics.observed_at_or_below_p90_fraction),
    reason: boundedString(record.reason, 1_000),
  };
}

function objectSize(value: unknown): number {
  return Object.keys(asObject(value) ?? {}).length;
}

function safeCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function normalizeLineage(value: Record<string, unknown>): LeoValidationLineage | null {
  const density = asObject(value.data_lineage);
  const drivers = asObject(value.driver_lineage);
  if (!density && !drivers) return null;
  return {
    density_evidence_class: density ? asString(density.evidence_class) : null,
    density_coverage_start_utc: density ? validIso(density.coverage_start_utc) : null,
    density_coverage_end_utc: density ? validIso(density.coverage_end_utc ?? density.coverage_stop_utc) : null,
    input_rows: density ? nonNegativeInteger(density.input_rows) : null,
    selected_rows: density ? nonNegativeInteger(density.selected_rows) : null,
    quality_rejected_rows: density ? nonNegativeInteger(density.quality_rejected_rows) : null,
    baseline_rejected_rows: density ? nonNegativeInteger(density.baseline_rejected_rows) : null,
    baseline_models: density ? asStringArray(density.baseline_models) : [],
    baseline_versions: density ? asStringArray(density.baseline_versions) : [],
    density_source_file_count: density ? safeCount(density.source_files) : 0,
    density_checksum_count: density ? objectSize(density.source_checksums_sha256) : 0,
    manifest_checksum_sha256: density ? asString(density.manifest_checksum_sha256) : null,
    driver_source: drivers ? asString(drivers.source) : null,
    driver_evidence_class: drivers ? asString(drivers.evidence_class) : null,
    driver_coverage_start_utc: drivers ? validIso(drivers.coverage_start_utc) : null,
    driver_coverage_end_utc: drivers ? validIso(drivers.coverage_end_utc ?? drivers.coverage_stop_utc) : null,
    driver_source_file_count: drivers ? safeCount(drivers.source_files) : 0,
    driver_checksum_count: drivers ? objectSize(drivers.checksums_sha256) : 0,
  };
}

function normalizeRegimeGroup(label: string, value: unknown, index: number): LeoValidationRegimeGroup | null {
  const group = asObject(value);
  if (!group) return null;
  const skill = asObject(group.skill_vs_m0);
  const numericMetrics = [
    group.mae_log10_rho,
    group.rmse_log10_rho,
    group.median_absolute_relative_error,
    group.bias_log10_rho,
    group.correlation_log10_rho,
    skill?.rmse_skill,
  ].some(item => finite(item) !== null);
  if (!numericMetrics) return null;
  return {
    id: `group-${index + 1}`,
    label,
    status: availability(group.status, 'available'),
    sample_count: nonNegativeInteger(group.sample_count),
    mae_log10_rho: finite(group.mae_log10_rho),
    rmse_log10_rho: finite(group.rmse_log10_rho),
    median_absolute_relative_error: finite(group.median_absolute_relative_error),
    bias_log10_rho: finite(group.bias_log10_rho),
    correlation_log10_rho: finite(group.correlation_log10_rho),
    rmse_skill_vs_m0: skill ? finite(skill.rmse_skill) : null,
  };
}

function normalizeRegimes(modeValue: unknown): LeoValidationRegimeDimension[] {
  const mode = asObject(modeValue);
  const diagnostics = mode ? asObject(mode.breakdowns) : null;
  const breakdowns = diagnostics ? asObject(diagnostics.breakdowns) ?? diagnostics : null;
  if (!breakdowns) return [];
  return REGIME_DIMENSIONS.flatMap(([id, label]) => {
    const rawGroups = asObject(id === 'geomagnetic_regime'
      ? breakdowns.geomagnetic_regime ?? breakdowns.storm_intensity
      : breakdowns[id]);
    if (!rawGroups) return [];
    const groups = Object.entries(rawGroups).slice(0, 50).map(([groupLabel, value], index) => normalizeRegimeGroup(groupLabel, value, index)).filter((group): group is LeoValidationRegimeGroup => group !== null);
    return groups.length ? [{ id, label, groups }] : [];
  });
}

function unavailableEventMode(mode: LeoStudyMode, reason: string): LeoValidationEventModeResult {
  return {
    mode,
    status: 'unavailable',
    sample_count: null,
    spacecraft_count: null,
    peak_density_absolute_relative_error: null,
    peak_timing_mae_min: null,
    onset_timing_mae_min: null,
    recovery_timing_mae_min: null,
    reason,
  };
}

function normalizeEventMode(mode: LeoStudyMode, modeValue: unknown, eventId: string): LeoValidationEventModeResult {
  const modeRecord = asObject(modeValue);
  const diagnostics = modeRecord ? asObject(modeRecord.breakdowns) : null;
  const holdout = diagnostics ? asObject(diagnostics.event_holdout) : null;
  const event = holdout ? asObject(holdout.event) : null;
  if (!holdout || !event || asString(event.event_id) !== eventId) {
    return unavailableEventMode(mode, 'No whole-event holdout result was published for this window.');
  }
  const metrics = asObject(holdout.event_metrics);
  if (!metrics) return unavailableEventMode(mode, 'The event holdout contains no normalized event metrics.');
  return {
    mode,
    status: availability(metrics.status, 'unavailable'),
    sample_count: nonNegativeInteger(holdout.test_rows),
    spacecraft_count: nonNegativeInteger(metrics.spacecraft_count),
    peak_density_absolute_relative_error: finite(metrics.peak_density_absolute_relative_error),
    peak_timing_mae_min: finite(metrics.peak_timing_mae_min),
    onset_timing_mae_min: finite(metrics.onset_timing_mae_min),
    recovery_timing_mae_min: finite(metrics.recovery_timing_mae_min),
    reason: asString(metrics.reason),
  };
}

function normalizeV2EventMode(event: Record<string, unknown>): LeoValidationEventModeResult {
  const metrics = asObject(event.metrics) ?? {};
  const onset = asObject(metrics.onset);
  const peakMagnitude = asObject(metrics.peak_magnitude);
  const peakTiming = asObject(metrics.peak_timing);
  const recovery = asObject(metrics.recovery);
  const components = [onset, peakMagnitude, peakTiming, recovery].filter((value): value is Record<string, unknown> => value !== null);
  const hasAvailableMetric = components.some(component => component.status === 'available' && finite(component.median) !== null);
  const reasons = [...new Set([
    boundedString(event.reason, 1_000),
    ...components.filter(component => component.status !== 'available').map(component => boundedString(component.reason, 1_000)),
  ].filter((reason): reason is string => reason !== null))];
  return {
    mode: 'heliosat_predicted_arrival',
    status: hasAvailableMetric ? 'available' : 'unavailable',
    sample_count: null,
    spacecraft_count: nonNegativeInteger(event.available_spacecraft_records ?? event.spacecraft_records)
      ?? Math.max(0, ...components.map(component => nonNegativeInteger(component.spacecraft_count) ?? 0)),
    peak_density_absolute_relative_error: peakMagnitude ? finite(peakMagnitude.median) : null,
    peak_timing_mae_min: peakTiming ? finite(peakTiming.median) : null,
    onset_timing_mae_min: onset ? finite(onset.median) : null,
    recovery_timing_mae_min: recovery ? finite(recovery.median) : null,
    reason: reasons.length ? reasons.join(' · ') : null,
  };
}

function normalizeV2Events(eventTiming: Record<string, unknown>): LeoValidationEventStudy[] {
  const perEvent = Array.isArray(eventTiming.per_event) ? eventTiming.per_event : [];
  const method = boundedString(eventTiming.method, 1_000);
  const threshold = finite(eventTiming.enhancement_threshold);
  const definition = [
    method,
    threshold === null ? null : `Density enhancement threshold: ${threshold}.`,
    'Aggregated event metrics for the primary HelioSat MRU plus ML arrival mode; no reference-aligned aggregate is implied.',
  ].filter((value): value is string => value !== null).join(' ');
  return perEvent.slice(0, 100).flatMap(value => {
    const event = asObject(value);
    const id = event ? asString(event.event_id) : null;
    const start = event ? validIso(event.event_start_utc ?? event.start_utc) : null;
    const end = event ? validIso(event.event_stop_utc ?? event.event_end_utc ?? event.stop_utc ?? event.end_utc) : null;
    if (!event || !id || !SAFE_RUN_ID.test(id) || !start || !end || Date.parse(start) >= Date.parse(end)) return [];
    return [{
      id,
      label: `${start.slice(0, 16).replace('T', ' ')} UTC · ${id}`,
      start_utc: start,
      end_utc: end,
      definition: definition || 'Retrospective MRU plus ML event aggregate recorded by the versioned study.',
      prediction_mode_label: 'HelioSat MRU plus ML arrival (v2 aggregate)',
      evidence_class: 'retrospective' as const,
      plot_artifact_id: null,
      mode_results: {
        reference_aligned: unavailableEventMode(
          'reference_aligned',
          'The v2 event_timing aggregate is published for the primary MRU plus ML mode; no reference-aligned per-event aggregate was published.',
        ),
        heliosat_predicted_arrival: normalizeV2EventMode(event),
      },
    }];
  });
}

function normalizeEvents(study: Record<string, unknown>, modes: Record<string, unknown>): LeoValidationEventStudy[] {
  const v2EventTiming = asObject(study.event_timing);
  if (v2EventTiming && Array.isArray(v2EventTiming.per_event)) {
    return normalizeV2Events(v2EventTiming);
  }
  const definitions = Array.isArray(study.event_definitions) ? study.event_definitions : [];
  const sharedDefinition = STUDY_MODES.map(mode => {
    const modeRecord = asObject(modes[mode]);
    const diagnostics = modeRecord ? asObject(modeRecord.breakdowns) : null;
    const holdout = diagnostics ? asObject(diagnostics.event_holdout) : null;
    return holdout ? asString(holdout.event_definition) : null;
  }).find((value): value is string => value !== null) ?? 'Retrospective event window recorded by the versioned study.';

  return definitions.slice(0, 50).flatMap(value => {
    const event = asObject(value);
    const id = event ? asString(event.event_id) : null;
    const start = event ? validIso(event.start_utc) : null;
    const end = event ? validIso(event.stop_utc) : null;
    if (!id || !SAFE_RUN_ID.test(id) || !start || !end || Date.parse(start) >= Date.parse(end)) return [];
    return [{
      id,
      label: `${start.slice(0, 16).replace('T', ' ')} UTC · ${id}`,
      start_utc: start,
      end_utc: end,
      definition: sharedDefinition,
      prediction_mode_label: 'HelioSat predicted arrival',
      evidence_class: 'retrospective' as const,
      plot_artifact_id: null,
      mode_results: {
        reference_aligned: normalizeEventMode('reference_aligned', modes.reference_aligned, id),
        heliosat_predicted_arrival: normalizeEventMode('heliosat_predicted_arrival', modes.heliosat_predicted_arrival, id),
      },
    }];
  });
}

interface ScientificArtifactDescriptor {
  metadata: LeoValidationScientificArtifact;
  fileName: string;
}

function artifactId(runId: string, fileName: string): string {
  return createHash('sha256').update(`leo-validation-plot-v1\0${runId}\0${fileName}`).digest('hex').slice(0, 24);
}

function modeLabel(mode: LeoStudyMode): string {
  return mode === 'reference_aligned' ? 'reference-aligned' : 'HelioSat predicted-arrival';
}

function modeFromFile(fileName: string): LeoStudyMode | null {
  if (fileName.includes('reference_aligned')) return 'reference_aligned';
  if (fileName.includes('heliosat_predicted_arrival')) return 'heliosat_predicted_arrival';
  return null;
}

function arrivalModeFromFile(fileName: string): LeoArrivalMode | null {
  if (fileName.includes('omni_reference_aligned')) return 'omni_reference_aligned';
  if (fileName.includes('mru_ml')) return 'mru_ml';
  if (/(^|[-_])mru([-_.]|$)/.test(fileName)) return 'mru';
  return null;
}

function describePlot(fileName: string): Omit<LeoValidationScientificArtifact, 'id' | 'kind' | 'media_type' | 'evidence_class' | 'arrival_mode' | 'interpretation_details' | 'url'> | null {
  const mode = modeFromFile(fileName);
  const label = mode ? modeLabel(mode) : null;
  if (fileName === 'observed-versus-baseline.png') return {
    category: 'overview', title: 'Observed density versus physical baseline', mode: null, event_id: null,
    interpretation: 'Retrospective comparison of official density observations and the NRLMSIS baseline. Departures are diagnostics, not forecast skill.',
  };
  if (fileName === 'reference-versus-end-to-end.png') return {
    category: 'performance', title: 'Reference aligned versus end to end', mode: null, event_id: null,
    interpretation: 'Matched held-out performance comparison. It isolates the penalty associated with HelioSat arrival-time alignment for the saved study population.',
  };
  if (mode && fileName === `corrected-density-timeseries-${mode}.png`) return {
    category: 'performance', title: `Held-out density time series · ${label}`, mode, event_id: null,
    interpretation: 'Chronological held-out observations, physical baseline and M3 residual-corrected density. The two timeline modes remain scientifically separate.',
  };
  if (mode && fileName === `scatter-residual-${mode}.png`) return {
    category: 'performance', title: `Prediction scatter and residuals · ${label}`, mode, event_id: null,
    interpretation: 'Held-out predicted-versus-observed density and residual distribution. Visual concentration is not a substitute for the reported block-bootstrap metrics.',
  };
  if (mode && fileName === `error-by-orbital-context-${mode}.png`) return {
    category: 'regime', title: `Error by orbital context · ${label}`, mode, event_id: null,
    interpretation: 'Held-out density error grouped by altitude, latitude and local solar time to expose context-dependent behavior and potential domain limits.',
  };
  if (mode && fileName === `error-by-mission-regime-${mode}.png`) return {
    category: 'regime', title: `Error by mission and saved regime · ${label}`, mode, event_id: null,
    interpretation: 'Held-out error split by observing mission and the saved retrospective regime. Unequal staged coverage limits generalization.',
  };
  if (mode && fileName === `coupling-response-${mode}.png`) return {
    category: 'interpretation', title: `Coupling response · ${label}`, mode, event_id: null,
    interpretation: 'Binned observed and predicted residual response to upstream coupling. This retrospective association does not establish causality.',
  };
  if (mode && fileName === `coupling-lag-${mode}.png`) return {
    category: 'lag_response', title: `Coupling-to-density lag scan · ${label}`, mode, event_id: null,
    interpretation: 'Retrospective lag-correlation scan. A correlation peak is a diagnostic and must not be interpreted as a calibrated operational response time.',
  };
  const lagResponse = /^lag-response-(fixed|distributed|latitude|local_solar_time|altitude|storm_intensity)-(omni_reference_aligned|mru|mru_ml)\.png$/.exec(fileName)
    ?? /^distributed-lag-(omni_reference_aligned|mru|mru_ml)\.png$/.exec(fileName);
  if (lagResponse) return {
    category: 'lag_response',
    title: `Causal lag-response experiment · ${arrivalModeFromFile(fileName)?.replaceAll('_', ' ') ?? 'recorded arrival mode'}`,
    mode: null,
    event_id: null,
    interpretation: 'Held-out fixed or distributed lag response over the declared causal grid. Interpret only with its saved split, regime and uncertainty metadata.',
  };
  if (/^feature-group-ablation-(omni_reference_aligned|mru|mru_ml)\.png$/.test(fileName)) return {
    category: 'interpretation', title: 'Matched feature-group ablation · MRU plus ML', mode: null, event_id: null,
    interpretation: 'Predeclared feature-group ablation on matched held-out rows. It measures predictive sensitivity to a group, not causal importance of individual variables.',
  };
  if (/^uncertainty-calibration-(omni_reference_aligned|mru|mru_ml)\.png$/.test(fileName)) return {
    category: 'performance', title: 'Held-out uncertainty calibration · MRU plus ML', mode: null, event_id: null,
    interpretation: 'Nominal quantiles calibrated on the reserved calibration year and evaluated on the separate test year. This is retrospective coverage, not an operational guarantee.',
  };
  if (mode && fileName === `feature-importance-${mode}.png`) return {
    category: 'interpretation', title: `Permutation feature importance · ${label}`, mode, event_id: null,
    interpretation: 'Single-repeat permutation importance on a held-out subset, as recorded by the saved study sidecar. Rankings are diagnostic rather than causal.',
  };
  const eventMatch = /^event-([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\.png$/.exec(fileName);
  if (eventMatch) return {
    category: 'event', title: `Retrospective event · ${eventMatch[1]}`, mode: null, event_id: eventMatch[1],
    interpretation: 'Official observed density response, physical baseline and the explicitly labeled saved retrospective correction within the held-out event window. This is not operational forecast performance.',
  };
  return null;
}

function declaredArtifacts(study: Record<string, unknown>): string[] {
  const modes = asObject(study.modes) ?? {};
  return [...new Set([
    ...asStringArray(study.artifacts),
    ...STUDY_MODES.flatMap(mode => asStringArray(asObject(modes[mode])?.artifacts)),
  ].map(item => item.replaceAll('\\', '/')))];
}

function declaredPlotFiles(study: Record<string, unknown>): string[] {
  return declaredArtifacts(study).flatMap(item => {
    const normalized = item.replaceAll('\\', '/');
    const parts = normalized.split('/');
    if (parts.length !== 2 || parts[0] !== 'plots' || !SAFE_PLOT_FILE.test(parts[1])) return [];
    return [parts[1]];
  }).sort();
}

function normalizeInterpretationDetails(value: unknown): LeoValidationScientificArtifact['interpretation_details'] {
  const root = asObject(value);
  if (!root) return null;
  const records = Array.isArray(root.records) ? root.records : [];
  const topFeatures = records.slice(0, 12).flatMap(value => {
    const record = asObject(value);
    const feature = record ? asString(record.feature) : null;
    const increase = record ? finite(record.mae_increase) : null;
    if (!feature || feature.length > 200 || increase === null) return [];
    return [{ feature, mae_increase: increase }];
  });
  if (!topFeatures.length) return null;
  return {
    method: asString(root.method),
    random_seed: finite(root.random_seed),
    top_features: topFeatures,
  };
}

export function normalizeLeoScientificArtifacts(value: unknown, runId: string): ScientificArtifactDescriptor[] {
  const study = asObject(value);
  if (!study || !SAFE_RUN_ID.test(runId)) return [];
  return declaredPlotFiles(study).flatMap(fileName => {
    const description = describePlot(fileName);
    if (!description) return [];
    const id = artifactId(runId, fileName);
    return [{
      fileName,
      metadata: {
        id,
        kind: 'plot',
        media_type: 'image/png',
        evidence_class: 'retrospective',
        arrival_mode: arrivalModeFromFile(fileName),
        interpretation_details: null,
        url: `${ARTIFACT_ROUTE}?id=${id}`,
        ...description,
      },
    }];
  });
}

function normalizeMetric(value: unknown): LeoValidationMetric | null {
  const metric = asObject(value);
  if (!metric) return null;
  const key = asString(metric.key);
  const numericValue = finite(metric.value);
  if (!key || numericValue === null) return null;

  const interval = asObject(metric.confidence_interval);
  const intervalProvenance = interval ? asObject(interval.provenance) : null;
  const low = interval ? finite(interval.low) : null;
  const high = interval ? finite(interval.high) : null;
  const levelRaw = interval ? finite(interval.level_pct ?? interval.confidence_level) : null;
  const level = levelRaw !== null && levelRaw > 0 && levelRaw <= 1 ? levelRaw * 100 : levelRaw;
  return {
    key,
    label: asString(metric.label) ?? key,
    value: numericValue,
    unit: asString(metric.unit),
    model_id: asString(metric.model_id),
    sample_count: finite(metric.sample_count),
    confidence_interval: low !== null && high !== null && level !== null
      ? {
          low,
          high,
          level_pct: level,
          method: boundedString(interval?.method ?? intervalProvenance?.method),
          block_count: nonNegativeInteger(interval?.block_count ?? intervalProvenance?.block_count),
          resamples: nonNegativeInteger(interval?.resamples ?? interval?.n_resamples ?? intervalProvenance?.resamples),
          random_seed: finite(interval?.random_seed ?? intervalProvenance?.random_seed),
        }
      : null,
  };
}

function normalizeMetrics(value: unknown): LeoValidationMetric[] {
  if (Array.isArray(value)) return value.map(normalizeMetric).filter((metric): metric is LeoValidationMetric => metric !== null);
  const record = asObject(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, raw]) => {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return [{
        key,
        label: key,
        value: raw,
        unit: null,
        model_id: null,
        sample_count: null,
        confidence_interval: null,
      } satisfies LeoValidationMetric];
    }
    const normalized = normalizeMetric({ key, ...asObject(raw) });
    return normalized ? [normalized] : [];
  });
}

function normalizeModel(value: unknown): LeoValidationModel | null {
  const model = asObject(value);
  if (!model) return null;
  const id = asString(model.id);
  if (!id) return null;
  const rawRole = model.role ?? model.model_role;
  const role = rawRole === 'deployable_candidate' || rawRole === 'retrospective_diagnostic' ? rawRole : 'unspecified';
  const rawCausality = model.causality ?? model.causality_status;
  const causality = rawCausality === 'issuance_safe' || rawCausality === 'retrospective_only' ? rawCausality : 'unverified';
  return {
    id,
    label: asString(model.label) ?? id,
    status: availability(model.status, normalizeMetrics(model.metrics).length ? 'available' : 'unavailable'),
    feature_group: asString(model.feature_group),
    role,
    uses_mission_identity: optionalBoolean(model.uses_mission_identity ?? model.uses_identity_features),
    causality,
    metrics: normalizeMetrics(model.metrics),
  };
}

function unavailableMode(mode: LeoStudyMode): LeoValidationModeResult {
  return {
    mode,
    label: mode === 'reference_aligned' ? 'Reference aligned response study' : 'HelioSat predicted arrival study',
    evidence_class: 'retrospective',
    status: 'unavailable',
    split: null,
    models: [],
    metrics: [],
    warnings: [`No ${mode} result is present in the selected study artifact.`],
  };
}

function normalizeMode(mode: LeoStudyMode, value: unknown): LeoValidationModeResult {
  const record = asObject(value);
  if (!record) return unavailableMode(mode);
  const models = Array.isArray(record.models)
    ? record.models.map(normalizeModel).filter((model): model is LeoValidationModel => model !== null)
    : [];
  const metrics = normalizeMetrics(record.metrics);
  return {
    mode,
    label: asString(record.label) ?? (mode === 'reference_aligned' ? 'Reference aligned response study' : 'HelioSat predicted arrival study'),
    evidence_class: 'retrospective',
    status: availability(record.status, models.length || metrics.length ? 'available' : 'unavailable'),
    split: asObject(record.split),
    models,
    metrics,
    warnings: asStringArray(record.warnings),
  };
}

function unavailableArrivalMode(mode: LeoArrivalMode, reason: string): LeoArrivalModeResult {
  const labels: Record<LeoArrivalMode, string> = {
    omni_reference_aligned: 'OMNI reference-aligned arrival',
    mru: 'HelioSat MRU arrival',
    mru_ml: 'HelioSat MRU plus ML arrival',
  };
  return {
    mode,
    label: labels[mode],
    evidence_class: 'retrospective',
    status: 'unavailable',
    models: [],
    metrics: [],
    warnings: [reason],
  };
}

function normalizeArrivalModeResult(mode: LeoArrivalMode, value: unknown): LeoArrivalModeResult {
  const record = asObject(value);
  if (!record) return unavailableArrivalMode(mode, `No ${mode} result was published.`);
  const models = Array.isArray(record.models)
    ? record.models.map(normalizeModel).filter((model): model is LeoValidationModel => model !== null)
    : [];
  const directMetrics = normalizeMetrics(record.metrics);
  const metrics = [
    ...directMetrics,
    ...normalizeDensityMetrics(record.metrics).filter(candidate => !directMetrics.some(metric => metric.key === candidate.key)),
  ];
  return {
    mode,
    label: boundedString(record.label) ?? unavailableArrivalMode(mode, '').label,
    evidence_class: 'retrospective',
    status: availability(record.status, models.length || metrics.length ? 'available' : 'unavailable'),
    models,
    metrics,
    warnings: asStringArray(record.warnings),
  };
}

function legacyArrivalModes(
  study: Record<string, unknown>,
  legacyModes: Record<LeoStudyMode, LeoValidationModeResult>,
): Record<LeoArrivalMode, LeoArrivalModeResult> {
  const predictedWarnings = legacyModes.heliosat_predicted_arrival.warnings.join(' ').toLowerCase();
  const arrivalArtifact = asObject(study.arrival_artifact);
  const explicitMruFallback = predictedWarnings.includes('mru fallback')
    || predictedWarnings.includes('mru-only')
    || arrivalArtifact?.effective_mode === 'mru';
  const reference: LeoArrivalModeResult = {
    ...legacyModes.reference_aligned,
    mode: 'omni_reference_aligned',
    label: 'OMNI reference-aligned arrival',
  };
  const mru: LeoArrivalModeResult = explicitMruFallback
    ? {
        ...legacyModes.heliosat_predicted_arrival,
        mode: 'mru',
        label: 'HelioSat MRU arrival',
      }
    : unavailableArrivalMode('mru', 'The legacy end-to-end result does not prove that MRU-only timing was used.');
  return {
    omni_reference_aligned: reference,
    mru,
    mru_ml: unavailableArrivalMode('mru_ml', 'No compatible MRU plus ML arrival result was published by this pilot.'),
  };
}

function normalizeArrivalModes(
  study: Record<string, unknown>,
  legacyModes: Record<LeoStudyMode, LeoValidationModeResult>,
): Record<LeoArrivalMode, LeoArrivalModeResult> {
  const legacy = legacyArrivalModes(study, legacyModes);
  const raw = asObject(study.arrival_modes) ?? asObject(asObject(study.arrival_mode_comparison)?.modes);
  if (!raw) return legacy;
  return {
    omni_reference_aligned: raw.omni_reference_aligned || raw.reference_aligned
      ? normalizeArrivalModeResult('omni_reference_aligned', raw.omni_reference_aligned ?? raw.reference_aligned)
      : legacy.omni_reference_aligned,
    mru: raw.mru || raw.mru_arrival
      ? normalizeArrivalModeResult('mru', raw.mru ?? raw.mru_arrival)
      : legacy.mru,
    mru_ml: raw.mru_ml || raw.mru_plus_ml || raw.mru_ml_arrival
      ? normalizeArrivalModeResult('mru_ml', raw.mru_ml ?? raw.mru_plus_ml ?? raw.mru_ml_arrival)
      : legacy.mru_ml,
  };
}

function normalizeComparability(study: Record<string, unknown>): LeoArrivalComparability {
  const record = asObject(study.arrival_comparability)
    ?? asObject(asObject(study.arrival_mode_comparison)?.comparability)
    ?? asObject(study.comparison_integrity);
  const rowFingerprint = boundedString(record?.matched_row_fingerprint ?? record?.row_fingerprint, 512);
  const splitFingerprint = boundedString(record?.split_fingerprint, 512);
  const hyperparameterFingerprint = boundedString(record?.hyperparameter_fingerprint, 512);
  const declaredStatus = record?.status === 'identical' || record?.status === 'mismatch' ? record.status : 'unverified';
  const status = declaredStatus === 'identical' && (!rowFingerprint || !splitFingerprint || !hyperparameterFingerprint)
    ? 'unverified'
    : declaredStatus;
  const reasons = asStringArray(record?.reasons);
  if (declaredStatus === 'identical' && status === 'unverified') {
    reasons.push('The artifact declared identical comparison inputs without all required fingerprints.');
  }
  if (!record) reasons.push('Matched-row, split and hyperparameter fingerprints were not published.');
  return {
    status,
    matched_row_fingerprint: rowFingerprint,
    split_fingerprint: splitFingerprint,
    hyperparameter_fingerprint: hyperparameterFingerprint,
    random_seed: finite(record?.random_seed),
    reasons,
  };
}

const DENSITY_METRIC_LABELS: Readonly<Record<string, readonly [string, string | null]>> = {
  mae_log10_rho: ['MAE log10 density', 'dex'],
  rmse_log10_rho: ['RMSE log10 density', 'dex'],
  median_absolute_relative_error: ['Median absolute relative error', 'fraction'],
  median_density_ratio: ['Median predicted/observed density ratio', 'ratio'],
  bias_log10_rho: ['Bias log10 density', 'dex'],
  correlation_log10_rho: ['Correlation log10 density', null],
};

function normalizeDensityMetrics(value: unknown, modelId = 'M3'): LeoValidationMetric[] {
  const direct = normalizeMetrics(value);
  const record = asObject(value);
  if (!record || Array.isArray(value)) return direct;
  const normalized = new Map(
    direct
      .filter(metric => metric.key in DENSITY_METRIC_LABELS || metric.key === 'rmse_skill_vs_m0')
      .map(metric => [metric.key, metric]),
  );
  for (const [key, [label, unit]] of Object.entries(DENSITY_METRIC_LABELS)) {
    const numeric = finite(record[key]);
    if (numeric !== null && !normalized.has(key)) {
      normalized.set(key, {
        key,
        label,
        value: numeric,
        unit,
        model_id: modelId,
        sample_count: nonNegativeInteger(record.sample_count),
        confidence_interval: null,
      });
    }
  }
  const skill = asObject(record.skill_vs_m0);
  const rmseSkill = skill ? finite(skill.rmse_skill) : null;
  if (rmseSkill !== null && !normalized.has('rmse_skill_vs_m0')) {
    normalized.set('rmse_skill_vs_m0', {
      key: 'rmse_skill_vs_m0',
      label: 'RMSE skill versus M0',
      value: rmseSkill,
      unit: 'fraction',
      model_id: modelId,
      sample_count: nonNegativeInteger(record.sample_count),
      confidence_interval: null,
    });
  }
  return [...normalized.values()];
}

function normalizeTransferExperiment(value: unknown, index: number): LeoTransferExperiment | null {
  const record = asObject(value);
  if (!record) return null;
  const heldOut = asObject(record.held_out);
  const kind = record.kind === 'leave_one_spacecraft_out' || record.kind === 'loso'
    ? 'leave_one_spacecraft_out'
    : record.kind === 'cross_mission'
      ? 'cross_mission'
      : null;
  const mode = arrivalMode(record.arrival_mode ?? record.mode);
  if (!kind || !mode) return null;
  const id = boundedString(record.id, 128) ?? `${kind}-${mode}-${index + 1}`;
  const role = record.role === 'deployable_candidate' || record.role === 'retrospective_diagnostic'
    ? record.role
    : 'unspecified';
  return {
    id,
    kind,
    label: boundedString(record.label) ?? (kind === 'cross_mission' ? 'Cross-mission holdout' : 'Leave-one-spacecraft-out'),
    arrival_mode: mode,
    status: availability(record.status),
    role,
    held_out_mission: boundedString(record.held_out_mission ?? heldOut?.mission),
    held_out_spacecraft_id: boundedString(record.held_out_spacecraft_id ?? heldOut?.spacecraft_id),
    train_missions: asStringArray(record.train_missions ?? asObject(record.train)?.missions),
    train_spacecraft_ids: asStringArray(record.train_spacecraft_ids ?? asObject(record.train)?.spacecraft_ids),
    test_rows: nonNegativeInteger(record.test_rows),
    metrics: normalizeDensityMetrics(record.metrics),
    reason: boundedString(record.reason, 1_000),
  };
}

function legacyCrossMissionTransfers(
  rawModes: Record<string, unknown>,
  arrivalModes: Record<LeoArrivalMode, LeoArrivalModeResult>,
): LeoTransferExperiment[] {
  const output: LeoTransferExperiment[] = [];
  const mappings: Array<readonly [LeoStudyMode, LeoArrivalMode]> = [
    ['reference_aligned', 'omni_reference_aligned'],
    ['heliosat_predicted_arrival', 'mru'],
  ];
  for (const [legacyMode, mode] of mappings) {
    if (arrivalModes[mode].status === 'unavailable') continue;
    const legacy = asObject(rawModes[legacyMode]);
    const breakdowns = legacy ? asObject(legacy.breakdowns) : null;
    const transfer = breakdowns ? asObject(breakdowns.cross_mission_transfer) : null;
    const results = transfer ? asObject(transfer.results) : null;
    if (!results) continue;
    for (const [heldOutMission, rawResult] of Object.entries(results)) {
      const result = asObject(rawResult);
      if (!result) continue;
      output.push({
        id: `legacy-cross-mission-${mode}-${heldOutMission.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
        kind: 'cross_mission',
        label: `Hold out ${heldOutMission}`,
        arrival_mode: mode,
        status: availability(result.status),
        role: 'retrospective_diagnostic',
        held_out_mission: heldOutMission,
        held_out_spacecraft_id: null,
        train_missions: asStringArray(result.train_missions),
        train_spacecraft_ids: [],
        test_rows: nonNegativeInteger(result.test_rows),
        metrics: normalizeDensityMetrics(result.metrics),
        reason: boundedString(result.reason, 1_000),
      });
    }
  }
  return output;
}

function normalizeTransferExperiments(
  study: Record<string, unknown>,
  rawModes: Record<string, unknown>,
  arrivalModes: Record<LeoArrivalMode, LeoArrivalModeResult>,
): LeoTransferExperiment[] {
  const generalization = asObject(study.generalization);
  const raw = Array.isArray(study.transfer_experiments)
    ? study.transfer_experiments
    : Array.isArray(generalization?.experiments)
      ? generalization.experiments
      : [];
  const normalized = raw.map(normalizeTransferExperiment).filter((item): item is LeoTransferExperiment => item !== null);
  return normalized.length ? normalized : legacyCrossMissionTransfers(rawModes, arrivalModes);
}

function normalizeLagExperiment(value: unknown, index: number): LeoLagExperiment | null {
  const record = asObject(value);
  if (!record) return null;
  const kind = record.kind === 'fixed_lag' || record.kind === 'distributed_lag' || record.kind === 'stratified_lag'
    ? record.kind
    : null;
  if (!kind) return null;
  const stratification = record.stratification === 'latitude'
    || record.stratification === 'local_solar_time'
    || record.stratification === 'altitude'
    || record.stratification === 'storm_intensity'
    ? record.stratification
    : null;
  const rawMetric = record.metric;
  return {
    id: boundedString(record.id, 128) ?? `lag-${kind}-${index + 1}`,
    label: boundedString(record.label) ?? kind.replaceAll('_', ' '),
    arrival_mode: arrivalMode(record.arrival_mode ?? record.mode),
    kind,
    status: availability(record.status),
    lag_min_hours: finite(record.lag_min_hours),
    lag_max_hours: finite(record.lag_max_hours),
    lag_step_minutes: finite(record.lag_step_minutes),
    stratification,
    best_lag_hours: finite(record.best_lag_hours),
    metric: normalizeMetric(rawMetric),
    plot_artifact_id: /^[a-f0-9]{24}$/.test(asString(record.plot_artifact_id) ?? '') ? asString(record.plot_artifact_id) : null,
    reason: boundedString(record.reason, 1_000),
  };
}

function normalizeLagExperiments(study: Record<string, unknown>): LeoLagExperiment[] {
  const lagStudy = asObject(study.lag_study) ?? asObject(study.lag_experiments);
  const raw = Array.isArray(study.lag_experiments)
    ? study.lag_experiments
    : Array.isArray(lagStudy?.experiments)
      ? lagStudy.experiments
      : [];
  return raw.map(normalizeLagExperiment).filter((item): item is LeoLagExperiment => item !== null);
}

export function normalizeLeoValidationStudy(value: unknown): LeoValidationStudy | null {
  const study = asObject(value);
  if (!study) return null;
  const runId = asString(study.run_id);
  const generatedAt = asString(study.generated_at_utc);
  const modes = asObject(study.modes) ?? {};
  const v2ArrivalModes = asObject(study.arrival_modes) ?? asObject(asObject(study.arrival_mode_comparison)?.modes);
  if (!runId || !generatedAt || (!Object.keys(modes).length && !v2ArrivalModes) || !Number.isFinite(Date.parse(generatedAt))) return null;

  const legacyModeInputs: Record<string, unknown> = {
    reference_aligned: modes.reference_aligned,
    heliosat_predicted_arrival: modes.heliosat_predicted_arrival ?? modes.heliosat_mru_ml_arrival,
  };
  const reference = normalizeMode('reference_aligned', legacyModeInputs.reference_aligned);
  const predicted = normalizeMode('heliosat_predicted_arrival', legacyModeInputs.heliosat_predicted_arrival);
  const legacyModes = {
    reference_aligned: reference,
    heliosat_predicted_arrival: predicted,
  };
  const arrivalModes = normalizeArrivalModes(study, legacyModes);
  const arrivalStatuses = ARRIVAL_MODES.map(mode => arrivalModes[mode].status);
  const fallbackStatus: LeoAvailabilityStatus = arrivalStatuses.every(modeStatus => modeStatus === 'available')
    ? 'available'
    : arrivalStatuses.every(modeStatus => modeStatus === 'error')
      ? 'error'
      : arrivalStatuses.every(modeStatus => modeStatus === 'unavailable')
        ? 'unavailable'
        : 'partial';
  const declaredStatus = availability(study.status, fallbackStatus);
  const status = declaredStatus === 'available' && fallbackStatus !== 'available' ? fallbackStatus : declaredStatus;

  return {
    run_id: runId,
    study_version: asString(study.study_version),
    generated_at_utc: generatedAt,
    dataset_version: asString(study.dataset_version),
    feature_schema_version: asString(study.feature_schema_version),
    research_stage: normalizeResearchStage(study),
    status,
    missions: asStringArray(study.missions),
    coverage_summary: normalizeCoverageSummary(study),
    split: asObject(study.split),
    modes: legacyModes,
    arrival_modes: arrivalModes,
    arrival_comparability: normalizeComparability(study),
    transfer_experiments: normalizeTransferExperiments(study, legacyModeInputs, arrivalModes),
    lag_experiments: normalizeLagExperiments(study),
    uncertainty_calibration: normalizeUncertaintyCalibration(
      study.uncertainty_calibration ?? asObject(study.uncertainty)?.calibration,
    ),
    scientific_artifacts: normalizeLeoScientificArtifacts(study, runId).map(artifact => artifact.metadata),
    events: normalizeEvents(study, legacyModeInputs),
    regimes: {
      reference_aligned: normalizeRegimes(legacyModeInputs.reference_aligned),
      heliosat_predicted_arrival: normalizeRegimes(legacyModeInputs.heliosat_predicted_arrival),
    },
    lineage: normalizeLineage(study),
    limitations: asStringArray(study.limitations),
    warnings: asStringArray(study.warnings),
  };
}

function configuredModelRoot(): string {
  const configured = process.env.HELIOSAT_LEO_MODEL_ROOT?.trim();
  return configured ? path.resolve(process.cwd(), configured) : path.join(process.cwd(), 'data', 'model-runs', 'leo-density');
}

interface Candidate {
  file: string;
  modifiedMs: number;
}

interface StoredScientificArtifact extends ScientificArtifactDescriptor {
  absoluteFile: string;
}

interface StudyBundle {
  study: LeoValidationStudy;
  artifacts: StoredScientificArtifact[];
}

async function findStudyCandidates(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const add = async (file: string) => {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) candidates.push({ file, modifiedMs: stat.mtimeMs });
    } catch {
      // A run can be written atomically while inventory is being read; skip a vanished candidate.
    }
  };

  await Promise.all(LEO_STUDY_SUMMARY_FILES.map(file => add(path.join(root, file))));
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isDirectory())
      .flatMap(entry => LEO_STUDY_SUMMARY_FILES.map(file => add(path.join(root, entry.name, file)))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return candidates.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function isContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function runDirectoryFor(root: string, runId: string): Promise<string | null> {
  if (!SAFE_RUN_ID.test(runId)) return null;
  const rootReal = await fs.realpath(root);
  const runDirectory = path.resolve(rootReal, runId);
  if (!isContainedBy(rootReal, runDirectory)) return null;
  try {
    const runReal = await fs.realpath(runDirectory);
    const stat = await fs.stat(runReal);
    return stat.isDirectory() && isContainedBy(rootReal, runReal) ? runReal : null;
  } catch {
    return null;
  }
}

async function availableScientificArtifacts(rawStudy: unknown, study: LeoValidationStudy, runDirectory: string | null): Promise<StoredScientificArtifact[]> {
  if (!runDirectory) return [];
  const descriptors = normalizeLeoScientificArtifacts(rawStudy, study.run_id);
  const rawRecord = asObject(rawStudy);
  const declared = new Set(rawRecord ? declaredArtifacts(rawRecord) : []);
  const output: StoredScientificArtifact[] = [];
  for (const descriptor of descriptors) {
    const expected = path.resolve(runDirectory, 'plots', descriptor.fileName);
    if (!isContainedBy(runDirectory, expected)) continue;
    try {
      const real = await fs.realpath(expected);
      const stat = await fs.stat(real);
      if (!isContainedBy(runDirectory, real) || !stat.isFile() || stat.size <= 8 || stat.size > 25 * 1_024 * 1_024) continue;
      let metadata = descriptor.metadata;
      if (descriptor.fileName.startsWith('feature-importance-')) {
        const sidecarName = descriptor.fileName.replace(/\.png$/, '.json');
        if (declared.has(`plots/${sidecarName}`)) {
          const sidecarExpected = path.resolve(runDirectory, 'plots', sidecarName);
          try {
            const sidecarReal = await fs.realpath(sidecarExpected);
            const sidecarStat = await fs.stat(sidecarReal);
            if (isContainedBy(runDirectory, sidecarReal) && sidecarStat.isFile() && sidecarStat.size > 2 && sidecarStat.size <= 2 * 1_024 * 1_024) {
              const details = normalizeInterpretationDetails(JSON.parse(await fs.readFile(sidecarReal, 'utf8')) as unknown);
              if (details) metadata = { ...metadata, interpretation_details: details };
            }
          } catch {
            // Sidecars are optional interpretations; the verified PNG remains available.
          }
        }
      }
      output.push({ ...descriptor, metadata, absoluteFile: real });
    } catch {
      // A declared plot may not have been produced by an incomplete run; omit it explicitly.
    }
  }
  return output;
}

async function loadLatestStudyBundle(root: string, candidates: Candidate[], warnings: string[]): Promise<StudyBundle | null> {
  const valid: Array<{ candidate: Candidate; rawStudy: unknown; study: LeoValidationStudy }> = [];
  for (const candidate of candidates) {
    try {
      const rawText = await fs.readFile(candidate.file, 'utf8');
      const rawStudy = JSON.parse(rawText) as unknown;
      const study = normalizeLeoValidationStudy(rawStudy);
      if (!study) {
        warnings.push(`${path.basename(path.dirname(candidate.file))}/${path.basename(candidate.file)} does not match the LEO study summary contract.`);
        continue;
      }
      valid.push({ candidate, rawStudy, study });
    } catch (error) {
      warnings.push(error instanceof SyntaxError
        ? `${path.basename(path.dirname(candidate.file))}/${path.basename(candidate.file)} is not valid JSON.`
        : `${path.basename(path.dirname(candidate.file))}/${path.basename(candidate.file)} could not be read.`);
    }
  }
  valid.sort((a, b) => {
    const stage = Number(b.study.research_stage === 'multi_year_study')
      - Number(a.study.research_stage === 'multi_year_study');
    if (stage) return stage;
    const generated = Date.parse(b.study.generated_at_utc) - Date.parse(a.study.generated_at_utc);
    return generated || b.candidate.modifiedMs - a.candidate.modifiedMs;
  });
  const selected = valid[0];
  if (!selected) return null;
  const runDirectory = await runDirectoryFor(root, selected.study.run_id);
  const declaredCount = normalizeLeoScientificArtifacts(
    selected.rawStudy, selected.study.run_id,
  ).length;
  const artifacts = await availableScientificArtifacts(
    selected.rawStudy, selected.study, runDirectory,
  );
  if (declaredCount > artifacts.length) warnings.push(`${declaredCount - artifacts.length} declared scientific plot${declaredCount - artifacts.length === 1 ? '' : 's'} could not be verified and were not exposed.`);
  selected.study.scientific_artifacts = artifacts.map(artifact => artifact.metadata);
  selected.study.events = selected.study.events.map(event => ({
    ...event,
    plot_artifact_id: artifacts.find(artifact => artifact.metadata.event_id === event.id)?.metadata.id ?? null,
  }));
  return { study: selected.study, artifacts };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function readLeoValidationArtifact(id: string): Promise<{ body: ArrayBuffer; mediaType: 'image/png' } | null> {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  const root = configuredModelRoot();
  let candidates: Candidate[];
  try {
    candidates = await findStudyCandidates(root);
  } catch {
    return null;
  }
  const bundle = await loadLatestStudyBundle(root, candidates, []);
  const artifact = bundle?.artifacts.find(candidate => candidate.metadata.id === id);
  if (!artifact) return null;
  try {
    const body = await fs.readFile(artifact.absoluteFile);
    if (body.length <= PNG_SIGNATURE.length || !body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    return {
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      mediaType: 'image/png',
    };
  } catch {
    return null;
  }
}

export async function buildLeoValidationResponse(): Promise<LeoValidationResponse> {
  const generatedAtUtc = new Date().toISOString();
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = configuredModelRoot();

  let candidates: Candidate[];
  try {
    candidates = await findStudyCandidates(root);
  } catch {
    return {
      schema_version: LEO_CONTRACT_VERSION,
      generated_at_utc: generatedAtUtc,
      status: 'error',
      artifact_root: 'data/model-runs/leo-density',
      study: null,
      warnings: [],
      errors: ['The local LEO density model artifact directory could not be read.'],
    };
  }

  const bundle = await loadLatestStudyBundle(root, candidates, warnings);
  if (bundle) return {
    schema_version: LEO_CONTRACT_VERSION,
    generated_at_utc: generatedAtUtc,
    status: warnings.length && bundle.study.status === 'available' ? 'partial' : bundle.study.status,
    artifact_root: 'data/model-runs/leo-density',
    study: bundle.study,
    warnings,
    errors,
  };

  return {
    schema_version: LEO_CONTRACT_VERSION,
    generated_at_utc: generatedAtUtc,
    status: candidates.length ? 'error' : 'unavailable',
    artifact_root: 'data/model-runs/leo-density',
    study: null,
    warnings: candidates.length
      ? warnings
      : [`No ${LEO_MULTIYEAR_STUDY_SUMMARY_FILE} or ${LEO_STUDY_SUMMARY_FILE} artifact is available under data/model-runs/leo-density.`],
    errors: candidates.length ? ['No readable LEO study summary matched the versioned contract.'] : [],
  };
}
