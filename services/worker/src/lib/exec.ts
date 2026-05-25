import { spawn } from "node:child_process";

export type RunCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : null;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`));
    });
  });
}
