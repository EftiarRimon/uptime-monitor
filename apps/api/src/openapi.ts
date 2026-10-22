import { Router } from "express";

export const openapiRouter = Router();
openapiRouter.get("/", (_req, res) =>
  res.json({
    openapi: "3.0.3",
    info: { title: "PulseOps Uptime API", version: "1.0.0" },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          security: [],
          summary: "Health check",
          responses: { "200": { description: "Service is healthy" } },
        },
      },
      "/auth/login": {
        post: {
          security: [],
          summary: "Create an access session",
          responses: { "200": { description: "Authenticated session" } },
        },
      },
      "/auth/register": {
        post: {
          security: [],
          summary: "Register a workspace",
          responses: { "201": { description: "Workspace created" } },
        },
      },
      "/monitors": {
        get: {
          summary: "List workspace monitors",
          responses: { "200": { description: "Monitor collection" } },
        },
        post: {
          summary: "Create a monitor",
          responses: { "201": { description: "Monitor created" } },
        },
      },
      "/monitors/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        get: {
          summary: "Get monitor details",
          responses: { "200": { description: "Monitor details" } },
        },
        patch: {
          summary: "Update a monitor",
          responses: { "200": { description: "Monitor updated" } },
        },
        delete: {
          summary: "Delete a monitor",
          responses: { "204": { description: "Monitor deleted" } },
        },
      },
      "/incidents": {
        get: {
          summary: "List incidents",
          responses: { "200": { description: "Incident collection" } },
        },
      },
      "/public/monitors": {
        get: {
          security: [{ apiKey: [] }],
          summary: "List monitors with an API key",
          responses: { "200": { description: "Monitor collection" } },
        },
      },
      "/public/incidents": {
        get: {
          security: [{ apiKey: [] }],
          summary: "List incidents with an API key",
          responses: { "200": { description: "Incident collection" } },
        },
      },
      "/status/{slug}": {
        get: {
          security: [],
          summary: "Read a public status page",
          responses: {
            "200": { description: "Public status" },
            "404": { description: "Status page not found" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
  }),
);
