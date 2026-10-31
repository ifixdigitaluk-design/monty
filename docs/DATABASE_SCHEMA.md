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
| `AuditLog` (1b) | Security/admin events | `organisationId` null for account-level events (login, logout); indexed by org and actor |

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
| 2 | `Team`, `TeamMembership`, `Milestone`, `Label`, `TaskLabel`, `Comment`, `Mention`, `Attachment`, `Document`, `DocumentVersion`, `Notification`, `NotificationPreference`, `PropertyDefinition` + typed value tables, `SavedView` |
| 3 | `DocumentYjsUpdate` (or snapshot+updates), `DeviceRegistration`, `SyncCursor` |
| 4 | `AiConversation`, `AiProposal`, `AiAction`, `ReadinessRuleConfig` |
| 5 | `AutomationRule`, `AutomationExecution`, `Integration`, `IntegrationToken` (encrypted), `Plan`, `Subscription`, `Entitlement`, `UsageCounter` |

## 5. Migrations
`pnpm db:generate` (drizzle-kit) creates SQL from schema changes; the SQL is committed and reviewed; `pnpm db:migrate` applies it. Forward-only in production. Destructive changes use expand → migrate data → contract across releases.

## 6. Backup & restore
Managed Postgres with PITR (target RPO ≤ 15 min). Restore drill scripted and run in Phase 6 before launch.
