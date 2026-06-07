/**
 * Revoke (deactivate) an API key by id or prefix (ROADMAP Fase 5). Sets is_active=false
 * so the next request is rejected; the row is kept for the usage history. Use
 * --delete to remove it entirely instead (also drops its usage rows via cascade).
 *
 *   node scripts/revoke-api-key.mjs --id <uuid>
 *   node scripts/revoke-api-key.mjs --prefix hsk_live_ab12
 *   node scripts/revoke-api-key.mjs --id <uuid> --delete
 */
import { getServiceClient, parseArgs } from './_supabase.mjs';

const args = parseArgs(process.argv.slice(2));
const supabase = getServiceClient();

if (!args.id && !args.prefix) {
  console.error('Provide --id <uuid> or --prefix <key_prefix>.');
  process.exit(1);
}

const match = (q) => (args.id ? q.eq('id', args.id) : q.eq('key_prefix', args.prefix));

if (args.delete === 'true') {
  const { data, error } = await match(supabase.from('api_keys').delete()).select('id, company, name');
  if (error) { console.error('Failed to delete key:', error.message); process.exit(1); }
  if (!data?.length) { console.error('No matching key found.'); process.exit(1); }
  console.log(`🗑️  Deleted key ${data[0].id} (${data[0].company ?? '—'}/${data[0].name ?? '—'}).`);
} else {
  const { data, error } = await match(supabase.from('api_keys').update({ is_active: false })).select('id, company, name, is_active');
  if (error) { console.error('Failed to revoke key:', error.message); process.exit(1); }
  if (!data?.length) { console.error('No matching key found.'); process.exit(1); }
  console.log(`🚫 Revoked key ${data[0].id} (${data[0].company ?? '—'}/${data[0].name ?? '—'}). It can no longer authenticate.`);
}
