export const LEO_CONTRACT_VERSION = '2' as const;
export const LEO_LEGACY_CONTRACT_VERSION = '1' as const;
export type LeoContractVersion = typeof LEO_CONTRACT_VERSION | typeof LEO_LEGACY_CONTRACT_VERSION;

export type LeoAvailabilityStatus = 'available' | 'partial' | 'unavailable' | 'error';
export type LeoEvidenceClass = 'observed' | 'retrospective' | 'experimental_forecast' | 'scenario';
export type LeoProcessingStatus = 'complete' | 'partial' | 'pending' | 'unavailable' | 'error';
export type LeoResearchStage = 'pilot' | 'multi_year_study' | 'experimental_live';
export type LeoMissionId = 'swarm-a' | 'swarm-b' | 'swarm-c' | 'grace-fo-1' | 'grace-fo-2';
export type LeoCoveragePhase = 'raw' | 'processed' | 'joined' | 'train' | 'validation' | 'test';

export interface LeoCoverageSummary {
  start_utc: string | null;
  end_utc: string | null;
  effective_observation_days: number | null;
  calendar_years: number[];
  mission_count: number | null;
  spacecraft_count: number | null;
  spacecraft_ids: string[];
  quiet_interval_count: number | null;
  storm_events: {
    total: number | null;
    moderate: number | null;
    severe: number | null;
  };
}

export interface LeoCoverageRange {
  status: LeoAvailabilityStatus;
  start_utc: string | null;
  end_utc: string | null;
  rows: number | null;
}

export interface LeoLineageEntry {
  source_product: string;
  source_version: string | null;
  source_file: string | null;
  checksum_sha256: string | null;
  processed_files: string[];
  provenance: Record<string, unknown> | null;
}

export interface LeoArchiveDataset {
  id: LeoMissionId;
  mission: 'Swarm' | 'GRACE-FO';
  spacecraft_id: string;
  display_name: string;
  product_ids: string[];
  source_provider: 'ESA VirES';
  source_access_url: string;
  status: LeoAvailabilityStatus;
  status_message: string;
  coverage: Record<LeoCoveragePhase, LeoCoverageRange>;
  native_cadence: string | null;
  processed_cadence: string | null;
  raw_files: number;
  processed_files: number;
  row_count_raw: number | null;
  row_count_processed: number | null;
  storage_bytes: number | null;
  quality_pass_count: number | null;
  quality_reject_count: number | null;
  quality_pass_pct: number | null;
  last_ingestion_utc: string | null;
  processing_status: LeoProcessingStatus;
  baseline_status: LeoProcessingStatus;
  driver_join_status: LeoProcessingStatus;
  lineage: LeoLineageEntry[];
  errors: string[];
}

export interface LeoInventoryResponse {
  schema_version: typeof LEO_CONTRACT_VERSION;
  generated_at_utc: string;
  evidence_class: 'observed';
  research_stage: Exclude<LeoResearchStage, 'experimental_live'>;
  manifest: {
    path: 'data/processed/thermosphere/manifest.v1.json';
    schema_version: string | null;
    generated_at_utc: string | null;
    status: LeoAvailabilityStatus;
  };
  datasets: LeoArchiveDataset[];
  coverage: Partial<Record<LeoCoveragePhase, { start_utc: string; end_utc: string }>>;
  coverage_summary: LeoCoverageSummary;
  source: {
    provider: 'ESA VirES';
    access_url: 'https://vires.services/hapi/';
    attribution: string;
    licensing_status: string;
  };
  warnings: string[];
  errors: string[];
}

export interface LeoConfidenceInterval {
  low: number;
  high: number;
  level_pct: number;
  method: string | null;
  block_count: number | null;
  resamples: number | null;
  random_seed: number | null;
}

export interface LeoValidationMetric {
  key: string;
  label: string;
  value: number;
  unit: string | null;
  model_id: string | null;
  sample_count: number | null;
  confidence_interval: LeoConfidenceInterval | null;
}

export interface LeoValidationModel {
  id: string;
  label: string;
  status: LeoAvailabilityStatus;
  feature_group: string | null;
  role: 'deployable_candidate' | 'retrospective_diagnostic' | 'unspecified';
  uses_mission_identity: boolean | null;
  causality: 'issuance_safe' | 'retrospective_only' | 'unverified';
  metrics: LeoValidationMetric[];
}

