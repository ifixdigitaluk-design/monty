# Monty — Product Requirements

Working name: **Monty**. Version 0.1 (Phase 0). See `COMPETITOR_ANALYSIS.md` for evidence.

## 1. Mission
One environment where a person or an organisation goes **Think → Plan → Organise → Collaborate → Execute → Monitor → Deliver**, starting from an idea and ending with a delivered, traceable project. Monty optimises for *work getting finished*, not for displaying work.

## 2. Positioning
"The project workspace that tells you the truth about your work." Docs, tasks and projects in one model, with a deterministic readiness/health engine and accountable AI.

## 3. Audiences and how one product adapts
| Segment | Starting shape | What changes |
|---|---|---|
| Individual / freelancer | Personal organisation with one workspace | Simplified nav; no member admin |
| Startup / agency / SMB | Team organisation, several workspaces, guests | Teams, roles, client guests |
| Software teams / PMs | Same + dependencies, milestones, timeline | Views and templates, not a different product |
| Mid-size / enterprise | Same + SSO, SCIM, audit export, data residency | Entitlements, not a fork |

Adaptation is via **entitlements + workspace templates + role-aware navigation**, never separate apps.

## 4. Core principles
1. One authoritative backend and data model for web and desktop.
2. Every view is a projection of the same records.
3. Saved means persisted: the UI shows "saved" only after the server commits.
4. Permissions are enforced on the server (and later in Postgres RLS); the UI only hides.
5. AI proposes; humans approve consequential changes; everything is audited.
6. Readiness/health is deterministic and explainable.
7. No control without a working action. Unbuilt modules are not shown in navigation.

## 5. Modules (A–N) — scope and phase
| Module | Summary | Phase |
|---|---|---|
| A Personal workspace | Personal org created at sign-up; My Tasks; notes/docs; calendar; insights | 1–2 |
| B Organisations & teams | Orgs, workspaces, teams, invites, roles, guests | 1 (core), 2 (invites/teams), 5 (advanced perms) |
| C Project management | Projects, owners, status, dates, milestones, dependencies, list/board/calendar/timeline | 1 (slice), 2 |
| D Task management | Full task model, subtasks, deps, time, recurrence, templates, My Tasks | 1 (slice), 2 |
| E Knowledge & docs | Block editor (TipTap/ProseMirror + Yjs), nested pages, versions, backlinks | 2 (basic), 3 (realtime) |
| F Databases & views | Typed custom properties on relational tables (no JSON-only blob) | 2 (custom fields), 5 (user DBs) |
| G Realtime | WebSocket gateway, presence, Yjs docs, outbox events, reconnection | 3 |
| H AI engine | Provider-agnostic, permission-aware tools, proposals + approvals, audit | 4 |
| I Readiness & execution | Deterministic rule engine, configurable criteria, explanations | 1 (v0 rules), 4 (configurable + AI explanation) |
| J Automation | Trigger → condition → action, idempotent, logged, retried | 5 |
| K Communication | Comments, mentions, inbox, preferences, email/desktop notifications | 2 |
| L Analytics | Workload, overdue, risk, milestones, time | 5 |
| M Search | Postgres FTS first, permission-filtered; semantic later | 2 (FTS), 4 (AI) |
| N Integrations | OAuth framework, encrypted tokens; GitHub, Google, Slack first | 5 |

## 6. Key user journeys (v1)
1. **Sign up → personal workspace → first project in under 2 minutes.**
2. **Idea → plan**: write an objective, (Phase 4) AI drafts tasks as a proposal, user accepts some.
3. **Is it ready?** Open a project and see readiness checks, each with a reason and a link to fix.
4. **Daily focus**: My Tasks grouped Overdue / Today / This week / Later.
5. **Team join**: invited user keeps their personal workspace and gains the org's workspaces in the same account.

## 7. Non-functional requirements
- p75 interactive < 1.0s for task list of 500 tasks (web, broadband).
- API p95 < 200ms for CRUD at 100 rps on a single node (to be measured, Phase 6).
- Zero cross-tenant data access (tested in CI).
- RPO ≤ 15 min, RTO ≤ 4 h at launch (managed Postgres PITR).
- WCAG 2.2 AA target.
- GDPR/UK GDPR obligations reviewed before EU/UK launch (no compliance claims without independent verification).

## 8. Out of scope until noted
Email client, chat channels and video calls (Macro's territory) — revisit after Phase 5; we integrate rather than rebuild.

## 9. Account types and plans
Individual, Freelancer, Team, Business, Enterprise are **organisation configurations + entitlements**. Plans: Free, Personal, Team, Business, Enterprise. **Pricing not decided.** Principles from research: no seat minimum, no bucket pricing, free view-only guests, included AI allowance with admin hard cap.
