# API Specification (v1)

Base path `/api/v1`. JSON. Contracts are the Zod schemas in `packages/validation` (single source of truth for server validation and client types).

## Conventions
- **Auth**: session cookie `monty_session` (web) or `Authorization: Bearer <token>` (desktop, Phase 3).
- **CSRF**: every non-GET request must send `X-Monty-Client: web|desktop`. Requests with an `Origin` header not in `ALLOWED_ORIGINS` are rejected (403).
- **Errors**: `{ "error": { "code": "NOT_FOUND", "message": "...", "details"?: ... } }`. Codes: `VALIDATION_FAILED` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` / `VERSION_CONFLICT` 409, `RATE_LIMITED` 429.
- **Not found vs forbidden**: resources the caller cannot read return 404 (no existence leak). Readable but not writable → 403.
- **Concurrency**: PATCH bodies require `expectedVersion`; mismatch → 409 `VERSION_CONFLICT` with `details.current` (the server record).
- **Idempotent create**: POST may include `id` (UUID). Replaying with the same `id` by the same user in the same scope returns the existing record with 200; otherwise 201.
- **Rate limits**: auth endpoints 10/min/IP; others 300/min/IP (Phase 1 in-memory; Redis-backed in Phase 3).

## Endpoints (implemented in Phase 1 slice)
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness + DB check |
| POST | `/auth/register` | `{email,name,password}` → creates user, personal org, workspace; sets session |
| POST | `/auth/login` | `{email,password}` → sets session |
| POST | `/auth/logout` | Revokes current session |
| GET | `/auth/me` | Current user |
| GET | `/auth/sessions` | Active sessions for current user |
| DELETE | `/auth/sessions/:id` | Revoke one of own sessions |
| GET | `/organisations` | Orgs I belong to, with role and workspaces I can access |
| POST | `/organisations` | `{name}` → TEAM org, caller OWNER, default workspace |
| POST | `/organisations/:orgId/workspaces` | `{name}` (org OWNER/ADMIN) |
| GET | `/workspaces/:workspaceId/projects` | Projects in workspace |
| POST | `/workspaces/:workspaceId/projects` | `{id?,name,objective?,description?,ownerId?,priority?,startDate?,targetDate?}` |
| GET | `/projects/:projectId` | Project + members who can be assigned |
| PATCH | `/projects/:projectId` | Partial update + `expectedVersion` |
| DELETE | `/projects/:projectId` | Soft delete (workspace ADMIN or project creator) |
| GET | `/projects/:projectId/tasks` | All tasks (top-level + subtasks) |
| POST | `/projects/:projectId/tasks` | `{id?,title,description?,status?,priority?,assigneeId?,startDate?,dueDate?,parentTaskId?,estimateMinutes?,blockedReason?}` |
| PATCH | `/tasks/:taskId` | Partial update + `expectedVersion` |
| DELETE | `/tasks/:taskId` | Soft delete |
| GET | `/projects/:projectId/readiness` | Deterministic readiness report + computed status |
| GET | `/projects/:projectId/activity` | Last 100 activity events |
| GET | `/me/tasks` | Open tasks assigned to me across accessible workspaces |

### Membership, invitations and audit (Phase 1b)
| Method | Path | Who | Description |
|---|---|---|---|
| GET | `/organisations/:orgId/members` | org Member+ | Members with org role and explicit workspace roles |
| PATCH | `/organisations/:orgId/members/:userId` | Owner/Admin | `{role}`. Only owners grant or change ownership; the last owner can't be demoted (row-locked, so concurrent changes are safe) |
| DELETE | `/organisations/:orgId/members/:userId` | Owner/Admin, or self (leave) | Removes org membership and every workspace membership in that org. Personal orgs are rejected (400) |
| GET | `/organisations/:orgId/invitations` | Owner/Admin | Pending invitations (never includes tokens) |
| POST | `/organisations/:orgId/invitations` | Owner/Admin | `{email, role: ADMIN/MEMBER/GUEST, workspaceId?, workspaceRole?}` → `invitePath` with a one-time token, returned once. 409 for an existing member or a pending invite; 400 for a personal org |
| DELETE | `/organisations/:orgId/invitations/:id` | Owner/Admin | Revoke |
| GET | `/invitations/:token` | public, rate-limited | Preview: organisation, inviter, email, role, workspace, status |
| POST | `/invitations/:token/accept` | signed in, rate-limited | Signed-in email must match the invite (else 403). Single use (410 once accepted/revoked/expired). Never downgrades an existing role |
| GET | `/organisations/:orgId/audit` | Owner/Admin | Last 200 audit entries |
| GET | `/workspaces/:id/members` | workspace read | Workspace admins also see org members without access, so they can grant it |
| PUT | `/workspaces/:id/members/:userId` | workspace Admin | `{role}`. Target must be an org member (400 otherwise) |
| DELETE | `/workspaces/:id/members/:userId` | workspace Admin | Remove explicit workspace access |

## Planned
Phase 2: invitation emails, teams, milestones, dependencies, comments, attachments (pre-signed S3 URLs), documents, search, notifications, saved views.
Phase 3: `/realtime` WebSocket (subscribe by workspace; events carry `eventId` for de-duplication), desktop token exchange via deep link.
Phase 4: `/ai/*` (conversations, proposals, approve/reject), readiness rule configuration.
Phase 5: automations, integrations (OAuth callbacks), billing webhooks, public REST tokens.
