# Database Schema

Source of truth: `packages/database/src/schema.ts` (Drizzle). Generated SQL migrations live in `packages/database/drizzle/`. This document explains intent; SQL table names are snake_case plurals (`tasks`, `workspace_memberships`, …).

## 1. Tenancy hierarchy
```
User ─┬─< Session
      ├─< OrganisationMembership >── Organisation (kind PERSONAL | TEAM)
      └─< WorkspaceMembership   >── Workspace ──< Project ──< Task ──< Task (subtasks)
                                                   │          └─< TaskDependency
                                                   └─< ActivityEvent, OutboxEvent (org-scoped)
```

## 2. Implemented tables (Phase 1 slice)
| Table | Purpose | Key constraints |
|---|---|---|
| `User` | Account | `email` unique (stored lowercase); soft delete `deletedAt` |
| `Session` | Login sessions | `tokenHash` unique; `expiresAt`, `revokedAt` |
| `Organisation` | Tenant root | `slug` unique; `personalOwnerId` unique → max one personal org per user |
| `OrganisationMembership` | User ↔ org role | unique (`organisationId`,`userId`); role OWNER/ADMIN/MEMBER/GUEST |
| `Workspace` | Space inside an org | unique (`organisationId`,`slug`); unique (`id`,`organisationId`) for composite FKs |
| `WorkspaceMembership` | User ↔ workspace role | unique (`workspaceId`,`userId`); role ADMIN/MEMBER/VIEWER |
| `Project` | Project | composite FK (`workspaceId`,`organisationId`) → Workspace; `version`; `lifecycle`; `deletedAt` |
| `Task` | Task / subtask | composite FK (`projectId`,`workspaceId`) → Project; self-relation `parentTaskId`; `version`; `sortOrder` |
| `TaskDependency` | Task A depends on B | unique pair; both tasks same org (API-enforced, Phase 2 API) |
| `ActivityEvent` | Append-only history | indexed by (`projectId`,`createdAt`) |
| `OutboxEvent` | Transactional outbox | `publishedAt` null = pending; index on pending |
| `Invitation` (1b) | Pending org invitations | `tokenHash` unique (raw token never stored); partial unique index = one open invite per (org, email); composite FK keeps the optional workspace in the same org; 7-day expiry |
| `UserToken` (1b) | Password-reset and email-verification tokens | `tokenHash` unique; purpose enum; bound to the email it was sent to; single use |
| `AuditLog` (1b) | Security/admin events | `organisationId` null for account-level events (login, logout); indexed by org and actor |
| `Milestone` (2) | Project milestones | per project; `version`; `completedAt`; tasks reference via `milestoneId` (set null on delete) |
| `Comment` (2) | Task or project discussion | Markdown body; mentions as `<@uuid>`; soft delete |
| `Notification` (2) | Inbox items | per recipient; unique `dedupeKey` per recipient makes fan-out idempotent |
| `Document`, `DocumentVersion` (2) | Nested workspace docs + full history | `parentId` tree (cycle-checked), optional `projectId`; generated `tsvector` + GIN for search |
| `AiProposal` (4) | AI suggestions awaiting a decision | stores input sent and validated output; status PENDING → APPLIED/REJECTED; `appliedEntityIds` |
| `organisations.plan` (5) | Plan tier | enum FREE/PRO/TEAM/BUSINESS/ENTERPRISE; limits in `@monty/domain` `PLAN_LIMITS` |
| `AutomationRule` (5) | Trigger → conditions → actions | composite FK to workspace; JSON validated by Zod before storage; `version`; soft delete; HMAC `webhookSecret` |
| `AutomationRun` (5) | Execution log | unique (`ruleId`,`eventKey`) = idempotency claim; status, attempts, error, detail |

