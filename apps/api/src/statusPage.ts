import { Router } from "express";
import { pool } from "./db.js";
import { authenticate, requireRole } from "./auth.js";
import { statusSettingsBody, validateBody } from "./validation.js";
import { sendError } from "./errors.js";

/** Read-only status data intended for an unauthenticated public status page. */
export const statusPageRouter = Router();

statusPageRouter.patch(
  "/settings",
  authenticate,
  requireRole("owner", "admin"),
  validateBody(statusSettingsBody),
  async (req, res) => {
    const { slug, isPublic } = req.body as {
      slug?: string | null;
      isPublic?: boolean;
    };
    try {
      const result = await pool.query(
        `UPDATE workspaces SET status_slug = COALESCE($1, status_slug), status_public = COALESCE($2, status_public)
       WHERE id = $3 RETURNING id, name, slug, status_slug, status_public`,
        [
          slug === null ? null : (slug ?? null),
          isPublic ?? null,
          req.auth!.workspaceId,
        ],
      );
      return res.json({ settings: result.rows[0] });
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        return sendError(res, 409, "That status slug is already in use");
      throw error;
    }
  },
);

statusPageRouter.get("/settings", authenticate, async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, slug, status_slug, status_public FROM workspaces WHERE id = $1",
    [req.auth!.workspaceId],
  );
  if (!result.rowCount) return sendError(res, 404, "Workspace not found");
  return res.json({ settings: result.rows[0] });
});

statusPageRouter.get("/:slug", async (req, res) => {
  const workspace = await pool.query(
    "SELECT id, name, slug, status_slug, status_public FROM workspaces WHERE (status_slug = $1 OR (status_slug IS NULL AND slug = $1)) AND status_public = TRUE",
    [req.params.slug],
  );
  if (!workspace.rowCount)
    return res.status(404).json({ error: "Status page not found" });

  const workspaceId = workspace.rows[0].id;
  const [monitors, incidents] = await Promise.all([
    pool.query(
      `SELECT id, name, last_status, last_checked_at
       FROM monitors
       WHERE workspace_id = $1 AND is_paused = FALSE
       ORDER BY name`,
      [workspaceId],
    ),
    pool.query(
      `SELECT incidents.id, incidents.monitor_id, incidents.title,
              incidents.status, incidents.error_message,
              incidents.started_at, incidents.resolved_at,
              monitors.name AS monitor_name
       FROM incidents
       JOIN monitors ON monitors.id = incidents.monitor_id
       WHERE incidents.workspace_id = $1
       ORDER BY incidents.started_at DESC
       LIMIT 50`,
      [workspaceId],
    ),
  ]);

  const statuses = monitors.rows.map((monitor) => monitor.last_status);
  const overall = statuses.includes("down")
    ? "degraded"
    : statuses.length > 0 && statuses.every((status) => status === "up")
      ? "operational"
      : "pending";

  res.setHeader(
    "Cache-Control",
    "public, max-age=30, stale-while-revalidate=60",
  );
  return res.json({
    workspace: workspace.rows[0],
    status: overall,
    monitors: monitors.rows,
    incidents: incidents.rows,
  });
});
