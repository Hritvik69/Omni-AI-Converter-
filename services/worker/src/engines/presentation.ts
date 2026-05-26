import path from "node:path";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import pptxgen from "pptxgenjs";
import sharp from "sharp";
import { resourceLimits, type ConversionOptions } from "@omniconvert/shared";
import { env } from "../config/env.js";
import { runCommand } from "../lib/exec.js";
import { assertPdfWithinLimits, assertZipArchiveWithinLimits, readUtf8FileLimited } from "../lib/resource-limits.js";

type PptxDeck = {
  layout: string;
  author: string;
  subject: string;
  title: string;
  lang: string;
  addSlide: () => {
    background: { color: string };
    addImage: (args: { path: string; x: number; y: number; w: number; h: number }) => void;
  };
  writeFile: (args: { fileName: string }) => Promise<unknown>;
};

async function moveLibreOfficeOutput(outDir: string, inputPath: string, targetFormat: string, outputPath: string) {
  const base = path.basename(inputPath, path.extname(inputPath));
  const generated = path.join(outDir, `${base}.${targetFormat}`);
  await stat(generated);
  await rename(generated, outputPath);
}

function libreOfficeArgs(workDir: string, args: string[]): string[] {
  const profile = pathToFileURL(path.join(workDir, "libreoffice-profile")).href;
  return [`-env:UserInstallation=${profile}`, ...args];
}

async function renderPdfToImages(inputPath: string, outDir: string, targetFormat: "png" | "jpg") {
  await assertPdfWithinLimits(inputPath);
  await mkdir(outDir, { recursive: true });
  await runCommand(
    env.PDFTOPPM_BIN,
    ["-r", "180", targetFormat === "png" ? "-png" : "-jpeg", inputPath, path.join(outDir, "slide")],
    { timeoutMs: 1000 * 60 * 15 }
  );
  const files = (await readdir(outDir))
    .filter((file) => file.endsWith(`.${targetFormat}`))
    .sort()
    .map((file) => path.join(outDir, file));
  if (!files.length) throw new Error("PDF renderer produced no slide images");
  return files;
}

