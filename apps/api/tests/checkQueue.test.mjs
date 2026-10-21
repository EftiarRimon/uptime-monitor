import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Worker } from "bullmq";
import pg from "pg";
import { pool, initDatabase } from "../src/db.ts";
import {
  createCheckQueue,
  createCheckWorker,
  enqueueDueChecks,
  processScheduledCheck,
  checkJobId,
} from "../src/checkQueue.ts";

test(
  "scheduled checks with PostgreSQL and Redis",
  {
    skip: !process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL,
    timeout: 60000,
  },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `check_queue_test_${suffix}`;
    const config = {
      redisUrl: process.env.TEST_REDIS_URL,
      queueName: `test-monitor-checks-${suffix}`,
    };
    const client = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const workers = new Set();
    const errors = [];
    let fixturePool;
    let queue;
    let schemaCreated = false;
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await client.query(`SET search_path TO "${schema}"`);
      fixturePool = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      pool.query = fixturePool.query.bind(fixturePool);
      pool.connect = fixturePool.connect.bind(fixturePool);
      await initDatabase();
      const workspaces = await client.query(
        "INSERT INTO workspaces (name, slug) VALUES ('Queue A', 'queue-a'), ('Queue B', 'queue-b') RETURNING id",
      );
      const workspaceId = workspaces.rows[0].id;
      const otherWorkspaceId = workspaces.rows[1].id;
      const openQueue = () => {
        const instance = createCheckQueue(config);
        instance.on("error", (error) => errors.push(error));
        return instance;
      };
      queue = openQueue();
      await queue.waitUntilReady();

      const watch = (worker) => {
        workers.add(worker);
        worker.on("error", (error) => errors.push(error));
        return worker;
      };
      const start = () =>
        watch(createCheckWorker({ ...config, concurrency: 2 }));
      const custom = (processor, options = {}) =>
        watch(
          new Worker(config.queueName, processor, {
            connection: { url: config.redisUrl, maxRetriesPerRequest: null },
            concurrency: 1,
            ...options,
          }),
        );
      const stop = async () => {
        await Promise.all([...workers].map((worker) => worker.close()));
        workers.clear();
      };
      const reset = async () => {
        await stop();
        await queue.drain(true);
        await client.query("TRUNCATE monitors CASCADE");
      };
      const payload = async (id) =>
        (
          await client.query(
            `SELECT id::text AS "monitorId", workspace_id::text AS "workspaceId",
      extract(epoch FROM updated_at)::text AS version FROM monitors WHERE id = $1`,
            [id],
          )
        ).rows[0];
      const monitor = async () => {
        // Stored legacy targets exercise the real checker without network traffic.
        const result = await client.query(
          "INSERT INTO monitors (name, url, workspace_id) VALUES ('Fixture', 'http://127.0.0.1', $1) RETURNING id",
          [workspaceId],
        );
        return payload(result.rows[0].id);
      };
      const counts = async () =>
        (
          await client.query(`SELECT
      (SELECT COUNT(*)::int FROM monitor_checks) AS checks,
      (SELECT COUNT(*)::int FROM incidents) AS incidents`)
        ).rows[0];
      const completed = async (job) => {
        const until = Date.now() + 10000;
        while (Date.now() < until) {
          const stored = await queue.getJob(job.id);
          if (stored && (await stored.getState()) === "completed")
            return stored;
          await delay(25);
        }
        assert.fail(`Job ${job.id} did not complete`);
      };

      await t.test(
        "competing schedulers deduplicate jobs and multiple consumers save one check each",
        async () => {
          const first = await monitor();
          const second = await monitor();
          const paused = await monitor();
          const recent = await monitor();
          await client.query(
            "UPDATE monitors SET is_paused = TRUE WHERE id = $1",
            [paused.monitorId],
          );
          await client.query(
            "UPDATE monitors SET last_checked_at = NOW() WHERE id = $1",
            [recent.monitorId],
          );
          const producer = openQueue();
          try {
            await producer.waitUntilReady();
            await Promise.all([
              enqueueDueChecks(queue),
              enqueueDueChecks(producer),
            ]);
            assert.equal(await queue.getWaitingCount(), 2);
            const jobs = await queue.getWaiting();
            assert.ok(
              jobs.every(
                (job) =>
                  Object.keys(job.data).sort().join(",") ===
                  "monitorId,version,workspaceId",
              ),
            );
            const active = [];
            const a = start();
            const b = start();
            for (const worker of [a, b])
              worker.on("active", (job) => active.push(job.id));
            await Promise.all(jobs.map(completed));
            await stop();
            assert.deepEqual(
              active.sort(),
              [checkJobId(first), checkJobId(second)].sort(),
            );
            assert.deepEqual(await counts(), { checks: 2, incidents: 2 });
            assert.equal(await enqueueDueChecks(queue), 0);
          } finally {
            await producer.close();
          }
        },
      );

      await t.test(
        "concurrent deliveries and replay cannot duplicate history or incidents",
        async () => {
          await reset();
          const data = await monitor();
          const results = await Promise.all([
            processScheduledCheck(data),
            processScheduledCheck(data),
          ]);
          assert.equal(results.filter((result) => result.skipped).length, 1);
          assert.deepEqual(await counts(), { checks: 1, incidents: 1 });
          assert.deepEqual(await processScheduledCheck(data), {
            skipped: true,
          });
          const state = (
            await client.query(
              "SELECT last_status, last_checked_at FROM monitors WHERE id = $1",
              [data.monitorId],
            )
          ).rows[0];
          assert.equal(state.last_status, "down");
          assert.ok(state.last_checked_at);
        },
      );

      await t.test(
        "paused, deleted, edited, early, and foreign workspace jobs are skipped",
        async () => {
          await reset();
          const paused = await monitor();
          const deleted = await monitor();
          const edited = await monitor();
          const early = await monitor();
          const foreign = await monitor();
          await client.query(
            "UPDATE monitors SET is_paused = TRUE WHERE id = $1",
            [paused.monitorId],
          );
          await client.query("DELETE FROM monitors WHERE id = $1", [
            deleted.monitorId,
          ]);
          // A one-microsecond change would be lost by converting a pg timestamp to Date.
          await client.query(
            "UPDATE monitors SET updated_at = updated_at + INTERVAL '1 microsecond' WHERE id = $1",
            [edited.monitorId],
          );
          await client.query(
            "UPDATE monitors SET last_checked_at = NOW() WHERE id = $1",
            [early.monitorId],
          );
          for (const data of [
            paused,
            deleted,
            edited,
            early,
            { ...foreign, workspaceId: otherWorkspaceId },
          ]) {
            assert.deepEqual(await processScheduledCheck(data), {
              skipped: true,
            });
          }
          assert.deepEqual(await counts(), { checks: 0, incidents: 0 });
          assert.equal(
            (await processScheduledCheck(await payload(edited.monitorId)))
              .skipped,
            false,
          );
          await assert.rejects(
            processScheduledCheck({ ...foreign, url: "http://127.0.0.1" }),
            /Invalid scheduled check/,
          );
        },
      );

      await t.test(
        "later intervals get a new job ID despite retained completed jobs",
        async () => {
          await reset();
          const first = await monitor();
          await enqueueDueChecks(queue);
          const firstJob = await queue.getJob(checkJobId(first));
          start();
          await completed(firstJob);
          await stop();
          await client.query(
            "UPDATE monitors SET last_checked_at = NOW() - INTERVAL '2 minutes', updated_at = clock_timestamp() WHERE id = $1",
            [first.monitorId],
          );
          const next = await payload(first.monitorId);
          assert.notEqual(checkJobId(first), checkJobId(next));
          await enqueueDueChecks(queue);
          const nextJob = await queue.getJob(checkJobId(next));
          start();
          await completed(nextJob);
          await stop();
          assert.deepEqual(await counts(), { checks: 2, incidents: 1 });
        },
      );

      await t.test(
        "incident write failures roll back check history and monitor state together",
        async () => {
          await reset();
          const data = await monitor();
          await client.query(`CREATE FUNCTION reject_incident() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test incident write failure'; END $$;
        CREATE TRIGGER reject_incident BEFORE INSERT ON incidents FOR EACH ROW EXECUTE FUNCTION reject_incident()`);
          try {
            await assert.rejects(
              processScheduledCheck(data),
              /test incident write failure/,
            );
            assert.deepEqual(await counts(), { checks: 0, incidents: 0 });
            assert.equal(
              (
                await client.query(
                  "SELECT last_checked_at FROM monitors WHERE id = $1",
                  [data.monitorId],
                )
              ).rows[0].last_checked_at,
              null,
            );
          } finally {
            await client.query(
              "DROP TRIGGER reject_incident ON incidents; DROP FUNCTION reject_incident()",
            );
          }
          assert.equal((await processScheduledCheck(data)).skipped, false);
          assert.deepEqual(await counts(), { checks: 1, incidents: 1 });
        },
      );

      await t.test(
        "BullMQ retries a transient database failure without partial results",
        async () => {
          await reset();
          const data = await monitor();
          await client.query(`CREATE SEQUENCE incident_attempt;
        CREATE FUNCTION reject_first_incident() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF nextval('incident_attempt') = 1 THEN RAISE EXCEPTION 'test transient failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_first_incident BEFORE INSERT ON incidents FOR EACH ROW EXECUTE FUNCTION reject_first_incident()`);
          try {
            const job = await queue.add("http-check", data, {
              jobId: checkJobId(data),
            });
            start();
            const stored = await completed(job);
            await stop();
            assert.equal(stored.attemptsMade, 2);
            assert.deepEqual(await counts(), { checks: 1, incidents: 1 });
          } finally {
            await client.query(
              "DROP TRIGGER reject_first_incident ON incidents; DROP FUNCTION reject_first_incident(); DROP SEQUENCE incident_attempt",
            );
          }
        },
      );

      await t.test(
        "retry after a committed check skips the already persisted work",
        async () => {
          await reset();
          const data = await monitor();
          const job = await queue.add("http-check", data, {
            jobId: checkJobId(data),
          });
          let calls = 0;
          custom(async (claimed) => {
            const result = await processScheduledCheck(claimed.data);
            if (++calls === 1) throw new Error("test crash after commit");
            return result;
          });
          const stored = await completed(job);
          await stop();
          assert.equal(stored.attemptsMade, 2);
          assert.deepEqual(stored.returnvalue, { skipped: true });
          assert.deepEqual(await counts(), { checks: 1, incidents: 1 });
        },
      );

      await t.test(
        "an exhausted infrastructure failure can be scheduled again on the next poll",
        async () => {
          await reset();
          const data = await monitor();
          const failing = custom(async () => {
            throw new Error("test exhausted failure");
          });
          const failed = once(failing, "failed");
          await queue.add("http-check", data, {
            jobId: checkJobId(data),
            attempts: 1,
          });
          await failed;
          await stop();
          assert.equal(await queue.getJob(checkJobId(data)), undefined);
          assert.deepEqual(await counts(), { checks: 0, incidents: 0 });
          assert.equal(await enqueueDueChecks(queue), 1);
          const replacement = await queue.getJob(checkJobId(data));
          start();
          await completed(replacement);
          await stop();
          assert.deepEqual(await counts(), { checks: 1, incidents: 1 });
        },
      );

      await t.test(
        "pending jobs survive producer reconnection and consumer replacement",
        async () => {
          await reset();
          const data = await monitor();
          await enqueueDueChecks(queue);
          await queue.close();
          queue = openQueue();
          await queue.waitUntilReady();
          const stored = await queue.getJob(checkJobId(data));
          assert.ok(stored);
          start();
          await completed(stored);
          await stop();
          assert.deepEqual(await counts(), { checks: 1, incidents: 1 });
        },
      );

      await t.test(
        "an abandoned active job is recovered by a replacement worker",
        async () => {
          await reset();
          const data = await monitor();
          // Earlier workers use the production 30s stalled-check interval. Clear
          // only this fixture's throttle key before using a faster recovery clock.
          await (
            await queue.getBackend().client
          ).del(queue.toKey("stalled-check"));
          const abandoned = custom(() => new Promise(() => {}), {
            lockDuration: 500,
            stalledInterval: 100,
            skipLockRenewal: true,
          });
          await abandoned.waitUntilReady();
          const active = once(abandoned, "active");
          const job = await queue.add("http-check", data, {
            jobId: checkJobId(data),
          });
          await active;
          await abandoned.close(true);
          workers.delete(abandoned);
          let recovered = 0;
          custom((claimed) => processScheduledCheck(claimed.data), {
            lockDuration: 1000,
            stalledInterval: 100,
          }).on("stalled", () => {
            recovered += 1;
          });
          await completed(job);
          await stop();
          assert.equal(recovered, 1);
          assert.deepEqual(await counts(), { checks: 1, incidents: 1 });
        },
      );

      await t.test(
        "pagination schedules beyond the first batch without duplicate queued jobs",
        async () => {
          await reset();
          await client.query(
            `INSERT INTO monitors (name, url, workspace_id)
        SELECT 'Batch ' || n, 'http://127.0.0.1', $1 FROM generate_series(1, 251) n`,
            [workspaceId],
          );
          assert.equal(await enqueueDueChecks(queue), 251);
          assert.equal(await queue.getWaitingCount(), 251);
          assert.equal(await enqueueDueChecks(queue), 251);
          assert.equal(await queue.getWaitingCount(), 251);
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      await Promise.all([...workers].map((worker) => worker.close(true)));
      // Only this test's random queue namespace is removed. Never flush Redis.
      if (queue) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      pool.query = originalQuery;
      pool.connect = originalConnect;
      await fixturePool?.end();
      if (schemaCreated) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
      await pool.end();
    }
  },
);
