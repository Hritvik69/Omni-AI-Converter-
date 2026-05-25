export const imageFormats = new Set(["png", "jpg", "jpeg", "webp", "svg", "gif", "bmp", "tiff", "tif", "ico", "heic"]);
export const documentFormats = new Set(["pdf", "docx", "doc", "txt", "rtf", "odt", "html", "htm", "md", "markdown", "epub"]);
export const presentationFormats = new Set(["pptx", "ppt"]);
export const videoFormats = new Set(["mp4", "mov", "avi", "mkv", "webm", "gif", "flv"]);
export const audioFormats = new Set(["mp3", "wav", "aac", "flac", "ogg", "m4a"]);

export function isImage(format: string): boolean {
  return imageFormats.has(format.toLowerCase());
}

export function isDocument(format: string): boolean {
  return documentFormats.has(format.toLowerCase());
}

export function isPresentation(format: string): boolean {
  return presentationFormats.has(format.toLowerCase());
}

export function isVideo(format: string): boolean {
  return videoFormats.has(format.toLowerCase());
}

export function isAudio(format: string): boolean {
  return audioFormats.has(format.toLowerCase());
}

export function normalizeExt(format: string): string {
  const normalized = format.toLowerCase().replace(/^\./, "");
  if (normalized === "jpeg") return "jpg";
  if (normalized === "markdown") return "md";
  if (normalized === "tif") return "tiff";
  return normalized;
}
