import { createHash } from "node:crypto";
import { Queue, Worker, UnrecoverableError } from "bullmq";
import { z } from "zod";
import { pool } from "./db.js";
import { checkMonitor } from "./monitor.js";
import { updateIncident } from "./incident.js";
import { notifyIncident } from "./notifications.js";

const scheduledCheck = z.strictObject({
  monitorId: z.string().regex(/^[1-9]\d*$/),
  workspaceId: z.string().regex(/^[1-9]\d*$/),
  version: z.string().regex(/^\d+\.\d+$/),
});
export type ScheduledCheck = z.infer<typeof scheduledCheck>;
type QueueConfig = { redisUrl?: string; queueName?: string };

function connection(
  redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379",
) {
  return { url: redisUrl, maxRetriesPerRequest: 1, connectTimeout: 5000 };
}

export function createCheckQueue({
  redisUrl,
  queueName = "monitor-checks",
}: QueueConfig = {}) {
  return new Queue<ScheduledCheck>(queueName, {
    connection: connection(redisUrl),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      // A terminal infrastructure failure must not prevent the next poll from
      // scheduling this still-due version again. Failures are logged by worker.ts.
      removeOnFail: true,
    },
  });
}

export function createCheckWorker({
  redisUrl,
  queueName = "monitor-checks",
  concurrency = 5,
}: QueueConfig & { concurrency?: number } = {}) {
  return new Worker<ScheduledCheck>(
    queueName,
    (job) => processScheduledCheck(job.data),
    {
      connection: { ...connection(redisUrl), maxRetriesPerRequest: null },
      concurrency,
    },
  );
}

export function checkJobId(data: ScheduledCheck) {
  return `check-${createHash("sha256")
    .update(JSON.stringify([data.workspaceId, data.monitorId, data.version]))
    .digest("hex")}`;
}

export async function enqueueDueChecks(queue: Queue<ScheduledCheck>) {
  let afterId = "0";
  let candidates = 0;
  // Page by ID so a backlog of already-queued monitors cannot starve later IDs.
  for (;;) {
    const result = await pool.query(
      `
      SELECT id::text AS "monitorId", workspace_id::text AS "workspaceId",
             extract(epoch FROM updated_at)::text AS version
      FROM monitors
      WHERE id > $1 AND is_paused = FALSE AND workspace_id IS NOT NULL
        AND (last_checked_at IS NULL OR last_checked_at <= NOW() - interval_seconds * INTERVAL '1 second')
      ORDER BY id LIMIT 250
    `,
      [afterId],
    );
    const rows = result.rows as ScheduledCheck[];
    if (!rows.length) return candidates;
    await queue.addBulk(
      rows.map((data) => ({
        name: "http-check",
        data,
        opts: { jobId: checkJobId(data) },
      })),
    );
    candidates += rows.length;
    afterId = rows[rows.length - 1]!.monitorId;
    if (rows.length < 250) return candidates;
  }
}

export async function processScheduledCheck(input: unknown) {
  const parsed = scheduledCheck.safeParse(input);
  if (!parsed.success) throw new UnrecoverableError("Invalid scheduled check");
  const { monitorId, workspaceId, version } = parsed.data;
  const client = await pool.connect();
  let check;
  let event;
  try {
    await client.query("BEGIN");
    // Keep PostgreSQL's full timestamp precision. JS Date would truncate the
    // microseconds that distinguish successive edits/checks. A row lock makes
    // the version test and history/incident writes atomic across all consumers.
    const current = await client.query(
      `
      SELECT id FROM monitors
      WHERE id = $1 AND workspace_id = $2
        AND extract(epoch FROM updated_at)::text = $3 AND is_paused = FALSE
        AND (last_checked_at IS NULL OR last_checked_at <= clock_timestamp() - interval_seconds * INTERVAL '1 second')
      FOR UPDATE
    `,
      [monitorId, workspaceId, version],
    );
    if (!current.rowCount) {
      await client.query("COMMIT");
      return { skipped: true };
    }
    check = await checkMonitor(monitorId, workspaceId, client);
    if (check)
      event = await updateIncident(workspaceId, monitorId, check, client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  // Delivery remains outside the transaction: outbound notification latency
  // must not hold the monitor lock. A durable alert outbox is a later milestone.
  if (event)
    await notifyIncident(
      workspaceId,
      event.incident.id,
      event.event,
      event.incident,
    );
  return { skipped: false, status: check?.status, checkId: check?.id };
}
