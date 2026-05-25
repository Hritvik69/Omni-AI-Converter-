import { conversionTargetsFor } from "@omniconvert/shared";

export const formatGroups = {
  image: ["png", "jpg", "jpeg", "webp", "svg", "gif", "bmp", "tiff", "ico", "heic"],
  document: ["pdf", "docx", "doc", "txt", "rtf", "odt", "html", "md", "epub"],
  presentation: ["pptx", "ppt", "pdf", "png", "jpg"],
  video: ["mp4", "mov", "avi", "mkv", "webm", "gif", "flv"],
  audio: ["mp3", "wav", "aac", "flac", "ogg", "m4a"]
} as const;

export function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function defaultTargets(ext: string): string[] {
  return conversionTargetsFor(ext);
}