async function ensurePdf(args: {
  inputPath: string;
  inputFormat: string;
  workDir: string;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<string> {
  if (args.inputFormat === "pdf") return args.inputPath;

  const pdfPath = path.join(args.workDir, "slides.pdf");
  await args.onProgress?.(30, "presentation: exporting to pdf");
  await runCommand(
    env.LIBREOFFICE_BIN,
    libreOfficeArgs(args.workDir, ["--headless", "--convert-to", "pdf", "--outdir", args.workDir, args.inputPath]),
    { timeoutMs: 1000 * 60 * 10 }
  );
  await moveLibreOfficeOutput(args.workDir, args.inputPath, "pdf", pdfPath);
  return pdfPath;
}

async function extractPdfText(pdfPath: string, outputPath: string): Promise<string> {
  await assertPdfWithinLimits(pdfPath);
  await runCommand(env.PDFTOTEXT_BIN, ["-layout", pdfPath, outputPath], { timeoutMs: 1000 * 60 * 10 });
  return readUtf8FileLimited(outputPath);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function cleanExtractedText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slideNumber(fileName: string): number {
  const match = /slide(\d+)\.xml$/i.exec(fileName);
  return match ? Number(match[1]) : 0;
}

async function extractPptxText(inputPath: string): Promise<string> {
  await assertZipArchiveWithinLimits(inputPath);
  const archive = unzipSync(new Uint8Array(await readFile(inputPath)));
  const decoder = new TextDecoder("utf-8");
  const slideFiles = Object.keys(archive)
    .filter((file) => /^ppt\/slides\/slide\d+\.xml$/i.test(file))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides = slideFiles.map((file, index) => {
    const xml = decoder.decode(archive[file]);
    const pieces = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXmlText(match[1] ?? "").trim())
      .filter(Boolean);

    return [`Slide ${index + 1}`, ...pieces].join("\n");
  });

  return cleanExtractedText(slides.filter(Boolean).join("\n\n"));
}

async function extractPresentationText(args: {
  inputPath: string;
  inputFormat: string;
  workDir: string;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<string> {
  if (args.inputFormat === "pptx") {
    const text = await extractPptxText(args.inputPath);
    if (text) return text;
  }

  if (args.inputFormat === "ppt") {
    const pptxPath = path.join(args.workDir, "legacy-presentation.pptx");
    await args.onProgress?.(35, "presentation: upgrading ppt for text extraction");
    await runCommand(
      env.LIBREOFFICE_BIN,
      libreOfficeArgs(args.workDir, ["--headless", "--convert-to", "pptx", "--outdir", args.workDir, args.inputPath]),
      { timeoutMs: 1000 * 60 * 10 }
    );
    await moveLibreOfficeOutput(args.workDir, args.inputPath, "pptx", pptxPath);
    const text = await extractPptxText(pptxPath);
    if (text) return text;
  }

  const pdfPath = await ensurePdf(args);
  return cleanExtractedText(await extractPdfText(pdfPath, path.join(args.workDir, "slides.txt")));
}

async function writeSlidesHtml(images: string[], outputPath: string, transcript?: string): Promise<void> {
  const slides = await Promise.all(
    images.map(async (image, index) => {
      const bytes = await readFile(image);
      return `<section class="slide"><h2>Slide ${index + 1}</h2><img src="data:image/png;base64,${bytes.toString("base64")}" alt="Slide ${index + 1}" /></section>`;
    })
  );
  const transcriptSection = transcript
    ? `<section class="transcript"><h2>Extracted Text</h2><pre>${escapeHtml(transcript)}</pre></section>`
    : "";
  await writeFile(
    outputPath,
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "<title>OmniConvert Presentation Export</title>",
      "<style>",
      "body{margin:0;background:#111827;color:#f8fafc;font-family:Arial,sans-serif;}",
      ".slide{min-height:100vh;display:grid;gap:16px;place-items:center;padding:32px;box-sizing:border-box;}",
      "h2{margin:0;font-size:18px;color:#94a3b8;}",
      "img{max-width:100%;max-height:calc(100vh - 120px);box-shadow:0 24px 80px rgba(0,0,0,.35);background:white;}",
      ".transcript{padding:40px;max-width:960px;margin:auto;}",
      ".transcript pre{white-space:pre-wrap;line-height:1.6;background:#020617;padding:24px;border-radius:8px;}",
      "</style>",
      "</head>",
      "<body>",
      ...slides,
      transcriptSection,
      "</body>",
      "</html>"
    ].join("\n"),
    "utf8"
  );
}

async function stitchImages(images: string[], outputPath: string, targetFormat: "png" | "jpg"): Promise<void> {
  const metadata = await Promise.all(images.map((image) => sharp(image).metadata()));
  const width = Math.max(...metadata.map((item) => item.width ?? 0));
  if (!width) throw new Error("Rendered slide images have no dimensions");

  const prepared = await Promise.all(
    images.map(async (image, index) => {
      const item = metadata[index]!;
      const height = Math.max(1, Math.round(((item.height ?? width) * width) / (item.width ?? width)));
      return {
        input: await sharp(image)
          .resize({ width, height, fit: "contain", background: "#ffffff" })
          .flatten({ background: "#ffffff" })
          .toBuffer(),
        height
      };
    })
  );

  let top = 0;
  const composite = prepared.map((item) => {
    const layer = { input: item.input, left: 0, top };
    top += item.height;
    return layer;
  });
  if (width * top > resourceLimits.maxOutputPixels || width > resourceLimits.maxOutputDimension || top > resourceLimits.maxOutputDimension) {
    throw new Error("Rendered slide image exceeds output dimension or pixel limits");
  }

  let output = sharp({
    create: {
      width,
      height: top,
      channels: 3,
      background: "#ffffff"
    }
  }).composite(composite);

  output = targetFormat === "jpg" ? output.jpeg({ quality: 90 }) : output.png({ compressionLevel: 8 });
  await output.toFile(outputPath);
}

async function writeTextDocument(textInput: string, outputPath: string, targetFormat: string, workDir: string): Promise<void> {
  const text = cleanExtractedText(textInput);
  const normalizedText = text || "No selectable text was found in this presentation.";

  if (targetFormat === "txt") {
    await writeFile(outputPath, normalizedText, "utf8");
    return;
  }

  const markdownPath = path.join(workDir, "slides.md");
  const markdown = [
    "# Presentation Text Export",
    "",
    ...normalizedText
      .split(/\f|\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk, index) => `## Section ${index + 1}\n\n${chunk}`)
  ].join("\n\n");

  if (targetFormat === "md") {
    await writeFile(outputPath, markdown, "utf8");
    return;
  }

  await writeFile(markdownPath, markdown, "utf8");
  await runCommand(env.PANDOC_BIN, [markdownPath, "-o", outputPath], { timeoutMs: 1000 * 60 * 10 });
}

export async function pdfToPptx(inputPath: string, outputPath: string, workDir: string): Promise<void> {
  const images = await renderPdfToImages(inputPath, path.join(workDir, "pdf-pages"), "png");
  const PptxGen = pptxgen as unknown as { new (): PptxDeck };
  const deck = new PptxGen();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "OmniConvert AI";
  deck.subject = "PDF converted into image-backed PowerPoint slides";
  deck.title = path.basename(outputPath);
  deck.lang = "en-US";
  for (const image of images) {
    const slide = deck.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addImage({ path: image, x: 0, y: 0, w: 13.333, h: 7.5 });
  }
  await deck.writeFile({ fileName: outputPath });
}

export async function convertPresentation(args: {
  inputPath: string;
  inputFormat: string;
  outputPath: string;
  targetFormat: string;
  workDir: string;
  options: ConversionOptions;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<void> {
  const target = args.targetFormat === "jpeg" ? "jpg" : args.targetFormat;
  await args.onProgress?.(10, "presentation: selecting rendering path");

  if (args.inputFormat === "pdf" && target === "pptx") {
    await args.onProgress?.(30, "presentation: rendering pdf pages");
    await pdfToPptx(args.inputPath, args.outputPath, args.workDir);
    await args.onProgress?.(100, "presentation: pptx generated");
    return;
  }

  if (["png", "jpg"].includes(target)) {
    const pdfPath = await ensurePdf(args);
    const imageFormat = target as "png" | "jpg";
    const images = await renderPdfToImages(pdfPath, path.join(args.workDir, "slides-images"), imageFormat);
    await stitchImages(images, args.outputPath, imageFormat);
    await args.onProgress?.(100, "presentation: slide image export complete");
    return;
  }

  if (target === "html") {
    const pdfPath = await ensurePdf(args);
    const images = await renderPdfToImages(pdfPath, path.join(args.workDir, "slides-html"), "png");
    const transcript = await extractPresentationText(args);
    await writeSlidesHtml(images, args.outputPath, transcript);
    await args.onProgress?.(100, "presentation: html export complete");
    return;
  }

  if (["txt", "md", "docx", "odt", "rtf", "epub"].includes(target)) {
    await args.onProgress?.(55, "presentation: extracting slide text");
    const text = await extractPresentationText(args);
    await writeTextDocument(text, args.outputPath, target, args.workDir);
    await args.onProgress?.(100, "presentation: document export complete");
    return;
  }

  await args.onProgress?.(40, "presentation: libreoffice headless export");
  await runCommand(
    env.LIBREOFFICE_BIN,
    libreOfficeArgs(args.workDir, ["--headless", "--convert-to", target, "--outdir", args.workDir, args.inputPath]),
    { timeoutMs: 1000 * 60 * 12 }
  );
  await moveLibreOfficeOutput(args.workDir, args.inputPath, target, args.outputPath);
  await args.onProgress?.(100, "presentation: libreoffice complete");
}
