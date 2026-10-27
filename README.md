# Uptime Monitor

![CI](https://github.com/EftiarRimon/uptime-monitor/actions/workflows/ci.yml/badge.svg)

Multi-tenant uptime monitoring and status page SaaS.

## Features

- HTTP, TCP, ping and heartbeat monitors with custom intervals
- Background workers (BullMQ + Redis) that run checks and detect incidents
- Email and webhook alerts
- Workspaces with owner/admin/viewer roles
- JWT auth with refresh token rotation, API keys
- SSRF protection on all outbound checks
- Public status pages and OpenAPI docs
- Next.js dashboard with uptime and latency charts

## Tech stack

Node.js, TypeScript, Express, PostgreSQL, Redis, BullMQ, Next.js, Docker, Playwright, GitHub Actions

## Run locally

```bash
docker compose up
```

## Tests

```bash
npm run typecheck
npm run lint
npm --prefix apps/api test
npm --prefix apps/web run test:e2e
```
