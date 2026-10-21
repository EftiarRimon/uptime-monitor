/* global fetch */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import process from "node:process";
import { test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import pg from "pg";
import { monitorRouter } from "../src/monitors.ts";
import { pool, initDatabase } from "../src/db.ts";
import { authRouter } from "../src/auth.ts";
import { errorHandler } from "../src/errors.ts";
import { notificationRouter } from "../src/notifications.ts";

// Opt in to PostgreSQL coverage. Fixtures live in a disposable schema.
test(
  "monitor details against PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const client = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const schema = `monitor_history_test_${randomUUID().replaceAll("-", "")}`;
    const originalQuery = pool.query;
    let server;
    let fixturePool;
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
      await initDatabase();
      const workspaces = await client.query(
        "INSERT INTO workspaces (name, slug) VALUES ('Team A', 'team-a'), ('Team B', 'team-b') RETURNING id",
      );
      const workspaceA = workspaces.rows[0].id;
      const workspaceB = workspaces.rows[1].id;
      const users = await client.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('Viewer', 'viewer@example.com', 'test-only-hash') RETURNING id",
      );
      const userId = users.rows[0].id;
      await client.query(
        "INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'viewer')",
        [userId, workspaceA],
      );
      const sessionId = randomUUID();
      await client.query(
        "INSERT INTO auth_sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')",
        [sessionId, userId, workspaceA],
      );
      const monitors = await client.query(
        "INSERT INTO monitors (name, url, workspace_id) VALUES ('API', 'https://example.com', $1), ('Private', 'https://private.example.com', $2), ('Empty', 'https://empty.example.com', $1), ('Busy', 'https://busy.example.com', $1) RETURNING id",
        [workspaceA, workspaceB],
      );
      const [monitorA, monitorB, emptyMonitor, busyMonitor] = monitors.rows.map(
        (row) => row.id,
      );
      await client.query(
        `INSERT INTO monitor_checks (monitor_id, status, response_time_ms, checked_at)
      SELECT $1, CASE WHEN n % 2 = 0 THEN 'up' ELSE 'down' END, 100, NOW() - n * INTERVAL '1 minute'
      FROM generate_series(1, 120) n`,
        [busyMonitor],
      );
      await client.query(
        `INSERT INTO monitor_checks (monitor_id, status, response_time_ms, checked_at) VALUES
      ($1, 'up', 100, NOW() - INTERVAL '30 minutes'),
      ($1, 'up', 300, NOW() - INTERVAL '20 minutes'),
      ($1, 'down', 10000, NOW() - INTERVAL '10 minutes'),
      ($1, 'down', 10000, NOW() - INTERVAL '2 days'),
      ($1, 'up', 999, NOW() - INTERVAL '31 days'),
      ($2, 'up', 9999, NOW() - INTERVAL '5 minutes')`,
        [monitorA, monitorB],
      );
      await client.query(
        `INSERT INTO incidents (workspace_id, monitor_id, title, status, started_at, resolved_at) VALUES
      ($1, $2, 'Ongoing from before the window', 'open', NOW() - INTERVAL '40 days', NULL),
      ($1, $2, 'Resolved during the window', 'resolved', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 hour'),
      ($1, $2, 'Old resolved incident', 'resolved', NOW() - INTERVAL '4 days', NOW() - INTERVAL '3 days'),
      ($3, $4, 'Private incident', 'open', NOW() - INTERVAL '1 hour', NULL)`,
        [workspaceA, monitorA, workspaceB, monitorB],
      );
      const app = express();
      app.use(express.json());
      app.use("/monitors", monitorRouter);
      app.use("/auth", authRouter);
      app.use("/notifications", notificationRouter);
      app.use(errorHandler);
      server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      const secret =
        process.env.JWT_SECRET ?? "local-development-secret-change-me";
      const token = jwt.sign(
        {
          userId,
          email: "viewer@example.com",
          workspaceId: workspaceA,
          role: "viewer",
          sessionId,
        },
        secret,
      );
      const get = (path, authenticated = true) =>
        fetch(`${origin}/monitors/${path}`, {
          headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
        });

      await t.test(
        "session metadata returns current membership and excludes credentials",
        async () => {
          const response = await fetch(`${origin}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            user: { id: userId, name: "Viewer", email: "viewer@example.com" },
            workspace: { id: workspaceA, name: "Team A", slug: "team-a" },
            role: "viewer",
          });
          await client.query(
            "UPDATE memberships SET role = 'admin' WHERE user_id = $1 AND workspace_id = $2",
            [userId, workspaceA],
          );
          assert.equal(
            (
              await (
                await fetch(`${origin}/auth/me`, {
                  headers: { Authorization: `Bearer ${token}` },
                })
              ).json()
            ).role,
            "admin",
          );
          const foreignToken = jwt.sign(
            { userId, workspaceId: workspaceB, role: "owner", sessionId },
            secret,
          );
          assert.equal(
            (
              await fetch(`${origin}/auth/me`, {
                headers: { Authorization: `Bearer ${foreignToken}` },
              })
            ).status,
            401,
          );
          assert.equal((await fetch(`${origin}/auth/me`)).status, 401);
        },
      );

      await t.test(
        "24-hour metrics use all checks, exclude failed latency, and fill gaps",
        async () => {
          const response = await get(monitorA);
          assert.equal(response.status, 200);
          const data = await response.json();
          assert.equal(data.monitor.id, monitorA);
          assert.equal(data.summary.totalChecks, 3);
          assert.equal(data.summary.failedChecks, 1);
          assert.equal(data.summary.successfulChecks, 2);
          assert.ok(Math.abs(data.summary.uptimePercent - 200 / 3) < 0.001);
          assert.equal(data.summary.avgLatencyMs, 200);
          assert.equal(data.series.length, 24);
          assert.equal(
            data.series.reduce((sum, bucket) => sum + bucket.totalChecks, 0),
            3,
          );
          assert.ok(
            data.series.some(
              (bucket) =>
                bucket.totalChecks === 0 &&
                bucket.uptimePercent === null &&
                bucket.avgLatencyMs === null,
            ),
          );
          assert.equal(data.checks.length, 3);
          assert.equal(data.checks[0].status, "down");
          assert.deepEqual(
            data.incidents.map((incident) => incident.title).sort(),
            ["Ongoing from before the window", "Resolved during the window"],
          );
        },
      );
      await t.test(
        "notification responses omit stored webhook credentials",
        async () => {
          const target = "https://hooks.example.com/private-hook-secret";
          const response = await fetch(`${origin}/notifications/channels`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "Incident hook", target }),
          });
          assert.equal(response.status, 201);
          const created = await response.json();
          assert.equal("target" in created.channel, false);
          const stored = await client.query(
            "SELECT target FROM notification_channels WHERE id = $1",
            [created.channel.id],
          );
          assert.equal(stored.rows[0].target, target);
          const channels = await (
            await fetch(`${origin}/notifications/channels`, {
              headers: { Authorization: `Bearer ${token}` },
            })
          ).json();
          assert.ok(
            channels.channels.every((channel) => !("target" in channel)),
          );
          assert.equal(
            JSON.stringify(channels).includes("private-hook-secret"),
            false,
          );
        },
      );
      await t.test(
        "7-day and 30-day views aggregate their full windows",
        async () => {
          for (const [hours, buckets, bucketSeconds] of [
            [168, 28, 21600],
            [720, 30, 86400],
          ]) {
            const response = await get(`${monitorA}?hours=${hours}`);
            assert.equal(response.status, 200);
            const data = await response.json();
            assert.equal(data.period.bucketSeconds, bucketSeconds);
            assert.equal(data.summary.totalChecks, 4);
            assert.equal(data.summary.uptimePercent, 50);
            assert.equal(data.summary.avgLatencyMs, 200);
            assert.equal(data.series.length, buckets);
            assert.equal(
              data.series.reduce((sum, bucket) => sum + bucket.totalChecks, 0),
              4,
            );
            assert.ok(
              data.series.some(
                (bucket) =>
                  bucket.totalChecks > 0 &&
                  bucket.uptimePercent === 0 &&
                  bucket.avgLatencyMs === null,
              ),
            );
          }
        },
      );
      await t.test(
        "no history is null rather than a claim of perfect uptime",
        async () => {
          const data = await (await get(emptyMonitor)).json();
          assert.equal(data.summary.totalChecks, 0);
          assert.equal(data.summary.uptimePercent, null);
          assert.equal(data.summary.avgLatencyMs, null);
          assert.equal(data.series.length, 24);
          assert.ok(
            data.series.every(
              (bucket) =>
                bucket.totalChecks === 0 && bucket.uptimePercent === null,
            ),
          );
          assert.deepEqual(data.checks, []);
          assert.deepEqual(data.incidents, []);
        },
      );
      await t.test(
        "summary includes history beyond the 50-check display limit",
        async () => {
          const data = await (await get(busyMonitor)).json();
          assert.equal(data.summary.totalChecks, 120);
          assert.equal(data.summary.uptimePercent, 50);
          assert.equal(data.checks.length, 50);
          assert.equal(
            data.series.reduce((sum, bucket) => sum + bucket.totalChecks, 0),
            120,
          );
        },
      );
      await t.test(
        "foreign and missing monitors return the same not-found response",
        async () => {
          for (const id of [monitorB, "999999"]) {
            const response = await get(id);
            assert.equal(response.status, 404);
            const error = await response.json();
            assert.equal(error.message, "Monitor not found");
            assert.equal(error.code, "NOT_FOUND");
            assert.equal(error.requestId, response.headers.get("x-request-id"));
          }
        },
      );
      await t.test(
        "authentication and range validation precede data access",
        async () => {
          assert.equal((await get(monitorA, false)).status, 401);
          for (const path of [
            "invalid",
            "-1",
            `${monitorA}?hours=1`,
            `${monitorA}?hours=24&hours=168`,
          ]) {
            assert.equal((await get(path)).status, 400, path);
          }
        },
      );
    } finally {
      if (server)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      pool.query = originalQuery;
      if (fixturePool) await fixturePool.end();
      if (schemaCreated) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
      await pool.end();
    }
  },
);
