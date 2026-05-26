import { spawn } from "node:child_process";

export type RunCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
};

const defaultMaxOutputBytes = 1024 * 1024;

function appendCapped(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const buffer = Buffer.from(combined, "utf8");
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => undefined);
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    const callbackTasks = new Set<Promise<void>>();

    function runCallback(stream: NodeJS.ReadableStream, callback: ((chunk: string) => void | Promise<void>) | undefined, text: string): void {
      if (!callback) return;
      stream.pause();
      const task = Promise.resolve()
        .then(() => callback(text))
        .catch(() => undefined)
        .finally(() => {
          callbackTasks.delete(task);
          stream.resume();
        });
      callbackTasks.add(task);
    }

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            killProcessTree(child.pid);
            reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : null;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = appendCapped(stdout, text, maxOutputBytes);
      runCallback(child.stdout, options.onStdout, text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = appendCapped(stderr, text, maxOutputBytes);
      runCallback(child.stderr, options.onStderr, text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      await Promise.allSettled(callbackTasks);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`));
    });
  });
}
