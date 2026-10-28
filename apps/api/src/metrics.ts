import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import client from "prom-client";

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});
const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    // Route pattern use kori, raw URL na, jeno token/id diye label explode na kore.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : "unmatched";
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    httpRequests.inc(labels);
    end(labels);
  });
  next();
}

export const metricsRouter = Router();
metricsRouter.get("/", async (_req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});
