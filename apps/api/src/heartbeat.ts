import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { pool } from "./db.js";
import { sendError } from "./errors.js";

export const heartbeatRouter = Router();

async function ping(req: Request, res: Response) {
  const token = String(req.params.token ?? "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token))
    return sendError(res, 404, "Not found");
  const result = await pool.query(
    "UPDATE monitors SET last_ping_at = clock_timestamp() WHERE heartbeat_token = $1 AND monitor_type = 'heartbeat' AND is_paused = FALSE",
    [token],
  );
  if (!result.rowCount) return sendError(res, 404, "Not found");
  res.json({ ok: true });
}

const handle = (req: Request, res: Response, next: NextFunction) => {
  ping(req, res).catch(next);
};

heartbeatRouter.get("/:token", handle);
heartbeatRouter.post("/:token", handle);
