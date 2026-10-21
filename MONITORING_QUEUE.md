# Monitoring queue

Each worker process has a polling producer and a BullMQ consumer. Producers scan PostgreSQL for due, unpaused monitors with a workspace, in pages of 250. They enqueue IDs and a monitor version; URLs and channel secrets stay in PostgreSQL. Consumers run HTTP checks concurrently using the existing SSRF-protected outbound client.

Multiple worker processes can run together. A stable job ID derived from workspace ID, monitor ID, and the full PostgreSQL `updated_at` timestamp deduplicates competing producers. After acquiring a PostgreSQL row lock, the consumer checks the workspace, version, paused state, and due time again. Paused, deleted, edited, early, and already completed jobs are skipped. Monitor edits take effect after an already-running check finishes; the row lock serializes those writes.

Check history, the monitor's latest state, and the incident transition commit in one transaction. If it fails, they roll back together. PostgreSQL's microsecond timestamp precision is preserved in the job version. The version changes at check completion, so a later interval gets a new job ID. Intervals run from the previous check's completion and are rounded up by the polling delay and queue backlog. Missed intervals during downtime are coalesced into one current check.

BullMQ can deliver a job again after a crash or lost lock. The database guard prevents that replay from creating a second committed check or incident transition. An interrupted HTTP request may still reach the target again if its transaction never committed. This is at-least-once job processing, with guarded database writes.

## Run and scale

```powershell
docker compose up -d --build
docker compose logs -f worker
docker compose up -d --scale worker=2 --no-deps worker
```

For development without the worker container:

```powershell
# Stop the container worker if you want only the development process checking.
docker compose stop worker
$env:DATABASE_URL = 'postgres://uptime:uptime_dev@localhost:5433/uptime'
$env:REDIS_URL = 'redis://localhost:6379'
npm --prefix apps/api run worker
```

| Setting              | Default                       | Purpose                                                      |
| -------------------- | ----------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`       | Local PostgreSQL on port 5433 | Shared monitor state and history                             |
| `REDIS_URL`          | `redis://localhost:6379`      | Shared BullMQ backend; supports authenticated Redis URLs     |
| `WORKER_POLL_MS`     | `10000`                       | Delay between completed scheduling passes; integer 1–3600000 |
| `WORKER_CONCURRENCY` | `5`                           | Concurrent jobs per process; integer 1–50                    |
| `SMTP_*`             | Same configuration as the API | Existing email delivery from worker incident events          |

Docker workers use the internal PostgreSQL and Redis hostnames. All replicas for this application must share the same databases. The queue name is `monitor-checks` with BullMQ's default `bull` prefix. Use separate Redis databases/instances for separate environments. The API's manual check route still runs synchronously and may check paused monitors at the user's request.

## Failure handling and persistence

- Connection and scheduling failures are logged with a safe error code. Polling resumes automatically, and consumers reconnect to Redis. Monitor URLs and Redis credentials are excluded from queue payloads and application logs.
- Infrastructure exceptions get three job attempts, with exponential backoff starting at one second. Ordinary HTTP failures/timeouts are saved as `down` checks and do not trigger these infrastructure retries. Exhausted jobs are removed so the next polling pass can enqueue the still-due monitor again. Inspect worker logs for these failures.
- Completed jobs are retained for at most an hour or 1000 jobs, with BullMQ's lazy cleanup. PostgreSQL retains the check and incident history independently.
- BullMQ renews active-job locks and recovers abandoned jobs. Default lock duration and stalled-check interval are 30 seconds, so crash recovery can take roughly a minute. SIGTERM/SIGINT stop polling and drain active jobs before closing connections. Compose allows 60 seconds; the process exits at 55 seconds if draining cannot complete.
- Compose stores Redis data in the `redisdata` volume with AOF enabled, an `everysec` fsync policy, and `noeviction`. A hard host failure can lose roughly the last second of Redis writes. Subsequent polling restores still-due work from PostgreSQL. Do not remove the volume when restarting services. Deleting Compose volumes deletes application data.

Notification delivery currently follows the check transaction. A crash between commit and delivery can lose an alert, and a downstream notification failure does not undo a committed check. A durable notification outbox and delivery idempotency remain part of the alerts milestone. Queue processing does not promise exactly-once external notifications.

Redis configuration and recovery behavior follow BullMQ's [production guidance](https://docs.bullmq.io/guide/going-to-production), [job ID rules](https://docs.bullmq.io/guide/jobs/job-ids), and [graceful shutdown guidance](https://docs.bullmq.io/guide/workers/graceful-shutdown).
