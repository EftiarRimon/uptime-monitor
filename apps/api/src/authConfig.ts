import type { NextFunction, Request, Response } from "express";
import { sendError } from "./errors.js";

export const webOrigins = new Set(
  (
    process.env.WEB_ORIGINS ??
    "http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3003,http://127.0.0.1:3102"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

export function trustedOrigin(req: Request, res: Response, next: NextFunction) {
  if (req.headers.origin && !webOrigins.has(req.headers.origin))
    return sendError(res, 403, "Request origin is not allowed");
  next();
}
