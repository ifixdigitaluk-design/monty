# Development Status (master record)

Last updated: 31 Oct 2026 · Session 2 · Phase 1b membership work delivered (invitations, member management, audit log).

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
| — | Client write serialisation (no false conflicts on rapid edits) | Implemented | Verified | regression Playwright test (bug found in session 1) |
| B-01 | Invitations: create, preview, accept, revoke; email-bound, single-use, expiring | Implemented | Verified | 7 API tests; Playwright invite → sign-up → accept, and wrong-account test |
| B-02 | Member management: list, role change, remove, leave; last-owner protection; workspace access grant/change/remove | Implemented | Verified | 8 API tests incl. concurrent demotion race; Playwright role change, access removal and member removal |
| B-04 | Audit log (security + admin events) with org-admin view | Implemented | Verified | 2 API tests; Playwright audit tab |
| B-02 UI | Members & settings page (members, invitations, audit tabs), workspace "Manage access", /invite page | Implemented | Verified | Playwright; screenshots reviewed |

Not started: RLS (B-03), email provider + invitation emails (B-08), email verification (B-05), password reset (B-06), Redis rate limiting (B-07), milestones, dependencies API, comments, attachments, documents and editor, search, notifications, realtime, desktop, AI, automation, billing, integrations, analytics.

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

## Session 2 report (Phase 1b)

1. **Inspected**: GitHub is still not connected to this session. The proxy only allows repositories attached to the session, so no repo could be created or pushed. Postgres had stopped while idle; I restarted it and the data was intact.
2. **Developed**:
   - Invitations: link-based, email-bound, single-use, 7-day expiry.
   - Member management: org roles with owner safeguards, plus workspace access.
   - Audit log: security and admin events.
   - UI: Members & settings page, workspace Manage access dialog, /invite accept page, and email prefill on sign-up and sign-in.
3. **Files changed**:
   - New: `packages/domain/src/membership.ts`, `packages/database/drizzle/0001_invitations_audit.sql`, `apps/api/src/audit/*`, `apps/api/src/tenancy/members.*`, `apps/web/src/app/{organisation,invite}/page.tsx`, `apps/web/src/components/WorkspaceAccess.tsx`, `apps/api/test/members.e2e.test.ts`, `e2e/tests/team-membership.spec.ts`.
   - Updated: auth and organisation services (audit events), api-client, validation, sidebar, docs.
4. **Functional**: B-01, B-02 and B-04 as listed above.
5. **Tests executed** (31 Oct 2026):
   - `pnpm build`, `pnpm typecheck` and `pnpm lint` → exit 0
   - `pnpm test` → domain 33/33, validation 7/7, API 58/58
   - `pnpm e2e` → 6/6, run twice consecutively
   - `pnpm audit --prod` → clean
6. **Passed**: all of the above.
7. **Failed**: none at the end of the session. One screenshot-helper mistake was fixed along the way.
8. **Incomplete**:
   - Invitations are shared as a copyable link; there is no email delivery yet (needs an email provider choice).
   - RLS, email verification, password reset and Redis rate limiting are not started.
   - CI is still not run.
9. **Risks**:
   - **No email provider yet**, so account recovery isn't possible. This blocks a public launch.
   - **RLS is still pending.**
   - **Invite link handling**: anyone who holds the link can see the inviter's name and the invited email. That is a deliberate trade-off for preview UX; tokens are 256-bit and rate-limited.
10. **Next**:
    - Choose an email provider (Postmark, Resend or AWS SES), then build B-08, B-05 and B-06.
    - B-03 RLS.
    - Push to GitHub and run CI.
    - Then Phase 2.
