# Competitor Analysis

Status: Phase 0 research, first pass (October 2026). Owner: CTO.
Method: official pricing/docs pages where available, plus third-party pricing trackers and public feedback boards. Third-party figures are marked **(3P)** and must be re-checked against the vendor's own page before any pricing decision. Nothing here is invented; where we could not verify something it says "not verified".

## 0. Identity check: "Macro"

Several products share the name. The one relevant to us is **Macro (macro.com)**, an open-source (AGPLv3), self-hostable "unified workspace" combining email, chat, docs, tasks, calls and CRM with workspace-aware AI agents. It is *not* Pulover's Macro Creator (a Windows automation recorder) or keyboard-macro tools. Source: docs.macro.com/faq, macro.com/posts/notion-alternative.

## 1. Comparison matrix

| | Core model | AI | Automation | Offline / desktop | Pricing shape (Oct 2026) | Publicly documented limits / recurring complaints |
|---|---|---|---|---|---|---|
| **Macro** | Purpose-built modules (mail, chat, docs, tasks, CRM, calls) in one app; CRDT docs; bidirectional @-mentions | Agents with live cursor in docs; team memory across modules, refreshed nightly | Not a focus in its docs | Desktop app; offline doc editing via CRDT | Free / Pro $40 / Max $200 per seat; all modules on every plan (macro.com/pricing) | Self-rated "basic" databases/custom views, smaller template and integration ecosystem (Macro's own page). Email limited to Gmail/Google Workspace today |
| **Notion** | Blocks + databases you assemble yourself | Notion AI + Custom Agents; credits only on Business/Enterprise | Database automations, buttons | Offline mode v1 shipped Aug 2025; databases capped at **50 rows offline**; early background-sync reliability issues reported | Free; Plus $10–12; Business $20–24; Enterprise custom **(3P, breeze.pm citing Notion pages)** | No native chat; per-block last-write-wins on concurrent edits (per Macro's comparison); AI gated to Business+ |
| **Linear** | Opinionated issue tracker for software teams; keyboard-first; fast sync | Linear AI / agents (details not verified this pass) | Workflow rules within issue lifecycle | Desktop app (Electron); known for speed | Free (capped teams/issues — reported as 250 issues **(3P)**); Basic; Business ~$16; Enterprise quote **(3P, inconsistent sources)** | SAML Enterprise-only; guests billed as paid seats **(3P)**. Narrow scope: weak for docs/non-engineering work |
| **ClickUp** | "Everything app": tasks, docs, chat, whiteboards, dashboards | ClickUp Brain add-on $9/user (annual) — **charged on every paid seat** **(3P)** | 100 / 1,000 / 10,000 / 25,000 runs per month by plan **(3P)** | Desktop app | Free; Unlimited $7–10; Business $12–19; Business Plus; Enterprise | Long-running performance complaints: "Web app performance and speed issues" request has ~1.1k votes, marked complete in 2021 yet users still report slow loading in 2024–2026 (feedback.clickup.com). Feature bloat |
| **monday.com** | Boards/items/columns; separate products for work mgmt, dev, CRM, service | monday AI (not verified this pass) | Automation/integration action quotas per plan (numbers not verified) | Desktop app | **3-seat minimum, seats sold in buckets** (support.monday.com) | Bucket pricing forces paying for unused seats; several separate products rather than one model |
| **Asana** | Projects, portfolios, goals, workload | AI Studio with pooled credits: 50k / 75k / 200k per month by plan; Plus $150/mo **(3P)** | Rules (paid plans only) | Desktop app | Personal free (**2-user cap for accounts created after 12 Nov 2025**); Starter ~$10.99; Advanced ~$24.99 **(3P)** | Free plan lacks timeline, automation, custom fields, dashboards. Above 5 seats billed in 5-seat blocks (community-reported, **3P**) |
| **Trello** | Kanban boards; Power-Ups | Atlassian Intelligence (not verified this pass) | Butler with command-run caps; automations **stop at cap** **(3P)** | Desktop app | Free; Standard $5; Premium $10; Enterprise $17.50 **(3P)** | Free: 10 collaborators per workspace; 11th member converts everyone to paid; multi-board guests billed as seats **(3P)**. Shallow beyond kanban |
| **Jira** | Highly configurable issue tracking | Rovo (search, chat, agents) — credit pool, overage billing from 3 Dec 2026, bulk actions capped at 20 items **(3P, eesel.ai — a competitor)** | Jira Automation | Desktop: none native for Cloud (not verified) | Free / Standard / Premium / Enterprise | Configuration complexity is a well-known complaint; Rovo agent reliability described as variable **(3P anecdotes)** |
| **Basecamp** | Opinionated projects: message board, to-dos, schedule, docs, chat | Not a focus | Minimal | Desktop app | **Flat pricing, no per-user fees**: Free (1 project) → $299/mo Unlimited **(3P, automationatlas, Sept 2026)** | "Ships fewer features than per-seat competitors" — no deep custom fields / dependency scheduling (not verified against official docs) |
| **Microsoft Planner** | Project for the Web merged into Planner (Aug 2025): Grid, Board, Timeline; Portfolios | Copilot features need a **separate M365 Copilot licence**; Project Manager Agent in preview | Power Automate | Teams/Windows | Plan 1 ~$10; Plan 3 ~$30; Plan 5 ~$55 **(3P)** | Roadmaps not migrated automatically; Project Online retires 30 Sept 2026. Strong only inside Microsoft 365 |

## 2. Patterns we can verify

1. **AI is a paid wall and metered unpredictably.** Notion (Business+ only, per-member credits), ClickUp (charged on every seat), Asana (pooled credits), Jira Rovo (overage on by default from Dec 2026), Planner (separate Copilot licence).
2. **Seat-pricing friction** hits small teams: monday 3-seat minimum and buckets; Asana 5-seat blocks; Trello 11th-member jump; guests billed as seats (Linear, Trello).
3. **Automation quotas stop silently** at the cap (ClickUp, Trello).
4. **Performance degrades as feature count grows** (ClickUp's public board).
5. **Offline is still partial** (Notion's 50-row database cap).
6. **"Status" is self-reported.** None of the tools we reviewed make *deterministic project readiness* a first-class idea; health fields are typically manually set (not exhaustively verified — treat as hypothesis to test in user interviews).
7. **Docs and tasks live in different products or tiers** (Jira+Confluence, monday's split products).

## 3. Top 10 differentiation opportunities

Each is tied to a pattern above, not to a feature-count race.

1. **Deterministic Project Readiness & Health** (signature). Explainable rule results — "not ready because: no owner, 3 tasks unassigned, 1 blocker open" — computed from real data, configurable per organisation. AI explains; it never decides. *(Pattern 6)*
2. **One data model, many views.** List/Board/Calendar/Timeline are projections of the same task records; no per-view datasets. *(Pattern 7)*
3. **Docs ⇄ tasks ⇄ projects linked natively** with backlinks, in one product and one plan. *(Pattern 7)*
4. **Predictable AI pricing**: a visible included allowance per workspace, a hard cap the admin controls, and no AI charge on seats that don't use it. *(Pattern 1)*
5. **Accountable AI actions**: every AI change is a proposal → approval → audited, revertible operation. *(Rovo/agent reliability complaints, Pattern 1)*
6. **Fair seat model**: no seat minimum, no buckets, free view-only guests. *(Pattern 2)*
7. **Automation that degrades loudly, not silently**: run history, retries, quota warnings before the cap, and a clear "paused" state with reasons. *(Pattern 3)*
8. **Performance as a feature**: budgets per screen (e.g. task list interactive < 1s at p75), measured in CI. *(Pattern 4)*
9. **Honest offline**: desktop cache with a visible pending-changes queue and conflict review — never silent overwrite. *(Pattern 5)*
10. **Scales from one person to an organisation without migrating**: personal workspace is a real tenant; joining an org adds memberships rather than a new account. *(Asana free-plan cap, Trello's collaborator jump)*

## 4. Open research items (next pass)

- Verify Linear, Jira, monday and Trello limits on official pages (current sources are 3P).
- Interview 8–12 target users across solo / agency / dev team to validate opportunity 1 and 4.
- Benchmark load times of competitors on a standard dataset (500 tasks, 50 docs).

## Sources

- Macro: https://docs.macro.com/faq.md · https://macro.com/posts/notion-alternative · https://macro.com/pricing
- Notion offline: https://thrive-culture-media.super.site/articles/how-notion-shipped-offline-mode-and-why-it-was-not-the-easy-fix-everyone-thinks
- Notion pricing/AI (3P): https://www.breeze.pm/articles/notion-ai-pricing
- Linear (3P): https://www.activepieces.com/blog/linear-app-pricing-every-plan-and-seat-cost-2026.md
- ClickUp feedback: https://feedback.clickup.com/feature-requests/p/web-app-performance-and-speed-issues · pricing (3P): https://agiled.app/blog/clickup-pricing
- monday.com: https://support.monday.com/hc/en-us/articles/4405633151634
- Asana (3P): https://agiled.app/blog/asana-pricing
- Trello (3P): https://www.activepieces.com/blog/trello-pricing-2026-plans-costs-and-hidden-fees.md
- Jira Rovo (3P, competitor-authored): https://eesel.ai/blog/rovo
- Basecamp (3P): https://automationatlas.io/answers/basecamp-pricing-2026/
- Microsoft Planner: https://www.theprojectgroup.com/blog/en/project-for-the-web-becoming-planner/
