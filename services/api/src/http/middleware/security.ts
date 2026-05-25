import rateLimit from "express-rate-limit";
import { env } from "../../config/env.js";

export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === "production" ? 120 : 2000,
  standardHeaders: true,
  legacyHeaders: false
});

export const uploadRateLimit = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === "production" ? 30 : 500,
  standardHeaders: true,
  legacyHeaders: false
});
