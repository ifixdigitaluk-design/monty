# Development Status (master record)

Last updated: 31 Oct 2026 · Session 5 · Private-beta hardening (email queue, timeouts, data lifecycle, accessibility, containers, observability). Nothing is Production Ready; see the private-beta checklist in RUNBOOKS.md §8.

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
| B-08 | Email via SMTP (provider-neutral), dev mailbox, HTML-escaped templates, invitation emails | Implemented | Verified (log transport) | API tests; Playwright reads real emails from the dev mailbox. **SMTP against a real provider not yet verified** (no credentials) |
| B-05 | Email verification (sign-up, resend, banner) | Implemented | Verified | 4 API tests; Playwright |
| B-06 | Password reset (enumeration-safe, single-use, revokes sessions) | Implemented | Verified | 5 API tests; Playwright incl. second-device sign-out |
| B-03 | Postgres row-level security; API runs as restricted role; refuses to start if RLS is ineffective | Implemented | Verified | 9 RLS tests (SQL-level and simulated missing check); every API and Playwright test now runs as the restricted role |
| B-02 UI | Members & settings page (members, invitations, audit tabs), workspace "Manage access", /invite page | Implemented | Verified | Playwright; screenshots reviewed |
| C-01 | Milestones (progress, complete, detach on delete) | Implemented | Verified | collaboration.e2e; Playwright collaboration flow |
| C-02 | Task dependencies (same project, cycle detection, readiness rule `dependencies_ordered`) | Implemented | Verified | domain cycle tests; API; Playwright |
| C-03 | Comments + @mentions (task and project), safe Markdown rendering | Implemented | Verified | API; Playwright |
| C-04 | Notifications inbox (assigned, mention, comment, automation), idempotent fan-out | Implemented | Verified | API; Playwright |
| D-01 | Documents: nested, linked to projects, version history + restore, conflict detection | Implemented | Verified | documents.e2e; Playwright |
| K-01 | Search (Postgres FTS, prefix, highlights, permission-filtered) + Ctrl K palette | Implemented | Verified | insights.e2e; Playwright |
| K-02 | Calendar (tasks, milestones, targets) and Home dashboard | Implemented | Verified | insights.e2e; Playwright |
| R-01 | Live updates over SSE (LISTEN/NOTIFY, replay, reset, access re-check) + presence | Implemented | Verified | realtime.e2e (two clients, replay, revocation); Playwright two-browser test |
| DT-01 | Tauri 2 desktop shell (origin allowlist, offline fallback page) | Implemented | Tested on Linux only | release build + Rust unit test + Xvfb screenshot. **Windows/macOS builds, signing, auto-update not verified** |
| AI-01 | AI project planning: provider abstraction (local planner default, Anthropic optional), strict output validation, approval, audit | Implemented | Verified (local planner) | ai.e2e incl. fake-fetch Anthropic tests; Playwright. **Real Anthropic API not called** (no key) |
| S-01 | Entitlements: plan tiers, central limits, usage endpoint, 403 PLAN_LIMIT_REACHED, plan & usage tab | Implemented | Verified | API; Playwright. Limits are placeholders; **no pricing, no payment provider** |
| S-02 | Automations: triggers, conditions, actions (notify, status, priority, assign, signed webhook), builder UI, run history | Implemented | Verified | automations.e2e (14 tests: idempotency, no loops, author permission re-check, retries, SSRF); Playwright builder flow |
| O-01 | Retention jobs, readiness probe, configurable DB pool | Implemented | Tested | operations.e2e |
| O-02 | Load test script + baseline | Implemented | Executed | RUNBOOKS §7 (single 2-vCPU host) |
| O-03 | Backup/restore drill script (also in CI) | Implemented | Executed locally | RUNBOOKS §4; CI step not yet run |
| O-04 | Runbooks, alert definitions, launch checklist | Written | n/a | RUNBOOKS.md |
| B-10 | Durable email queue: transactional outbox, encrypted bodies, retry with backoff, permanent failure, expiry, restart-safe, idempotent | Implemented | Tested | mail-queue.e2e (12) against a real local SMTP server; container restart check. **Real provider not verified** |
| O-05 | Statement / idle-in-transaction / lock / pool / request timeouts, 503 mapping, connection recovery | Implemented | Tested | db-timeouts.e2e (10) |
| L-01 | Personal data export (encrypted, expiring, session + token) | Implemented | Verified | data-lifecycle.e2e; Playwright |
| L-02 | Account deletion with emailed confirmation, anonymisation and audit scrubbing | Implemented | Verified | data-lifecycle.e2e; Playwright |
| L-03 | Organisation rename; scheduled deletion, restore, purge | Implemented | Verified | data-lifecycle.e2e; Playwright |
| A-01 | Accessible calendar (WAI-ARIA date grid, keyboard), main landmarks/headings; axe regression test | Implemented | Verified | accessibility.spec: 0 axe violations on 14 page states; keyboard test. No manual screen-reader test |
| O-06 | Dockerfile (api/web/migrate), compose | Implemented | Run locally on a substitute base image | official base image + compose up **not verified** |
| O-07 | Prometheus metrics, error-reporting webhook hook, job/email/automation monitoring | Implemented | Tested | observability.e2e; scraped from a container. **No monitoring service connected** |

