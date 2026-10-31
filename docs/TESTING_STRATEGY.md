# Testing Strategy

## Layers
| Layer | Tool | Scope | Runs |
|---|---|---|---|
| Unit | Vitest | `packages/domain` (permissions, readiness, grouping), `packages/validation` | every commit |
| API integration | Vitest + Supertest + real Postgres (`monty_test`) | full HTTP → DB, auth, permissions, tenancy, concurrency, idempotency | every commit |
| E2E | Playwright (Chromium) | real browser through Next.js → API → DB | every PR |
| Static | `tsc --noEmit`, ESLint | all packages | every commit |
| Realtime (Phase 3) | Two Playwright contexts + WS test client | propagation, reconnect, de-dup | every PR |
| Desktop (Phase 3) | tauri-driver / manual matrix | install, login, update signature | release |
| Load (Phase 6) | k6 | CRUD + WS fan-out | pre-release |
| Security (Phase 6) | dependency audit, ZAP baseline, external pentest | — | release |

## Rules
- Integration tests use a real database, reset between files (`TRUNCATE … CASCADE`); no mocked database layer.
- Every permission rule has a positive and a negative test.
- Every bug fix adds a regression test.
- Results reported only from actual runs; DEVELOPMENT_STATUS records the command and outcome.

## Acceptance criteria (Phase 1 slice)
1. Registering creates a user, a personal org, a workspace, and memberships in one transaction.
2. Login with wrong password and unknown email return the same 401.
3. A created project and task persist across a page reload.
4. User B gets 404 for user A's project and tasks, and cannot create tasks in A's project.
5. Viewer can read but gets 403 on write.
6. PATCH with a stale `expectedVersion` returns 409 and does not change data.
7. Replaying a create with the same `id` does not create a duplicate.
8. Mutations without `X-Monty-Client` header are rejected.
9. Readiness report reflects real data and changes when the data changes.
10. Logout revokes the session server-side.

## Commands
```
pnpm test          # unit + integration
pnpm typecheck
pnpm lint
pnpm build
pnpm e2e           # requires running stack (see DEPLOYMENT_GUIDE)
```
