import { pool } from "./db.js";
import { isPublicAddress, publicRequest } from "./outbound.js";
import type { PoolClient } from "pg";
import net from "node:net";
import dns from "node:dns/promises";
async function resolvePublicAddress(host: string) {
  const hostname = host.replace(/^\[|\]$/g, "");
  if (
    !net.isIP(hostname) &&
    /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(hostname)
  )
    throw new Error("Target is blocked");
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (
    records.length === 0 ||
    !records.every((record) => isPublicAddress(record.address))
  ) {
    throw new Error("Target is blocked");
  }
  const first = records[0];
  if (!first) throw new Error("Target is blocked");
  return first.address;
}

export async function checkMonitor(
  id: number | string,
  workspaceId: number | string,
  database: Pick<PoolClient, "query"> = pool,
) {
  const result = await database.query(
    "SELECT id, url, monitor_type FROM monitors WHERE id = $1 AND workspace_id = $2",
    [id, workspaceId],
  );
  if (!result.rowCount) return null;
  const monitor = result.rows[0] as {
    id: number;
    url: string;
    monitor_type?: string;
  };
  const started = Date.now();
  let status: "up" | "down" = "down";
  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  try {
    const type = monitor.monitor_type ?? "http";
    if (type === "http") {
      const response = await publicRequest(monitor.url);
      statusCode = response.status;
      status = response.ok ? "up" : "down";
      if (!response.ok) errorMessage = `HTTP ${response.status}`;
    } else if (type === "heartbeat") {
      const response = await publicRequest(
        monitor.url.replace(/^heartbeat:/, "http:"),
      );
      statusCode = response.status;
      status = response.ok ? "up" : "down";
      if (!response.ok) errorMessage = `Heartbeat HTTP ${response.status}`;
    } else {
      const parsed = new URL(monitor.url);
      const host = parsed.hostname;
      const port = Number(parsed.port || (type === "ping" ? 443 : 80));
      const targetIp = await resolvePublicAddress(host);
      if (type === "ping") {
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(
            { host: targetIp, port, timeout: 5000 },
            () => {
              socket.destroy();
              resolve();
            },
          );
          socket.on("error", reject);
          socket.on("timeout", () => {
            socket.destroy();
            reject(new Error("Ping timeout"));
          });
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(
            { host: targetIp, port, timeout: 5000 },
            () => {
              socket.destroy();
              resolve();
            },
          );
          socket.on("error", reject);
          socket.on("timeout", () => {
            socket.destroy();
            reject(new Error("TCP timeout"));
          });
        });
      }
      status = "up";
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Request failed";
  }
  const responseTime = Date.now() - started;
  const check = await database.query(
    `INSERT INTO monitor_checks (monitor_id, status, status_code, response_time_ms, error_message)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [id, status, statusCode, responseTime, errorMessage],
  );
  await database.query(
    "UPDATE monitors SET last_status = $1, last_checked_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $2 AND workspace_id = $3",
    [status, id, workspaceId],
  );
  return check.rows[0];
}
