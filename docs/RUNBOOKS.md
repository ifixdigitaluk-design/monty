# Runbooks and operations

Written for the Stage 1 target (API containers ×2+, Next.js web, managed Postgres 16). Procedures marked **(drilled)** were executed in this repository's environment; the rest are written but not yet exercised on real infrastructure.

## 1. Health, metrics and alerts
**What exists in the code (tested locally):**
| Signal | Where |
|---|---|
| Liveness | `GET /api/v1/health` checks the DB (`select 1`). Used by the container `HEALTHCHECK` for web (`/login`). |
| Readiness | `GET /api/v1/health/ready` returns 503 unless the DB **and** the live-update LISTEN connection are up. Used by the API container `HEALTHCHECK`. |
| Metrics | `GET /api/v1/metrics` in Prometheus text format. It is off unless `METRICS_TOKEN` is set, and requires `Authorization: Bearer <token>`. It contains counts and timings only, with no ids, emails or content. |
| Structured logs | JSON lines on stdout/stderr: `time`, `level`, `context`, `msg`, `requestId`, `durationMs`. No tokens, passwords, query strings or email bodies. |
| Error reporting | Every unhandled error is written to the log (`unhandled_error`) and counted in `monty_errors_total`. Optionally, each one is also POSTed to `ERROR_WEBHOOK_URL` (rate-limited to 30/min, no bodies, cookies or queries). This is a vendor-neutral integration point. |

