# Monty

Monty is a project workspace that tells you the truth about your work. It connects projects, tasks and (soon) documents in one model. A deterministic **readiness and health engine** explains why a project is or isn't ready, and AI will be **accountable**: it proposes changes and people approve them.

> Status: **Phase 1 vertical slice**. See [`docs/DEVELOPMENT_STATUS.md`](docs/DEVELOPMENT_STATUS.md) for what works today and what has been verified.

## What works today
- Sign up and sign in with server-side sessions. You can list sessions and revoke them.
- Every account gets a personal workspace. You can also create team organisations and workspaces.
- Role-based permissions: org Owner/Admin/Member/Guest and workspace Admin/Member/Viewer, enforced on the server.
- Projects: objective, owner, stage, dates. Changes use optimistic concurrency, and deletes are soft.
- Tasks and subtasks: status, priority, assignee, dates, estimate and blocker. List and Board views run on the same records.
- **Readiness engine**: 9 transparent rules plus a computed status (Draft, Ready to start, In progress, At risk, Blocked, Ready to deliver, and others).
- My Tasks (overdue, today, next 7 days, later) and a project activity history.
- A transactional outbox is written with every change, ready for real-time delivery in Phase 3.

## Repository
```
apps/api        NestJS 11 API (modular monolith)
apps/web        Next.js 16 client UI (statically exportable for the Tauri desktop app)
packages/domain       Pure business rules: permissions, readiness, task grouping
packages/validation   Zod API contract shared by server and clients
packages/database     Drizzle schema, SQL migrations, migrate CLI
packages/api-client   Typed client used by web (and desktop later)
e2e             Playwright end-to-end tests against the real stack
docs            Product, architecture, security, testing and status documents
```

## Quick start
```bash
cp .env.example .env
pnpm install
createdb monty_dev && createdb monty_test
pnpm build && pnpm db:migrate
pnpm dev            # http://localhost:3000
```
Full instructions: [`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md).

## Quality gates
`pnpm typecheck` · `pnpm lint` · `pnpm test` (unit + API integration against real Postgres) · `pnpm e2e` (Playwright).

## Key documents
[Product requirements](docs/PRODUCT_REQUIREMENTS.md) · [Competitor analysis](docs/COMPETITOR_ANALYSIS.md) · [Roadmap](docs/PRODUCT_ROADMAP.md) · [Architecture](docs/SYSTEM_ARCHITECTURE.md) · [Decisions](docs/ARCHITECTURE_DECISIONS.md) · [Database](docs/DATABASE_SCHEMA.md) · [API](docs/API_SPECIFICATION.md) · [Realtime](docs/REALTIME_ARCHITECTURE.md) · [Security](docs/SECURITY_PLAN.md) · [UI/UX](docs/UI_UX_GUIDELINES.md) · [Testing](docs/TESTING_STRATEGY.md) · [Backlog](docs/BACKLOG.md)
