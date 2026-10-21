/* global fetch */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import process from "node:process";
import { test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import pg from "pg";
import { authRouter, authenticate, requireRole } from "../src/auth.ts";
import { pool, initDatabase } from "../src/db.ts";
import { errorHandler } from "../src/errors.ts";

test(
  "refresh sessions against PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const client = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const schema = `auth_session_test_${randomUUID().replaceAll("-", "")}`;
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    let fixturePool;
    let server;
    let created = false;
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await client.query(`SET search_path TO "${schema}"`);
      fixturePool = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      pool.query = fixturePool.query.bind(fixturePool);
      pool.connect = fixturePool.connect.bind(fixturePool);
      await initDatabase();
      const app = express();
      app.use(express.json());
      app.use("/auth", authRouter);
      app.get("/private", authenticate, (req, res) =>
        res.json({ workspaceId: req.auth.workspaceId, role: req.auth.role }),
      );
      app.post(
        "/write",
        authenticate,
        requireRole("owner", "admin"),
        (_req, res) => res.json({ ok: true }),
      );
      app.use(errorHandler);
      server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      const password = "test-password-123";
      const cookie = (response) =>
        response.headers.getSetCookie()[0]?.split(";")[0];
      const send = (
        path,
        {
          token,
          refreshCookie,
          body,
          origin: requestOrigin,
          method = "POST",
        } = {},
      ) =>
        fetch(origin + path, {
          method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(refreshCookie ? { Cookie: refreshCookie } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(requestOrigin ? { Origin: requestOrigin } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const register = async () => {
        const email = `${randomUUID()}@example.test`;
        const response = await send("/auth/register", {
          body: {
            name: "Alex",
            workspaceName: `Team ${randomUUID()}`,
            email,
            password,
          },
        });
        assert.equal(response.status, 201);
        return {
          response,
          identity: await response.json(),
          refreshCookie: cookie(response),
          email,
        };
      };
      const privateRequest = (token) =>
        send("/private", { method: "GET", token });

      await t.test(
        "registration returns only public identity and a short-lived access token",
        async () => {
          const { response, identity, refreshCookie } = await register();
          assert.deepEqual(Object.keys(identity).sort(), [
            "accessToken",
            "role",
            "user",
            "workspace",
          ]);
          assert.deepEqual(Object.keys(identity.user).sort(), [
            "email",
            "id",
            "name",
          ]);
          const header = response.headers.getSetCookie()[0];
          assert.match(header, /HttpOnly/);
          assert.match(header, /Path=\/auth/);
          assert.match(header, /SameSite=Lax/);
          assert.equal(response.headers.get("cache-control"), "no-store");
          const claims = jwt.decode(identity.accessToken);
          assert.equal(claims.exp - claims.iat, 900);
          const rawToken = refreshCookie.split("=")[1];
          assert.match(rawToken, /^[a-f0-9]{64}$/);
          const stored = await client.query(
            "SELECT token_hash FROM refresh_tokens WHERE session_id = $1",
            [claims.sessionId],
          );
          assert.equal(
            stored.rows[0].token_hash,
            createHash("sha256").update(rawToken).digest("hex"),
          );
          assert.notEqual(stored.rows[0].token_hash, rawToken);
          assert.equal(
            (await privateRequest(identity.accessToken)).status,
            200,
          );
        },
      );
      await t.test(
        "expired access can renew once and receives current membership permissions",
        async () => {
          const session = await register();
          const claims = jwt.decode(session.identity.accessToken);
          const expired = jwt.sign(
            {
              userId: claims.userId,
              workspaceId: claims.workspaceId,
              sessionId: claims.sessionId,
            },
            process.env.JWT_SECRET ?? "local-development-secret-change-me",
            { expiresIn: -1 },
          );
          assert.equal((await privateRequest(expired)).status, 401);
          await client.query(
            "UPDATE memberships SET role = 'viewer' WHERE user_id = $1 AND workspace_id = $2",
            [session.identity.user.id, session.identity.workspace.id],
          );
          assert.equal(
            (await send("/write", { token: session.identity.accessToken }))
              .status,
            403,
          );
          const refreshed = await send("/auth/refresh", {
            refreshCookie: session.refreshCookie,
          });
          assert.equal(refreshed.status, 200);
          assert.notEqual(cookie(refreshed), session.refreshCookie);
          const identity = await refreshed.json();
          assert.equal(identity.role, "viewer");
          assert.equal(identity.workspace.id, session.identity.workspace.id);
          assert.equal(jwt.decode(identity.accessToken).role, "viewer");
          assert.equal(
            (await privateRequest(identity.accessToken)).status,
            200,
          );
        },
      );
      await t.test(
        "replayed refresh revokes its entire family while another login survives",
        async () => {
          const session = await register();
          const login = await send("/auth/login", {
            body: { email: session.email, password },
          });
          assert.equal(login.status, 200);
          const other = await login.json();
          const rotated = await send("/auth/refresh", {
            refreshCookie: session.refreshCookie,
          });
          const rotatedIdentity = await rotated.json();
          assert.equal(rotated.status, 200);
          assert.equal(
            (
              await send("/auth/refresh", {
                refreshCookie: session.refreshCookie,
              })
            ).status,
            401,
          );
          assert.equal(
            (await send("/auth/refresh", { refreshCookie: cookie(rotated) }))
              .status,
            401,
          );
          assert.equal(
            (await privateRequest(rotatedIdentity.accessToken)).status,
            401,
          );
          assert.equal((await privateRequest(other.accessToken)).status, 200);
        },
      );
      await t.test(
        "logout clears the cookie and immediately invalidates access and refresh",
        async () => {
          const session = await register();
          const response = await send("/auth/logout", {
            refreshCookie: session.refreshCookie,
          });
          assert.equal(response.status, 204);
          assert.match(
            response.headers.getSetCookie()[0],
            /Expires=Thu, 01 Jan 1970/,
          );
          assert.equal(
            (await privateRequest(session.identity.accessToken)).status,
            401,
          );
          assert.equal(
            (
              await send("/auth/refresh", {
                refreshCookie: session.refreshCookie,
              })
            ).status,
            401,
          );
          assert.equal((await send("/auth/logout")).status, 204);
          const bearerOnly = await register();
          assert.equal(
            (
              await send("/auth/logout", {
                token: bearerOnly.identity.accessToken,
              })
            ).status,
            204,
          );
          assert.equal(
            (await privateRequest(bearerOnly.identity.accessToken)).status,
            401,
          );
        },
      );
      await t.test(
        "expired sessions and deleted memberships cannot renew",
        async () => {
          const expired = await register();
          await client.query(
            "UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
            [jwt.decode(expired.identity.accessToken).sessionId],
          );
          assert.equal(
            (
              await send("/auth/refresh", {
                refreshCookie: expired.refreshCookie,
              })
            ).status,
            401,
          );
          assert.equal(
            (await privateRequest(expired.identity.accessToken)).status,
            401,
          );
          const removed = await register();
          await client.query(
            "DELETE FROM memberships WHERE user_id = $1 AND workspace_id = $2",
            [removed.identity.user.id, removed.identity.workspace.id],
          );
          assert.equal(
            (
              await send("/auth/refresh", {
                refreshCookie: removed.refreshCookie,
              })
            ).status,
            401,
          );
          assert.equal(
            (await privateRequest(removed.identity.accessToken)).status,
            401,
          );
        },
      );
      await t.test(
        "untrusted origins cannot log in, register, rotate, or log out a session",
        async () => {
          const session = await register();
          for (const path of [
            "/auth/login",
            "/auth/register",
            "/auth/refresh",
            "/auth/logout",
          ]) {
            const response = await send(path, {
              origin: "https://untrusted.example",
              refreshCookie: session.refreshCookie,
            });
            assert.equal(response.status, 403, path);
            assert.equal(response.headers.getSetCookie().length, 0);
          }
          assert.equal(
            (await privateRequest(session.identity.accessToken)).status,
            200,
          );
          assert.equal(
            (
              await send("/auth/refresh", {
                origin: "http://localhost:3002",
                refreshCookie: session.refreshCookie,
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "concurrent use of the same refresh is detected and revoked",
        async () => {
          const session = await register();
          const responses = await Promise.all([
            send("/auth/refresh", { refreshCookie: session.refreshCookie }),
            send("/auth/refresh", { refreshCookie: session.refreshCookie }),
          ]);
          assert.deepEqual(
            responses.map((response) => response.status).sort(),
            [200, 401],
          );
          const winner = await responses
            .find((response) => response.status === 200)
            .json();
          assert.equal((await privateRequest(winner.accessToken)).status, 401);
        },
      );
      await t.test(
        "invalid cookies, legacy JWTs, and incorrect credentials are rejected",
        async () => {
          for (const refreshCookie of [
            undefined,
            "pulseops_refresh=bad",
            `pulseops_refresh=${"0".repeat(64)}`,
          ]) {
            assert.equal(
              (await send("/auth/refresh", { refreshCookie })).status,
              401,
            );
          }
          const session = await register();
          const invalidLogin = await send("/auth/login", {
            body: { email: session.email, password: "incorrect" },
          });
          assert.equal(invalidLogin.status, 401);
          assert.equal(invalidLogin.headers.getSetCookie().length, 0);
          const legacy = jwt.sign(
            {
              userId: session.identity.user.id,
              workspaceId: session.identity.workspace.id,
              role: "owner",
            },
            process.env.JWT_SECRET ?? "local-development-secret-change-me",
          );
          assert.equal((await privateRequest(legacy)).status, 401);
        },
      );
    } finally {
      if (server)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      pool.query = originalQuery;
      pool.connect = originalConnect;
      if (fixturePool) await fixturePool.end();
      if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
      await pool.end();
    }
  },
);
