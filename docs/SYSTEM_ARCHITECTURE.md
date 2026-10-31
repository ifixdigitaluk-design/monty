# System Architecture

## 1. Shape
A **modular monolith** API plus a background worker, one Postgres database, clients on web and desktop. Domain boundaries are enforced by module structure so a module can be extracted later if load demands it (ADR-002).

```
            ┌──────────────┐      ┌──────────────────┐
 Browser ──►│ apps/web     │      │ apps/desktop     │  Tauri 2 shell (Phase 3)
            │ Next.js 16   │      │ loads the same   │  bundles static export of
            │ (client UI)  │      │ client UI        │  apps/web, bearer tokens in OS keychain
            └──────┬───────┘      └────────┬─────────┘
   same-origin     │ /api/* rewrite        │ HTTPS + WSS
                   ▼                       ▼
            ┌───────────────────────────────────────┐
            │ apps/api  NestJS 11 modular monolith  │
            │  auth · tenancy · projects · tasks ·  │
            │  readiness · activity · (docs, search,│
            │  realtime gateway, ai, automation)    │
            └───────┬───────────────────┬───────────┘
                    │ Drizzle (pg)      │ outbox rows (same txn)
                    ▼                   ▼
            ┌──────────────┐    ┌──────────────┐     ┌──────────────┐
            │ PostgreSQL 16│◄───│ apps/worker  │────►│ Redis (when  │
            │ (+RLS, FTS)  │    │ outbox relay,│     │ justified:   │
            └──────────────┘    │ jobs, AI,    │     │ pub/sub,     │
                                │ automations  │     │ rate limits) │
                                └──────────────┘     └──────────────┘
                                     S3-compatible storage for attachments (Phase 2)
```

## 2. Repository layout (pnpm workspaces)
```
apps/
  web/        Next.js App Router UI (client-rendered against the API)
  api/        NestJS HTTP API (+ WebSocket gateway in Phase 3)
  worker/     Background jobs, outbox relay (Phase 2–3)
  desktop/    Tauri 2 shell (Phase 3)
packages/
  domain/     Pure business rules: permissions, readiness engine, task grouping. No I/O.
  validation/ Zod schemas = API contract (request/response), shared by api + clients
  database/   Drizzle schema, SQL migrations (/drizzle), db client, migrate CLI
  api-client/ Typed fetch client used by web and desktop
  ui/         Design system primitives (Phase 2 extraction from web)
  editor/     Block editor + Yjs bindings (Phase 2–3)
  config/     Shared tsconfig / eslint
```
Folders appear when real code exists; empty placeholders are not created.

## 3. Key decisions (details in ARCHITECTURE_DECISIONS.md)
- **Business logic lives in the API and `packages/domain`**, never in Next.js server code. This keeps web and desktop identical and lets the web build be exported statically for Tauri.
- **Tenancy**: every user gets a *personal organisation*. Team orgs are the same entity with `kind = TEAM`. One permission model covers both.
- **Tenant columns everywhere**: every tenant row carries `organisationId` (and `workspaceId` where scoped). Composite foreign keys stop a task referencing a project in another workspace.
- **Optimistic concurrency** on mutable business records (`version` column, `expectedVersion` on PATCH → 409 on conflict).
- **Idempotent creates**: clients may send their own UUID; replaying the same create returns the original record.
- **Transactional outbox**: domain writes and their events commit in one transaction; a relay publishes them (Phase 3).
- **Readiness engine** is a pure, deterministic function in `packages/domain`.

## 4. Data flow for a write (task update)
1. Client sends `PATCH /api/v1/tasks/:id { expectedVersion, ...changes }` with session cookie and CSRF header.
2. Auth guard resolves session → user. Validation pipe parses body with the shared Zod schema.
3. Service loads task with its workspace; `domain.can(actor, 'task.update', ctx)` decides.
4. In one transaction: conditional update `WHERE id AND version = expected`, insert `ActivityEvent`, insert `OutboxEvent`.
5. Response returns the new record; only now does the UI show "Saved".

## 5. Runtime and scaling path
- Stage 1: one API container, one worker, managed Postgres, object storage.
- Stage 2: horizontal API replicas behind a load balancer; Redis pub/sub for WebSocket fan-out; read replica for search/analytics.
- Stage 3: extract hot modules (realtime gateway, AI) only with measured need.

## 6. Technology versions (pinned, Oct 2026)
Node 22 LTS · TypeScript 5.9 · Next.js 16.4 · React 19.3 · Tailwind 4 · NestJS 11 · Drizzle ORM 0.45 + node-postgres · PostgreSQL 16 · Zod 4 · Vitest 3 · Playwright 1.63.
TypeScript 7 and NestJS 12 exist but were deliberately not adopted yet (ADR-008). Prisma was replaced by Drizzle (ADR-013).
