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
| POST | `/auth/password-reset` | `{email}` → always 202 with the same body; emails a 1-hour link if the account exists |
| POST | `/auth/password-reset/confirm` | `{token, password}` → 204; signs out every session. 400 if the link is invalid or expired |
| POST | `/auth/verify-email` | `{token}` → 204 |
| POST | `/auth/verify-email/resend` | signed in → 202 `{sent}` |
| GET | `/dev/mailbox?to=` | **development only** (log transport, non-production): captured emails |
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

### Phase 2 — collaboration, documents, insights
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET/POST | `/projects/:id/milestones` | read / task.create | `{name, dueDate?, description?}` |
| PATCH/DELETE | `/milestones/:id` | task.update | `expectedVersion`; `completed: true` stamps `completedAt`; delete detaches tasks |
| GET | `/projects/:id/dependencies` | read | |
| POST | `/tasks/:id/dependencies` | task.update | `{dependsOnTaskId}`; same project only; cycles rejected (400) |
| DELETE | `/tasks/:id/dependencies/:depId` | task.update | |
| GET/POST | `/projects/:id/comments`, `/tasks/:id/comments` | read / comment | Markdown body; `<@uuid>` mentions notify members who can see the workspace |
| DELETE | `/comments/:id` | author or admin | soft delete |
| GET | `/me/notifications?unread=1` | self | types: `mention`, `assigned`, `comment`, `automation` |
| POST | `/me/notifications/read` | self | `{ids?}` (omit = all) |
| GET | `/search?q=` | accessible workspaces | Postgres FTS over projects, tasks, documents; highlights as `[[ ]]`; 120/min per IP |
| GET | `/calendar?from&to&mine` | accessible workspaces | tasks, milestones, project targets |
| GET | `/me/home` | self | overdue, due soon, at-risk projects, recent activity |
| GET/POST | `/workspaces/:id/documents` | read / doc.create | nested via `parentId`, optional `projectId` |
| GET/PATCH/DELETE | `/documents/:id` | read / update | optimistic `expectedVersion`; every save snapshots a version |
| GET | `/documents/:id/versions` | read | |
| POST | `/documents/:id/versions/:versionId/restore` | update | restoring creates a new version (history is never rewritten) |

### Phase 3 — live updates
| GET | `/workspaces/:id/events?projectId=` | read | Server-Sent Events: `ready`, `change` (pointer: topic, entityId, version, actorId), `presence`, `reset`, `revoked`. Honors `Last-Event-ID` (replay ≤ 500). |

### Phase 4 — AI (human approval required)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/ai/status` | signed in | which provider is active (`local` or `anthropic`) |
| POST | `/projects/:id/ai/plan` | task.create, plan limit | `{guidance?}` → PENDING proposal; nothing changes; 20/min |
| GET | `/projects/:id/ai/proposals` | read | |
| POST | `/ai/proposals/:id/apply` | task.create | `{taskIndexes}`; locked + audited; creates tasks and dependencies; 409 if already decided |
| POST | `/ai/proposals/:id/reject` | task.create | |

### Phase 5 — entitlements and automations
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/organisations/:id/usage` | org member | plan, limits (placeholders, no prices), usage. Over-limit actions return 403 `PLAN_LIMIT_REACHED` |
| GET/POST | `/workspaces/:id/automations` | workspace.manage, plan limit | trigger `task.created/updated/status_changed/overdue`; conditions `projectId, status, priority, assigneeId, toStatus`; actions `notify, set_status, set_priority, assign, webhook(https)` |
| PATCH/DELETE | `/automations/:id` | workspace.manage | `expectedVersion`; editor becomes the rule's author (runs with their permissions) |
| GET | `/automations/:id/runs` | workspace.manage | last 50 runs: `SUCCEEDED/FAILED/SKIPPED/RUNNING`, attempts, error |

Webhook requests: `POST` JSON `{event, rule, task, runId}` with `X-Monty-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`. 5 s timeout, no redirects, private/loopback/link-local destinations refused at connect time.

### Phase 6 — operations
| GET | `/health` | public | liveness + DB |
| GET | `/health/ready` | public | 503 unless DB and the live-update listener are both up |

### Session 5 — data lifecycle and operations
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/me/exports` | self | unexpired exports (metadata only) |
| POST | `/me/exports` | self, 1 per 10 min (429) | builds an encrypted JSON export; returns `downloadPath` with a one-time-shown token; expires in 24 h |
| GET | `/me/exports/:id/download?token=` | same signed-in user + token | `attachment`, `Cache-Control: no-store`; 404 for anyone else or a wrong token; 410 after expiry |
| GET | `/me/deletion-blockers` | self | team organisations where the user is the only owner and others are members |
| POST | `/me/deletion-request` | self + `{password}` | 202; emails a 1-hour single-use link; 409 with `details.blockers` if blocked; 403 for a wrong password |
| POST | `/me/deletion-confirm` | same signed-in user + `{token, confirm:"DELETE"}` | irreversible erasure (DATA_LIFECYCLE.md §3); clears the cookie |
| PATCH | `/organisations/:id` | owner/admin | `{name}` |
| DELETE | `/organisations/:id` | owner, team orgs only | `{confirmName, password}` → scheduled deletion (hidden at once, purged after 30 days) |
| GET | `/organisations/pending-deletion` | owners | restorable organisations |
| POST | `/organisations/:id/restore` | owner | 204; 404 after the grace period |
| GET | `/metrics` | `Authorization: Bearer METRICS_TOKEN` | Prometheus text; 404 when `METRICS_TOKEN` is unset |

New error codes: **503 `SERVICE_UNAVAILABLE`** (database busy/unreachable; `Retry-After: 2`; nothing was saved) and **503 `REQUEST_TIMEOUT`** (handler exceeded `REQUEST_TIMEOUT_MS`; the change may have been saved — refresh before retrying). `invitation.emailSent` now means "queued for delivery".

## Not implemented (planned)
Attachments (pre-signed object storage), saved views, custom fields, user databases, integrations (OAuth: GitHub, Google, Slack), billing provider webhooks, public API tokens, desktop token exchange via deep link, WebSocket transport (SSE is used), Yjs collaborative editing.
