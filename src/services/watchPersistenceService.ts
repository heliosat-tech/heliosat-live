import type { SupabaseClient } from '@supabase/supabase-js';
import type { SatelliteTLE } from './celestrakService';
import type { WatchConfig } from '@/contexts/SatelliteWatchContext';

// Read/write the per-user dashboard watch-list (tracked satellites + instruments/thresholds) in
// Supabase. The browser client + RLS (auth.uid() = user_id) means each user only ever sees their
// own row. See supabase/dashboard-watchlists.sql for the schema.

const TABLE = 'dashboard_watchlists';

export interface DashboardConfig {
  tracked: SatelliteTLE[];
  instruments: WatchConfig;
}

function isTleArray(value: unknown): value is SatelliteTLE[] {
  return Array.isArray(value) && value.every(item =>
    item && typeof item === 'object'
    && typeof (item as SatelliteTLE).name === 'string'
    && typeof (item as SatelliteTLE).line1 === 'string'
    && typeof (item as SatelliteTLE).line2 === 'string',
  );
}

/** Load the signed-in user's saved config, or null if there is no row yet / on error. */
export async function loadDashboardConfig(
  supabase: SupabaseClient,
  userId: string,
): Promise<DashboardConfig | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('tracked, instruments')
    .eq('user_id', userId)
    .maybeSingle<{ tracked: unknown; instruments: unknown }>();

  if (error || !data) return null;

  return {
    tracked: isTleArray(data.tracked) ? data.tracked : [],
    instruments: data.instruments && typeof data.instruments === 'object'
      ? (data.instruments as WatchConfig)
      : {},
  };
}

/** Upsert the signed-in user's config (one row per user, keyed by user_id). */
export async function saveDashboardConfig(
  supabase: SupabaseClient,
  userId: string,
  config: DashboardConfig,
): Promise<void> {
  await supabase
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        tracked: config.tracked,
        instruments: config.instruments,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
}