export type LeoStudyMode = 'reference_aligned' | 'heliosat_predicted_arrival';
export type LeoArrivalMode = 'omni_reference_aligned' | 'mru' | 'mru_ml';

export interface LeoArrivalModeResult {
  mode: LeoArrivalMode;
  label: string;
  evidence_class: 'retrospective';
  status: LeoAvailabilityStatus;
  models: LeoValidationModel[];
  metrics: LeoValidationMetric[];
  warnings: string[];
}

export interface LeoArrivalComparability {
  status: 'identical' | 'mismatch' | 'unverified';
  matched_row_fingerprint: string | null;
  split_fingerprint: string | null;
  hyperparameter_fingerprint: string | null;
  random_seed: number | null;
  reasons: string[];
}

export interface LeoTransferExperiment {
  id: string;
  kind: 'leave_one_spacecraft_out' | 'cross_mission';
  label: string;
  arrival_mode: LeoArrivalMode;
  status: LeoAvailabilityStatus;
  role: 'deployable_candidate' | 'retrospective_diagnostic' | 'unspecified';
  held_out_mission: string | null;
  held_out_spacecraft_id: string | null;
  train_missions: string[];
  train_spacecraft_ids: string[];
  test_rows: number | null;
  metrics: LeoValidationMetric[];
  reason: string | null;
}

export interface LeoLagExperiment {
  id: string;
  label: string;
  arrival_mode: LeoArrivalMode | null;
  kind: 'fixed_lag' | 'distributed_lag' | 'stratified_lag';
  status: LeoAvailabilityStatus;
  lag_min_hours: number | null;
  lag_max_hours: number | null;
  lag_step_minutes: number | null;
  stratification: 'latitude' | 'local_solar_time' | 'altitude' | 'storm_intensity' | null;
  best_lag_hours: number | null;
  metric: LeoValidationMetric | null;
  plot_artifact_id: string | null;
  reason: string | null;
}

export interface LeoUncertaintyCalibration {
  status: LeoAvailabilityStatus | 'calibrated' | 'uncalibrated';
  method: string | null;
  calibration_start_utc: string | null;
  calibration_end_utc: string | null;
  sample_count: number | null;
  block_count: number | null;
  nominal_coverage: number | null;
  empirical_coverage: number | null;
  p10_coverage: number | null;
  p50_coverage: number | null;
  p90_coverage: number | null;
  reason: string | null;
}

export interface LeoValidationModeResult {
  mode: LeoStudyMode;
  label: string;
  evidence_class: 'retrospective';
  status: LeoAvailabilityStatus;
  split: Record<string, unknown> | null;
  models: LeoValidationModel[];
  metrics: LeoValidationMetric[];
  warnings: string[];
}

export type LeoValidationArtifactCategory = 'overview' | 'performance' | 'event' | 'regime' | 'interpretation' | 'lag_response';

export interface LeoValidationScientificArtifact {
  id: string;
  kind: 'plot';
  media_type: 'image/png';
  category: LeoValidationArtifactCategory;
  title: string;
  interpretation: string;
  evidence_class: 'retrospective';
  mode: LeoStudyMode | null;
  arrival_mode: LeoArrivalMode | null;
  event_id: string | null;
  interpretation_details: {
    method: string | null;
    random_seed: number | null;
    top_features: Array<{ feature: string; mae_increase: number }>;
  } | null;
  url: string;
}

export interface LeoValidationEventModeResult {
  mode: LeoStudyMode;
  status: LeoAvailabilityStatus;
  sample_count: number | null;
  spacecraft_count: number | null;
  peak_density_absolute_relative_error: number | null;
  peak_timing_mae_min: number | null;
  onset_timing_mae_min: number | null;
  recovery_timing_mae_min: number | null;
  reason: string | null;
}

export interface LeoValidationEventStudy {
  id: string;
  label: string;
  start_utc: string;
  end_utc: string;
  definition: string;
  prediction_mode_label: string;
  evidence_class: 'retrospective';
  plot_artifact_id: string | null;
  mode_results: Record<LeoStudyMode, LeoValidationEventModeResult>;
}

