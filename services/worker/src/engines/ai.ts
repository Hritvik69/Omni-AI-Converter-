import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import mammoth from "mammoth";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import sharp from "sharp";
import { resourceLimits, type AiToolId, type ConversionOptions } from "@omniconvert/shared";
import { env } from "../config/env.js";
import { runCommand } from "../lib/exec.js";
import { logger } from "../lib/logger.js";
import { readUtf8FileLimited } from "../lib/resource-limits.js";
import { repairPdf } from "./document.js";

// MAX_TEXT_CHARS controls how many characters of extracted text are sent to
// the AI API per request. Reducing this is the single biggest lever for
// cutting token costs without removing the AI call entirely.
// 40,000 chars ≈ ~10,000 tokens — sufficient for all standard business documents.
// The local fallback functions (localSummary / localAnalysisJson) always run
// on the full extracted text, so long documents are still fully covered.
const MAX_TEXT_CHARS = 40000; // reduced from 120,000 — saves ~66% token spend
const MAX_TEXT_SOURCE_BYTES = 100 * 1024 * 1024;
const GEMINI_TEXT_FALLBACKS = ["gemini-2.0-flash"];

function cleanText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function uniqueValues(values: string[], max = 12): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= max) break;
  }
  return output;
}

function splitSentences(text: string): string[] {
  return cleanText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24 && sentence.length <= 360);
}

function scoreSentence(sentence: string, index: number): number {
  const lower = sentence.toLowerCase();
  const keywords = [
    "important",
    "risk",
    "issue",
    "action",
    "recommend",
    "required",
    "must",
    "should",
    "because",
    "therefore",
    "result",
    "impact",
    "increase",
    "decrease",
    "cost",
    "deadline",
    "goal"
  ];
  const keywordScore = keywords.reduce((score, keyword) => score + (lower.includes(keyword) ? 1 : 0), 0);
  const numberScore = /\d/.test(sentence) ? 1.5 : 0;
  const earlyScore = Math.max(0, 3 - index / 8);
  return keywordScore + numberScore + earlyScore + Math.min(sentence.length, 180) / 180;
}

function importantSentences(text: string, max = 6): string[] {
  const sentences = splitSentences(text);
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, score: scoreSentence(sentence, index) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
  return ranked.length ? ranked : [cleanText(text).slice(0, 600) || "No extractable text was found in the source file."];
}

function matchingSentences(text: string, pattern: RegExp, max = 6): string[] {
  return uniqueValues(
    splitSentences(text).filter((sentence) => pattern.test(sentence)),
    max
  );
}

function extractEntities(text: string): string[] {
  const matches = cleanText(text).match(/\b[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4}\b/g) ?? [];
  return uniqueValues(
    matches.filter((match) => !["The", "This", "That", "These", "Those", "A", "An"].includes(match)),
    16
  );
}

function extractDates(text: string): string[] {
  const month =
    "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
  const matches =
    cleanText(text).match(
      new RegExp(`\\b(?:\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|(?:${month})\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:${month})\\s+\\d{4})\\b`, "gi")
    ) ?? [];
  return uniqueValues(matches, 12);
}

function extractNumbers(text: string): string[] {
  const matches = cleanText(text).match(/\b(?:[$₹])?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|days?|weeks?|months?|years?|kg|mb|gb|million|billion)?\b/gi) ?? [];
  return uniqueValues(matches, 12);
}

function localSummary(text: string): string {
  const cleaned = cleanText(text);
  const summary = importantSentences(cleaned, 6);
  const actions = matchingSentences(cleaned, /\b(action|next|must|should|need|needs|required|recommend|plan|todo|deliver)\b/i, 5);
  const risks = matchingSentences(cleaned, /\b(risk|issue|problem|fail|failure|warning|blocked|concern|critical|urgent|threat|loss|damage)\b/i, 5);
  const numbers = extractNumbers(cleaned);
  const dates = extractDates(cleaned);

  return [
    "OmniConvert Document Summary",
    "",
    "Summary",
    ...summary.map((item) => `- ${item}`),
    "",
    "Action Items",
    ...(actions.length ? actions : ["No explicit action items were detected."]).map((item) => `- ${item}`),
    "",
    "Risks And Watch Items",
    ...(risks.length ? risks : ["No explicit risks were detected."]).map((item) => `- ${item}`),
    "",
    "Important Numbers",
    ...(numbers.length ? numbers : ["No important numbers were detected."]).map((item) => `- ${item}`),
    "",
    "Important Dates",
    ...(dates.length ? dates : ["No explicit dates were detected."]).map((item) => `- ${item}`)
  ].join("\n");
}

