import { Router } from "express";
import { pool } from "./db.js";
import { authenticate } from "./auth.js";

export const incidentRouter = Router();
incidentRouter.use(authenticate);
incidentRouter.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT incidents.*, monitors.name AS monitor_name FROM incidents JOIN monitors ON monitors.id = incidents.monitor_id WHERE incidents.workspace_id = $1 ORDER BY incidents.started_at DESC LIMIT 100",
    [req.auth!.workspaceId],
  );
  res.json({ incidents: result.rows });
});
