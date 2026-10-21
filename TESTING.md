# Local verification

Run static checks from the repository root:

```powershell
npm run typecheck
npm run lint
```

Run API validation and permission tests:

```powershell
npm --prefix apps/api test
```

The security middleware suite runs without a database. It exercises the complete app with controlled database failures and checks Helmet, CORS, JSON limits, schema validation, error redaction, request IDs, rate limits, and recovery after a rate window. Database connections are blocked in this suite so invalid-input tests cannot create application records.

The outbound suite also runs without a database or external network requests. Controlled DNS and transport doubles verify private and encoded addresses, IPv6, mixed DNS answers, pinned connections, repeated DNS validation, redirects, webhook payload isolation, shared deadlines, response disposal, and redacted failures. A database double checks that stored private targets produce failed check/delivery history without making requests. The HTTP middleware suite rejects private monitor and channel targets during configuration as well.

PostgreSQL history and session tests are opt-in. Start the local database, then run:

```powershell
docker compose up -d postgres
$env:TEST_DATABASE_URL = 'postgres://uptime:uptime_dev@localhost:5433/uptime'
npm --prefix apps/api test
Remove-Item Env:TEST_DATABASE_URL
```

These integration tests create uniquely named schemas, use the application's actual database initialization and HTTP routes, and drop their schemas afterward. They check workspace isolation, current membership, viewer access, time ranges, aggregates, gaps, incident overlap, and history exceeding the display limit. Session tests cover cookie properties, hashed token storage, rotation, concurrent replay, logout, expiry, membership removal, and Origin checks. Existing application records are not used. The database account must be able to create schemas. Without `TEST_DATABASE_URL`, these groups are skipped.

Include the queue integration suite by enabling Redis as well:

```powershell
docker compose up -d postgres redis
$env:TEST_DATABASE_URL = 'postgres://uptime:uptime_dev@localhost:5433/uptime'
$env:TEST_REDIS_URL = 'redis://localhost:6379'
npm --prefix apps/api test
Remove-Item Env:TEST_DATABASE_URL, Env:TEST_REDIS_URL
```

Queue tests require both variables. They use real BullMQ producers and consumers, a disposable PostgreSQL schema, and a random Redis queue name. Coverage includes competing schedulers/consumers, concurrent duplicate processing, stale jobs, workspace checks, microsecond version changes, interval rescheduling, transactional rollback, infrastructure retries, retry after commit, exhausted-failure rescheduling, producer reconnection, abandoned-job recovery, and pagination. Stored private targets exercise the actual checker without external requests. Cleanup removes only the fixture schema and queue; it never flushes Redis or uses existing monitors. [MONITORING_QUEUE.md](MONITORING_QUEUE.md) describes configuration and operational limits.

Run browser tests against a production web build:

```powershell
npm --prefix apps/web exec -- playwright install chromium --only-shell
npm --prefix apps/web run build
npm --prefix apps/web run test:e2e
```

Playwright starts the web app on port 3102 and mocks the API for deterministic browser checks. Tests cover session restoration, loading and empty states, partial outages, saved data during failed refreshes, automatic refresh, viewer controls, mobile editing, dashboard navigation, history filters, chart inspection, and expired sessions. Mobile layout checks include narrow screens and long names. Screenshots and traces are saved in `apps/web/test-results` when a test fails; selected passing tests also save screenshots for visual review. PostgreSQL tests provide separate coverage of actual SQL behavior.

Browser session tests also cover shared renewal for parallel requests, cookie-based restoration, temporary renewal failure, a single retry after expiry, history page renewal, logout during rotation, coordination between tabs, and clearing workspace data when accounts change.
