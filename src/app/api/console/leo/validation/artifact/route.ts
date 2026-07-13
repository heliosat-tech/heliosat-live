import { getCurrentAdminState } from '@/lib/supabase/admin';
import { readLeoValidationArtifact } from '@/services/leo/leoValidationService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
} as const;

/** Serves only a plot from the latest validated study's opaque, server-built allowlist. */
export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return Response.json({ error: 'Admin required' }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const id = new URL(request.url).searchParams.get('id') ?? '';
  const artifact = await readLeoValidationArtifact(id);
  if (!artifact) {
    return Response.json({ error: 'Scientific artifact unavailable' }, { status: 404, headers: NO_STORE_HEADERS });
  }

  return new Response(artifact.body, {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      'Content-Type': artifact.mediaType,
      'Content-Disposition': 'inline',
    },
  });
}
