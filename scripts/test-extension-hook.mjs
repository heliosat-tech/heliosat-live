/**
 * ESM resolve hook: lets `node --test` run the repo's `*.test.ts` files, which use
 * extensionless relative imports (the codebase targets `moduleResolution: bundler`).
 * It maps `./foo` -> `./foo.ts` / `./foo.tsx` when such a file exists. Node 22.6+ /
 * Node 26 strips the TypeScript types natively; this only fixes specifier resolution.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HAS_EXTENSION = /\.(?:m|c)?(?:j|t)sx?$/;

export async function resolve(specifier, context, nextResolve) {
  // Mirror tsconfig's `@/* -> ./src/*` mapping so focused service tests can import
  // the same server modules that Next bundles in production.
  if (specifier.startsWith('@/')) {
    const basePath = fileURLToPath(new URL(`../src/${specifier.slice(2)}`, import.meta.url));
    for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`]) {
      if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  if (specifier.startsWith('.') && !HAS_EXTENSION.test(specifier) && context.parentURL) {
    try {
      const basePath = fileURLToPath(new URL(specifier, context.parentURL));
      for (const ext of ['.ts', '.tsx']) {
        if (existsSync(basePath + ext)) {
          return nextResolve(specifier + ext, context);
        }
      }
    } catch {
      // Fall through to Node's default resolution.
    }
  }
  return nextResolve(specifier, context);
}
