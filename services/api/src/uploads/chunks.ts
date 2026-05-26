import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { HttpError } from "../http/middleware/errors.js";
import type { UploadSession } from "./session-store.js";

function createByteLimitTransform(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new HttpError(413, "Chunk exceeds configured chunk size"));
        return;
      }
      callback(null, chunk);
    }
  });
}

export async function writeChunkFromRequest(
  req: Request,
  session: UploadSession,
  chunkIndex: number
): Promise<{ sizeBytes: number }> {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new HttpError(422, "Invalid chunk index");
  }
  const maxChunkIndex = Math.ceil(session.fileSize / session.chunkSize) - 1;
  if (chunkIndex > maxChunkIndex) {
    throw new HttpError(422, "Chunk index exceeds expected file size");
  }

  await mkdir(path.join(session.dir, "chunks"), { recursive: true });
  const chunkPath = path.join(session.dir, "chunks", `${chunkIndex}.part`);
  const tempPath = path.join(session.dir, "chunks", `${chunkIndex}.${randomUUID()}.tmp`);
  try {
    await pipeline(req, createByteLimitTransform(session.chunkSize), createWriteStream(tempPath, { flags: "wx" }));
    await rename(tempPath, chunkPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const chunkStat = await stat(chunkPath);

  if (chunkStat.size > session.chunkSize) {
    throw new HttpError(413, "Chunk exceeds configured chunk size");
  }

  return { sizeBytes: chunkStat.size };
}

export async function mergeChunks(session: UploadSession, totalChunks: number): Promise<{
  mergedPath: string;
  sizeBytes: number;
  checksumSha256: string;
}> {
  const chunkDir = path.join(session.dir, "chunks");
  const entries = await readdir(chunkDir);
  if (entries.filter((entry) => entry.endsWith(".part")).length !== totalChunks) {
    throw new HttpError(422, "Missing one or more upload chunks");
  }

  const mergedPath = path.join(session.dir, "complete.bin");
  const output = createWriteStream(mergedPath, { flags: "w" });
  const hash = createHash("sha256");
  let sizeBytes = 0;

  for (let index = 0; index < totalChunks; index += 1) {
    const chunkPath = path.join(chunkDir, `${index}.part`);
    const chunkStat = await stat(chunkPath).catch(() => null);
    if (!chunkStat) throw new HttpError(422, `Missing chunk ${index}`);
    sizeBytes += chunkStat.size;

    await new Promise<void>((resolve, reject) => {
      const input = createReadStream(chunkPath);
      input.on("data", (chunk) => hash.update(chunk));
      input.on("error", reject);
      input.on("end", resolve);
      input.pipe(output, { end: false });
    });
  }

  await new Promise<void>((resolve, reject) => {
    output.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });

  if (sizeBytes !== session.fileSize) {
    throw new HttpError(422, `Merged file size mismatch: expected ${session.fileSize}, got ${sizeBytes}`);
  }

  return {
    mergedPath,
    sizeBytes,
    checksumSha256: hash.digest("hex")
  };
}