export interface LeoValidationRegimeGroup {
  id: string;
  label: string;
  status: LeoAvailabilityStatus;
  sample_count: number | null;
  mae_log10_rho: number | null;
  rmse_log10_rho: number | null;
  median_absolute_relative_error: number | null;
  bias_log10_rho: number | null;
  correlation_log10_rho: number | null;
  rmse_skill_vs_m0: number | null;
}

export interface LeoValidationRegimeDimension {
  id: 'geomagnetic_regime' | 'altitude' | 'latitude' | 'local_solar_time' | 'mission' | 'solar_activity';
  label: string;
  groups: LeoValidationRegimeGroup[];
}

export interface LeoValidationLineage {
  density_evidence_class: string | null;
  density_coverage_start_utc: string | null;
  density_coverage_end_utc: string | null;
  input_rows: number | null;
  selected_rows: number | null;
  quality_rejected_rows: number | null;
  baseline_rejected_rows: number | null;
  baseline_models: string[];
  baseline_versions: string[];
  density_source_file_count: number;
  density_checksum_count: number;
  manifest_checksum_sha256: string | null;
  driver_source: string | null;
  driver_evidence_class: string | null;
  driver_coverage_start_utc: string | null;
  driver_coverage_end_utc: string | null;
  driver_source_file_count: number;
  driver_checksum_count: number;
}

export interface LeoValidationStudy {
  run_id: string;
  study_version: string | null;
  generated_at_utc: string;
  dataset_version: string | null;
  feature_schema_version: string | null;
  research_stage: Exclude<LeoResearchStage, 'experimental_live'>;
  status: LeoAvailabilityStatus;
  missions: string[];
  coverage_summary: LeoCoverageSummary;
  split: Record<string, unknown> | null;
  modes: Record<LeoStudyMode, LeoValidationModeResult>;
  arrival_modes: Record<LeoArrivalMode, LeoArrivalModeResult>;
  arrival_comparability: LeoArrivalComparability;
  transfer_experiments: LeoTransferExperiment[];
  lag_experiments: LeoLagExperiment[];
  uncertainty_calibration: LeoUncertaintyCalibration;
  scientific_artifacts: LeoValidationScientificArtifact[];
  events: LeoValidationEventStudy[];
  regimes: Record<LeoStudyMode, LeoValidationRegimeDimension[]>;
  lineage: LeoValidationLineage | null;
  limitations: string[];
  warnings: string[];
}

export interface LeoValidationResponse {
  schema_version: typeof LEO_CONTRACT_VERSION;
  generated_at_utc: string;
  status: LeoAvailabilityStatus;
  artifact_root: 'data/model-runs/leo-density';
  study: LeoValidationStudy | null;
  warnings: string[];
  errors: string[];
}

export type LeoTleFreshness = 'fresh' | 'degraded' | 'stale' | 'unknown';

export interface LeoVector3 {
  x: number;
  y: number;
  z: number;
}

export interface LeoTrajectoryPoint {
  timestamp_utc: string;
  frame: 'TEME';
  position_km: LeoVector3;
  velocity_km_s: LeoVector3;
  atmosphere_corotation_velocity_km_s: LeoVector3;
  air_relative_velocity_km_s: LeoVector3;
  air_relative_speed_km_s: number;
  latitude_deg: number;
  longitude_deg: number;
  altitude_km: number;
  local_solar_time_h: number | null;
}

export interface LeoSatelliteOption {
  norad_id: string;
  name: string;
  source: string;
  tle_epoch_utc: string | null;
  tle_age_hours: number | null;
  tle_freshness: LeoTleFreshness;
}

export interface LeoTrajectory {
  status: LeoAvailabilityStatus;
  satellite: LeoSatelliteOption | null;
  frame: 'TEME';
  propagator: 'SGP4 via satellite.js';
  generated_at_utc: string;
  horizon_minutes: number;
  cadence_minutes: number;
  points: LeoTrajectoryPoint[];
  warnings: string[];
}

