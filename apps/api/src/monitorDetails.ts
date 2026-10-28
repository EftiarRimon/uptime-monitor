import type { Request, Response } from "express";
import { pool } from "./db.js";
import { historyQuery } from "./validation.js";
import { sendError } from "./errors.js";
import { monitorView } from "./secrets.js";

export async function monitorDetails(req: Request, res: Response) {
  const id = Number(req.params.id);
  const hours = Number(historyQuery.parse(req.query).hours);

  const workspaceId = req.auth!.workspaceId;
  const monitor = await pool.query(
    "SELECT * FROM monitors WHERE id = $1 AND workspace_id = $2",
    [id, workspaceId],
  );
  if (!monitor.rowCount) return sendError(res, 404, "Monitor not found");

  const endsAt = new Date();
  const startsAt = new Date(endsAt.getTime() - hours * 3600_000);
  const bucketSeconds = hours === 24 ? 3600 : hours === 168 ? 21600 : 86400;
  const values = [id, workspaceId, startsAt, endsAt];
  const scopedChecks = `SELECT c.* FROM monitor_checks c JOIN monitors m ON m.id = c.monitor_id
    WHERE m.id = $1 AND m.workspace_id = $2 AND c.checked_at >= $3 AND c.checked_at < $4`;

  const [summary, series, checks, incidents] = await Promise.all([
    pool.query(
      `WITH checks AS (${scopedChecks}) SELECT
      COUNT(*)::int AS "totalChecks",
      COUNT(*) FILTER (WHERE status = 'up')::int AS "successfulChecks",
      COUNT(*) FILTER (WHERE status = 'down')::int AS "failedChecks",
      (100.0 * COUNT(*) FILTER (WHERE status = 'up') / NULLIF(COUNT(*), 0))::double precision AS "uptimePercent",
      (AVG(response_time_ms) FILTER (WHERE status = 'up'))::double precision AS "avgLatencyMs"
      FROM checks`,
      values,
    ),
    pool.query(
      `WITH checks AS (${scopedChecks}), buckets AS (
      SELECT $3::timestamptz + n * ($5 * INTERVAL '1 second') AS bucket_start
      FROM generate_series(0, $6::int - 1) n
    ) SELECT b.bucket_start AS "bucketStart", COUNT(c.id)::int AS "totalChecks",
      (100.0 * COUNT(c.id) FILTER (WHERE c.status = 'up') / NULLIF(COUNT(c.id), 0))::double precision AS "uptimePercent",
      (AVG(c.response_time_ms) FILTER (WHERE c.status = 'up'))::double precision AS "avgLatencyMs"
      FROM buckets b LEFT JOIN checks c ON c.checked_at >= b.bucket_start
        AND c.checked_at < b.bucket_start + ($5 * INTERVAL '1 second')
      GROUP BY b.bucket_start ORDER BY b.bucket_start`,
      [...values, bucketSeconds, (hours * 3600) / bucketSeconds],
    ),
    pool.query(
      `${scopedChecks} ORDER BY c.checked_at DESC, c.id DESC LIMIT 50`,
      values,
    ),
    pool.query(
      `SELECT id, title, status, error_message, started_at, resolved_at FROM incidents
      WHERE monitor_id = $1 AND workspace_id = $2 AND started_at < $4
        AND (resolved_at IS NULL OR resolved_at >= $3)
      ORDER BY started_at DESC, id DESC LIMIT 50`,
      values,
    ),
  ]);

  return res.json({
    monitor: monitorView(monitor.rows[0], req.auth!.role),
    period: { hours, startsAt, endsAt, bucketSeconds },
    summary: summary.rows[0],
    series: series.rows,
    checks: checks.rows,
    incidents: incidents.rows,
  });
}
