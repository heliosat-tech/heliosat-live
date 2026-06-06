import type { PlaygroundScreenId } from './playgroundTaxonomy';

/**
 * Plain-language help shown in the (i) popup next to each screen title, so a new
 * external user understands what the section does and how it fits the project.
 */
export interface ScreenInfo {
  /** One-line plain summary. */
  intro: string;
  /** What the screen actually shows / does. */
  details: string[];
  /** How it fits into the whole project. */
  fitsIn: string;
  /** What the user has to do, or null if fully automatic. */
  userAction: string | null;
}

export const PLAYGROUND_SCREEN_INFO: Record<PlaygroundScreenId, ScreenInfo> = {
  input: {
    intro: 'Where the raw measurements come in — the start of everything.',
    details: [
      'Current: the latest live telemetry from spacecraft at L1 (DSCOVR, ~1.5 M km sunward of Earth) and near Earth (GOES), refreshed automatically.',
      'Historic: pull past windows of data from public archives (NASA/NOAA) for analysis and validation.',
    ],
    fitsIn: 'This is the source feed. Everything downstream — health checks, exploration, the forecast — reads from here.',
    userAction: 'Nothing for Current. For Historic, choose sources and a date window.',
  },
  health: {
    intro: 'Is the incoming data healthy and usable? A trust check before we use it.',
    details: [
      'Pipeline: did each data source ingest correctly, and when was it last updated.',
      'Quality: coverage, gaps, outliers and sampling cadence of each feed.',
    ],
    fitsIn: 'Garbage in, garbage out — this catches bad or stale data before it reaches the models.',
    userAction: 'None — it refreshes automatically.',
  },
  exploration: {
    intro: 'Getting to know the solar wind and how long it takes to travel from L1 to Earth.',
    details: [
      'Univariate: the distribution and statistics of each variable (speed, density, magnetic field) measured at L1 and at Earth.',
      'Coupling: the cross-correlation between L1 and Earth — the peak is the real, measured travel time, which we compare to the simple physics (MRU) estimate.',
    ],
    fitsIn: 'Builds intuition and empirically validates the core idea — the L1→Earth propagation lag — before any modelling.',
    userAction: 'None — it auto-picks a window that has real data. You can refresh.',
  },
  models: {
    intro: 'The methods that turn L1 measurements into an Earth forecast, and how good each one is.',
    details: [
      'MRU baseline: pure physics (arrival lag = distance ÷ solar-wind speed). Always on, needs no training.',
      'ML model: learns the corrections the baseline misses, trained once offline with a button, then served automatically.',
      'Per-orbit impact models: a second family that predicts conditions AT a satellite (GEO/MEO/LEO), where the satellite’s own position matters a lot.',
    ],
    fitsIn: 'The “brain” of the platform — these are the methods used by Validation and the Live Forecast.',
    userAction: 'Optional (admin): press Train to (re)fit the ML and per-orbit models. The forecast itself needs no action.',
  },
  validation: {
    intro: 'How well do the forecasts match what really happened on past events?',
    details: [
      'Replays past L1 data, propagates it to Earth with both MRU and ML, and compares against OMNI (the community-standard “what actually reached Earth”).',
      'Shows the error (MAE/RMSE), the quality coefficient R² (1 = perfect), and the ML skill vs the baseline.',
    ],
    fitsIn: 'The evidence that the models work — measured against reality, not opinion.',
    userAction: 'Optional: pick a recommended interval (or your own window) and press Run backtest. It also auto-runs on a window with data.',
  },
  liveforecast: {
    intro: 'What’s heading to Earth right now — the operational output.',
    details: [
      'Takes the solar wind measured at L1 this minute and projects when and what reaches Earth (your free lead time).',
      'Shows a green/yellow/red status from the field orientation and speed, and the minutes until arrival.',
    ],
    fitsIn: 'The product. Everything else exists to make this number trustworthy and automatic.',
    userAction: 'None — fully automatic.',
  },
};
