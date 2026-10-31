# Deployment Guide

## Local development
Requirements: Node 22+, pnpm 10, PostgreSQL 16.

```bash
cp .env.example .env            # edit DATABASE_URL etc.
pnpm install
createdb monty_dev && createdb monty_test   # or your own database names
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
| `DATABASE_URL` | api, database | Postgres connection |
| `TEST_DATABASE_URL` | tests | Separate test DB (wiped by tests) |
| `API_PORT` | api | default 4000 |
| `ALLOWED_ORIGINS` | api | comma list, e.g. `http://localhost:3000` |
| `NODE_ENV` | all | `production` enables Secure cookies |
| `API_INTERNAL_URL` | web | where Next.js rewrites `/api/*` (default `http://localhost:4000`). **Read at build time** — set it before `next build`. |
| `LOG_LEVEL` | api | `info` default |

## Production (target, Stage 1)
- **API**: container (`node apps/api/dist/main.js`), ≥2 replicas behind HTTPS load balancer. Run `node packages/database/dist/migrate-cli.js` (Drizzle migrator, forward-only) as a release step before rollout.
- **Web**: `next build && next start` container, or static export for CDN once confirmed (ADR-005). Same-origin routing: `/api/*` → API at the load balancer, so cookies stay first-party.
- **Database**: managed PostgreSQL 16 with PITR, private network, TLS.
- **Secrets**: provider secret manager; never in images.
- **Observability**: JSON logs → log platform; health check `/api/v1/health`; error tracking and metrics added in Phase 6.
- **Desktop**: Phase 3 — Tauri builds per OS in CI, code-signed (Apple Developer ID + notarisation; Windows Authenticode), updater manifests signed with Tauri updater key.

This guide is updated each phase; Phase 6 delivers full runbooks (rollback, restore, incident response).
