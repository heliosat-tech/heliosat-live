import crypto from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';

/**
 * API-key authentication + rate limiting for the PUBLIC API (distinct from the
 * cookie-based admin gate, which can't authenticate machines). The caller presents
 * `Authorization: Bearer <key>`; we hash it and hand the digest to the
 * `consume_api_key` SQL function, which validates the key and consumes one unit of
 * its per-minute budget atomically. The raw key never leaves the request.
 */

export interface ApiKeyAuthOk {
  ok: true;
  keyId: string;
  company: string | null;
  rateLimit: number;
  remaining: number;
}

export interface ApiKeyAuthErr {
  ok: false;
  status: number;
  error: string;
  /** Seconds until the rate-limit window resets (429 only). */
  retryAfter?: number;
  rateLimit?: number;
}

export type ApiKeyAuthResult = ApiKeyAuthOk | ApiKeyAuthErr;

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** SHA-256 hex digest — what we store and compare against (keys are high-entropy). */
export function hashApiKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

interface ConsumeVerdict {
  allowed: boolean;
  reason?: string;
  key_id?: string;
  company?: string | null;
  rate_limit?: number;
  remaining?: number;
  retry_after?: number;
}

export async function authenticateApiKey(request: Request): Promise<ApiKeyAuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return { ok: false, status: 401, error: 'Missing or malformed Authorization header. Use: Authorization: Bearer <api_key>.' };
  }

  const supabase = createServiceRoleClient();
  if (!supabase) {
    return { ok: false, status: 503, error: 'API authentication is not configured.' };
  }

  const { data, error } = await supabase.rpc('consume_api_key', { p_key_hash: hashApiKey(token) });
  if (error) {
    return { ok: false, status: 500, error: 'Authentication backend error.' };
  }

  const verdict = (data ?? {}) as ConsumeVerdict;
  if (!verdict.allowed) {
    if (verdict.reason === 'rate_limited') {
      return { ok: false, status: 429, error: 'Rate limit exceeded.', retryAfter: verdict.retry_after, rateLimit: verdict.rate_limit };
    }
    return { ok: false, status: 401, error: 'Invalid, inactive, or expired API key.' };
  }

  return {
    ok: true,
    keyId: verdict.key_id ?? '',
    company: verdict.company ?? null,
    rateLimit: verdict.rate_limit ?? 0,
    remaining: verdict.remaining ?? 0,
  };
}
