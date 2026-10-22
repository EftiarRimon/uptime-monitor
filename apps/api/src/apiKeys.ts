import crypto from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "./db.js";
import { authenticate, requireRole } from "./auth.js";
import { apiKeyBody, validateBody, validateId } from "./validation.js";
import { sendError } from "./errors.js";

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export const apiKeyRouter = Router();
// Express request augmentation for API-key authenticated public calls.
/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      apiKey?: { id: number; workspace_id: number };
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */
apiKeyRouter.use(authenticate);
apiKeyRouter.param("id", validateId);
apiKeyRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

apiKeyRouter.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, key_prefix, last_used_at, created_at, revoked_at FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC",
    [req.auth!.workspaceId],
  );
  res.json({ keys: result.rows });
});

apiKeyRouter.post(
  "/",
  requireRole("owner", "admin"),
  validateBody(apiKeyBody),
  async (req, res) => {
    const { name } = req.body;
    const raw = `po_${crypto.randomBytes(32).toString("base64url")}`;
    const result = await pool.query(
      "INSERT INTO api_keys (workspace_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4) RETURNING id, name, key_prefix, created_at",
      [req.auth!.workspaceId, name, hash(raw), raw.slice(0, 10)],
    );
    res.status(201).json({
      key: raw,
      metadata: result.rows[0],
      warning: "Store this key now. It will not be shown again.",
    });
  },
);

apiKeyRouter.delete("/:id", requireRole("owner", "admin"), async (req, res) => {
  const result = await pool.query(
    "UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id",
    [Number(req.params.id), req.auth!.workspaceId],
  );
  if (!result.rowCount) return sendError(res, 404, "Active API key not found");
  res.status(204).end();
});

export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const raw = req.headers["x-api-key"];
  if (typeof raw !== "string" || !/^po_[A-Za-z0-9_-]{43}$/.test(raw))
    return sendError(res, 401, "A valid X-API-Key is required");
  const result = await pool.query(
    "SELECT id, workspace_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [hash(raw)],
  );
  if (!result.rowCount)
    return sendError(res, 401, "API key is invalid or revoked");
  req.apiKey = result.rows[0];
  await pool.query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [
    result.rows[0].id,
  ]);
  return next();
}
