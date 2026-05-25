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
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  CLERK_SECRET_KEY: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanFromEnv.default(false),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024 * 1024),
  UPLOAD_CHUNK_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  UPLOAD_TMP_DIR: z.string().default("./uploads"),
  CLAMAV_REQUIRED: booleanFromEnv.default(false),
  CLAMSCAN_BIN: z.string().default("clamscan")
});

export const env = envSchema.parse(process.env);
export const isProduction = env.NODE_ENV === "production";
