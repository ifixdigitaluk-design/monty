# Engineering Backlog

Format: `ID · story · acceptance · tests · depends on`. Status tracked in DEVELOPMENT_STATUS.md.

## Phase 1 — Foundation
| ID | Story | Acceptance | Tests | Deps |
|---|---|---|---|---|
| F-01 | Monorepo with web, api, packages | `pnpm install && pnpm build` succeeds | build | — |
| F-02 | Drizzle schema + SQL migration for tenancy, projects, tasks, activity, outbox | Migration applies on empty DB | integration | F-01 |
| F-03 | Register creates user + personal org + workspace atomically | AC-1 | integration | F-02 |
| F-04 | Login/logout/me with server sessions | AC-2, AC-10 | integration | F-03 |
| F-05 | Session list + revoke | Revoked token gets 401 | integration | F-04 |
| F-06 | Permission engine (org × workspace roles × actions) | matrix tests | unit | — |
| F-07 | Create team organisation + workspaces | Owner can create; member cannot create workspace | integration | F-06 |
| F-08 | Project CRUD with optimistic concurrency + soft delete | AC-3, AC-6 | integration | F-06 |
| F-09 | Task CRUD, subtasks, idempotent create | AC-3, AC-7 | integration | F-08 |
| F-10 | Cross-tenant isolation | AC-4, AC-5 | integration | F-09 |
| F-11 | CSRF + origin guard, helmet, rate limiting | AC-8 | integration | F-04 |
| F-12 | Activity + outbox written transactionally | rows present after mutation | integration | F-09 |
| F-13 | Readiness engine v0 + endpoint | AC-9 | unit + integration | F-09 |
| F-14 | My Tasks endpoint + grouping (overdue/today/week/later/no date) | grouping unit tests | unit + integration | F-09 |
| F-15 | Web: auth pages, sidebar, projects, project list/board, task drawer, readiness panel, My Tasks, sessions | Playwright flow passes | e2e | F-04..F-14 |
| F-16 | Structured JSON logging with request IDs | logs contain requestId, no secrets | manual + unit | F-01 |
| F-17 | CI workflow (GitHub Actions) | runs typecheck, lint, test, build | CI | F-01 |

## Phase 1b
✅ B-01 Invitations (link-based; email delivery is still to do) · ✅ B-02 Member management & role changes · B-03 Postgres RLS · ✅ B-04 AuditLog · B-05 Email verification · B-06 Password reset · B-07 Redis rate limiting · B-08 Email provider integration (needed by B-01 email delivery, B-05, B-06) · B-09 Personal audit view (my sign-ins).

## Phase 2 (epics)
Milestones · Dependencies (API + UI + cycle detection) · Labels · Comments & mentions · Attachments (S3, pre-signed) · Documents & block editor · Version history · Backlinks · Calendar view · Timeline/Gantt (read-only first) · Search (FTS) · Notifications & inbox · Custom fields (ADR-011) · Saved views · Home dashboard · Recurring tasks · Templates · Time tracking.

## Phase 3+ epics
See PRODUCT_ROADMAP.md.
