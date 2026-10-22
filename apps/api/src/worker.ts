import "dotenv/config";
import { pool, initDatabase, pruneCheckHistory } from "./db.js";
import {
  createCheckQueue,
  createCheckWorker,
  enqueueDueChecks,
} from "./checkQueue.js";

function integerSetting(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`Invalid ${name}`);
  return value;
}

const pollMs = integerSetting("WORKER_POLL_MS", 10_000, 3_600_000);
const concurrency = integerSetting("WORKER_CONCURRENCY", 5, 50);
const retentionDays = integerSetting("CHECK_RETENTION_DAYS", 30, 3650);
await initDatabase();
const queue = createCheckQueue();
const worker = createCheckWorker({ concurrency });
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = Promise.resolve();
let lastPrunedAt = 0;

// Connection errors can contain credentials or destinations. Log only a code.
function errorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
    ? code
    : "QUEUE_ERROR";
}
queue.on("error", (error) =>
  console.error(`[worker] producer error: ${errorCode(error)}`),
);
worker.on("error", (error) =>
  console.error(`[worker] consumer error: ${errorCode(error)}`),
);
worker.on("failed", (job, error) =>
  console.error(
    `[worker] job ${job?.id ?? "unknown"} failed (attempt ${job?.attemptsMade ?? 0}): ${errorCode(error)}`,
  ),
);
worker.on("stalled", (id) =>
  console.warn(`[worker] recovering stalled job ${id}`),
);
worker.on("completed", (job, result) => {
  if (!result.skipped)
    console.log(`[worker] monitor ${job.data.monitorId}: ${result.status}`);
});

function poll() {
  polling = enqueueDueChecks(queue)
    .then(async () => {
      if (Date.now() - lastPrunedAt < 60 * 60 * 1000) return;
      const removed = await pruneCheckHistory(retentionDays);
      lastPrunedAt = Date.now();
      if (removed) console.log(`[worker] pruned ${removed} check samples`);
    })
    .then(() => undefined)
    .catch((error: unknown) =>
      console.error(`[worker] scheduling failed: ${errorCode(error)}`),
    )
    .finally(() => {
      if (!stopping) timer = setTimeout(poll, pollMs);
    });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  console.log("[worker] draining active jobs");
  // Docker allows 60s. A forced exit leaves a recoverable BullMQ job; PostgreSQL
  // rolls back an uncommitted check when this process's connection closes.
  const deadline = setTimeout(() => process.exit(1), 55_000);
  deadline.unref();
  try {
    await worker.close();
    await polling;
    await queue.close();
    await pool.end();
  } catch (error) {
    console.error(`[worker] shutdown failed: ${errorCode(error)}`);
    process.exit(1);
  } finally {
    clearTimeout(deadline);
  }
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});

await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
if (!stopping) {
  console.log(
    `[worker] Redis queue ready; concurrency=${concurrency}, poll=${pollMs}ms`,
  );
  poll();
}
