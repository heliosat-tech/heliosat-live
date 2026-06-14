export const dynamic = 'force-static';

/**
 * Human-facing API documentation page. Renders the OpenAPI spec (served at
 * /api/v1/openapi.json) with Redoc, loaded from its CDN — no build dependency.
 * Public and unauthenticated so prospective clients can browse the contract.
 */
const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HELIOSAT Public API — v1</title>
    <link rel="icon" href="data:," />
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <redoc spec-url="/api/v1/openapi.json"></redoc>
    <script src="https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`;

export function GET() {
  return new Response(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
