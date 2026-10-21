import { pool } from "./db.js";
import type { PoolClient } from "pg";

export async function updateIncident(
  workspaceId: number | string,
  monitorId: number | string,
  check: { status: "up" | "down"; error_message?: string | null },
  database: Pick<PoolClient, "query"> = pool,
) {
  const open = await database.query(
    "SELECT id FROM incidents WHERE monitor_id = $1 AND workspace_id = $2 AND status = 'open' ORDER BY started_at DESC LIMIT 1",
    [monitorId, workspaceId],
  );
  if (check.status === "down" && !open.rowCount) {
    const created = await database.query(
      "INSERT INTO incidents (workspace_id, monitor_id, title, error_message) VALUES ($1, $2, $3, $4) RETURNING *",
      [
        workspaceId,
        monitorId,
        "Monitor is down",
        check.error_message ?? "Request failed",
      ],
    );
    return { event: "opened" as const, incident: created.rows[0] };
  } else if (check.status === "down" && open.rowCount) {
    await database.query(
      "UPDATE incidents SET error_message = $1, updated_at = NOW() WHERE id = $2",
      [check.error_message ?? "Request failed", open.rows[0].id],
    );
  } else if (check.status === "up" && open.rowCount) {
    const resolved = await database.query(
      "UPDATE incidents SET status = 'resolved', resolved_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
      [open.rows[0].id],
    );
    return { event: "resolved" as const, incident: resolved.rows[0] };
  }
  return null;
}
