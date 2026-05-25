import path from "node:path";
import { fileTypeFromFile } from "file-type";
import { canConvert } from "@omniconvert/shared";
import { HttpError } from "../http/middleware/errors.js";

const extensionToMimePrefixes: Record<string, string[]> = {
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  webp: ["image/webp"],
  svg: ["image/svg+xml", "text/xml", "application/xml", "text/plain"],
  gif: ["image/gif"],
  bmp: ["image/bmp", "image/x-ms-bmp"],
  tiff: ["image/tiff"],
  tif: ["image/tiff"],
  ico: ["image/vnd.microsoft.icon", "image/x-icon"],
  heic: ["image/heic", "image/heif"],
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  doc: ["application/msword", "application/octet-stream"],
  txt: ["text/plain", "application/octet-stream"],
  rtf: ["application/rtf", "text/rtf", "application/octet-stream"],
  odt: ["application/vnd.oasis.opendocument.text"],
  html: ["text/html", "application/xhtml+xml", "text/plain"],
  htm: ["text/html", "application/xhtml+xml", "text/plain"],
  md: ["text/markdown", "text/plain", "application/octet-stream"],
  markdown: ["text/markdown", "text/plain", "application/octet-stream"],
  epub: ["application/epub+zip", "application/zip"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ppt: ["application/vnd.ms-powerpoint", "application/octet-stream"],
  mp4: ["video/mp4"],
  mov: ["video/quicktime", "video/mp4"],
  avi: ["video/x-msvideo", "application/octet-stream"],
  mkv: ["video/x-matroska", "application/octet-stream"],
  webm: ["video/webm"],
  flv: ["video/x-flv", "application/octet-stream"],
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav"],
  aac: ["audio/aac", "application/octet-stream"],
  flac: ["audio/flac", "application/octet-stream"],
  ogg: ["audio/ogg", "application/ogg"],
  m4a: ["audio/mp4", "audio/x-m4a", "video/mp4"]
};

export const supportedInputExtensions = new Set(Object.keys(extensionToMimePrefixes));

export function getExtension(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (!ext) throw new HttpError(422, "Uploaded file must have an extension");
  return ext;
}

export function sanitizeFileName(fileName: string): string {
  return path
    .basename(fileName)
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 180);
}

export async function validateCompletedFile(args: {
  localPath: string;
  originalName: string;
  declaredMimeType: string;
  maxBytes: number;
  sizeBytes: number;
}): Promise<{ extension: string; detectedMimeType: string }> {
  if (args.sizeBytes > args.maxBytes) {
    throw new HttpError(413, "File exceeds maximum upload size");
  }

  const extension = getExtension(args.originalName);
  if (!supportedInputExtensions.has(extension)) {
    throw new HttpError(415, `Unsupported input extension: ${extension}`);
  }

  const detection = await fileTypeFromFile(args.localPath);
  const detectedMimeType = detection?.mime ?? args.declaredMimeType;
  const allowed = extensionToMimePrefixes[extension] ?? [];
  const matches = allowed.some((candidate) => detectedMimeType.startsWith(candidate));

  if (!matches) {
    const isTextFallback =
      ["txt", "md", "markdown", "html", "svg", "rtf"].includes(extension) &&
      (detectedMimeType.startsWith("text/") || detectedMimeType === "application/octet-stream");

    if (!isTextFallback) {
      throw new HttpError(415, `MIME type ${detectedMimeType} does not match .${extension}`);
    }
  }

  return { extension, detectedMimeType };
}

export function assertTargetFormat(targetFormat: string): string {
  const normalized = targetFormat.trim().toLowerCase().replace(/^\./, "");
  if (!supportedInputExtensions.has(normalized) && !["zip", "srt", "vtt"].includes(normalized)) {
    throw new HttpError(415, `Unsupported target format: ${targetFormat}`);
  }
  return normalized;
}

export function assertConversionTarget(sourceFormat: string, targetFormat: string): string {
  const normalized = assertTargetFormat(targetFormat);
  if (!canConvert(sourceFormat, normalized)) {
    throw new HttpError(415, `Unsupported conversion path: ${sourceFormat} -> ${normalized}`);
  }
  return normalized;
}
