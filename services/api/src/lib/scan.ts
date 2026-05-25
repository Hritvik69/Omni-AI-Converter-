import { spawn } from "node:child_process";
import { env } from "../config/env.js";
import { HttpError } from "../http/middleware/errors.js";
import { logger } from "./logger.js";

export async function scanForMalware(localPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(env.CLAMSCAN_BIN, ["--no-summary", localPath], {
      windowsHide: true
    });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (env.CLAMAV_REQUIRED) {
        reject(new HttpError(503, `Malware scanner unavailable: ${error.message}`));
        return;
      }
      logger.warn({ error }, "Malware scanner unavailable; continuing because CLAMAV_REQUIRED=false");
      resolve();
    });

    child.on("close", (code) => {
      if (code === 0) return resolve();
      if (code === 1) return reject(new HttpError(422, "Malware scan failed: infected file rejected"));
      if (env.CLAMAV_REQUIRED) {
        return reject(new HttpError(503, stderr || `Malware scanner exited with code ${code}`));
      }
      logger.warn({ code, stderr }, "Malware scanner failed; continuing because CLAMAV_REQUIRED=false");
      return resolve();
    });
  });
}
