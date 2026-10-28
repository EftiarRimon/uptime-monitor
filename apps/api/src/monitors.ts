import { Router } from "express";
import { randomBytes } from "node:crypto";
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
import { updateIncident } from "./incident.js";
import { notifyIncident } from "./notifications.js";

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
      monitorType = "http",
      intervalSeconds = 60,
    } = req.body as {
      name?: unknown;
      url?: unknown;
      monitorType?: unknown;
      intervalSeconds?: unknown;
    };
    const result = await pool.query(
      "INSERT INTO monitors (workspace_id, name, url, monitor_type, interval_seconds, heartbeat_token) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [
        req.auth!.workspaceId,
        name,
        url,
        monitorType,
        intervalSeconds,
        monitorType === "heartbeat"
          ? randomBytes(24).toString("base64url")
          : null,
      ],
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
    const { name, url, monitorType, intervalSeconds, isPaused } =
      req.body as Record<string, unknown>;
    const result = await pool.query(
      `UPDATE monitors SET name = COALESCE($1, name), url = COALESCE($2, url), monitor_type = COALESCE($3, monitor_type), interval_seconds = COALESCE($4, interval_seconds), is_paused = COALESCE($5, is_paused), updated_at = NOW() WHERE id = $6 AND workspace_id = $7 RETURNING *`,
      [
        name ?? null,
        url ?? null,
        monitorType ?? null,
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
    const event = await updateIncident(
      req.auth!.workspaceId,
      Number(req.params.id),
      check,
    );
    if (event)
      await notifyIncident(
        req.auth!.workspaceId,
        event.incident.id,
        event.event,
        event.incident,
      );
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