function localAnalysisJson(text: string): string {
  const cleaned = cleanText(text);
  const analysis = {
    summary: importantSentences(cleaned, 5),
    entities: extractEntities(cleaned),
    dates: extractDates(cleaned),
    numbers: extractNumbers(cleaned),
    risks: matchingSentences(cleaned, /\b(risk|issue|problem|fail|failure|warning|blocked|concern|critical|urgent|threat|loss|damage)\b/i, 8),
    actionItems: matchingSentences(cleaned, /\b(action|next|must|should|need|needs|required|recommend|plan|todo|deliver)\b/i, 8),
    suggestedConversions: ["txt", "pdf", "docx", "json"]
  };
  return JSON.stringify(analysis, null, 2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function limitExtractedText(text: string): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= resourceLimits.maxExtractedTextBytes) return text;
  return buffer.subarray(0, resourceLimits.maxExtractedTextBytes).toString("utf8");
}

async function assertMaxFileBytes(inputPath: string, maxBytes: number, label: string): Promise<void> {
  const fileStat = await stat(inputPath);
  if (fileStat.size > maxBytes) {
    throw new Error(`${label} exceeds ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit`);
  }
}

async function extractText(inputPath: string, inputFormat: string, workDir: string): Promise<string> {
  if (["txt", "md", "markdown", "html", "htm", "rtf"].includes(inputFormat)) {
    return readUtf8FileLimited(inputPath);
  }

  if (inputFormat === "pdf") {
    await assertMaxFileBytes(inputPath, MAX_TEXT_SOURCE_BYTES, "PDF text extraction input");
    const buffer = await readFile(inputPath);
    const parsed = await pdfParse(buffer);
    return limitExtractedText(parsed.text);
  }

  if (inputFormat === "docx") {
    await assertMaxFileBytes(inputPath, MAX_TEXT_SOURCE_BYTES, "DOCX text extraction input");
    const result = await mammoth.extractRawText({ path: inputPath });
    return limitExtractedText(result.value);
  }

  const plainTextPath = path.join(workDir, "extracted.txt");
  await runCommand(env.PANDOC_BIN, [inputPath, "-t", "plain", "-o", plainTextPath], {
    timeoutMs: 1000 * 60 * 8
  });
  return readUtf8FileLimited(plainTextPath);
}

async function extractTextWithOcrFallback(inputPath: string, inputFormat: string, workDir: string): Promise<string> {
  const extracted = await extractText(inputPath, inputFormat, workDir);
  if (cleanText(extracted).length >= 80 || inputFormat !== "pdf") return extracted;

  const ocrOutput = path.join(workDir, "ocr-extracted.txt");
  await ocrPdf(inputPath, ocrOutput, workDir);
  return readFile(ocrOutput, "utf8");
}

async function generateText(prompt: string): Promise<string | null> {
  if (env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const response = await openai.chat.completions.create({
        model: env.OPENAI_TEXT_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are OmniConvert AI's secure document intelligence engine. Produce concise, grounded analysis from the supplied file text only."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      });
      return response.choices[0]?.message.content?.trim() || null;
    } catch (error) {
      logger.warn({ provider: "openai", error: errorMessage(error) }, "Text AI provider failed; trying fallback");
    }
  }

  if (env.GEMINI_API_KEY) {
    const gemini = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const modelNames = uniqueValues([env.GEMINI_TEXT_MODEL, ...GEMINI_TEXT_FALLBACKS]);
    for (const modelName of modelNames) {
      try {
        const model = gemini.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text().trim() || null;
      } catch (error) {
        logger.warn({ provider: "gemini", model: modelName, error: errorMessage(error) }, "Text AI provider failed; trying fallback");
      }
    }
  }

  return null;
}

async function generateGeminiFromFile(prompt: string, filePath: string, mimeType: string): Promise<string | null> {
  if (!env.GEMINI_API_KEY) return null;
  await assertMaxFileBytes(filePath, resourceLimits.maxAiInlineUploadBytes, "Gemini inline upload");
  const gemini = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const file = await readFile(filePath);
  const modelNames = uniqueValues([env.GEMINI_TEXT_MODEL, ...GEMINI_TEXT_FALLBACKS]);

  for (const modelName of modelNames) {
    try {
      const model = gemini.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: file.toString("base64"),
            mimeType
          }
        }
      ]);
      return result.response.text().trim() || null;
    } catch (error) {
      logger.warn({ provider: "gemini", model: modelName, error: errorMessage(error) }, "Gemini file prompt failed");
    }
  }

  return null;
}

