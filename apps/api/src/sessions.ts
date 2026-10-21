import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";

const cookieName = "pulseops_refresh";
const cookieOptions = {
  httpOnly: true,
  secure: process.env.REFRESH_COOKIE_SECURE === "true",
  sameSite: "lax" as const,
  path: "/auth",
};
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const newRefreshToken = () => randomBytes(32).toString("hex");

export function readRefreshToken(req: Request) {
  const value = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function setRefreshCookie(
  res: Response,
  token: string,
  expiresAt: Date,
) {
  res.cookie(cookieName, token, { ...cookieOptions, expires: expiresAt });
}
export function clearRefreshCookie(res: Response) {
  res.clearCookie(cookieName, cookieOptions);
}

export async function createSession(
  client: PoolClient,
  userId: number,
  workspaceId: number,
) {
  const id = randomUUID();
  const token = newRefreshToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
  await client.query(
    "INSERT INTO auth_sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, $4)",
    [id, userId, workspaceId, expiresAt],
  );
  await client.query(
    "INSERT INTO refresh_tokens (token_hash, session_id) VALUES ($1, $2)",
    [hashToken(token), id],
  );
  return { id, token, expiresAt };
}
