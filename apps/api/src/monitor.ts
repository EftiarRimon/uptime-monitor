import { pool } from "./db.js";
import { publicRequest } from "./outbound.js";
import type { PoolClient } from "pg";

export async function checkMonitor(
  id: number | string,
  workspaceId: number | string,
  database: Pick<PoolClient, "query"> = pool,
) {
  const result = await database.query(
    "SELECT id, url FROM monitors WHERE id = $1 AND workspace_id = $2",
    [id, workspaceId],
  );
  if (!result.rowCount) return null;
  const monitor = result.rows[0] as { id: number; url: string };
  const started = Date.now();
  let status: "up" | "down" = "down";
  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  try {
    const response = await publicRequest(monitor.url);
    statusCode = response.status;
    status = response.ok ? "up" : "down";
    if (!response.ok) errorMessage = `HTTP ${response.status}`;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Request failed";
  }
  const responseTime = Date.now() - started;
  const check = await database.query(
    `INSERT INTO monitor_checks (monitor_id, status, status_code, response_time_ms, error_message)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [id, status, statusCode, responseTime, errorMessage],
  );
  await database.query(
    "UPDATE monitors SET last_status = $1, last_checked_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $2 AND workspace_id = $3",
    [status, id, workspaceId],
  );
  return check.rows[0];
}