**Suggested alert rules** (PromQL). They are defined here but **not active anywhere**: no monitoring provider has been configured.
| Alert | Expression | Severity |
|---|---|---|
| API down | `up{job="monty-api"} == 0` for 2 m, or readiness 503 for 2 m | page |
| Database unreachable | `monty_db_up == 0` for 2 m | page |
| Pool saturation | `monty_db_pool_waiting_requests > 0` for 5 m | page |
| 5xx rate | `sum(rate(monty_http_requests_total{status="5xx"}[5m])) / sum(rate(monty_http_requests_total[5m])) > 0.01` | page |
| Slow requests | `histogram_quantile(0.95, sum by (le) (rate(monty_http_request_duration_seconds_bucket[10m]))) > 0.5` | ticket |
| DB busy / timeouts | `increase(monty_db_unavailable_total[10m]) > 10`, or `increase(monty_request_timeouts_total[10m]) > 5` | ticket |
| Live updates broken | `monty_realtime_listener_up == 0` for 2 m | page |
| Email backlog | `monty_email_overdue_messages > 0` for 15 m | page (sign-ups can't verify) |
| Email failures | `increase(monty_email_failed_last_24h[1h]) > 5` | ticket |
| Mail worker stalled | `time() - monty_job_last_success_timestamp_seconds{job="mail_delivery"} > 300` | page |
| Maintenance stalled | `time() - monty_job_last_success_timestamp_seconds{job="maintenance"} > 7200` | ticket |
| Automation failures | `monty_automation_runs_failed{window="1h"} > 20` or `monty_automation_runs_stuck > 0` | ticket |
| Unhandled errors | `increase(monty_errors_total[10m]) > 5` | ticket |
| Event loop lag | `monty_event_loop_delay_p99_seconds > 0.2` | ticket |

**What you need to provide** (all **Requires external provider**):
- A metrics backend that can scrape HTTP. Any Prometheus-compatible service or a self-hosted Prometheus with Alertmanager. You also need a `METRICS_TOKEN` stored as a secret.
- An error tracker with a webhook or HTTP intake that accepts JSON, set as `ERROR_WEBHOOK_URL`. Alternatively, an SDK swapped into `ErrorReporter.deliver`.
- A log platform that collects container stdout. Target retention is 30 days.
- An uptime checker hitting `/api/v1/health/ready` from outside.
- A paging channel: an on-call tool, or email/SMS.

Metrics are per instance, so scrape every API instance.

## 2. Deploy and roll back
1. Build images from a green CI commit (`API_INTERNAL_URL` must be set at web build time).
2. Run migrations as the owner role: `node packages/database/dist/migrate-cli.js` (forward-only). Migrations must be backward compatible with the previous API version (expand → migrate → contract).
3. Roll out API, then web. Watch readiness and error rate for 10 minutes.
4. **Roll back**: redeploy the previous image. Do **not** roll back migrations; if a migration itself is faulty, ship a new forward migration. If data was damaged, see §4.

## 3. Database incidents
- **API refuses to start, "Row-level security is NOT effective"**: the API is connecting as the owner, a superuser or a BYPASSRLS role, or migrations didn't run. Fix `DATABASE_URL` to use `monty_app` (`infra/db/create-app-role.sql`). Never set `REQUIRE_RLS=false` in production.
- **Connection pool exhaustion** (requests hang, then time out): each authenticated request holds a connection for its duration. Raise `DB_POOL_MAX` within the server's `max_connections` budget, add instances, or add PgBouncer (transaction mode is compatible: all RLS settings are transaction-local).
- **Database restarted**: API reconnects automatically; live-update clients receive `reset` and refetch. Check readiness recovers on every instance.
- **Slow queries**: check `pg_stat_statements`; search uses GIN indexes on generated `tsvector` columns.

## 4. Backup and restore
- Provider PITR is the primary mechanism (target RPO 15 min, RTO 1 h). **Not drilled** — no provider chosen yet.
- Logical backup drill **(drilled 31 Oct 2026, also in CI)**:
  ```bash
  SOURCE_URL=postgresql://owner:…@host/monty ADMIN_URL=postgresql://owner:…@host/postgres \
  APP_ROLE_URL_TEMPLATE='postgresql://monty_app:…@host/{db}' bash infra/scripts/backup-restore-drill.sh
  ```
  It dumps, restores into `monty_restore_drill`, compares every table's row count, RLS-enabled tables, policies and the migration journal, and confirms the app role sees no rows without a user context. Result here: 22 tables, 16 with RLS, 15 migrations, all identical; dump and restore each < 1 s on a small dataset.
- **Restoring production**: restore into a *new* database, run the drill's comparison against expectations, re-grant `monty_app` (the script shows the grants), point `DATABASE_URL` at it, restart the API. Sessions survive a restore; outbox events older than the restore point will cause clients to `reset` (harmless).

## 5. Security incidents
- **Suspected account takeover**: revoke the user's sessions (`update sessions set revoked_at = now() where user_id = …`), force a password reset, review `audit_logs` for the user and their organisations.
- **Leaked webhook secret**: delete and recreate the rule (a new secret is generated) and tell the receiver to update verification. (Secret rotation in place is not implemented.)
- **Leaked AI key / SMTP credentials**: rotate at the provider, update the secret, restart the API. Nothing else stores them.
- **Data exposure concern between tenants**: confirm RLS is active (`rls_active` log line at startup), run `pnpm --filter @monty/api test -- rls`, then review the affected endpoint's permission checks.

## 6. Feature-specific
- **Email not arriving**: the queue is durable.
  - **Find the message:** query `email_outbox` (as the owner role) by `kind`/`status`; `last_error` holds the provider's reason and `email_delivery_attempts` holds every attempt.
  - **Temporary failures** (network, SMTP 4xx, authentication) retry with exponential backoff: 30 s doubling, capped at 1 h, 10 attempts, about 4.5 h in total.
  - **Permanent failures** (SMTP 5xx) stop immediately.
  - **Expired links** become `EXPIRED` (reset links are never sent after 1 h).
  - **Re-queue after a provider outage:** `update email_outbox set status='PENDING', attempts=0, next_attempt_at=now() where status='FAILED' and payload is not null` (bodies are wiped once final, so only messages that still have a payload can be re-sent; otherwise users resend from the app).
  - **Also:** verify SPF/DKIM/DMARC.
  - **Delivery guarantee:** at least once. A crash after the provider accepted a message causes one resend with the same Message-ID.
- **AI planning failing**: `ai_plan_failed` logs carry the provider error. Set `AI_PROVIDER=local` to fall back to the built-in planner without data leaving the server.
- **Automation not firing**: check the rule is enabled and its author is still a workspace admin (runs show `SKIPPED` with the reason); webhook failures show the HTTP status or "non-public address". Changes made while no API instance was running are not processed (known limitation).
- **Table growth**: MaintenanceService runs hourly and purges:
  - the live-update outbox after 7 days;
  - stale sessions after 30 days;
  - used tokens after 7 days;
  - automation runs after 90 days;
  - finished email metadata after 30 days;
  - expired exports;
  - organisations whose 30-day deletion grace period has ended.

  Check for `maintenance_done` log lines, or `monty_job_last_success_timestamp_seconds{job="maintenance"}`.
- **Account / organisation deletion requests**: see DATA_LIFECYCLE.md. Restoring an organisation after its purge is impossible except from a database backup.
- **503 SERVICE_UNAVAILABLE / REQUEST_TIMEOUT spikes**: look at `db_unavailable` log reasons.
  - `pool_timeout` → raise `DB_POOL_MAX`, or add instances or PgBouncer.
  - `lock_timeout` → find blockers in `pg_locks`.
  - `statement_timeout` → `pg_stat_statements`.

## 7. Load test baseline **(run 31 Oct 2026)**
`infra/scripts/load-test.mjs`, 20 users each with a project of 25+ tasks, mix: list tasks 40 %, home 20 %, search 15 %, update 15 %, create 10 %. Single API instance (`DB_POOL_MAX=20`), Postgres and the load generator **all on the same 2-vCPU container**, so absolute numbers are a floor, not a capacity statement.

| Concurrency | Throughput | p50 | p95 | p99 | Errors (5xx/4xx other than below) |
|---|---|---|---|---|---|
| 10 | 179 req/s | 56 ms | 98 ms | 120 ms | 0 |
| 40 | 199 req/s | 222 ms | 311 ms | 357 ms | 0 |

- Throughput saturates around 180–200 req/s on this hardware; extra concurrency only adds queueing latency (CPU-bound, shared by API, DB and generator).
- 409 conflicts (1 and 3) are expected optimistic-concurrency rejections on simultaneous edits of the same task.
- Search returned 429 after 120 requests/min because all virtual users share one IP: the per-IP limit works, but would also throttle a real office behind one NAT (see SECURITY_PLAN §3).
- Not yet measured: multiple instances, a separate DB host, SSE connection counts, large tenants (100k+ tasks).

## 8. Private-beta readiness checklist (updated 31 Oct 2026, session 5)
Statuses: **Completed and tested** · **Implemented but externally unverified** · **Requires my action** (founder) · **Requires external provider** · **Requires legal review** · **Not completed**.

| Item | Status | Evidence / what's missing |
|---|---|---|
| Durable email queue with retries, backoff, permanent-failure handling, restart survival | Completed and tested | `mail-queue.e2e` (real local SMTP server: success, 451 retry, 550, unreachable, restart, crashed-worker lease, idempotency, expiry, RLS); container restart kept the queued email |
| Real email delivery through a provider (incl. SPF/DKIM/DMARC) | Requires external provider | No SMTP credentials here; the production TLS check rejects the local test server by design |
| Database/statement/lock/idle/pool/request timeouts | Completed and tested | `db-timeouts.e2e` (10 tests); values documented in DEPLOYMENT_GUIDE |
| Personal data export, account deletion, organisation rename/deletion/restore/purge | Completed and tested | `data-lifecycle.e2e` (7 tests) + Playwright `data-lifecycle.spec` |
| Retention and deletion rules reviewed by a privacy professional | Requires legal review | DATA_LIFECYCLE.md is an engineering proposal |
| Privacy policy, terms, DPA, sub-processor list, cookie notice | Requires legal review | Not written |
| Calendar and page accessibility (axe, keyboard) | Completed and tested | `accessibility.spec`: 0 violations on 14 page states incl. phone width; keyboard grid test. Manual screen-reader testing (NVDA/VoiceOver) not done |
| Container images (api, web, migrate), non-root, read-only, health checks, graceful shutdown | Implemented but externally unverified | Built and run here with a **locally built Ubuntu 24.04 + Node 22.23 substitute base**, because Docker Hub is blocked. The official `node:22-bookworm-slim` build is in CI but not yet run |
| `compose.yaml` full stack (with official `postgres:16` image) | Implemented but externally unverified | `docker compose config` validated; `up` not run (images can't be pulled here) |
| Metrics endpoint, error-reporting hook, job/email/automation monitoring | Implemented but externally unverified | `observability.e2e`; scraped from a production-mode container. No monitoring service is connected, so **no alert is active** |
| Monitoring stack, alert routing, uptime checks, log retention | Requires external provider | See §1 |
| Hosting, TLS certificates, domain, managed Postgres with PITR | Requires external provider / my action | No provider chosen |
| PITR restore drill on the chosen provider | Requires external provider | The logical restore drill passed locally |
| CI green on GitHub (tests, e2e, restore drill, image build) | Requires my action | Repository not pushed; create `ifixdigitaluk-design/monty` and connect it, or push the bundle |
| External penetration test | Requires external provider | |
| Hosted AI provider check (if enabled) | Requires external provider | Needs an `AI_API_KEY`; the default local planner works without it |
| Shared rate limits / presence for >1 API instance (Redis) | Not completed | Run a single API instance for the beta, or add Redis |
| CSP nonces (remove `'unsafe-inline'`), sign-up enumeration fix, MFA | Not completed | |
| Desktop app signed builds (Windows/macOS) | Not completed | Linux unsigned build only; not needed for a web beta |
| Pricing and billing | Requires my action | Plan limits are placeholders |
| Load test baseline | Completed and tested | Single small host (§7); repeat on the target hosting |
