import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "./db.js";
import { trustedOrigin } from "./authConfig.js";
import {
  createSession,
  clearRefreshCookie,
  hashToken,
  newRefreshToken,
  readRefreshToken,
  setRefreshCookie,
} from "./sessions.js";
import {
  emptyBody,
  loginBody,
  registerBody,
  validateBody,
} from "./validation.js";
import { sendError } from "./errors.js";

const secret = process.env.JWT_SECRET ?? "local-development-secret-change-me";
export type AuthUser = {
  userId: number;
  email: string;
  workspaceId: number;
  role: "owner" | "admin" | "viewer";
  sessionId: string;
};
/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */
export const authRouter = Router();

function tokenFor(user: AuthUser) {
  return jwt.sign(user, secret, {
    expiresIn: "15m",
    algorithm: "HS256",
    jwtid: randomUUID(),
  });
}
function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

authRouter.post(
  "/register",
  trustedOrigin,
  validateBody(registerBody),
  async (req, res) => {
    const { name, email, password, workspaceName } = req.body as {
      name: string;
      email: string;
      password: string;
      workspaceName: string;
    };
    const normalizedEmail = email.trim().toLowerCase();
    const baseSlug = slugify(workspaceName);
    if (!baseSlug) return sendError(res, 400, "Workspace name is invalid");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query(
        "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
        [name.trim(), normalizedEmail, await bcrypt.hash(password, 12)],
      );
      const workspace = await client.query(
        "INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id, name, slug",
        [workspaceName.trim(), `${baseSlug}-${Date.now().toString(36)}`],
      );
      await client.query(
        "INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')",
        [user.rows[0].id, workspace.rows[0].id],
      );
      const session = await createSession(
        client,
        user.rows[0].id,
        workspace.rows[0].id,
      );
      await client.query("COMMIT");
      const authUser: AuthUser = {
        userId: user.rows[0].id,
        email: user.rows[0].email,
        workspaceId: workspace.rows[0].id,
        role: "owner",
        sessionId: session.id,
      };
      setRefreshCookie(res, session.token, session.expiresAt);
      return res.status(201).json({
        user: user.rows[0],
        workspace: workspace.rows[0],
        role: "owner",
        accessToken: tokenFor(authUser),
      });
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        return sendError(res, 409, "An account with this email already exists");
      throw error;
    } finally {
      client.release();
    }
  },
);

