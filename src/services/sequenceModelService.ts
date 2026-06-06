import type { BaselinesLabSnapshot, ModelRunRecord } from './modelBenchmarkService';

export interface TrainingCurvePoint {
  epoch: number;
  trainLoss: number | null;
  valLoss: number | null;
  learningRate: number | null;
  gradientNorm: number | null;
}

export interface SaliencyCell {
  timestepMinutes: number;
  horizonMinutes: number;
  value: number;
}

export interface SequenceModelRecord {
  model: string;
  architecture: 'lstm_attention' | 'tcn' | 'patchtst' | 'nhits' | 'tft';
  status: 'registered' | 'blocked' | 'trained';
  target: string;
  horizonMinutes: number;
  windowMinutes: number;
  inferenceLatencyMsP95: number | null;
  skillVsBestBaseline: number | null;
  trainingCurves: TrainingCurvePoint[];
  saliency: SaliencyCell[];
  notes: string[];
}

export interface SequenceModelsSnapshot {
  generatedAtUtc: string;
  decision: {
    canProceed: boolean;
    bestBaselineModel: string | null;
    bestBaselineSkill: number | null;
    reason: string;
  };
  baselineRuns: ModelRunRecord[];
  sequenceModels: SequenceModelRecord[];
  warnings: string[];
}

const ARCHITECTURES: Array<Pick<SequenceModelRecord, 'model' | 'architecture'>> = [
  { model: 'LSTM encoder-decoder attention', architecture: 'lstm_attention' },
  { model: 'TCN', architecture: 'tcn' },
  { model: 'PatchTST', architecture: 'patchtst' },
  { model: 'N-HiTS', architecture: 'nhits' },
  { model: 'TFT', architecture: 'tft' },
];

export function buildSequenceModelsSnapshot(baselines: BaselinesLabSnapshot): SequenceModelsSnapshot {
  const trainedBaselineRuns = baselines.runs.filter(run => run.status === 'trained' && run.metrics.skillVsPersistence !== null);
  const bestBaseline = trainedBaselineRuns
    .slice()
    .sort((a, b) => (b.metrics.skillVsPersistence ?? Number.NEGATIVE_INFINITY) - (a.metrics.skillVsPersistence ?? Number.NEGATIVE_INFINITY))[0] ?? null;
  const bestSkill = bestBaseline?.metrics.skillVsPersistence ?? null;
  const canProceed = bestSkill !== null && bestSkill > 0.05;
  const target = baselines.target;
  const horizonMinutes = baselines.horizonsMinutes[0] ?? 30;

  return {
    generatedAtUtc: new Date().toISOString(),
    decision: {
      canProceed,
      bestBaselineModel: bestBaseline?.model ?? null,
      bestBaselineSkill: bestSkill,
      reason: canProceed
        ? 'Baselines show non-trivial skill over persistence; sequence experiments are worth scheduling.'
        : 'Sequence training is gated until baselines beat persistence by a meaningful margin.',
    },
    baselineRuns: baselines.runs,
    sequenceModels: ARCHITECTURES.map(architecture => ({
      ...architecture,
      status: canProceed ? 'registered' : 'blocked',
      target,
      horizonMinutes,
      windowMinutes: 120,
      inferenceLatencyMsP95: null,
      skillVsBestBaseline: null,
      trainingCurves: [],
      saliency: [],
      notes: [
        canProceed
          ? 'Registered for PyTorch/ONNX training job; runtime dependency is not installed in this Next.js workspace.'
          : 'Blocked by baseline gate.',
      ],
    })),
    warnings: canProceed ? [] : ['No sequence model was trained because the baseline gate did not pass.'],
  };
}
