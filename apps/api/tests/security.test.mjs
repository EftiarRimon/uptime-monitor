/* global fetch */
import assert from "node:assert/strict";
import console from "node:console";
import { once } from "node:events";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.ts";
import { pool } from "../src/db.ts";

const limits = { api: 1000, auth: 1000, refresh: 1000, checks: 1000 };
async function withApp(overrides, run) {
  const server = createApp({ ...limits, ...overrides }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function errorBody(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(typeof body.message, "string");
  assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  assert.equal("stack" in body, false);
  return body;
}

test("API security middleware and schemas", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  let statements = [];
  let databaseError = null;
  pool.connect = async () => {
    throw new Error("Unexpected database connection in validation test");
  };
  pool.query = async (sql, values) => {
    if (databaseError) throw databaseError;
    if (sql.includes("FROM auth_sessions s"))
      return {
        rows: [
          {
            id: 1,
            email: "owner@example.com",
            workspace_id: 42,
            role: "owner",
          },
        ],
        rowCount: 1,
      };
    statements.push({ sql, values });
    return { rows: [], rowCount: 0 };
  };
  const token = jwt.sign(
    {
      userId: 1,
      workspaceId: 42,
      role: "owner",
      sessionId: "10000000-0000-4000-8000-000000000001",
    },
    process.env.JWT_SECRET ?? "local-development-secret-change-me",
  );
  try {
    await withApp({}, async (origin) => {
      const json = (path, body, method = "POST") =>
        fetch(origin + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

      await t.test(
        "Helmet and request identifiers apply to success and unknown routes",
        async () => {
          const response = await fetch(origin + "/health");
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-powered-by"), null);
          assert.equal(
            response.headers.get("x-content-type-options"),
            "nosniff",
          );
          assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
          assert.equal(response.headers.get("referrer-policy"), "no-referrer");
          assert.match(
            response.headers.get("content-security-policy"),
            /frame-ancestors/,
          );
          assert.ok(response.headers.get("x-request-id"));
          await errorBody(await fetch(origin + "/missing"), 404, "NOT_FOUND");
        },
      );
      await t.test(
        "credentialed CORS allows configured origins and blocks cookie changes from others",
        async () => {
          const response = await fetch(origin + "/health", {
            headers: { Origin: "http://localhost:3002" },
          });
          assert.equal(
            response.headers.get("access-control-allow-origin"),
            "http://localhost:3002",
          );
          assert.equal(
            response.headers.get("access-control-allow-credentials"),
            "true",
          );
          const rejected = await fetch(origin + "/auth/logout", {
            method: "POST",
            headers: { Origin: "https://untrusted.example" },
          });
          await errorBody(rejected, 403, "FORBIDDEN");
          assert.equal(
            rejected.headers.get("access-control-allow-origin"),
            null,
          );
          const preflight = await fetch(origin + "/monitors", {
            method: "OPTIONS",
            headers: {
              Origin: "http://localhost:3002",
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "authorization,content-type",
            },
          });
          assert.equal(preflight.status, 204);
          assert.match(
            preflight.headers.get("access-control-allow-headers"),
            /authorization/i,
          );
        },
      );
      await t.test(
        "malformed JSON, unsupported media, and oversized payloads return JSON errors",
        async () => {
          await errorBody(
            await fetch(origin + "/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{",
            }),
            400,
            "VALIDATION_ERROR",
          );
          await errorBody(
            await fetch(origin + "/auth/login", {
              method: "POST",
              headers: { "Content-Type": "text/plain" },
              body: "credentials",
            }),
            415,
            "UNSUPPORTED_MEDIA_TYPE",
          );
          await errorBody(
            await json("/auth/login", { email: "x".repeat(17000) }),
            413,
            "PAYLOAD_TOO_LARGE",
          );
        },
      );
      await t.test(
        "monitor schemas reject coercion, blank fields, credentials, and unknown fields before SQL",
        async () => {
          statements = [];
          const base = { name: "API", url: "https://example.com" };
          for (const body of [
            undefined,
            null,
            [],
            {},
            { ...base, name: " " },
            { ...base, intervalSeconds: "60" },
            { ...base, intervalSeconds: 30.5 },
            { ...base, workspaceId: 99 },
            { ...base, url: "ftp://example.com" },
            { ...base, url: "https://user:secret@example.com" },
            { ...base, url: "http://127.1" },
            { ...base, url: "http://169.254.169.254" },
            { ...base, url: "http://[::ffff:127.0.0.1]" },
            { ...base, name: "x".repeat(121) },
          ]) {
            await errorBody(
              await json("/monitors", body),
              400,
              "VALIDATION_ERROR",
            );
          }
          for (const body of [
            {},
            { isPaused: "false" },
            { intervalSeconds: null },
            { role: "owner" },
            { url: "http://localhost" },
          ])
            await errorBody(
              await json("/monitors/7", body, "PATCH"),
              400,
              "VALIDATION_ERROR",
            );
          assert.equal(statements.length, 0);
        },
      );
      await t.test(
        "invalid IDs and history queries never reach resource SQL",
        async () => {
          statements = [];
          for (const [path, method] of [
            ["/monitors/-1", "DELETE"],
            ["/monitors/1e3/checks", "GET"],
            ["/monitors/9007199254740992", "GET"],
            ["/api-keys/invalid", "DELETE"],
            ["/notifications/channels/1.5", "DELETE"],
            ["/monitors/7?hours=24&hours=168", "GET"],
            ["/monitors/7?hours=0x18", "GET"],
          ]) {
            await errorBody(
              await json(path, undefined, method),
              400,
              "VALIDATION_ERROR",
            );
          }
          assert.equal(statements.length, 0);
        },
      );
      await t.test(
        "registration validates email, password bytes, names, and extra properties",
        async () => {
          const base = {
            name: "Alex",
            workspaceName: "Acme",
            email: "alex@example.com",
            password: "test-password",
          };
          for (const body of [
            null,
            [],
            { ...base, name: " " },
            { ...base, email: "not-email" },
            { ...base, password: "short" },
            { ...base, password: "é".repeat(37) },
            { ...base, role: "owner" },
          ]) {
            const result = await errorBody(
              await json("/auth/register", body),
              400,
              "VALIDATION_ERROR",
            );
            if (body !== null) assert.ok(result.details.length);
            assert.equal(
              JSON.stringify(result).includes("test-password"),
              false,
            );
          }
          await errorBody(
            await json("/auth/refresh", {
              refreshToken: "not-accepted-in-JSON",
            }),
            400,
            "VALIDATION_ERROR",
          );
        },
      );
      await t.test(
        "channel targets and API key names are strictly validated",
        async () => {
          statements = [];
          for (const body of [
            {
              type: "email",
              name: "Email",
              target: "a@example.com,b@example.com",
            },
            { type: "webhook", name: " ", target: "https://example.com" },
            { type: "webhook", name: "Hook", target: "file:///tmp/secret" },
            {
              type: "webhook",
              name: "Internal hook",
              target: "http://10.0.0.1",
            },
            {
              type: "slack",
              name: "Slack",
              target: "https://user:secret@example.com",
            },
            {
              type: "email",
              name: "Mail",
              target: "valid@example.com",
              is_enabled: false,
            },
          ]) {
            await errorBody(
              await json("/notifications/channels", body),
              400,
              "VALIDATION_ERROR",
            );
          }
          await errorBody(
            await json("/api-keys", { name: " " }),
            400,
            "VALIDATION_ERROR",
          );
          await errorBody(
            await json("/api-keys", { name: "CI", workspaceId: 99 }),
            400,
            "VALIDATION_ERROR",
          );
          await errorBody(
            await fetch(origin + "/public/monitors", {
              headers: { "X-API-Key": "malformed" },
            }),
            401,
            "UNAUTHORIZED",
          );
          assert.equal(statements.length, 0);
        },
      );
      await t.test(
        "unexpected database errors are redacted and correlated with safe logs",
        async () => {
          const logs = [];
          const logger = t.mock.method(console, "error", (value) =>
            logs.push(value),
          );
          try {
            databaseError = new Error(
              "postgres://user:database-secret@internal/db SELECT password_hash",
            );
            const response = await json("/auth/login", {
              email: "alex@example.com",
              password: "password-secret",
            });
            const result = await errorBody(response, 500, "INTERNAL_ERROR");
            assert.equal(JSON.stringify(result).includes("secret"), false);
            assert.equal(logs.length, 1);
            assert.equal(JSON.parse(logs[0]).requestId, result.requestId);
            assert.equal(logs[0].includes("secret"), false);
            databaseError = Object.assign(
              new Error("private connection details"),
              { code: "ECONNREFUSED" },
            );
            await errorBody(
              await json("/auth/login", {
                email: "alex@example.com",
                password: "password-secret",
              }),
              503,
              "SERVICE_UNAVAILABLE",
            );
          } finally {
            databaseError = null;
            logger.mock.restore();
          }
        },
      );
    });
    await t.test(
      "global throttling cannot block health checks, logout, or CORS preflight",
      async () => {
        await withApp({ api: 1 }, async (origin) => {
          assert.equal((await fetch(origin + "/")).status, 200);
          const response = await fetch(origin + "/");
          await errorBody(response, 429, "RATE_LIMITED");
          assert.ok(Number(response.headers.get("retry-after")) > 0);
          assert.ok(response.headers.get("ratelimit"));
          assert.equal((await fetch(origin + "/health")).status, 200);
          assert.equal(
            (await fetch(origin + "/auth/logout", { method: "POST" })).status,
            204,
          );
          assert.equal(
            (
              await fetch(origin + "/monitors", {
                method: "OPTIONS",
                headers: {
                  Origin: "http://localhost:3002",
                  "Access-Control-Request-Method": "POST",
                },
              })
            ).status,
            204,
          );
        });
      },
    );
    await t.test(
      "login and registration share a stricter limit, including mixed-case paths",
      async () => {
        await withApp({ auth: 2 }, async (origin) => {
          for (const path of ["/auth/login", "/AUTH/REGISTER"])
            assert.equal(
              (await fetch(origin + path, { method: "POST" })).status,
              400,
            );
          await errorBody(
            await fetch(origin + "/auth/login/", { method: "POST" }),
            429,
            "RATE_LIMITED",
          );
        });
      },
    );
    await t.test(
      "refresh and manual checks have independent limits",
      async () => {
        await withApp({ refresh: 1, checks: 1 }, async (origin) => {
          for (const path of ["/auth/refresh", "/monitors/7/check"]) {
            assert.equal(
              (await fetch(origin + path, { method: "POST" })).status,
              401,
            );
            await errorBody(
              await fetch(origin + path, { method: "POST" }),
              429,
              "RATE_LIMITED",
            );
          }
        });
      },
    );
    await t.test(
      "the rate window expires so requests can recover",
      async () => {
        await withApp({ api: 1, windowMs: 500 }, async (origin) => {
          assert.equal((await fetch(origin + "/")).status, 200);
          assert.equal((await fetch(origin + "/")).status, 429);
          await delay(550);
          assert.equal((await fetch(origin + "/")).status, 200);
        });
      },
    );
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await pool.end();
  }
});