export interface LeoSpacecraftScenario {
  id: 'low-drag' | 'nominal' | 'high-drag';
  label: string;
  evidence_class: 'scenario';
  direct_ballistic_coefficient_m2_kg: number;
  mass_kg: null;
  reference_area_m2: null;
  drag_coefficient: null;
  attitude_mode: 'generic sensitivity scenario';
  parameter_source: string;
  is_real_satellite_property: false;
}

export interface LeoForcingPoint {
  arrival_time_bow_shock_utc: string;
  forcing_mode: 'confirmed_inbound' | 'assumption_extension';
  evidence_class: 'experimental_forecast';
  speed_km_s: number | null;
  bz_gsm_nt: number | null;
  dynamic_pressure_npa: number | null;
  em_mv_m: number | null;
  newell_coupling: number | null;
}

export interface LeoForecastTimelinePoint {
  timestamp_utc: string;
  forcing_mode: 'confirmed_inbound' | 'assumption_extension';
  density_evidence_class: 'experimental_forecast';
  impact_evidence_class: 'scenario';
  rho_baseline_kg_m3: number | null;
  rho_p10_kg_m3: number | null;
  rho_p50_kg_m3: number | null;
  rho_p90_kg_m3: number | null;
  drag_acceleration_baseline_m_s2: number | null;
  drag_acceleration_p10_m_s2: number | null;
  drag_acceleration_p50_m_s2: number | null;
  drag_acceleration_p90_m_s2: number | null;
  cumulative_delta_v_baseline_m_s: number | null;
  cumulative_delta_v_p50_m_s: number | null;
  along_track_baseline_m: number | null;
  along_track_p50_m: number | null;
  altitude_km: number | null;
  latitude_deg: number | null;
  longitude_deg: number | null;
  local_solar_time_h: number | null;
}

export interface LeoForecastSummary {
  rho_baseline_kg_m3: number | null;
  rho_p50_kg_m3: number | null;
  rho_p10_kg_m3: number | null;
  rho_p90_kg_m3: number | null;
  density_enhancement: number | null;
  drag_acceleration_p50_m_s2: number | null;
  cumulative_delta_v_m_s: number | null;
  along_track_estimate_m: number | null;
  expected_onset_utc: string | null;
  expected_peak_utc: string | null;
  expected_recovery_utc: string | null;
  forecast_confidence: string | null;
}

export interface LeoForecastResponse {
  schema_version: typeof LEO_CONTRACT_VERSION;
  generated_at_utc: string;
  forecast_mode: 'experimental';
  research_stage: 'experimental_live';
  evidence_classes: LeoEvidenceClass[];
  status: LeoAvailabilityStatus;
  research_label: 'Research model, not operational';
  selector: {
    group: 'stations' | 'weather';
    selected_norad_id: string | null;
    options: LeoSatelliteOption[];
  };
  model: {
    status: LeoAvailabilityStatus;
    version: string | null;
    artifact: string | null;
    training_range: { start_utc: string; end_utc: string } | null;
    uncertainty: LeoUncertaintyCalibration;
  };
  baseline: {
    status: LeoAvailabilityStatus;
    model_name: string | null;
    model_version: string | null;
    licensing_status: string;
  };
  validated_domain: {
    altitude_min_km: number | null;
    altitude_max_km: number | null;
    missions: string[];
  } | null;
  out_of_distribution: {
    is_out_of_domain: boolean | null;
    reasons: string[];
  };
  spacecraft_parameters: LeoSpacecraftScenario;
  trajectory: LeoTrajectory;
  forcing: {
    source_status: LeoAvailabilityStatus;
    l1_sample_time_utc: string | null;
    arrival_model: string;
    confirmed_inbound: { start_utc: string | null; end_utc: string | null };
    assumption_extension: { start_utc: string | null; end_utc: string | null; policy: string };
    timeline: LeoForcingPoint[];
    warnings: string[];
  };
  timeline: LeoForecastTimelinePoint[] | null;
  summary: LeoForecastSummary;
  assumptions: {
    atmosphere_corotation: 'rigid Earth co-rotation';
    neutral_winds: 'not modeled';
    orbit_source: string | null;
    orbital_impact: 'first-order estimate, not precise orbit determination';
  };
  data_health: Record<string, unknown>;
  warnings: string[];
  errors: string[];
}
