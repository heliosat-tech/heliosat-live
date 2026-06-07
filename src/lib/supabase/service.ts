import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * SERVER-ONLY Supabase client using the SERVICE ROLE key. It BYPASSES Row Level
 * Security, so it must NEVER be imported into a Client Component or otherwise
 * reach the browser. Used by the public API surface to validate API keys and read
 * precomputed forecasts — tables that anon/publishable callers cannot touch.
 *
 * Returns null when SUPABASE_SERVICE_ROLE_KEY (or the URL) is not configured, so
 * callers can degrade to a clean 503 instead of throwing.
 */
let cached: SupabaseClient | null = null;

export function createServiceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  if (cached) return cached;

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
