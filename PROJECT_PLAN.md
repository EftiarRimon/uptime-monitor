# Multi-tenant uptime monitoring SaaS

This project follows the supplied brief: a production-style mini Better Stack/Statuspage with workspaces, RBAC, monitors, workers, incidents, alerts, live dashboards, public status pages, API keys, testing, and deployment tooling.

## Milestones

### 1. Foundation

- [x] Docker Compose with PostgreSQL and Redis
- [x] TypeScript Express API
- [x] Health endpoint
- [x] Monitor CRUD API
- [x] On-demand HTTP check and check history
- [x] Workspace, user, membership, and role data model
- [x] JWT access token flow
- [x] Refresh tokens
- [x] Input validation, rate limits, CORS, Helmet, and structured errors
- [x] SSRF protection for monitor and webhook requests, including DNS and redirects

### 2. Product dashboard

- [x] Next.js web app
- [x] Login, workspace context, and sign-out
- [x] Monitor list, create/delete/check flows
- [x] Edit/pause flows
- [x] Uptime and latency charts
- [x] Incident timeline and monitor detail page
- [x] Responsive dashboard and empty/loading/error states

### 3. Monitoring engine

- [x] Background worker service with interval scheduling
- [x] HTTP monitor checks
- [x] Timeout policy and check history
- [x] Redis-backed job queue
- [ ] TCP, ICMP/ping, and cron heartbeat monitor types
- [x] Retry and retention/aggregation policies
- [x] Worker startup and Docker restart policy

### 4. Incidents and alerts

- [x] Incident detection and recovery state machine
- [x] Incident API and dashboard timeline
- [x] Webhook channels and delivery history
- [ ] Email, Slack, and escalation delivery
- [ ] Alert rules and notification preferences
- [ ] Email, Slack, webhook, and escalation delivery
- [ ] Delivery attempts, retries, and audit trail

### 5. Public status and API

- [x] Public status page per workspace with custom slug
- [x] Component status and incident communication
- [x] Public REST API and API key management
- [x] OpenAPI documentation

### 6. Production readiness

- [ ] Unit, integration, API, and Playwright E2E tests
- [ ] Coverage gate and k6 load test
- [ ] Prometheus metrics and Grafana dashboard
- [ ] Multi-stage Docker images and GitHub Actions CI
- [ ] Nginx/HTTPS deployment guide
- [ ] Seed data and one-command local setup

## Data boundaries

Every workspace-owned record must carry a workspace identifier and be scoped in the query layer. Public status pages expose only explicitly public component and incident data. Secrets, API keys, notification credentials, and refresh tokens must never be returned from API responses.
