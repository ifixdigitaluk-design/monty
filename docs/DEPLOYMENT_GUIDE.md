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

## Production (target, Stage 1)
- **API**: container (`node apps/api/dist/main.js`), ≥2 replicas behind HTTPS load balancer. Run `node packages/database/dist/migrate-cli.js` (Drizzle migrator, forward-only) as a release step before rollout.
- **Web**: `next build && next start` container, or static export for CDN once confirmed (ADR-005). Same-origin routing: `/api/*` → API at the load balancer, so cookies stay first-party.
- **Database**: managed PostgreSQL 16 with PITR, private network, TLS. Create `monty_app` with `infra/db/create-app-role.sql` **before** the first migration, so the migration grants it table access.
- **Email**: verify your sending domain with the provider (SPF, DKIM, DMARC) before launch.
- **Secrets**: provider secret manager; never in images.
- **Observability**: JSON logs → log platform; health check `/api/v1/health`; error tracking and metrics added in Phase 6.
- **Desktop**: Phase 3 — Tauri builds per OS in CI, code-signed (Apple Developer ID + notarisation; Windows Authenticode), updater manifests signed with Tauri updater key.

This guide is updated each phase; Phase 6 delivers full runbooks (rollback, restore, incident response).
