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
const originalQuery = pool.query;
const secret = "s".repeat(32);
const monitorRow = {
  id: 7,
  name: "Nightly backup",
  url: "heartbeat://nightly",
  monitor_type: "heartbeat",
  heartbeat_token: secret,
  workspace_id: 42,
  interval_seconds: 60,
  is_paused: false,
  created_at: new Date().toISOString(),
};
let server;
let origin;
let currentRole = "owner";

before(async () => {
  pool.query = async (sql) => {
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
    if (sql.startsWith("SELECT * FROM monitors"))
      return { rows: [monitorRow], rowCount: 1 };
    return { rows: [{}], rowCount: 1 };
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

function get(path, role) {
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
    { expiresIn: "5m" },
  );
  return fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

test("viewers never receive heartbeat tokens from the list", async () => {
  const response = await get("/monitors", "viewer");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(secret), false);
  assert.equal("heartbeat_token" in JSON.parse(text).monitors[0], false);
});

test("viewers never receive heartbeat tokens from monitor details", async () => {
  const response = await get("/monitors/7", "viewer");
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(secret), false);
});

test("owners and admins can read the heartbeat token", async () => {
  for (const role of ["owner", "admin"]) {
    const list = await (await get("/monitors", role)).json();
    assert.equal(list.monitors[0].heartbeat_token, secret, role);
    const details = await (await get("/monitors/7", role)).json();
    assert.equal(details.monitor.heartbeat_token, secret, role);
  }
});
