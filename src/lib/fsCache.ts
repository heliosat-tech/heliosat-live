import { promises as fs } from 'fs';
import path from 'path';

/**
 * Persist a JSON file best-effort. These on-disk caches/stores back INTERNAL,
 * admin-only tools (console/playground), which are "local-only" by design — see
 * ROADMAP decision D2.1 (option A). On a read-only serverless filesystem (e.g.
 * Vercel) the write fails with EROFS/EACCES; we swallow it so the route keeps
 * serving the freshly-computed value instead of 500-ing. A successful persist
 * only happens on a writable filesystem (local dev / a persistent host).
 *
 * Returns true if the file was written, false if the write was skipped/failed.
 */
export async function writeJsonFileBestEffort(
  filePath: string,
  data: unknown,
  options: { pretty?: boolean } = {},
): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, options.pretty ? 2 : undefined), 'utf8');
    return true;
  } catch (err) {
    // Expected in production (read-only FS). Only worth surfacing while developing.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[fsCache] could not persist ${filePath}:`, (err as Error)?.message ?? err);
    }
    return false;
  }
}
