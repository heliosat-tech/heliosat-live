/**
 * Mint a HELIOSAT public-API key (ROADMAP Fase 3 / Fase 5 "emisión de claves").
 *
 * Generates a high-entropy token, stores only its SHA-256 hash in Supabase, and
 * prints the raw token ONCE — it cannot be recovered later. Requires the SERVICE
 * ROLE key (it writes the locked-down `api_keys` table).
 *
 *   node scripts/mint-api-key.mjs --company "Acme Corp" --name prod --rate 60 [--expires-days 365]
 */
import crypto from 'crypto';
import { getServiceClient, parseArgs } from './_supabase.mjs';

const args = parseArgs(process.argv.slice(2));
const supabase = getServiceClient();

const company = args.company ?? null;
const name = args.name ?? null;
const rateLimitPerMin = Number(args.rate ?? 60);
const expiresAt = args['expires-days']
  ? new Date(Date.now() + Number(args['expires-days']) * 86_400_000).toISOString()
  : null;

const token = `hsk_live_${crypto.randomBytes(32).toString('base64url')}`;
const keyHash = crypto.createHash('sha256').update(token).digest('hex');
const keyPrefix = token.slice(0, 16);

const { data, error } = await supabase
  .from('api_keys')
  .insert({ name, company, key_hash: keyHash, key_prefix: keyPrefix, rate_limit_per_min: rateLimitPerMin, expires_at: expiresAt })
  .select('id, company, name, rate_limit_per_min, expires_at')
  .single();

if (error) {
  console.error('Failed to insert API key:', error.message);
  process.exit(1);
}

console.log('\n✅ API key created. Store this token now — it will NOT be shown again:\n');
console.log(`   ${token}\n`);
console.log('Key record:', JSON.stringify(data, null, 2));
console.log('\nTest it:');
console.log(`   curl -H "Authorization: Bearer ${token}" <host>/api/v1/forecast/realtime\n`);