Not started: Redis rate limiting (B-07), MFA, labels, attachments, custom fields, saved views, user databases, Yjs collaborative editing, desktop offline cache and signed updates, AI assistant chat / summaries / risk detection, billing provider, integrations (GitHub, Google, Slack), analytics, monitoring stack.

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

## Session 3 report (Phase 1b completion)

1. **Inspected**: GitHub is still not connected to this session. Postgres had stopped again while idle (restarted; data intact).
2. **Developed**:
   - Email over SMTP, so any provider works by configuration. There's a development mailbox for testing.
   - Password reset.
   - Email verification.
   - Invitation emails.
   - Postgres row-level security with a restricted runtime role, plus a startup guard that refuses to run if RLS wouldn't apply.
3. **Files changed**:
   - New: `apps/api/src/mail/*`, `apps/api/src/auth/{account-recovery.service,crypto}.ts`, `apps/api/src/db/request-context.interceptor.ts`, `packages/database/drizzle/0002_user_tokens.sql`, `packages/database/drizzle/0003_row_level_security.sql`, `infra/db/create-app-role.sql`, the web pages `forgot-password`, `reset-password` and `verify-email`, and the tests `account-recovery.e2e`, `rls.e2e` and `account-recovery.spec`.
   - Updated: DbService (request-scoped transactions), config, the CI workflow, `.env.example`, docs.
4. **Functional**: B-03, B-05, B-06 and B-08 as listed in the feature table.
5. **Tests executed** (31 Oct 2026):
   - `pnpm build`, `pnpm typecheck` and `pnpm lint` → exit 0
   - `pnpm test` → domain 33/33, validation 7/7, API 80/80 (the API now runs as the restricted `monty_app` role)
   - `pnpm e2e` → 9/9, three consecutive runs
   - `pnpm audit --prod` → clean
6. **Passed**: all of the above.
7. **Failed during the session and fixed**:
   - The first RLS policy design broke `INSERT … RETURNING`, because the policy looked up the row being inserted within the same statement. Redesigned the policies.
   - "Leave organisation" failed under RLS because the audit row was written after the membership was removed. The audit row is now written first.
   - nodemailer 9.x had 12 advisories. Upgraded to 10.1.7.
   - Two test races (sign-out timing, an ambiguous label) fixed.
8. **Incomplete**:
   - Real SMTP delivery hasn't been tested end to end, because there are no provider credentials.
   - No email retry queue.
   - Redis rate limiting.
   - CI hasn't run.
9. **Risks**:
   - **Request-wide transactions**: each authenticated request holds one database connection for its whole duration, so pool sizing matters under load (Phase 6 load test).
   - **RLS escape hatch**: the system context is a session setting (ADR-009 residual risk).
   - **Sign-up enumeration**: sign-up still reveals whether an email is registered.
   - **Production sending setup**: production needs SPF, DKIM and DMARC configured for the sending domain.
10. **Next**:
    - Connect GitHub and run CI.
    - Choose an email provider and add its credentials, then send one real test email.
    - Then Phase 2: milestones, dependencies, comments, documents.