authRouter.post(
  "/login",
  trustedOrigin,
  validateBody(loginBody),
  async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const result = await pool.query(
      "SELECT u.id, u.name, u.email, u.password_hash, m.workspace_id, m.role, w.name AS workspace_name, w.slug FROM users u JOIN memberships m ON m.user_id = u.id JOIN workspaces w ON w.id = m.workspace_id WHERE u.email = $1 ORDER BY m.created_at LIMIT 1",
      [email.trim().toLowerCase()],
    );
    if (
      !result.rowCount ||
      !(await bcrypt.compare(password, result.rows[0].password_hash))
    )
      return sendError(res, 401, "Invalid email or password");
    const row = result.rows[0];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const session = await createSession(client, row.id, row.workspace_id);
      await client.query("COMMIT");
      setRefreshCookie(res, session.token, session.expiresAt);
      const authUser: AuthUser = {
        userId: row.id,
        email: row.email,
        workspaceId: row.workspace_id,
        role: row.role,
        sessionId: session.id,
      };
      return res.json({
        user: { id: row.id, name: row.name, email: row.email },
        workspace: {
          id: row.workspace_id,
          name: row.workspace_name,
          slug: row.slug,
        },
        role: row.role,
        accessToken: tokenFor(authUser),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

authRouter.post(
  "/refresh",
  trustedOrigin,
  validateBody(emptyBody),
  async (req, res) => {
    const token = readRefreshToken(req);
    if (!token) {
      clearRefreshCookie(res);
      return sendError(res, 401, "Sign in again to continue");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT t.used_at, s.id AS session_id, s.user_id, s.workspace_id, s.expires_at, s.revoked_at,
      u.name, u.email, m.role, w.name AS workspace_name, w.slug
      FROM refresh_tokens t JOIN auth_sessions s ON s.id = t.session_id
      JOIN users u ON u.id = s.user_id JOIN memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
      JOIN workspaces w ON w.id = s.workspace_id WHERE t.token_hash = $1 FOR UPDATE OF s, t`,
        [hashToken(token)],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.revoked_at ||
        row.expires_at.getTime() <= Date.now() ||
        row.used_at
      ) {
        if (row?.used_at && !row.revoked_at)
          await client.query(
            "UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1",
            [row.session_id],
          );
        await client.query("COMMIT");
        clearRefreshCookie(res);
        return sendError(res, 401, "Session expired. Sign in again.");
      }
      const nextToken = newRefreshToken();
      await client.query(
        "UPDATE refresh_tokens SET used_at = NOW() WHERE token_hash = $1",
        [hashToken(token)],
      );
      await client.query(
        "INSERT INTO refresh_tokens (token_hash, session_id) VALUES ($1, $2)",
        [hashToken(nextToken), row.session_id],
      );
      await client.query("COMMIT");
      setRefreshCookie(res, nextToken, row.expires_at);
      const authUser: AuthUser = {
        userId: row.user_id,
        email: row.email,
        workspaceId: row.workspace_id,
        role: row.role,
        sessionId: row.session_id,
      };
      return res.json({
        user: { id: row.user_id, name: row.name, email: row.email },
        workspace: {
          id: row.workspace_id,
          name: row.workspace_name,
          slug: row.slug,
        },
        role: row.role,
        accessToken: tokenFor(authUser),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

authRouter.post(
  "/logout",
  trustedOrigin,
  validateBody(emptyBody),
  async (req, res) => {
    const token = readRefreshToken(req);
    if (token)
      await pool.query(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = (SELECT session_id FROM refresh_tokens WHERE token_hash = $1)",
        [hashToken(token)],
      );
    let claims;
    try {
      claims = jwt.verify(
        req.headers.authorization?.replace(/^Bearer /, "") ?? "",
        secret,
        { algorithms: ["HS256"], ignoreExpiration: true },
      );
    } catch {
      /* Cookie-based logout also works without an access token. */
    }
    if (
      typeof claims === "object" &&
      typeof claims.sessionId === "string" &&
      validSessionId(claims.sessionId) &&
      validId(claims.userId) &&
      validId(claims.workspaceId)
    ) {
      await pool.query(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1 AND user_id = $2 AND workspace_id = $3",
        [claims.sessionId, claims.userId, claims.workspaceId],
      );
    }
    clearRefreshCookie(res);
    return res.status(204).end();
  },
);

type AuthRequest = Request & { auth?: AuthUser };
authRouter.get("/me", authenticate, async (req, res) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, m.role, w.id AS workspace_id, w.name AS workspace_name, w.slug
     FROM users u JOIN memberships m ON m.user_id = u.id
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE u.id = $1 AND m.workspace_id = $2`,
    [req.auth!.userId, req.auth!.workspaceId],
  );
  if (!result.rowCount)
    return sendError(
      res,
      401,
      "Workspace access is no longer available. Sign in again.",
    );
  const row = result.rows[0];
  return res.json({
    user: { id: row.id, name: row.name, email: row.email },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      slug: row.slug,
    },
    role: row.role,
  });
});

const validSessionId = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const validId = (value: unknown) =>
  (typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) > 0;
export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer "))
    return sendError(res, 401, "Authentication required");
  let claims;
  try {
    claims = jwt.verify(value.slice(7), secret, { algorithms: ["HS256"] });
  } catch {
    return sendError(res, 401, "Session expired");
  }
  if (
    typeof claims !== "object" ||
    typeof claims.sessionId !== "string" ||
    !validSessionId(claims.sessionId) ||
    !validId(claims.userId) ||
    !validId(claims.workspaceId)
  )
    return sendError(res, 401, "Session expired. Sign in again.");
  const result = await pool.query(
    `SELECT u.id, u.email, s.workspace_id, m.role FROM auth_sessions s
    JOIN users u ON u.id = s.user_id JOIN memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
    WHERE s.id = $1 AND s.user_id = $2 AND s.workspace_id = $3 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [claims.sessionId, claims.userId, claims.workspaceId],
  );
  if (!result.rowCount)
    return sendError(res, 401, "Session expired. Sign in again.");
  const row = result.rows[0];
  req.auth = {
    userId: row.id,
    email: row.email,
    workspaceId: row.workspace_id,
    role: row.role,
    sessionId: claims.sessionId,
  };
  next();
}

export function requireRole(...roles: AuthUser["role"][]) {
  return (req: AuthRequest, res: Response, next: NextFunction) =>
    roles.includes(req.auth?.role as AuthUser["role"])
      ? next()
      : sendError(res, 403, "Insufficient permissions");
}
