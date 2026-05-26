import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resourceLimits } from "@omniconvert/shared";
import sharp from "sharp";
import { env } from "../config/env.js";
import { runCommand } from "./exec.js";

const zipEocdSignature = 0x06054b50;
const zipCentralDirectorySignature = 0x02014b50;
const zip64Sentinel = 0xffffffff;

function formatBytes(value: number): string {
  return `${Math.round(value / 1024 / 1024)} MB`;
}

export async function readUtf8FileLimited(filePath: string, maxBytes = resourceLimits.maxExtractedTextBytes): Promise<string> {
  const fileStat = await stat(filePath);
  if (fileStat.size > maxBytes) {
    throw new Error(`Text extraction exceeds ${formatBytes(maxBytes)} limit`);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(filePath)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function assertImageWithinLimits(inputPath: string): Promise<void> {
  const metadata = await sharp(inputPath, {
    limitInputPixels: resourceLimits.maxImageInputPixels,
    animated: false
  }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return;
  const pixels = width * height * Math.max(1, metadata.pages ?? 1);
  if (width > resourceLimits.maxOutputDimension || height > resourceLimits.maxOutputDimension) {
    throw new Error(`Image dimensions exceed ${resourceLimits.maxOutputDimension}px limit`);
  }
  if (pixels > resourceLimits.maxImageInputPixels) {
    throw new Error(`Image pixel count exceeds ${resourceLimits.maxImageInputPixels} pixels`);
  }
}

export async function assertPdfWithinLimits(inputPath: string): Promise<void> {
  const result = await runCommand(env.PDFINFO_BIN, [inputPath], {
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024
  });
  const pages = Number(/^\s*Pages:\s+(\d+)/im.exec(result.stdout)?.[1] ?? 0);
  if (pages > resourceLimits.maxPdfPages) {
    throw new Error(`PDF has ${pages} pages; maximum is ${resourceLimits.maxPdfPages}`);
  }

  const sizeMatch = /^\s*Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/im.exec(result.stdout);
  if (sizeMatch) {
    const widthPts = Number(sizeMatch[1]);
    const heightPts = Number(sizeMatch[2]);
    const renderPixels = Math.ceil((widthPts / 72) * 180) * Math.ceil((heightPts / 72) * 180);
    if (renderPixels > resourceLimits.maxOutputPixels) {
      throw new Error("PDF page render size exceeds the maximum pixel count");
    }
  }
}

export async function assertZipArchiveWithinLimits(inputPath: string): Promise<void> {
  const fileStat = await stat(inputPath);
  const file = await open(inputPath, "r");
  try {
    const tailSize = Math.min(fileStat.size, 66_000);
    const tail = Buffer.alloc(tailSize);
    await file.read(tail, 0, tailSize, fileStat.size - tailSize);

    let eocdOffset = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === zipEocdSignature) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("Archive central directory was not found");

    const entries = tail.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entries === 0xffff || centralDirectorySize === zip64Sentinel || centralDirectoryOffset === zip64Sentinel) {
      throw new Error("Zip64 archives are not accepted for conversion preflight");
    }
    if (entries > resourceLimits.maxArchiveEntries) {
      throw new Error(`Archive has ${entries} entries; maximum is ${resourceLimits.maxArchiveEntries}`);
    }
    if (centralDirectorySize > 32 * 1024 * 1024) {
      throw new Error("Archive central directory is too large");
    }

    const directory = Buffer.alloc(centralDirectorySize);
    await file.read(directory, 0, centralDirectorySize, centralDirectoryOffset);
    let offset = 0;
    let totalUncompressed = 0;
    for (let index = 0; index < entries; index += 1) {
      if (directory.readUInt32LE(offset) !== zipCentralDirectorySignature) {
        throw new Error("Archive central directory is invalid");
      }
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      if (compressedSize === zip64Sentinel || uncompressedSize === zip64Sentinel) {
        throw new Error("Zip64 archive entries are not accepted for conversion preflight");
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > resourceLimits.maxArchiveUncompressedBytes) {
        throw new Error(`Archive expands beyond ${formatBytes(resourceLimits.maxArchiveUncompressedBytes)} limit`);
      }
      const fileNameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      offset += 46 + fileNameLength + extraLength + commentLength;
      if (offset > directory.length) throw new Error("Archive central directory is truncated");
    }
  } finally {
    await file.close();
  }
}

export async function assertInputWithinResourceLimits(inputPath: string, format: string): Promise<void> {
  if (["png", "jpg", "jpeg", "webp", "svg", "gif", "bmp", "tiff", "ico", "heic"].includes(format)) {
    await assertImageWithinLimits(inputPath);
  }
  if (format === "pdf") {
    await assertPdfWithinLimits(inputPath);
  }
  if (["pptx", "docx", "epub"].includes(format)) {
    await assertZipArchiveWithinLimits(inputPath);
  }
}
