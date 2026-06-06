import type { TrainingExperimentRecord } from '@/services/trainingExperimentConfig';

export type ExperimentDataDependencyRole = 'l1_source' | 'target_source' | 'mru_required';

export type ExperimentDataDependency = {
  sourceId: string;
  role: ExperimentDataDependencyRole;
  label: string;
  variables: string[];
};

const L1_SOURCE_TO_PIPELINE_SOURCE: Record<string, string> = {
  omni_hro_1min: 'omni-hro',
  dscovr_archive: 'ncei-dscovr-archive',
  ace_archive: 'cdaweb-ace-wind-imap',
};

const TARGET_SOURCE_TO_PIPELINE_SOURCE: Record<string, string> = {
  goes_nccei: 'ncei-goes-r-mag-seiss',
};

const DEFAULT_MODEL_DATA_DEPENDENCIES: ExperimentDataDependency[] = [
  {
    sourceId: 'omni-hro',
    role: 'l1_source',
    label: 'Planned historical L1 source',
    variables: ['solar wind speed', 'magnetic field', 'SYM/H'],
  },
  {
    sourceId: 'ncei-dscovr-archive',
    role: 'l1_source',
    label: 'Candidate DSCOVR archive',
    variables: ['magnetic field', 'plasma', 'ephemeris'],
  },
  {
    sourceId: 'cdaweb-ace-wind-imap',
    role: 'l1_source',
    label: 'L1 fallback / cross-check',
    variables: ['magnetic field', 'solar-wind plasma'],
  },
  {
    sourceId: 'ncei-goes-r-mag-seiss',
    role: 'target_source',
    label: 'Primary historical target',
    variables: ['goes_mag_h_magnitude', 'SEISS particles'],
  },
];

export function getExperimentDataDependencies(
  experiment: TrainingExperimentRecord | null,
): ExperimentDataDependency[] {
  if (!experiment) {
    return [];
  }

  const l1SourceId = L1_SOURCE_TO_PIPELINE_SOURCE[experiment.config.l1_source];
  const targetSourceId = TARGET_SOURCE_TO_PIPELINE_SOURCE[experiment.config.target.source];
  const dependencies: ExperimentDataDependency[] = [];

  if (l1SourceId) {
    dependencies.push({
      sourceId: l1SourceId,
      role: 'l1_source',
      label: 'Active L1 source',
      variables: ['solar wind speed', 'magnetic field'],
    });
  }

  if (targetSourceId) {
    dependencies.push({
      sourceId: targetSourceId,
      role: 'target_source',
      label: 'Active target source',
      variables: [experiment.config.target.variable],
    });
  }

  if (l1SourceId && experiment.config.target.variable.includes('mag')) {
    dependencies.push({
      sourceId: l1SourceId,
      role: 'mru_required',
      label: 'MRU baseline input',
      variables: ['solar wind speed', 'L1 magnetic magnitude/components'],
    });
  }

  return dependencies;
}

export function getModelDataDependencies(
  experiment: TrainingExperimentRecord | null,
): ExperimentDataDependency[] {
  const experimentDependencies = getExperimentDataDependencies(experiment);

  return experimentDependencies.length > 0 ? experimentDependencies : DEFAULT_MODEL_DATA_DEPENDENCIES;
}
