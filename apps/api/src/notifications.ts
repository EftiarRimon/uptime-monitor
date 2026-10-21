import { Router } from "express";
import { pool } from "./db.js";
import { authenticate, requireRole } from "./auth.js";
import nodemailer from "nodemailer";
import { channelBody, validateBody, validateId } from "./validation.js";
import { sendError } from "./errors.js";
import { OutboundPolicyError, publicRequest } from "./outbound.js";

export const notificationRouter = Router();
notificationRouter.use(authenticate);
notificationRouter.param("id", validateId);

notificationRouter.get("/channels", async (req, res) => {
  const result = await pool.query(
    "SELECT id, type, name, is_enabled, created_at FROM notification_channels WHERE workspace_id = $1 ORDER BY created_at DESC",
    [req.auth!.workspaceId],
  );
  res.json({ channels: result.rows });
});

notificationRouter.post(
  "/channels",
  requireRole("owner", "admin"),
  validateBody(channelBody),
  async (req, res) => {
    const {
      type = "webhook",
      name,
      target,
    } = req.body as Record<string, unknown>;
    const result = await pool.query(
      "INSERT INTO notification_channels (workspace_id, type, name, target) VALUES ($1, $2, $3, $4) RETURNING id, type, name, is_enabled, created_at",
      [req.auth!.workspaceId, type, name, target],
    );
    res.status(201).json({ channel: result.rows[0] });
  },
);

notificationRouter.delete(
  "/channels/:id",
  requireRole("owner", "admin"),
  async (req, res) => {
    const result = await pool.query(
      "DELETE FROM notification_channels WHERE id = $1 AND workspace_id = $2",
      [Number(req.params.id), req.auth!.workspaceId],
    );
    if (!result.rowCount) return sendError(res, 404, "Channel not found");
    res.status(204).end();
  },
);

export async function notifyIncident(
  workspaceId: number | string,
  incidentId: number,
  event: "opened" | "resolved",
  incident: Record<string, unknown>,
) {
  const channels = await pool.query(
    "SELECT id, type, target FROM notification_channels WHERE workspace_id = $1 AND is_enabled = TRUE",
    [workspaceId],
  );
  for (const channel of channels.rows as Array<{
    id: number;
    type: string;
    target: string;
  }>) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (channel.type === "email") {
          const host = process.env.SMTP_HOST;
          if (!host) throw new Error("SMTP_HOST is not configured");
          const transport = nodemailer.createTransport({
            host,
            port: Number(process.env.SMTP_PORT ?? 587),
            secure: process.env.SMTP_SECURE === "true",
            auth: process.env.SMTP_USER
              ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
              : undefined,
          });
          await transport.sendMail({
            from: process.env.SMTP_FROM ?? "alerts@pulseops.local",
            to: channel.target,
            subject: `[PulseOps] Incident ${event}`,
            text: `${incident.title}\n${incident.error_message ?? ""}\nStatus: ${event}`,
          });
          await pool.query(
            "INSERT INTO notification_deliveries (channel_id, incident_id, status, attempt) VALUES ($1, $2, 'sent', $3)",
            [channel.id, incidentId, attempt],
          );
          break;
        }
        const payload =
          channel.type === "slack"
            ? {
                text: `*PulseOps incident ${event}*\n${incident.title}\n${incident.error_message ?? ""}`,
              }
            : { event, incident };
        const response = await publicRequest(channel.target, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "PulseOps-Alerts/1.0",
          },
          body: JSON.stringify(payload),
        });
        await pool.query(
          "INSERT INTO notification_deliveries (channel_id, incident_id, status, response_code, attempt) VALUES ($1, $2, $3, $4, $5)",
          [
            channel.id,
            incidentId,
            response.ok ? "sent" : "failed",
            response.status,
            attempt,
          ],
        );
        if (response.ok || (response.status >= 300 && response.status < 400))
          break;
        if (attempt < 3)
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * 2 ** (attempt - 1)),
          );
      } catch (error) {
        await pool.query(
          "INSERT INTO notification_deliveries (channel_id, incident_id, status, error_message, attempt) VALUES ($1, $2, 'failed', $3, $4)",
          [
            channel.id,
            incidentId,
            error instanceof Error ? error.message : "Delivery failed",
            attempt,
          ],
        );
        if (error instanceof OutboundPolicyError) break;
        if (attempt < 3)
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * 2 ** (attempt - 1)),
          );
      }
    }
  }
}
