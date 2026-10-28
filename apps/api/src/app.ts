import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { monitorRouter } from "./monitors.js";
import { authRouter } from "./auth.js";
import { incidentRouter } from "./incidents.js";
import { notificationRouter } from "./notifications.js";
import { apiKeyRouter } from "./apiKeys.js";
import { publicApiRouter } from "./publicApi.js";
import { statusPageRouter } from "./statusPage.js";
import { openapiRouter } from "./openapi.js";
import { heartbeatRouter } from "./heartbeat.js";
import { webOrigins } from "./authConfig.js";
import { errorHandler, requestContext, sendError } from "./errors.js";

type Limits = {
  api: number;
  auth: number;
  refresh: number;
  checks: number;
  windowMs: number;
};
function positive(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(value) ||
    Number(value) <= 0 ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("Rate limit configuration must be a positive integer");
  return Number(value);
}

export function createApp(overrides: Partial<Limits> = {}) {
  const limits = {
    api: positive(process.env.API_RATE_LIMIT, 300),
    auth: positive(process.env.AUTH_RATE_LIMIT, 20),
    refresh: positive(process.env.REFRESH_RATE_LIMIT, 60),
    checks: positive(process.env.CHECK_RATE_LIMIT, 10),
    windowMs: 60_000,
    ...overrides,
  };
  const app = express();
  app.disable("x-powered-by");
  const proxies = (process.env.TRUSTED_PROXIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  app.set("trust proxy", proxies.length ? proxies : false);
  app.use(requestContext);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(null, !origin || webOrigins.has(origin)),
      credentials: true,
      exposedHeaders: [
        "X-Request-Id",
        "Retry-After",
        "RateLimit",
        "RateLimit-Policy",
      ],
    }),
  );
  const limiter = (limit: number, windowMs = limits.windowMs) =>
    rateLimit({
      limit,
      windowMs,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) =>
        sendError(
          res,
          429,
          `Too many requests. Try again in ${res.getHeader("Retry-After")} seconds.`,
        ),
    });
  const apiLimit = limiter(limits.api);
  const authLimit = limiter(limits.auth, 15 * limits.windowMs);
  const refreshLimit = limiter(limits.refresh);
  const checkLimit = limiter(limits.checks);
  app.use((req, res, next) =>
    /^\/(health|auth\/logout)\/?$/i.test(req.path) || req.method === "OPTIONS"
      ? next()
      : apiLimit(req, res, next),
  );
  app.use((req, res, next) =>
    /^\/auth\/(login|register)\/?$/i.test(req.path) && req.method === "POST"
      ? authLimit(req, res, next)
      : next(),
  );
  app.use((req, res, next) =>
    /^\/auth\/refresh\/?$/i.test(req.path) && req.method === "POST"
      ? refreshLimit(req, res, next)
      : next(),
  );
  app.use((req, res, next) =>
    /^\/monitors\/[^/]+\/check\/?$/i.test(req.path) && req.method === "POST"
      ? checkLimit(req, res, next)
      : next(),
  );
  app.use((req, res, next) => {
    const hasBody =
      req.headers["transfer-encoding"] !== undefined ||
      Number(req.headers["content-length"] ?? 0) > 0;
    if (hasBody && !req.is(["application/json", "application/*+json"]))
      return sendError(res, 415, "Request bodies must use application/json");
    next();
  });
  app.use(
    express.json({
      limit: "16kb",
      type: ["application/json", "application/*+json"],
    }),
  );
  app.get("/", (_req, res) =>
    res.json({
      name: "Uptime Monitoring API",
      status: "ok",
      endpoints: { health: "/health", monitors: "/monitors" },
    }),
  );
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", uptime: process.uptime() }),
  );
  app.use("/openapi.json", openapiRouter);
  app.use(
    ["/monitors", "/incidents", "/notifications", "/api-keys", "/public"],
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
  );
  app.use("/monitors", monitorRouter);
  app.use("/auth", authRouter);
  app.use("/incidents", incidentRouter);
  app.use("/notifications", notificationRouter);
  app.use("/api-keys", apiKeyRouter);
  app.use("/public", publicApiRouter);
  app.use("/status", statusPageRouter);
  app.use("/heartbeat", heartbeatRouter);
  app.use((_req, res) => sendError(res, 404, "Route not found"));
  app.use(errorHandler);
  return app;
}
