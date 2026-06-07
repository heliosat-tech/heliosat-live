/**
 * Shared helpers for the API-key admin scripts (mint / list / revoke). They all need
 * the SERVICE ROLE key to touch the locked-down `api_keys` table. Env is read from the
 * process or from .env.local (no dotenv dependency).
 */
import { readFileSync } from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

export function loadEnvLocal() {
  try {
    const raw = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local — rely on the real environment */ }
}

/** Parse `--flag value` / `--flag` pairs into an object. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
      args[key] = val;
    }
  }
  return args;
}

/** Service-role Supabase client, or exit(1) if not configured. */
export function getServiceClient() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (env or .env.local).');
    process.exit(1);
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
