# Development Status (master record)

Last updated: 31 Oct 2026 · Session 1 · Phase 0 complete, Phase 1 vertical slice delivered.

## Status definitions
- **Implemented**: code exists and builds.
- **Tested**: automated unit/integration tests pass against a real Postgres database.
- **Verified**: exercised end-to-end in a real browser (Playwright) → Next.js → API → Postgres.
- **Production Ready**: nothing yet. This needs Phase 6 (load, security review, restore drills, monitoring).

Implementation status and verification status are recorded separately below.

## Feature status
| ID | Feature | Implementation | Verification | Evidence |
|---|---|---|---|---|
| F-01 | Monorepo (pnpm workspaces), shared packages | Implemented | Tested | `pnpm build` exit 0 |
| F-02 | Drizzle schema + SQL migration (11 tables, composite tenant FKs) | Implemented | Tested | migration applied to dev/test/e2e DBs; FK integrity tests |
| F-03 | Register → user + personal org + workspace (atomic) | Implemented | Verified | auth.e2e AC-1; Playwright flow |
| F-04 | Login / logout / me, server sessions, Argon2id | Implemented | Verified | auth.e2e; Playwright logout test |
| F-05 | Session list + revoke | Implemented | Verified | auth.e2e; Playwright sessions page |
| F-06 | Permission engine (org × workspace roles) | Implemented | Tested | 9 unit tests + role e2e tests |
| F-07 | Team organisations + workspaces | Implemented | Verified | tenancy.e2e; Playwright team test |
| F-08 | Projects CRUD, optimistic concurrency, soft delete | Implemented | Verified | projects-tasks.e2e; Playwright |
| F-09 | Tasks + subtasks, idempotent create | Implemented | Verified | incl. 5-way concurrent create test |
| F-10 | Cross-tenant isolation (404, no leaks) | Implemented | Verified | 12-endpoint isolation test; Playwright second user |
| F-11 | CSRF header + Origin allowlist, Helmet, rate limiting | Implemented | Tested | auth.e2e CSRF + 429 tests |
| F-12 | Activity history + transactional outbox | Implemented | Tested | outbox rows asserted in same flow |
| F-13 | Readiness engine v0 (9 rules, computed status, configurable) | Implemented | Verified | 12 unit tests; API + Playwright |
| F-14 | My Tasks (cross-workspace, grouped) | Implemented | Verified | API test; Playwright |
| F-15 | Web UI: auth, sidebar, workspace, project list/board, task drawer, readiness panel, activity, sessions, dark mode, mobile layout | Implemented | Verified | 4 Playwright flows; screenshots reviewed (light, dark, 390px mobile) |
| F-16 | Structured JSON logging with request IDs | Implemented | Partially tested | `X-Request-Id` asserted; log content reviewed manually |
| F-17 | CI workflow (GitHub Actions) | Implemented | **Not verified** | not run yet: the repo hasn't been pushed |
| — | Client write serialisation (no false conflicts on rapid edits) | Implemented | Verified | regression Playwright test (bug found this session) |

Not started: invitations and member management UI, RLS, audit log, email verification and password reset, milestones, dependencies API, comments, attachments, documents and editor, search, notifications, realtime, desktop, AI, automation, billing, integrations, analytics.

## Session 1 report

1. **Inspected**: an empty cloud workspace (no existing repository). Toolchain: Node 22.23, pnpm 10.28, PostgreSQL 16, Chromium/Playwright 1.63, Rust toolchain. The GitHub CLI token here is invalid. `binaries.prisma.sh` is blocked by the network policy.
2. **Developed**:
   - Phase 0 docs: 13 documents in `/docs`, including competitor research.
   - Phase 1 vertical slice across web, API, domain, validation, database and e2e.
3. **Files changed**: new repository with ~70 source files. Key paths: `apps/api/src/**`, `apps/web/src/**`, `packages/{domain,validation,database,api-client}/src/**`, `packages/database/drizzle/0000_init.sql`, `e2e/tests/**`, `.github/workflows/ci.yml`.
4. **Functional**: everything marked Verified or Tested above.
5. **Tests executed** (31 Oct 2026, this environment):
   - `pnpm build` → exit 0
   - `pnpm typecheck` → exit 0
   - `pnpm lint` → exit 0
   - `pnpm test` → domain 24/24, validation 6/6, API integration 41/41
   - `pnpm e2e` → 4/4 passed (1 screenshot helper skipped by design), stable across 3 consecutive runs
   - `pnpm audit --prod` → no known vulnerabilities (after the multer override)
6. **Passed**: all of the above.
7. **Failed during the session and fixed**:
   - Rapid successive edits produced false "someone else changed this" conflicts and lost the second edit. Fixed with per-record write serialisation and a regression test.
   - A test selector race captured the wrong URL. Fixed.
   - A high-severity multer advisory came in through `@nestjs/platform-express`. Fixed with an override to 2.5.0.
8. **Incomplete**: see "Not started" above. The CI workflow has not been run.
9. **Risks identified**:
   - **ORM change**: Prisma was replaced by Drizzle (ADR-013). This needs founder sign-off.
   - **RLS not yet enabled**: tenant isolation currently relies on the API layer plus composite foreign keys.
   - **CSP**: uses `'unsafe-inline'` for scripts. Nonce-based CSP is planned.
   - **`API_INTERNAL_URL`** is read when the web app is built, not at runtime. This is documented.
   - **Rate limiting** is in memory and per instance. Redis is needed before horizontal scaling.
   - **Tauri compatibility** is unproven (ADR-010).
   - **Pinned versions**: TS 7 and Nest 12 were deliberately not adopted.
10. **Next tasks** (Phase 1b):
    - B-01 invitations
    - B-02 member management UI
    - B-03 Postgres RLS
    - B-04 audit log
    - B-05 / B-06 email verification and password reset
    - Run the CI pipeline on GitHub
    - Then Phase 2: milestones, dependencies, comments, documents