| `EmailOutbox`, `EmailDeliveryAttempt` (session 5) | Durable email queue and per-attempt log | unique `idempotencyKey`; `payload` AES-256-GCM encrypted, nulled when final; status PENDING/SENDING/SENT/FAILED/EXPIRED; lease `lockedUntil`; RLS: system context only |
| `DataExport` (session 5) | Personal data exports | gzip + AES-256-GCM `content`; SHA-256 `downloadTokenHash`; 24 h `expiresAt`; RLS: owner or system |
| `organisations.deletionRequestedById`, `purgeAfter` (session 5) | Scheduled organisation deletion | `deletedAt` set → hidden; purged after `purgeAfter` |
| `user_token_purpose` += `ACCOUNT_DELETION` | Emailed account-deletion confirmation | 1 h, single use |

Search: `projects`, `tasks` and `documents` carry a generated `search` tsvector column with a GIN index (migrations 0006, 0008).

## 3. Rules
- All IDs are UUID v4 (client-supplied allowed on create for idempotency).
- Every tenant row has `organisationId`. Workspace-scoped rows also have `workspaceId`.
- Composite FKs guarantee a task's project is in the task's workspace and a project's workspace is in the project's org.
- Soft delete (`deletedAt`) on User, Organisation, Workspace, Project, Task. All reads filter `deletedAt IS NULL`.
- Mutable business rows have `version INT` incremented on every update.
- Timestamps are `timestamptz(3)`; project/task dates are `date` and travel as `YYYY-MM-DD` strings end-to-end (no timezone drift).
- Indexes: tasks by (`projectId`,`deletedAt`,`status`), (`assigneeId`,`deletedAt`), (`workspaceId`); projects by (`workspaceId`,`deletedAt`).

## 4. Planned tables
| Phase | Tables |
|---|---|
| 2 (remaining) | `Team`, `TeamMembership`, `Label`, `TaskLabel`, `Attachment`, `NotificationPreference`, `PropertyDefinition` + typed value tables, `SavedView` |
| 3 (remaining) | `DocumentYjsUpdate` (or snapshot+updates), `DeviceRegistration`, `SyncCursor` |
| 4 (remaining) | `AiConversation`, `AiAction`, `ReadinessRuleConfig` |
| 5 (remaining) | `Integration`, `IntegrationToken` (encrypted), `Subscription`, `UsageCounter` (usage is currently counted live) |

## 5. Row-level security
See ADR-009 and `drizzle/0003_row_level_security.sql`. RLS is enabled on every table that carries `organisation_id` or `workspace_id` (16 tables), except the two membership tables that the policy helper functions read. A guard test (`rls.e2e`) fails if a new tenant table is added without RLS. Policies: migrations 0003, 0005, 0008, 0011, 0014, 0016 (email queue: system only), 0018 (exports: owner only). 19 tables have RLS.

## 6. Migrations
`pnpm db:generate` (drizzle-kit) creates SQL from schema changes; the SQL is committed and reviewed; `pnpm db:migrate` applies it. Forward-only in production. Destructive changes use expand → migrate data → contract across releases.

## 7. Retention (MaintenanceService, hourly)
Outbox events 7 days (live-update replay window); expired/revoked sessions 30 days after expiry; used/expired email tokens 7 days; automation runs 90 days; finished email metadata 30 days; data exports at expiry (24 h); organisations whose deletion grace period (30 days) ended. Full rules: DATA_LIFECYCLE.md. Activity history and audit logs are never pruned automatically. Deletes run in batches of 5,000.

## 8. Backup & restore
Target: managed Postgres with PITR (RPO ≤ 15 min). Logical backup drill: `infra/scripts/backup-restore-drill.sh` (pg_dump custom format → restore into a scratch DB → compares every table's row count, RLS-enabled tables, policies and the migration journal, then checks that the restricted role sees nothing without a user context). Run here on 31 Oct 2026: passed (session 4: 22 tables, 16 with RLS, 15 migrations; session 5 on the e2e database: 25 tables, 19 with RLS, 19 migrations). Also runs in CI after e2e. A PITR restore on the managed provider has **not** been exercised (no provider chosen).