## Session 4 report (Phases 2–6, autonomous run)

1. **Inspected**: GitHub is still not connected to this session, so nothing has been pushed and CI has never run. Postgres stopped several times while idle (restarted each time; data intact). There's no AI key, SMTP credentials, payment provider, or Windows/macOS machine here.
2. **Developed** (one commit per batch):
   - Phase 2a: milestones, dependencies (cycle-safe), comments, mentions, notifications inbox.
   - Phase 2b: full-text search with Ctrl K palette, calendar, Home dashboard.
   - Phase 2c: documents with nesting, history, restore and safe Markdown (`@monty/editor`).
   - Phase 3: live updates over SSE with Postgres LISTEN/NOTIFY, replay, presence; Tauri 2 desktop shell.
   - Phase 4: AI planning with human approval (local planner by default, Anthropic provider optional).
   - Phase 5: entitlements with placeholder plan limits; automation engine and builder UI.
   - Phase 6: retention jobs, readiness probe, configurable pool, load test, backup/restore drill, runbooks.
3. **Files changed**: migrations 0004–0014. New API modules `collaboration`, `insights`, `documents`, `realtime`, `ai`, `billing`, `automations`, `maintenance`. New web pages `inbox`, `calendar`, `home`, `docs`, `automations`. Also `packages/editor`, `apps/desktop`, `infra/scripts/{load-test.mjs,backup-restore-drill.sh}`, `docs/RUNBOOKS.md`, and updates to the API spec, schema, security, realtime, deployment and roadmap docs.
4. **Functional**: rows C-01 … O-04 above, at the verification level stated in each row.
5. **Tests executed** (31 Oct 2026, this environment):
   - `pnpm build`, `pnpm typecheck` and `pnpm lint` → exit 0
   - `pnpm test` → domain 40/40, validation 8/8, editor 2/2, API 120/120 (13 files, run as the restricted role)
   - `pnpm e2e` → 15/15 passed, 1 screenshot helper skipped by design
   - Desktop: `cargo build --release` and `cargo test` on Linux; smoke screenshot under Xvfb
   - Load test (2 runs) and backup/restore drill — results in RUNBOOKS.md
   - `pnpm audit --prod` → clean
6. **Passed**: all of the above.
7. **Failed during the session and fixed**:
   - Search union type mismatch.
   - Desktop fallback directory was git-ignored.
   - DB pool double-close on failed startup.
   - Lint errors in the search palette.
   - The web build has to be made with `API_INTERNAL_URL` set for e2e (operator error, documented).
   - Load test found search throttled by the per-IP limit. This is expected behaviour; documented as a risk.
8. **Incomplete / unverified**:
   - GitHub push and CI.
   - Real SMTP delivery.
   - Real Anthropic API call.
   - Payments.
   - OAuth integrations.
   - Windows/macOS desktop builds, code signing and auto-update.
   - PITR restore on a managed provider.
   - Monitoring stack.
   - External penetration test.
   - Legal review.
   - Pricing.
9. **Risks**:
   - **Single-instance assumptions**: presence and rate limits are per instance in memory, and automations miss events while no instance is listening.
   - **Pool sizing**: request-wide RLS transactions make pool size the main scaling knob.
   - **CSP** still allows `'unsafe-inline'`.
   - **Sign-up enumeration**: sign-up still reveals whether an email is registered.
   - **Webhook secret rotation** requires recreating the rule.
   - **Unreviewed decisions**: Drizzle instead of Prisma (ADR-013) and SSE instead of WebSockets still need founder review.
10. **Next**:
    - Connect GitHub, push, and get CI green.
    - Choose providers for email, AI, payments, hosting and error tracking.
    - Shared Redis for rate limits and presence.
    - Durable outbox relay for automations.
    - Windows/macOS desktop builds with signing.
    - Pen test and legal review before any launch.

## Session 5 report (private-beta hardening)

1. **Inspected**:
   - Mail, auth and member services.
   - The DB service, filters and config.
   - The calendar and page landmarks.
   - The FK cascade graph for organisation purge.
   - The Docker daemon. It was startable, but every container registry is blocked (Docker Hub, ECR, GCR, GHCR and Quay all returned 403). I built a substitute Ubuntu 24.04 + Node 22.23 base with debootstrap from the Ubuntu archive.
   - GitHub: creating a repository is blocked for this session.
   - All work is on branch `beta-readiness`.
