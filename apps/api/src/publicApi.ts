import { Router } from "express";
import { pool } from "./db.js";
import { authenticateApiKey } from "./apiKeys.js";

export const publicApiRouter = Router();
publicApiRouter.use(authenticateApiKey);
publicApiRouter.get("/monitors", async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, url, last_status, last_checked_at, is_paused FROM monitors WHERE workspace_id = $1 ORDER BY name",
    [req.apiKey!.workspace_id],
  );
  res.json({ monitors: result.rows });
});
publicApiRouter.get("/incidents", async (req, res) => {
  const result = await pool.query(
    "SELECT id, monitor_id, title, status, error_message, started_at, resolved_at FROM incidents WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 100",
    [req.apiKey!.workspace_id],
  );
  res.json({ incidents: result.rows });
});
