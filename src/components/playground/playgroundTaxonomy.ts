import {
  Activity,
  Archive,
  Database,
  Gauge,
  Radar,
  RadioTower,
  Ruler,
  Sigma,
  Target,
  Waves,
  type LucideIcon,
} from 'lucide-react';

export const PLAYGROUND_STAGES = [
  { id: 1, label: 'Data', separatorLabel: '1 · DATA', colorVar: '--stage-1-color' },
  { id: 2, label: 'Analysis', separatorLabel: '2 · ANALYSIS', colorVar: '--stage-2-color' },
  { id: 3, label: 'Forecast', separatorLabel: '3 · FORECAST', colorVar: '--stage-3-color' },
] as const;

export type PlaygroundStageId = (typeof PLAYGROUND_STAGES)[number]['id'];

/**
 * Leaf views are the individual content panels. They stay stable even when
 * several of them are grouped behind a single menu screen, so all the panel
 * rendering and data-fetching logic keys off these ids unchanged.
 */
export type PlaygroundView =
  | 'insitu'
  | 'historic'
  | 'pipeline'
  | 'quality'
  | 'eda'
  | 'coupling'
  | 'overview'
  | 'datapipeline'
  | 'validation'
  | 'forecast';

/** Back-compat alias: `activeTab` state still refers to a leaf view. */
export type PlaygroundTab = PlaygroundView;

/** Screens are the top-level menu entries; some bundle multiple views as sub-tabs. */
export type PlaygroundScreenId =
  | 'input'
  | 'health'
  | 'exploration'
  | 'models'
  | 'validation'
  | 'liveforecast';

/** Anything that can render a stage-coloured code pill (`1A`, `2C`, …). */
export type StageCoded = {
  code: string;
  stageId: PlaygroundStageId;
};

export type PlaygroundScreenViewConfig = {
  id: PlaygroundView;
  label: string;
  description: string;
  icon: LucideIcon;
};

export type PlaygroundScreenConfig = StageCoded & {
  id: PlaygroundScreenId;
  label: string;
  description: string;
  icon: LucideIcon;
  views: readonly PlaygroundScreenViewConfig[];
};

export const PLAYGROUND_SCREENS = [
  {
    id: 'input',
    code: '1A',
    label: 'Input data',
    description: 'Live and historic spacecraft feeds',
    stageId: 1,
    icon: Database,
    views: [
      {
        id: 'insitu',
        label: 'Current',
        description: 'Current L1 and near-Earth feeds',
        icon: RadioTower,
      },
      {
        id: 'historic',
        label: 'Historic',
        description: 'Event windows and validation sets',
        icon: Archive,
      },
    ],
  },
  {
    id: 'health',
    code: '1B',
    label: 'Data Health',
    description: 'Ingestion status and quality checks',
    stageId: 1,
    icon: Activity,
    views: [
      {
        id: 'pipeline',
        label: 'Pipeline',
        description: 'Ingestion status and pull logs',
        icon: Activity,
      },
      {
        id: 'quality',
        label: 'Quality',
        description: 'Coverage, gaps, outliers, cadence',
        icon: Gauge,
      },
    ],
  },
  {
    id: 'exploration',
    code: '2A',
    label: 'Exploration',
    description: 'Solar-wind distributions and measured L1→Earth travel time',
    stageId: 2,
    icon: Sigma,
    views: [
      {
        id: 'eda',
        label: 'Univariate',
        description: 'Distributions of each variable at L1 and at Earth',
        icon: Sigma,
      },
      {
        id: 'coupling',
        label: 'Coupling',
        description: 'Measured L1→Earth travel time vs the MRU estimate',
        icon: Waves,
      },
    ],
  },
  {
    id: 'models',
    code: '3A',
    label: 'Models',
    description: 'How the forecast is computed',
    stageId: 3,
    icon: Ruler,
    views: [
      {
        id: 'overview',
        label: 'Models',
        description: 'How the forecast is computed',
        icon: Ruler,
      },
      {
        id: 'datapipeline',
        label: 'Data & pipeline',
        description: 'Training, validation and live data',
        icon: Database,
      },
    ],
  },
  {
    id: 'validation',
    code: '3B',
    label: 'Validation',
    description: 'How well predictions match reality',
    stageId: 3,
    icon: Target,
    views: [
      {
        id: 'validation',
        label: 'Validation',
        description: 'How well predictions match reality',
        icon: Target,
      },
    ],
  },
  {
    id: 'liveforecast',
    code: '3C',
    label: 'Live Forecast',
    description: 'What is heading to Earth right now',
    stageId: 3,
    icon: Radar,
    views: [
      {
        id: 'forecast',
        label: 'Live Forecast',
        description: 'What is heading to Earth right now',
        icon: Radar,
      },
    ],
  },
] as const satisfies readonly PlaygroundScreenConfig[];

const PLAYGROUND_SCREEN_BY_VIEW = PLAYGROUND_SCREENS.reduce(
  (screensByView, screen) => {
    for (const view of screen.views) {
      screensByView[view.id] = screen;
    }

    return screensByView;
  },
  {} as Record<PlaygroundView, PlaygroundScreenConfig>,
);

export const PLAYGROUND_SCREENS_BY_STAGE = PLAYGROUND_STAGES.map(stage => ({
  stage,
  screens: PLAYGROUND_SCREENS.filter(screen => screen.stageId === stage.id),
})).filter(group => group.screens.length > 0);

/** Resolve the menu screen that currently owns a given leaf view. */
export function getScreenForView(viewId: PlaygroundView): PlaygroundScreenConfig {
  return PLAYGROUND_SCREEN_BY_VIEW[viewId];
}

export function getPlaygroundStage(stageId: PlaygroundStageId) {
  return PLAYGROUND_STAGES.find(stage => stage.id === stageId) ?? PLAYGROUND_STAGES[0];
}

export function getPlaygroundCodeAriaLabel(item: StageCoded) {
  return `Stage ${item.stageId}, section ${item.code.slice(1)}`;
}
