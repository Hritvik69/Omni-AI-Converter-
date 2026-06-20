import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const base = path.resolve(env.WORK_TMP_DIR || os.tmpdir());
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, `${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Fix 13: Clean up stale temp directories left behind by crashed worker processes.
 * Scans the base temp directory and removes any subdirectory whose mtime is
 * older than `maxAgeMs`. Called at startup and on a recurring interval.
 */
export async function cleanStaleTempDirs(maxAgeMs: number): Promise<void> {
  const base = path.resolve(env.WORK_TMP_DIR || os.tmpdir());
  try {
    const entries = await readdir(base, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const fullPath = path.join(base, entry.name);
        try {
          const info = await stat(fullPath);
          if (now - info.mtimeMs > maxAgeMs) {
            await rm(fullPath, { recursive: true, force: true });
            logger.info({ path: fullPath }, "Cleaned stale temp directory");
          }
        } catch {
          // Directory may have been removed by a concurrent cleanup — ignore
        }
      })
    );
  } catch (error) {
    logger.warn({ error, base }, "cleanStaleTempDirs: failed to scan base directory");
  }
}
