import sharp from "sharp";
import type { ConversionOptions } from "@omniconvert/shared";
import { env } from "../config/env.js";
import { runCommand } from "../lib/exec.js";

function needsImageMagick(inputFormat: string, targetFormat: string): boolean {
  return ["ico", "bmp", "heic"].includes(targetFormat) || ["ico", "bmp", "heic"].includes(inputFormat);
}

export async function convertImage(args: {
  inputPath: string;
  inputFormat: string;
  outputPath: string;
  targetFormat: string;
  options: ConversionOptions;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<void> {
  const target = args.targetFormat === "jpg" ? "jpeg" : args.targetFormat;
  await args.onProgress?.(15, "image: metadata loaded");

  if (target === "svg" && args.inputFormat !== "svg") {
    throw new Error("Raster-to-SVG vectorization is intentionally not faked. Use an SVG source or a vectorization worker.");
  }

  if (needsImageMagick(args.inputFormat, args.targetFormat)) {
    const commandArgs = [args.inputPath];
    if (args.options.stripMetadata !== false) commandArgs.push("-strip");
    if (args.options.width || args.options.height) {
      commandArgs.push("-resize", `${args.options.width ?? ""}x${args.options.height ?? ""}`);
    }
    if (args.options.quality) commandArgs.push("-quality", String(args.options.quality));
    commandArgs.push(args.outputPath);
    await runCommand(env.MAGICK_BIN, commandArgs, { timeoutMs: 1000 * 60 * 20 });
    await args.onProgress?.(100, "image: imagemagick complete");
    return;
  }

  let pipeline = sharp(args.inputPath, {
    limitInputPixels: false,
    animated: args.inputFormat === "gif"
  });

  if (args.options.crop) {
    pipeline = pipeline.extract({
      left: args.options.crop.left,
      top: args.options.crop.top,
      width: args.options.crop.width,
      height: args.options.crop.height
    });
  }

  if (args.options.width || args.options.height) {
    pipeline = pipeline.resize({
      width: args.options.width,
      height: args.options.height,
      fit: "inside",
      withoutEnlargement: false
    });
  }

  await args.onProgress?.(45, "image: transformations prepared");

  const quality = args.options.quality ?? 86;
  const compressionLevel = args.options.compressionLevel ?? 8;
  const keepMetadata = args.options.stripMetadata === false;
  if (keepMetadata) pipeline = pipeline.withMetadata();

  switch (target) {
    case "png":
      pipeline = pipeline.png({ compressionLevel, quality, adaptiveFiltering: true });
      break;
    case "jpeg":
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      break;
    case "webp":
      pipeline = pipeline.webp({
        quality,
        lossless: args.options.lossless ?? false,
        smartSubsample: true
      });
      break;
    case "gif":
      pipeline = pipeline.gif({ dither: 1 });
      break;
    case "tiff":
      pipeline = pipeline.tiff({ quality, compression: args.options.lossless ? "lzw" : "jpeg" });
      break;
    case "svg":
      await runCommand(env.MAGICK_BIN, [args.inputPath, args.outputPath], { timeoutMs: 1000 * 60 * 10 });
      await args.onProgress?.(100, "image: svg copied");
      return;
    default:
      throw new Error(`Unsupported image target: ${args.targetFormat}`);
  }

  await pipeline.toFile(args.outputPath);
  await args.onProgress?.(100, "image: sharp pipeline complete");
}
