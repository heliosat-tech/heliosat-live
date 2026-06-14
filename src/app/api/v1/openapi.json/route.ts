import { NextResponse } from 'next/server';
import { openApiDocument } from '@/lib/api/openapi';

export const dynamic = 'force-static';

/**
 * Public, unauthenticated OpenAPI 3.1 description of the v1 API. External clients
 * import this into Postman/Insomnia or generate a client from it. The spec itself
 * is constant, so it is cacheable.
 */
export function GET() {
  return NextResponse.json(openApiDocument, {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Content-Disposition': 'inline; filename="heliosat-openapi-v1.json"',
    },
  });
}