2. **Developed (one commit per priority)**:
   - P1: durable email queue.
   - P2: timeouts.
   - P3: data lifecycle (rules in DATA_LIFECYCLE.md).
   - P4: accessibility.
   - P5: containers and compose.
   - P6: metrics, error reporting and job monitoring.
3. **Files**:
   - New:
     - `apps/api/src/{common/encryption.ts, common/db-errors.ts, account/*, observability/*}`
     - `apps/web/src/app/{settings/account, account/delete}/page.tsx`
     - `Dockerfile`, `.dockerignore`, `compose.yaml`, `infra/docker/*`
     - `docs/DATA_LIFECYCLE.md`
     - API tests: `mail-queue`, `db-timeouts`, `data-lifecycle`, `observability`
     - e2e tests: `accessibility`, `data-lifecycle`
     - Test SMTP server: `apps/api/test/smtp-test-server.ts`
   - Modified:
     - Mail service and transports, account recovery, members service
     - DB service, config, app factory, `main.ts`, exception filter, logging, realtime (extra NOTIFY channels), maintenance, automations
     - Calendar, AuthForm, CenteredCard, invite/docs/project pages, AppShell, organisation page
     - api-client, validation, package manifests (`files`; `pg` moved to API dependencies), `next.config` (optional standalone output)
     - CI workflow, docs
4. **Migrations**:
   - `0015_email_outbox`
   - `0016_email_outbox_rls`
   - `0017_data_lifecycle` (data_exports, organisation deletion columns, ACCOUNT_DELETION token purpose)
   - `0018_data_lifecycle_rls`

   All are additive. They were applied to dev, test, e2e and a fresh container database.
5. **Tests executed** (31 Oct 2026):
   - `pnpm build`, `pnpm typecheck` and `pnpm lint` → exit 0
   - `pnpm audit --prod` → clean
   - `pnpm test` → domain 40/40, validation 8/8, editor 2/2, API 154/154 (17 files). The full API suite was run twice consecutively and passed both times.
   - `pnpm e2e` → 18 passed, 1 skipped (screenshot helper)
   - Backup/restore drill → passed (25 tables, 19 with RLS, 19 migrations)
   - Containers (production mode, substitute base): healthy, register via web proxy, `Secure` cookie, read-only FS, UID 10001, metrics, graceful SIGTERM (~0.1 s), email queue persisted across restart
6. **Previously passing tests**:
   - All earlier API (120) and Playwright (15) tests still pass.
   - `account-recovery` tests now wait for the queue, because email is no longer sent inline.
   - One production-config assertion now supplies the newly required `DATA_ENCRYPTION_KEY`.
7. **Failed during the session and fixed**:
   - **Shutdown order:** the mail worker used the pool after it was closed. Fixed by closing the pool in `onApplicationShutdown`.
   - **Idle-transaction error lost:** drizzle surfaced the rollback failure rather than the original error. Fixed by classifying "not queryable".
   - **Test race:** a test-harness TRUNCATE deadlocked with an in-flight mail worker. Fixed with a retry in `resetDb`; this was not a product bug.
   - **Missing runtime dependency:** `pg` was a dev-only dependency of the API, so the container would have lacked it at runtime.
   - **Docker build:** the `# syntax` directive needed a registry pull.
   - Minor test expectations.
8. **Outstanding**: see the RUNBOOKS §8 checklist. Main local gaps:
   - Redis for running more than one instance
   - CSP nonces
   - Sign-up enumeration
   - MFA
   - Manual screen-reader testing
   - `DATA_ENCRYPTION_KEY` rotation
9. **Risks**:
   - **Email delivery** is at least once, so a crash can cause one duplicate send.
   - **Late commits:** a `REQUEST_TIMEOUT` answer can coexist with a late commit (the user is told to refresh).
   - **Images built on a substitute base:** they were built and run on a different base distro than the official image.
   - **Retention periods** for audit and activity data need legal confirmation.