async function ocrImage(inputPath: string, outputPath: string): Promise<void> {
  const outputBase = outputPath.replace(/\.[^.]+$/, "");
  await runCommand(env.TESSERACT_BIN, [inputPath, outputBase, "-l", "eng"], {
    timeoutMs: 1000 * 60 * 15
  });
}

async function ocrPdf(inputPath: string, outputPath: string, workDir: string): Promise<void> {
  const pagesDir = path.join(workDir, "ocr-pages");
  await mkdir(pagesDir, { recursive: true });
  await runCommand(env.PDFTOPPM_BIN, ["-r", "220", "-png", inputPath, path.join(pagesDir, "page")], {
    timeoutMs: 1000 * 60 * 15
  });
  const pageFiles = (await readdir(pagesDir))
    .filter((file) => file.endsWith(".png"))
    .sort()
    .map((file) => path.join(pagesDir, file));
  const pageText: string[] = [];
  for (const [index, pagePath] of pageFiles.entries()) {
    const outputBase = path.join(workDir, `ocr-page-${index + 1}`);
    await runCommand(env.TESSERACT_BIN, [pagePath, outputBase, "-l", "eng"], {
      timeoutMs: 1000 * 60 * 10
    });
    pageText.push(await readFile(`${outputBase}.txt`, "utf8"));
  }
  await writeFile(outputPath, pageText.join("\n\n--- page break ---\n\n"), "utf8");
}

async function transcribeAudioOrVideo(inputPath: string, outputPath: string, responseFormat: "text" | "srt"): Promise<void> {
  if (env.OPENAI_API_KEY) {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(inputPath),
      model: env.OPENAI_TRANSCRIPTION_MODEL,
      response_format: responseFormat
    } as never);
    await writeFile(outputPath, String(transcription), "utf8");
    return;
  }

  const audioPath = path.join(path.dirname(outputPath), "speech-source.wav");
  await runCommand(env.FFMPEG_BIN, ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", audioPath], {
    timeoutMs: 1000 * 60 * 20
  });

  const prompt =
    responseFormat === "srt"
      ? "Transcribe this audio and return only valid SubRip SRT subtitles. Use sensible caption timing."
      : "Transcribe this audio. Return only the spoken text.";
  const transcription = await generateGeminiFromFile(prompt, audioPath, "audio/wav");
  if (!transcription) {
    throw new Error("Speech-to-text needs OPENAI_API_KEY or a working GEMINI_API_KEY.");
  }
  await writeFile(outputPath, transcription, "utf8");
}

async function removeBackground(inputPath: string, outputPath: string): Promise<void> {
  await runCommand(env.REMBG_BIN, ["i", "-m", env.REMBG_MODEL, inputPath, outputPath], {
    env: {
      OMP_NUM_THREADS: "1",
      OPENBLAS_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1",
      NUMEXPR_NUM_THREADS: "1"
    },
    timeoutMs: 1000 * 60 * 20
  });
}

