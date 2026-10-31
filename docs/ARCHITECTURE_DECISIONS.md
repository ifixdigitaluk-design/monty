# Architecture Decision Records

Format: context → decision → consequences. Status in brackets.

## ADR-001 Monorepo with pnpm workspaces [Accepted]
One repo for web, api, worker, desktop and shared packages so contracts and rules are shared. No Turborepo yet (avoid dependency until build times justify it); `pnpm -r` runs in topological order.

## ADR-002 Modular monolith, not microservices [Accepted]
Small team, unproven load. NestJS modules per domain (auth, tenancy, projects, tasks, readiness, activity). Modules talk through services, not each other's tables. Extraction later is possible because events go through the outbox.

## ADR-003 Personal workspace = personal organisation [Accepted]
Instead of a separate "personal" concept, sign-up creates an `Organisation(kind=PERSONAL)` owned by the user, with one workspace. Joining a team org adds memberships to the same account. One permission code path; no migration when a freelancer starts a team.

## ADR-004 Session tokens, not JWT [Accepted]
Opaque random 256-bit tokens; only a SHA-256 hash is stored. Enables instant revocation and a session list. Web uses an HttpOnly, SameSite=Lax cookie through a same-origin proxy; desktop (Phase 3) uses the same token as a Bearer header stored in the OS keychain. Passwords hashed with Argon2id.

## ADR-005 Business logic outside Next.js [Accepted]
The web app renders on the client and calls the API. No Server Actions or route handlers with business rules. Reason: one backend for web and desktop; lets the UI be statically exported for Tauri. Consequence: app routes use query parameters (`/project?id=…`) rather than dynamic segments so static export works without `generateStaticParams`.

## ADR-006 Concurrency strategy per data type [Accepted]
- Structured records (projects, tasks): optimistic concurrency with `version`; server rejects stale writes with 409; client shows the conflict.
- Rich documents: Yjs CRDT (Phase 3).
- Presence: ephemeral, in memory/Redis, never persisted.
- Notifications/automation: append-only events with unique IDs; consumers idempotent.

## ADR-007 Readiness is deterministic [Accepted]
Readiness and computed status come from pure rules over project data (`packages/domain/readiness`). Organisations will configure which rules apply and their severity (Phase 4). AI may explain results but never sets them.

## ADR-008 Conservative major versions [Accepted]
TypeScript 7 (native compiler) and NestJS 12 are recent majors. We pin TS 5.9 and Nest 11 to keep decorator metadata, ecosystem tooling (typescript-eslint, SWC) and documented behaviour stable. Revisit each quarter.

## ADR-009 Tenant isolation layers [Accepted, RLS implemented in session 3]
1. API authorisation via `packages/domain` permission function on every request.
2. Tenant columns + composite foreign keys.
3. Postgres row-level security (migration `0003_row_level_security.sql`):
   - The API connects as `monty_app` (not owner, NOBYPASSRLS). Migrations use the owner role.
   - Each authenticated request runs in one transaction with `app.user_id` set. Policies call SECURITY DEFINER helpers (`app_user_org_ids`, `app_user_admin_org_ids`, `app_user_member_workspace_ids`) that mirror `effectiveWorkspaceRole`.
   - Workspaces, projects and tasks are filtered per workspace. Activity, outbox, invitations, dependencies and audit are filtered per organisation. Account-level audit rows are visible only to their own user.
   - Membership tables are not row-filtered: they are the source of truth.
   - **System context**: `app.system = on` is used only for invitation preview and accept by secret token (`DbService.runAsSystem`).
   - **Residual risk**: SQL injection could set the GUC. Mitigation: all queries are parameterised; a stricter future option is a separate BYPASSRLS system role.
   - The API refuses to start when `REQUIRE_RLS` is on (always in production) and RLS wouldn't apply: superuser, BYPASSRLS, or table owner.
   - Consequence: a request is a transaction. A thrown error rolls back all its writes.

## ADR-010 Desktop with Tauri 2 [Proposed — needs proof]
Small binaries, Rust core for keychain, notifications, deep links, updater with signature verification. Risk: WebView differences (WebKit on macOS/Linux vs WebView2 on Windows) for the editor. Proof of compatibility in Phase 3 before committing: build shell, load static export, run editor + WebSocket smoke tests on all three OSes. Fallback: Electron.

## ADR-011 Custom properties are relational, not a JSON blob [Accepted for Phase 2]
`PropertyDefinition` (typed) + typed value tables (`PropertyValueText/Number/Date/Option`) with FKs and indexes. JSON only for formula cache/derived data.

## ADR-012 Search starts in Postgres [Accepted]
`tsvector` columns + GIN indexes, query always joined to permission scope. Move to a dedicated engine only when measured relevance/latency requires it.

## ADR-013 Drizzle ORM instead of Prisma [Accepted — replaces the brief's "Prisma ORM" recommendation]
Context: the brief recommended Prisma. In Phase 1, Prisma 6 and 7 both needed native engine binaries downloaded from `binaries.prisma.sh` at install/migrate time, and the build sandbox blocks that host. That is an environment issue, but it exposed real costs: binary engines complicate locked-down CI, air-gapped/enterprise installs and desktop packaging, and Prisma makes Postgres RLS (ADR-009) awkward because the session setting must be applied inside the same transaction as every query.
Decision: Drizzle ORM 0.45 + node-postgres. Pure TypeScript, no engine binaries; schema in TS; drizzle-kit generates plain SQL migrations that we commit and review; explicit transactions make per-request `set_config` for RLS simple.
Consequences: queries are a little more explicit (joins rather than nested includes). Composite FKs, enums and composite indexes are expressed in the schema. Reversible: the SQL schema is ORM-neutral, so Prisma could introspect it later if the founder prefers.

## ADR-014 Email over SMTP behind a transport port [Accepted]
Context: password reset, email verification and invitations need email; the provider wasn't chosen yet.
Decision: a `MailTransport` interface with an SMTP implementation (nodemailer ≥10.1.4 for security fixes, STARTTLS required) and an in-memory log transport for dev/test. Postmark, Resend, Amazon SES and Mailgun all accept SMTP, so choosing a provider is configuration only (`SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`). Production refuses to start with the log transport.
Consequences: sending happens after commit and isn't retried yet. A failed invitation email is reported in the UI and the link can be shared manually. Reset emails are fire-and-forget so timing doesn't reveal whether an account exists. A queued outbox with retries is planned alongside the Phase 3 worker. Provider-specific features (webhooks for bounces) are a later addition.
