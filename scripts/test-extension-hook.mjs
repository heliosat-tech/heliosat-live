/**
 * ESM resolve hook: lets `node --test` run the repo's `*.test.ts` files, which use
 * extensionless relative imports (the codebase targets `moduleResolution: bundler`).
 * It maps `./foo` -> `./foo.ts` / `./foo.tsx` when such a file exists. Node 22.6+ /
 * Node 26 strips the TypeScript types natively; this only fixes specifier resolution.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HAS_EXTENSION = /\.(?:m|c)?(?:j|t)sx?$/;

export async function resolve(specifier, context, nextResolve) {
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
