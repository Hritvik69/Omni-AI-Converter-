import { z } from "zod";

export const imageFormats = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "svg",
  "gif",
  "bmp",
  "tiff",
  "ico",
  "heic"
] as const;

export const documentFormats = [
  "pdf",
  "docx",
  "doc",
  "txt",
  "rtf",
  "odt",
  "html",
  "md",
  "markdown",
  "epub"
] as const;

export const presentationFormats = ["pptx", "ppt", "pdf", "png", "jpg", "jpeg"] as const;

export const videoFormats = ["mp4", "mov", "avi", "mkv", "webm", "gif", "flv"] as const;

export const audioFormats = ["mp3", "wav", "aac", "flac", "ogg", "m4a"] as const;

export const aiToolIds = [
  "ocr",
  "pdf-summary",
  "speech-to-text",
  "subtitle-generator",
  "image-upscale",
  "background-remove",
  "document-analyzer",
  "file-repair"
] as const;

export const allFormats = [
  ...imageFormats,
  ...documentFormats,
  ...presentationFormats,
  ...videoFormats,
  ...audioFormats
] as const;

export type ImageFormat = (typeof imageFormats)[number];
export type DocumentFormat = (typeof documentFormats)[number];
export type VideoFormat = (typeof videoFormats)[number];
export type AudioFormat = (typeof audioFormats)[number];
export type AiToolId = (typeof aiToolIds)[number];
export type SupportedFormat = (typeof allFormats)[number];

const imageTargets = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "ico", "heic"] as const;
const documentTargets = ["pdf", "docx", "doc", "txt", "rtf", "odt", "html", "md", "epub"] as const;
const documentVisualTargets = ["png", "jpg", "jpeg", "pptx"] as const;
const presentationTargets = ["pdf", "pptx", "ppt", "html", "txt", "md", "docx", "odt", "rtf", "epub", "png", "jpg", "jpeg"] as const;

export function normalizeFormat(format: string): string {
  const normalized = format.trim().toLowerCase().replace(/^\./, "");
  if (normalized === "markdown") return "md";
  if (normalized === "tif") return "tiff";
  return normalized;
}

export function conversionTargetsFor(sourceFormat: string): string[] {
  const source = normalizeFormat(sourceFormat);

  if ((imageFormats as readonly string[]).includes(source)) {
    return imageTargets.filter((target) => target !== source && !(target === "jpeg" && source === "jpg"));
  }

  if ((videoFormats as readonly string[]).includes(source)) {
    return [...videoFormats, ...audioFormats].filter((target) => normalizeFormat(target) !== source);
  }

  if ((audioFormats as readonly string[]).includes(source)) {
    return audioFormats.filter((target) => target !== source);
  }

  if (source === "ppt" || source === "pptx") {
    return presentationTargets.filter((target) => target !== source);
  }

  if ((documentFormats as readonly string[]).includes(source)) {
    return [...documentTargets, ...documentVisualTargets].filter((target) => normalizeFormat(target) !== source);
  }

  return [];
}

export function canConvert(sourceFormat: string, targetFormat: string): boolean {
  const target = normalizeFormat(targetFormat);
  return conversionTargetsFor(sourceFormat).some((candidate) => normalizeFormat(candidate) === target);
}

export const conversionOptionsSchema = z.object({
  lossless: z.boolean().optional(),
  quality: z.number().min(1).max(100).optional(),
  compressionLevel: z.number().min(0).max(9).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  crop: z
    .object({
      left: z.number().int().nonnegative(),
      top: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive()
    })
    .optional(),
  stripMetadata: z.boolean().optional(),
  bitrate: z.string().regex(/^\d+[kKmM]?$/).optional(),
  audioBitrate: z.string().regex(/^\d+[kKmM]?$/).optional(),
  videoBitrate: z.string().regex(/^\d+[kKmM]?$/).optional(),
  resolution: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive()
    })
    .optional(),
  trim: z
    .object({
      startSeconds: z.number().min(0),
      durationSeconds: z.number().positive().optional()
    })
    .optional(),
  normalizeAudio: z.boolean().optional(),
  denoiseAudio: z.boolean().optional(),
  extractAudio: z.boolean().optional(),
  extractFrames: z.boolean().optional(),
  subtitleUploadId: z.string().optional(),
  webhookUrl: z.string().url().optional()
});

export type ConversionOptions = z.infer<typeof conversionOptionsSchema>;

export const createUploadSessionSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  mimeType: z.string().min(1).max(255),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
});

export const completeUploadSchema = z.object({
  totalChunks: z.number().int().positive(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
});

export const createConversionSchema = z.object({
  files: z.array(
    z.object({
      uploadId: z.string().uuid(),
      targetFormat: z.string().trim().toLowerCase(),
      options: conversionOptionsSchema.default({})
    })
  ).min(1).max(100),
  presetId: z.string().uuid().optional()
});

export const createAiJobSchema = z.object({
  uploadId: z.string().uuid(),
  tool: z.enum(aiToolIds),
  options: conversionOptionsSchema.default({})
});

export type CreateUploadSessionInput = z.infer<typeof createUploadSessionSchema>;
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;
export type CreateConversionInput = z.infer<typeof createConversionSchema>;
export type CreateAiJobInput = z.infer<typeof createAiJobSchema>;

export type JobProgressEvent = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  stage: string;
  outputAssetId?: string;
  downloadUrl?: string;
  error?: string;
};
