# Deployment Guide

## Local development
Requirements: Node 22+, pnpm 10, PostgreSQL 16.

```bash
cp .env.example .env            # edit DATABASE_URL etc.
pnpm install
createdb monty_dev && createdb monty_test   # or your own database names
# once, as a Postgres admin: the API's restricted runtime role (row-level security applies to it)
psql -d monty_dev -v app_password="'monty_app_dev'" -v dbname=monty_dev -f infra/db/create-app-role.sql
psql -d monty_test -c "GRANT CONNECT ON DATABASE monty_test TO monty_app; GRANT USAGE ON SCHEMA public TO monty_app;"
pnpm build                      # builds packages + apps (also builds the migrate CLI)
pnpm db:migrate                 # applies committed SQL migrations to DATABASE_URL
pnpm dev                        # api on :4000, web on :3000 (web proxies /api → api)
```
Open http://localhost:3000 and create an account.

### Tests
```bash
# integration tests use TEST_DATABASE_URL (separate database!)
pnpm test
pnpm typecheck && pnpm lint
# e2e: start api + web first (pnpm start), then
pnpm e2e
```

## Environment variables
| Var | App | Purpose |
|---|---|---|
| `DATABASE_URL` | api | Connection as the **`monty_app`** role (not the owner) |
| `MIGRATION_DATABASE_URL` | database | Owner connection used by `pnpm db:migrate` |
| `REQUIRE_RLS` | api | `true` refuses to start unless RLS applies (forced on in production) |
| `TEST_DATABASE_URL` / `TEST_APP_DATABASE_URL` | tests | Owner and app-role URLs for a separate test DB (wiped by tests) |
| `APP_URL` | api | Public web origin used in email links (https in production) |
| `MAIL_TRANSPORT` | api | `log` (dev: in-memory, `GET /api/v1/dev/mailbox`) or `smtp` (required in production) |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | api | Any SMTP provider (Postmark, Resend, SES, Mailgun). Port 587 uses STARTTLS, which is required |
| `API_PORT` | api | default 4000 |
| `ALLOWED_ORIGINS` | api | comma list, e.g. `http://localhost:3000` |
| `NODE_ENV` | all | `production` enables Secure cookies |
| `API_INTERNAL_URL` | web | where Next.js rewrites `/api/*` (default `http://localhost:4000`). **Read at build time** — set it before `next build`. |
| `LOG_LEVEL` | api | `info` default |
| `DB_POOL_MAX` | api | Postgres connections per instance (default 10). Each authenticated request holds one for its whole duration (RLS transaction): size it ≥ expected concurrent requests per instance, and keep `instances × DB_POOL_MAX` below the server's `max_connections` (or use PgBouncer in transaction mode) |
| `RATE_LIMIT`, `AUTH_RATE_LIMIT` | api | requests/min per IP (defaults 300 and 10). In memory per instance |
| `TRUST_PROXY` | api | Express trust-proxy setting so client IPs are correct behind the load balancer |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | api | `local` (default, no network) or `anthropic` with key + model id |
| `MONTY_URL` | desktop | web origin the desktop shell opens (https, or http://localhost for development) |

## Production (target, Stage 1)
- **API**: container (`node apps/api/dist/main.js`), ≥2 replicas behind HTTPS load balancer. Run `node packages/database/dist/migrate-cli.js` (Drizzle migrator, forward-only) as a release step before rollout.
- **Web**: `next build && next start` container, or static export for CDN once confirmed (ADR-005). Same-origin routing: `/api/*` → API at the load balancer, so cookies stay first-party.
- **Database**: managed PostgreSQL 16 with PITR, private network, TLS. Create `monty_app` with `infra/db/create-app-role.sql` **before** the first migration, so the migration grants it table access.
- **Email**: verify your sending domain with the provider (SPF, DKIM, DMARC) before launch.
- **Secrets**: provider secret manager; never in images.
- **Observability**: JSON logs → log platform; liveness `/api/v1/health`, readiness `/api/v1/health/ready` (503 when the DB or live-update listener is down). See RUNBOOKS.md for alerts to configure. No metrics endpoint or error tracker is integrated yet.
- **Desktop**: Phase 3 — Tauri builds per OS in CI, code-signed (Apple Developer ID + notarisation; Windows Authenticode), updater manifests signed with Tauri updater key.

Operational procedures (rollback, restore, incidents, secret rotation) are in RUNBOOKS.md.

## Timeouts (and why these values)
| Setting | Default | Reason |
|---|---|---|
| `DB_STATEMENT_TIMEOUT_MS` | 15 000 | The slowest request queries in the load test were < 0.6 s p99. 15 s is far above legitimate use but stops a runaway query from holding a connection for minutes. Maintenance jobs raise it per transaction (120 s); migrations use their own connection with no limit. |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 60 000 | Each authenticated request is one transaction. The longest legitimate pause inside one is the AI provider call (30 s timeout). 60 s leaves headroom; the API refuses to start with ≤ 35 s. A crashed/stalled handler can no longer pin locks indefinitely. |
| `DB_LOCK_TIMEOUT_MS` | 5 000 | Row locks are held for milliseconds (version checks, proposal apply). Waiting longer means contention or a stuck session; failing fast with 503 + `Retry-After` is better than piling up requests. |
| `DB_CONNECT_TIMEOUT_MS` | 5 000 | Max wait for a pooled connection. With `DB_POOL_MAX` exhausted, clients get 503 instead of an unbounded queue. |
| `DB_POOL_MAX` | 10 | Per instance. Keep `instances × DB_POOL_MAX` + migrations + admin < Postgres `max_connections` (or use PgBouncer in transaction mode; all session settings used are transaction-local). |
| `REQUEST_TIMEOUT_MS` | 40 000 | Outer limit for any handler (AI 30 s + margin). Live-update streams are exempt. On timeout the client gets 503 `REQUEST_TIMEOUT`; the message tells users to refresh before retrying, because the transaction may still have committed. |
| HTTP server | headers 20 s, body `REQUEST_TIMEOUT_MS + 5 s`, keep-alive 65 s | Slowloris protection; keep-alive above common 60 s load-balancer idle timeouts to avoid 502s. |
| SMTP | connect 10 s, greeting 10 s, socket 20 s | Worker lease is 2 min, so a slow provider can't cause duplicate parallel sends. |
| Webhooks / AI | 5 s / 30 s | Unchanged. |

Transient database failures (statement/lock/idle timeouts, pool exhaustion, dropped connections, deadlocks) return **503 `SERVICE_UNAVAILABLE`** with `Retry-After: 2`, logged as `db_unavailable` with the reason. Covered by `apps/api/test/db-timeouts.e2e.test.ts`.
