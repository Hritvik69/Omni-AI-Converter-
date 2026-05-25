import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../../lib/logger.js";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const notFoundHandler = () => {
  throw new HttpError(404, "Route not found");
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    return res.status(422).json({
      error: "Validation failed",
      details: error.flatten()
    });
  }

  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
      details: error.details
    });
  }

  logger.error({ error }, "Unhandled API error");
  return res.status(500).json({
    error: "Internal server error"
  });
};
