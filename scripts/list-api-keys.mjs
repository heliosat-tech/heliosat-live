/**
 * List issued API keys with lifetime usage (ROADMAP Fase 5). With --usage <days> it
 * also shows the per-day request counts from api_key_usage_daily (billing / abuse).
 *
 *   node scripts/list-api-keys.mjs [--usage 30]
 */
import { getServiceClient, parseArgs } from './_supabase.mjs';

const args = parseArgs(process.argv.slice(2));
const supabase = getServiceClient();

const { data: keys, error } = await supabase
  .from('api_keys')
  .select('id, key_prefix, name, company, is_active, rate_limit_per_min, request_count, last_used_at, expires_at, created_at')
  .order('created_at', { ascending: true });

if (error) {
  console.error('Failed to list API keys:', error.message);
  process.exit(1);
}

if (!keys?.length) {
  console.log('No API keys yet. Mint one with scripts/mint-api-key.mjs.');
  process.exit(0);
}

for (const k of keys) {
  const status = k.is_active ? 'active' : 'REVOKED';
  const expired = k.expires_at && new Date(k.expires_at) < new Date() ? ' (EXPIRED)' : '';
  console.log(`\n• ${k.company ?? '—'} / ${k.name ?? '—'}  [${status}${expired}]`);
  console.log(`  id:        ${k.id}`);
  console.log(`  prefix:    ${k.key_prefix ?? '—'}…`);
  console.log(`  rate/min:  ${k.rate_limit_per_min}`);
  console.log(`  requests:  ${k.request_count} (lifetime)`);
  console.log(`  last used: ${k.last_used_at ?? 'never'}`);
  console.log(`  expires:   ${k.expires_at ?? 'never'}`);
}

const usageDays = args.usage ? Number(args.usage) : 0;
if (usageDays > 0) {
  const since = new Date(Date.now() - usageDays * 86_400_000).toISOString().slice(0, 10);
  const { data: usage, error: usageErr } = await supabase
    .from('api_key_usage_daily')
    .select('key_id, day, request_count')
    .gte('day', since)
    .order('day', { ascending: true });
  if (usageErr) {
    console.error('\nFailed to load usage:', usageErr.message);
    process.exit(1);
  }
  const label = new Map(keys.map(k => [k.id, `${k.company ?? '—'}/${k.name ?? '—'}`]));
  console.log(`\n── Daily usage (last ${usageDays} days) ──`);
  if (!usage?.length) {
    console.log('  (no requests in window)');
  } else {
    for (const u of usage) console.log(`  ${u.day}  ${String(u.request_count).padStart(8)}  ${label.get(u.key_id) ?? u.key_id}`);
  }
}
