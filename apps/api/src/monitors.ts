import { Router } from "express";
import { pool } from "./db.js";
import { checkMonitor } from "./monitor.js";
import { authenticate, requireRole } from "./auth.js";
import { monitorDetails } from "./monitorDetails.js";
import {
  createMonitorBody,
  updateMonitorBody,
  emptyBody,
  validateBody,
  validateId,
} from "./validation.js";
import { sendError } from "./errors.js";

export const monitorRouter = Router();
monitorRouter.use(authenticate);
monitorRouter.param("id", validateId);
monitorRouter.get("/:id", monitorDetails);

monitorRouter.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM monitors WHERE workspace_id = $1 ORDER BY created_at DESC",
    [req.auth!.workspaceId],
  );
  res.json({ monitors: result.rows });
});

monitorRouter.post(
  "/",
  requireRole("owner", "admin"),
  validateBody(createMonitorBody),
  async (req, res) => {
    const {
      name,
      url,
      intervalSeconds = 60,
    } = req.body as {
      name?: unknown;
      url?: unknown;
      intervalSeconds?: unknown;
    };
    const result = await pool.query(
      "INSERT INTO monitors (workspace_id, name, url, interval_seconds) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.auth!.workspaceId, name, url, intervalSeconds],
    );
    res.status(201).json({ monitor: result.rows[0] });
  },
);

monitorRouter.patch(
  "/:id",
  requireRole("owner", "admin"),
  validateBody(updateMonitorBody),
  async (req, res) => {
    const id = Number(req.params.id);
    const { name, url, intervalSeconds, isPaused } = req.body as Record<
      string,
      unknown
    >;
    const result = await pool.query(
      `UPDATE monitors SET name = COALESCE($1, name), url = COALESCE($2, url), interval_seconds = COALESCE($3, interval_seconds), is_paused = COALESCE($4, is_paused), updated_at = NOW() WHERE id = $5 AND workspace_id = $6 RETURNING *`,
      [
        name ?? null,
        url ?? null,
        intervalSeconds ?? null,
        isPaused ?? null,
        id,
        req.auth!.workspaceId,
      ],
    );
    if (!result.rowCount) return sendError(res, 404, "Monitor not found");
    res.json({ monitor: result.rows[0] });
  },
);

monitorRouter.delete(
  "/:id",
  requireRole("owner", "admin"),
  async (req, res) => {
    const result = await pool.query(
      "DELETE FROM monitors WHERE id = $1 AND workspace_id = $2",
      [Number(req.params.id), req.auth!.workspaceId],
    );
    if (!result.rowCount) return sendError(res, 404, "Monitor not found");
    res.status(204).end();
  },
);

monitorRouter.post(
  "/:id/check",
  requireRole("owner", "admin"),
  validateBody(emptyBody),
  async (req, res) => {
    const check = await checkMonitor(
      Number(req.params.id),
      req.auth!.workspaceId,
    );
    if (!check) return sendError(res, 404, "Monitor not found");
    res.json({ check });
  },
);

monitorRouter.get("/:id/checks", async (req, res) => {
  const result = await pool.query(
    "SELECT checks.* FROM monitor_checks checks JOIN monitors monitors ON monitors.id = checks.monitor_id WHERE checks.monitor_id = $1 AND monitors.workspace_id = $2 ORDER BY checks.checked_at DESC LIMIT 100",
    [Number(req.params.id), req.auth!.workspaceId],
  );
  res.json({ checks: result.rows });
});
