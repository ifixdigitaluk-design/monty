# Product Roadmap

Phases are sequential gates; each ends with tests passing and DEVELOPMENT_STATUS updated. Durations are estimates for a small team (2–4 engineers) and will be revised.

| Phase | Goal | Exit criteria | Est. |
|---|---|---|---|
| 0 Discovery | Research, PRD, architecture, schema, security, backlog | Docs approved by founder | done (v0.1) |
| 1 Foundation | Monorepo, auth, sessions, personal + team orgs, workspaces, roles, projects/tasks slice, readiness v0, logging, tests | Vertical slice works end-to-end, cross-tenant tests pass | 4–6 wks |
| 1b Hardening | Invitations, member management, RLS, audit log, email verification, password reset, CI pipeline | RLS enabled in prod config; CI green | 2–3 wks |
| 2 Core workspace | Home dashboard, milestones, dependencies, labels, comments, mentions, attachments, documents (basic editor), activity feed, calendar view, search (FTS), notifications/inbox, custom fields | All Module C/D/E-basic/K/M acceptance criteria pass | 8–12 wks |
| 3 Realtime + desktop | Outbox relay, WS gateway, live task updates, presence, Yjs documents, Tauri shell (proof → app), notifications, deep links, signed updates, SQLite cache, offline queue | Two-client and reconnection tests; desktop install/update on Win/macOS | 8–12 wks |
| 4 AI & intelligence | Provider abstraction, permission-aware retrieval, assistant, idea→plan proposals, summaries, approvals, AI audit, configurable readiness, risk detection | AI acceptance criteria; red-team prompt-injection tests | 8–10 wks |
| 5 Automation & SaaS | Automation engine + builder, user databases, advanced permissions, entitlements, billing provider, integrations (GitHub, Google, Slack), analytics | Billing end-to-end in test mode; automation idempotency tests | 10–14 wks |
| 6 Production readiness | Load, security, restore drills, monitoring, runbooks, desktop signing, launch checklist | Launch checklist signed off | 4–6 wks |

## Sequencing rationale
- Readiness v0 ships in Phase 1 because it is the signature feature and only needs project + task data.
- Realtime comes after the core model is stable, so event shapes don't churn.
- Desktop after realtime, because offline sync depends on the event/versions model.
- AI after permissions, search and activity exist, so it has trustworthy, authorised context.
