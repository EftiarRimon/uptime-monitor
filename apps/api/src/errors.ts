import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { ZodError } from "zod";

type FieldError = { path: string; message: string };
const codes: Record<number, string> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

function requestId(res: Response) {
  const existing = res.getHeader("X-Request-Id");
  const id = typeof existing === "string" ? existing : randomUUID();
  res.setHeader("X-Request-Id", id);
  return id;
}
export const requestContext: RequestHandler = (_req, res, next) => {
  requestId(res);
  next();
};
export function sendError(
  res: Response,
  status: number,
  message: string,
  details?: FieldError[],
) {
  res.setHeader("Cache-Control", "no-store");
  return res
    .status(status)
    .json({
      message,
      code: codes[status] ?? "REQUEST_FAILED",
      requestId: requestId(res),
      ...(details ? { details } : {}),
    });
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req,
  res,
  next,
) => {
  if (res.headersSent) return next(error);
  if (error instanceof ZodError) {
    return sendError(
      res,
      400,
      "Request validation failed",
      error.issues.map((issue) => ({
        path: issue.path.map(String).join(".") || "body",
        message: issue.message,
      })),
    );
  }
  const info = error as { type?: string; code?: string } | null;
  if (info?.type === "entity.parse.failed")
    return sendError(res, 400, "Malformed JSON request body");
  if (info?.type === "entity.too.large")
    return sendError(res, 413, "JSON request body must not exceed 16 KiB");
  if (
    info?.type === "encoding.unsupported" ||
    info?.type === "charset.unsupported"
  )
    return sendError(res, 415, "Unsupported request encoding");
  if (info?.code === "23505")
    return sendError(res, 409, "A record with these values already exists");
  if (info?.code === "23503")
    return sendError(res, 400, "A referenced record is unavailable");
  const unavailable = ["ECONNREFUSED", "ECONNRESET", "57P01", "53300"].includes(
    info?.code ?? "",
  );
  const id = requestId(res);
  // Do not log bodies, credentials, database errors, or connection strings.
  console.error(
    JSON.stringify({
      level: "error",
      requestId: id,
      method: req.method,
      path: req.path,
      code: unavailable ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR",
    }),
  );
  return sendError(
    res,
    unavailable ? 503 : 500,
    unavailable
      ? "Service temporarily unavailable. Try again."
      : "An unexpected error occurred. Try again.",
  );
};
