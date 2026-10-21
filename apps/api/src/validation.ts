import { z } from "zod";
import type { RequestHandler, RequestParamHandler } from "express";
import { sendError } from "./errors.js";
import { publicUrl } from "./outbound.js";

const name = z.string().trim().min(1).max(120);
const email = z.string().trim().max(254).email();
const password = z
  .string()
  .min(8)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Password must be at most 72 UTF-8 bytes",
  );
const interval = z.number().int().min(30).max(2147483647);
export const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      publicUrl(value);
      return true;
    } catch {
      return false;
    }
  }, "URL must be a public HTTP or HTTPS destination without credentials");

export const registerBody = z
  .object({
    name,
    workspaceName: name,
    email: email.transform((value) => value.toLowerCase()),
    password,
  })
  .strict();
export const loginBody = z
  .object({
    email: email.transform((value) => value.toLowerCase()),
    password: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 72,
        "Password must be at most 72 UTF-8 bytes",
      ),
  })
  .strict();
export const emptyBody = z.object({}).strict().default({});
export const createMonitorBody = z
  .object({ name, url: httpUrl, intervalSeconds: interval.default(60) })
  .strict();
export const updateMonitorBody = z
  .object({
    name: name.optional(),
    url: httpUrl.optional(),
    intervalSeconds: interval.optional(),
    isPaused: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one monitor field is required",
  );
export const historyQuery = z
  .object({ hours: z.enum(["24", "168", "720"]).default("24") })
  .strict();
export const apiKeyBody = z.object({ name }).strict();
export const channelBody = z
  .object({
    type: z.enum(["webhook", "email", "slack"]).default("webhook"),
    name,
    target: z.string().trim().min(1).max(2048),
  })
  .strict()
  .superRefine((value, context) => {
    const result = (value.type === "email" ? email : httpUrl).safeParse(
      value.target,
    );
    if (!result.success)
      context.addIssue({
        code: "custom",
        path: ["target"],
        message:
          value.type === "email"
            ? "Target must be one valid email address"
            : "Target must be a public HTTP or HTTPS URL without credentials",
      });
  });

export const validateBody =
  (schema: z.ZodType): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };
export const validateId: RequestParamHandler = (
  _req,
  res,
  next,
  value: string,
) => {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) <= 0
  )
    return sendError(res, 400, "ID must be a positive safe integer", [
      { path: "id", message: "Invalid resource ID" },
    ]);
  next();
};
