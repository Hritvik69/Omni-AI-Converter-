import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  STORAGE_DRIVER: z.enum(["s3", "local"]).default("s3"),
  LOCAL_STORAGE_DIR: z.string().default("./storage"),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().default("omniconvert-local"),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanFromEnv.default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORK_TMP_DIR: z.string().default("./tmp/worker"),
  FFMPEG_BIN: z.string().default("ffmpeg"),
  FFPROBE_BIN: z.string().default("ffprobe"),
  MAGICK_BIN: z.string().default("magick"),
  LIBREOFFICE_BIN: z.string().default("soffice"),
  PANDOC_BIN: z.string().default("pandoc"),
  WKHTMLTOPDF_BIN: z.string().default("wkhtmltopdf"),
  WKHTMLTOIMAGE_BIN: z.string().default("wkhtmltoimage"),
  GHOSTSCRIPT_BIN: z.string().default("gs"),
  TESSERACT_BIN: z.string().default("tesseract"),
  PDFTOPPM_BIN: z.string().default("pdftoppm"),
  PDFTOTEXT_BIN: z.string().default("pdftotext"),
  PDFINFO_BIN: z.string().default("pdfinfo"),
  REALESRGAN_BIN: z.string().optional(),
  REMBG_BIN: z.string().default("rembg"),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("whisper-1"),
  OPENAI_TEXT_MODEL: z.string().default("gpt-4.1-mini"),
  GEMINI_TEXT_MODEL: z.string().default("gemini-2.5-flash")
});

export const env = envSchema.parse(process.env);
