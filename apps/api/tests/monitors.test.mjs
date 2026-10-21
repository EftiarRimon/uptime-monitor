/* global fetch */
import assert from "node:assert/strict";
import process from "node:process";
import { once } from "node:events";
import { after, before, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { monitorRouter } from "../src/monitors.ts";
import { pool } from "../src/db.ts";
import { errorHandler } from "../src/errors.ts";

const app = express();
app.use(express.json());
app.use("/monitors", monitorRouter);
app.use(errorHandler);
const queries = [];
const originalQuery = pool.query;
let server;
let origin;
let rows = [{ id: 7, workspace_id: 42, is_paused: true }];
let currentRole = "owner";
before(async () => {
  pool.query = async (sql, values) => {
    if (sql.includes("FROM auth_sessions s"))
      return {
        rows: [
          {
            id: 1,
            email: "owner@example.com",
            workspace_id: 42,
            role: currentRole,
          },
        ],
        rowCount: 1,
      };
    queries.push({ sql, values });
    return { rows, rowCount: rows.length };
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
function request(body, role = "owner", id = "7") {
  currentRole = role;
  const token = jwt.sign(
    {
      userId: 1,
      email: "owner@example.com",
      workspaceId: 42,
      role,
      sessionId: "10000000-0000-4000-8000-000000000001",
    },
    process.env.JWT_SECRET ?? "local-development-secret-change-me",
  );
  return fetch(`${origin}/monitors/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
test("invalid changes never issue monitor queries", async () => {
  for (const body of [
    { name: "" },
    { name: 12 },
    { url: "ftp://example.com" },
    { url: null },
    { intervalSeconds: 29 },
    { intervalSeconds: 30.5 },
    { intervalSeconds: "60" },
    { intervalSeconds: 2147483648 },
    { isPaused: "false" },
    { isPaused: null },
  ]) {
    const count = queries.length;
    assert.equal((await request(body)).status, 400, JSON.stringify(body));
    assert.equal(queries.length, count);
  }
  assert.equal((await request({ isPaused: true }, "owner", "-1")).status, 400);
});
test("viewers cannot mutate monitors", async () => {
  const count = queries.length;
  assert.equal((await request({ isPaused: true }, "viewer")).status, 403);
  assert.equal(queries.length, count);
});
test("edit and pause/resume retain the workspace boundary and false values", async () => {
  for (const isPaused of [true, false]) {
    const response = await request(
      {
        name: " API ",
        url: "https://example.com",
        intervalSeconds: 90,
        isPaused,
      },
      "admin",
    );
    assert.equal(response.status, 200);
    assert.match(queries.at(-1).sql, /WHERE id = \$5 AND workspace_id = \$6/);
    assert.deepEqual(queries.at(-1).values, [
      "API",
      "https://example.com",
      90,
      isPaused,
      7,
      42,
    ]);
  }
});
test("a monitor outside the workspace is not found", async () => {
  rows = [];
  assert.equal((await request({ isPaused: true })).status, 404);
});
