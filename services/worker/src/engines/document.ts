import path from "node:path";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ConversionOptions } from "@omniconvert/shared";
import { env } from "../config/env.js";
import { runCommand } from "../lib/exec.js";
import { assertSafeHtmlForImageRender } from "../lib/html-safety.js";
import { readUtf8FileLimited } from "../lib/resource-limits.js";

function isPandocNative(inputFormat: string, targetFormat: string): boolean {
  return (
    ["md", "markdown", "html", "htm", "txt", "docx", "epub"].includes(inputFormat) ||
    ["md", "html", "txt", "docx", "epub"].includes(targetFormat)
  );
}

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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeHtmlForRendering(html: string): string {
  const cleaned = html
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

  if (/<meta\s+[^>]*charset\s*=/i.test(cleaned)) return cleaned;

  const charsetMeta = '<meta charset="utf-8">';
  if (/<head\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head\b([^>]*)>/i, `<head$1>${charsetMeta}`);
  }
  if (/<html\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<html\b([^>]*)>/i, `<html$1><head>${charsetMeta}</head>`);
  }

  return `<!doctype html><html lang="en"><head>${charsetMeta}</head><body>${cleaned}</body></html>`;
}

async function prepareHtmlForRendering(inputPath: string, outputPath: string): Promise<void> {
  const html = await readFile(inputPath, "utf8");
  await writeFile(outputPath, normalizeHtmlForRendering(html), "utf8");
}

async function convertPdfTextOutput(inputPath: string, outputPath: string, targetFormat: string, workDir: string): Promise<void> {
  const textPath = path.join(workDir, "pdf-text.txt");
  await runCommand(env.PDFTOTEXT_BIN, ["-layout", inputPath, textPath], { timeoutMs: 1000 * 60 * 10 });
  const text = (await readUtf8FileLimited(textPath)).trim() || "No selectable text was found in this PDF.";

  if (targetFormat === "txt") {
    await writeFile(outputPath, text, "utf8");
    return;
  }

  if (targetFormat === "html") {
    await writeFile(
      outputPath,
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>PDF Text Export</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`,
      "utf8"
    );
    return;
  }

  const markdownPath = path.join(workDir, "pdf-text.md");
  const markdown = `# PDF Text Export\n\n${text}`;
  if (targetFormat === "md") {
    await writeFile(outputPath, markdown, "utf8");
    return;
  }

  await writeFile(markdownPath, markdown, "utf8");
  await runCommand(env.PANDOC_BIN, [markdownPath, "-o", outputPath], { timeoutMs: 1000 * 60 * 10 });
}

export async function convertHtmlToImage(args: {
  inputPath: string;
  outputPath: string;
  targetFormat: string;
  options: ConversionOptions;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<void> {
  const target = args.targetFormat === "jpeg" ? "jpg" : args.targetFormat;
  if (!["png", "jpg"].includes(target)) {
    throw new Error(`Unsupported HTML image target: ${args.targetFormat}`);
  }

  await assertSafeHtmlForImageRender(args.inputPath);

  const commandArgs = [
    "--disable-local-file-access",
    "--disable-javascript",
    "--load-error-handling",
    "abort",
    "--load-media-error-handling",
    "abort",
    "--format",
    target,
    "--quality",
    String(args.options.quality ?? 90)
  ];

  if (args.options.width) commandArgs.push("--width", String(args.options.width));
  if (args.options.height) commandArgs.push("--height", String(args.options.height));

  await args.onProgress?.(35, "document: rendering html page to image");
  await runCommand(env.WKHTMLTOIMAGE_BIN, [...commandArgs, args.inputPath, args.outputPath], {
    timeoutMs: 1000 * 60 * 10
  });
  await args.onProgress?.(100, "document: html image export complete");
}

async function convertHtmlToPdf(args: {
  inputPath: string;
  outputPath: string;
  workDir: string;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<void> {
  await assertSafeHtmlForImageRender(args.inputPath);

  const normalizedInputPath = path.join(args.workDir, "html-render-input.html");
  await prepareHtmlForRendering(args.inputPath, normalizedInputPath);

  await args.onProgress?.(35, "document: rendering html page to pdf");
  await runCommand(
    env.WKHTMLTOPDF_BIN,
    [
      "--quiet",
      "--disable-local-file-access",
      "--disable-javascript",
      "--encoding",
      "utf-8",
      normalizedInputPath,
      args.outputPath
    ],
    { timeoutMs: 1000 * 60 * 10 }
  );
  await args.onProgress?.(100, "document: html pdf export complete");
}

export async function convertDocument(args: {
  inputPath: string;
  inputFormat: string;
  outputPath: string;
  targetFormat: string;
  workDir: string;
  options: ConversionOptions;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<void> {
  const source = args.inputFormat === "markdown" ? "md" : args.inputFormat;
  const target = args.targetFormat === "markdown" ? "md" : args.targetFormat;
  await args.onProgress?.(10, "document: selecting rendering engine");

  if (source === "pdf" && ["txt", "md", "html", "rtf", "odt", "epub"].includes(target)) {
    await args.onProgress?.(35, "document: extracting pdf text");
    await convertPdfTextOutput(args.inputPath, args.outputPath, target, args.workDir);
    await args.onProgress?.(100, "document: pdf text export complete");
    return;
  }

  if (source === "pdf" && target === "docx") {
    await runCommand(
      env.LIBREOFFICE_BIN,
      libreOfficeArgs(args.workDir, [
        "--headless",
        "--infilter=writer_pdf_import",
        "--convert-to",
        "docx",
        "--outdir",
        args.workDir,
        args.inputPath
      ]),
      { timeoutMs: 1000 * 60 * 10 }
    );
    await moveLibreOfficeOutput(args.workDir, args.inputPath, "docx", args.outputPath);
    await args.onProgress?.(100, "document: pdf imported into docx");
    return;
  }

  if (["html", "htm"].includes(source) && target === "pdf") {
    await convertHtmlToPdf({
      inputPath: args.inputPath,
      outputPath: args.outputPath,
      workDir: args.workDir,
      onProgress: args.onProgress
    });
    return;
  }

  if (isPandocNative(source, target)) {
    const commandArgs = [args.inputPath, "-o", args.outputPath];
    if (target === "pdf") {
      commandArgs.push("--pdf-engine=wkhtmltopdf");
    }
    await args.onProgress?.(40, "document: pandoc rendering");
    await runCommand(env.PANDOC_BIN, commandArgs, { timeoutMs: 1000 * 60 * 10 });
    await args.onProgress?.(100, "document: pandoc complete");
    return;
  }

  await args.onProgress?.(35, "document: libreoffice headless rendering");
  await runCommand(
    env.LIBREOFFICE_BIN,
    libreOfficeArgs(args.workDir, ["--headless", "--convert-to", target, "--outdir", args.workDir, args.inputPath]),
    { timeoutMs: 1000 * 60 * 12 }
  );
  await moveLibreOfficeOutput(args.workDir, args.inputPath, target, args.outputPath);
  await args.onProgress?.(100, "document: libreoffice complete");
}

export async function repairPdf(inputPath: string, outputPath: string): Promise<void> {
  await runCommand(
    env.GHOSTSCRIPT_BIN,
    [
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-sDEVICE=pdfwrite",
      "-dPDFSETTINGS=/prepress",
      `-sOutputFile=${outputPath}`,
      inputPath
    ],
    { timeoutMs: 1000 * 60 * 10 }
  );
}
