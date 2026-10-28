/* global fetch */
import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import express from "express";
import { heartbeatRouter } from "../src/heartbeat.ts";
import { checkMonitor } from "../src/monitor.ts";
import { pool } from "../src/db.ts";
import { errorHandler } from "../src/errors.ts";

const app = express();
app.use("/heartbeat", heartbeatRouter);
app.use(errorHandler);
const originalQuery = pool.query;
const goodToken = "a".repeat(32);
let server;
let origin;
let queries = [];
let handler = async () => ({ rows: [], rowCount: 0 });

before(async () => {
  pool.query = async (sql, values) => {
    queries.push({ sql, values });
    return handler(sql, values);
  };
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  pool.query = originalQuery;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
});

test("a valid token records a ping for GET and POST", async () => {
  handler = async () => ({ rows: [], rowCount: 1 });
  for (const method of ["GET", "POST"]) {
    queries = [];
    const response = await fetch(`${origin}/heartbeat/${goodToken}`, {
      method,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].values, [goodToken]);
    assert.match(queries[0].sql, /monitor_type = 'heartbeat'/);
    assert.match(queries[0].sql, /is_paused = FALSE/);
  }
});

test("malformed tokens are rejected before any query", async () => {
  queries = [];
  for (const token of ["short", "a".repeat(65), `${"a".repeat(19)}%21`]) {
    const response = await fetch(`${origin}/heartbeat/${token}`);
    assert.equal(response.status, 404, token);
  }
  assert.equal(queries.length, 0);
});

test("unknown or paused monitors return 404", async () => {
  handler = async () => ({ rows: [], rowCount: 0 });
  const response = await fetch(`${origin}/heartbeat/${goodToken}`);
  assert.equal(response.status, 404);
});

test("a database failure returns a redacted 500 instead of hanging", async () => {
  handler = async () => {
    throw new Error("db down secret-host");
  };
  const response = await fetch(`${origin}/heartbeat/${goodToken}`);
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("secret-host"), false);
});

function heartbeatCheck({ never = false, age, interval = 60 }) {
  handler = async (sql, values) => {
    if (sql.startsWith("SELECT id, url, monitor_type"))
      return {
        rowCount: 1,
        rows: [{ id: 7, url: "heartbeat://x", monitor_type: "heartbeat" }],
      };
    if (sql.includes("last_ping_at IS NULL"))
      return {
        rowCount: 1,
        rows: [{ never, age_seconds: age, interval_seconds: interval }],
      };
    if (sql.includes("INSERT INTO monitor_checks"))
      return {
        rowCount: 1,
        rows: [{ id: 10, status: values[1], error_message: values[4] }],
      };
    return { rowCount: 1, rows: [] };
  };
  return checkMonitor(7, 42);
}

test("heartbeat checks are up while pings arrive within two intervals", async () => {
  assert.equal((await heartbeatCheck({ age: 30 })).status, "up");
  assert.equal((await heartbeatCheck({ age: 120 })).status, "up");
});

test("heartbeat checks go down after two missed intervals", async () => {
  const late = await heartbeatCheck({ age: 121 });
  assert.equal(late.status, "down");
  assert.match(late.error_message, /No heartbeat for 121s/);
});

test("a heartbeat monitor that never pinged reports it clearly", async () => {
  const result = await heartbeatCheck({ never: true, age: 500 });
  assert.equal(result.status, "down");
  assert.match(result.error_message, /No heartbeat received yet/);
});
