# Runbooks and operations

Written for the Stage 1 target (API containers ×2+, Next.js web, managed Postgres 16). Procedures marked **(drilled)** were executed in this repository's environment; the rest are written but not yet exercised on real infrastructure.

## 1. Health, readiness and what to alert on
| Signal | Where | Alert when |
|---|---|---|
| Liveness | `GET /api/v1/health` (DB `select 1`) | any non-200 for 2 min |
| Readiness | `GET /api/v1/health/ready` | 503 for > 2 min on any instance (DB or LISTEN connection down) — the LB should already drain it |
| Error rate | JSON logs, `status >= 500` | > 1 % of requests over 5 min |
| Latency | JSON logs `ms` field | p95 > 500 ms for 10 min (baseline below) |
| `rls_inactive` / startup failure "Row-level security is NOT effective" | logs | ever — page immediately |
| `audit_write_failed`, `maintenance_failed`, `automation_error`, `listener_error` | logs | any occurrence (ticket); sustained (page) |
| `ai_plan_failed` | logs | > 5 in 10 min (provider outage or key problem) |
| Automation runs `FAILED` | `automation_runs.status` | spikes per workspace (customer webhook down) — informational |
| Postgres connections | provider metrics | > 80 % of `max_connections` |
| Disk / replication lag / backup age | provider metrics | backup older than 26 h; PITR disabled |

No metrics exporter or error tracker is wired in yet; until then the above are log-based queries.

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
- **Email not arriving**: check logs for the mail type and recipient domain; verify SPF/DKIM/DMARC; invitations remain usable via the copyable link. Password-reset requests always return 200 by design.
- **AI planning failing**: `ai_plan_failed` logs carry the provider error. Set `AI_PROVIDER=local` to fall back to the built-in planner without data leaving the server.
- **Automation not firing**: check the rule is enabled and its author is still a workspace admin (runs show `SKIPPED` with the reason); webhook failures show the HTTP status or "non-public address". Changes made while no API instance was running are not processed (known limitation).
- **Table growth**: MaintenanceService purges outbox (7 d), stale sessions (30 d), used tokens (7 d) and automation runs (90 d) hourly; check for `maintenance_done` log lines.

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

## 8. Launch checklist (status)
| Item | Status |
|---|---|
| CI green on GitHub | ✗ repository not pushed from this environment |
| External penetration test | ✗ |
| Real SMTP provider verified with one test email | ✗ (no credentials) |
| Hosted AI provider verified (if enabled) | ✗ (no key) |
| PITR restore drill on chosen provider | ✗ |
| Logical restore drill | ✓ |
| Load test baseline | ✓ (single small host) |
| Monitoring alerts configured | ✗ (defined above, not set up) |
| Desktop builds signed for Windows/macOS | ✗ (Linux build only, unsigned) |
| Legal: privacy policy, terms, DPA, GDPR review | ✗ needs qualified advice |
| Pricing | ✗ not decided (limits are placeholders) |