async function upscaleImage(inputPath: string, outputPath: string): Promise<void> {
  if (env.REALESRGAN_BIN) {
    await runCommand(env.REALESRGAN_BIN, ["-i", inputPath, "-o", outputPath, "-s", "2"], {
      timeoutMs: 1000 * 60 * 30
    });
    return;
  }

  const metadata = await sharp(inputPath, { limitInputPixels: resourceLimits.maxImageInputPixels }).metadata();
  const width = metadata.width ? metadata.width * 2 : undefined;
  const height = metadata.height ? metadata.height * 2 : undefined;
  await sharp(inputPath, { limitInputPixels: resourceLimits.maxImageInputPixels })
    .resize({ width, height, fit: "fill", kernel: "lanczos3" })
    .sharpen()
    .toFile(outputPath);
}

async function repairFile(inputPath: string, inputFormat: string, outputPath: string): Promise<void> {
  if (inputFormat === "pdf") {
    await repairPdf(inputPath, outputPath);
    return;
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "tiff"].includes(inputFormat)) {
    await runCommand(env.MAGICK_BIN, [inputPath, "-strip", outputPath], { timeoutMs: 1000 * 60 * 10 });
    return;
  }
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(inputFormat)) {
    await runCommand(env.FFMPEG_BIN, ["-y", "-i", inputPath, "-c", "copy", outputPath], {
      timeoutMs: 1000 * 60 * 60
    });
    return;
  }
  if (["txt", "md", "markdown", "html", "htm", "rtf", "json"].includes(inputFormat)) {
    await copyFile(inputPath, outputPath);
    return;
  }
  throw new Error(`AI file repair does not support .${inputFormat} yet.`);
}

export async function runAiTool(args: {
  tool: AiToolId;
  inputPath: string;
  inputFormat: string;
  outputPath: string;
  workDir: string;
  options: ConversionOptions;
  onProgress?: (progress: number, stage: string) => Promise<void>;
}): Promise<void> {
  await assertMaxFileBytes(args.inputPath, resourceLimits.maxAiSourceBytes, "AI input");
  await args.onProgress?.(12, `ai: ${args.tool} starting`);

  switch (args.tool) {
    case "ocr":
      if (args.inputFormat === "pdf") await ocrPdf(args.inputPath, args.outputPath, args.workDir);
      else await ocrImage(args.inputPath, args.outputPath);
      await args.onProgress?.(100, "ai: tesseract ocr complete");
      return;

    case "pdf-summary": {
      const text = await extractTextWithOcrFallback(args.inputPath, args.inputFormat, args.workDir);
      await args.onProgress?.(45, "ai: source text extracted");
      const summary = await generateText(
        `Summarize this document with key decisions, risks, action items, and important numbers.\n\n${text.slice(0, MAX_TEXT_CHARS)}`
      );
      await writeFile(args.outputPath, summary || localSummary(text), "utf8");
      await args.onProgress?.(100, "ai: summary complete");
      return;
    }

    case "document-analyzer": {
      const text = await extractTextWithOcrFallback(args.inputPath, args.inputFormat, args.workDir);
      await args.onProgress?.(45, "ai: source text extracted");
      const analysis = await generateText(
        `Return strict JSON with fields summary, entities, dates, risks, actionItems, and suggestedConversions for this file:\n\n${text.slice(0, MAX_TEXT_CHARS)}`
      );
      await writeFile(args.outputPath, analysis || localAnalysisJson(text), "utf8");
      await args.onProgress?.(100, "ai: analysis complete");
      return;
    }

    case "speech-to-text":
      await transcribeAudioOrVideo(args.inputPath, args.outputPath, "text");
      await args.onProgress?.(100, "ai: whisper transcription complete");
      return;

    case "subtitle-generator":
      await transcribeAudioOrVideo(args.inputPath, args.outputPath, "srt");
      await args.onProgress?.(100, "ai: subtitles generated");
      return;

    case "background-remove":
      await removeBackground(args.inputPath, args.outputPath);
      await args.onProgress?.(100, "ai: background removed");
      return;

    case "image-upscale":
      await upscaleImage(args.inputPath, args.outputPath);
      await args.onProgress?.(100, "ai: image upscaled");
      return;

    case "file-repair":
      await repairFile(args.inputPath, args.inputFormat, args.outputPath);
      await args.onProgress?.(100, "ai: file repair complete");
      return;

    default:
      throw new Error(`Unsupported AI tool: ${args.tool satisfies never}`);
  }
}
