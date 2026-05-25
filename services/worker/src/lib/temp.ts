import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { env } from "../config/env.js";

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
