import type { ConversionOptions } from "@omniconvert/shared";
import { env } from "../config/env.js";
import { runCommand } from "../lib/exec.js";

function parseDurationSeconds(ffprobeJson: string): number | null {
  try {
    const parsed = JSON.parse(ffprobeJson) as { format?: { duration?: string } };
    const duration = Number(parsed.format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

function parseFfmpegTime(stderrChunk: string): number | null {
  const match = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderrChunk);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

async function probeDuration(inputPath: string): Promise<number | null> {
  const result = await runCommand(env.FFPROBE_BIN, [
    "-v",
    "error",
    "-show_format",
    "-of",
    "json",
    inputPath
  ]);
  return parseDurationSeconds(result.stdout);
}

function addTrimArgs(args: string[], options: ConversionOptions): void {
  if (!options.trim) return;
  args.push("-ss", String(options.trim.startSeconds));
  if (options.trim.durationSeconds) args.push("-t", String(options.trim.durationSeconds));
}

export async function convertVideo(args: {
  inputPath: string;
  outputPath: string;
  targetFormat: string;
  options: ConversionOptions;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<void> {
  const duration = await probeDuration(args.inputPath);
  await args.onProgress?.(12, "video: ffprobe complete");
  const ffmpegArgs = ["-y"];
  addTrimArgs(ffmpegArgs, args.options);
  ffmpegArgs.push("-i", args.inputPath);

  if (args.options.subtitleUploadId) {
    throw new Error("Subtitle embedding requires the subtitle asset to be materialized by the API before queuing.");
  }

  if (args.options.resolution) {
    ffmpegArgs.push("-vf", `scale=${args.options.resolution.width}:${args.options.resolution.height}`);
  }

  if (args.targetFormat === "gif") {
    ffmpegArgs.push("-vf", args.options.resolution ? `scale=${args.options.resolution.width}:${args.options.resolution.height},fps=12` : "fps=12");
  } else {
    ffmpegArgs.push("-c:v", "libx264", "-preset", "medium");
    if (args.options.videoBitrate || args.options.bitrate) {
      ffmpegArgs.push("-b:v", args.options.videoBitrate ?? args.options.bitrate!);
    } else {
      ffmpegArgs.push("-crf", String(args.options.quality ? Math.max(16, 35 - Math.round(args.options.quality / 5)) : 23));
    }
    ffmpegArgs.push("-c:a", "aac");
    if (args.options.audioBitrate) ffmpegArgs.push("-b:a", args.options.audioBitrate);
  }

  if (args.targetFormat === "webm") {
    ffmpegArgs.splice(ffmpegArgs.indexOf("-c:v") + 1, 1, "libvpx-vp9");
    ffmpegArgs.splice(ffmpegArgs.indexOf("-c:a") + 1, 1, "libopus");
  }

  ffmpegArgs.push(args.outputPath);

  await runCommand(env.FFMPEG_BIN, ffmpegArgs, {
    timeoutMs: 1000 * 60 * 60 * 4,
    onStderr: async (chunk) => {
      const current = parseFfmpegTime(chunk);
      if (duration && current) {
        const progress = 12 + Math.min(83, (current / duration) * 83);
        await args.onProgress?.(progress, "video: ffmpeg transcoding");
      }
    }
  });
  await args.onProgress?.(100, "video: ffmpeg complete");
}

export async function convertAudio(args: {
  inputPath: string;
  outputPath: string;
  targetFormat: string;
  options: ConversionOptions;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<void> {
  const duration = await probeDuration(args.inputPath);
  await args.onProgress?.(12, "audio: ffprobe complete");
  const ffmpegArgs = ["-y"];
  addTrimArgs(ffmpegArgs, args.options);
  ffmpegArgs.push("-i", args.inputPath, "-vn");

  const filters = [];
  if (args.options.normalizeAudio) filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  if (args.options.denoiseAudio) filters.push("afftdn=nf=-25");
  if (filters.length) ffmpegArgs.push("-af", filters.join(","));

  if (args.options.audioBitrate || args.options.bitrate) {
    ffmpegArgs.push("-b:a", args.options.audioBitrate ?? args.options.bitrate!);
  }

  const codecByFormat: Record<string, string> = {
    mp3: "libmp3lame",
    wav: "pcm_s16le",
    aac: "aac",
    flac: "flac",
    ogg: "libvorbis",
    m4a: "aac"
  };
  ffmpegArgs.push("-c:a", codecByFormat[args.targetFormat] ?? "aac", args.outputPath);

  await runCommand(env.FFMPEG_BIN, ffmpegArgs, {
    timeoutMs: 1000 * 60 * 60,
    onStderr: async (chunk) => {
      const current = parseFfmpegTime(chunk);
      if (duration && current) {
        const progress = 12 + Math.min(83, (current / duration) * 83);
        await args.onProgress?.(progress, "audio: ffmpeg transcoding");
      }
    }
  });
  await args.onProgress?.(100, "audio: ffmpeg complete");
}

export async function extractAudio(args: {
  inputPath: string;
  outputPath: string;
  targetFormat: string;
}): Promise<void> {
  await runCommand(env.FFMPEG_BIN, ["-y", "-i", args.inputPath, "-vn", "-c:a", "copy", args.outputPath], {
    timeoutMs: 1000 * 60 * 60
  });
}
