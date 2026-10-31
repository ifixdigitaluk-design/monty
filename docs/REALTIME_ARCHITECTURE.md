# Realtime Architecture (Phase 3 design; foundations in Phase 1)

## 1. Data classes and strategies
| Class | Examples | Store | Conflict strategy | Transport |
|---|---|---|---|---|
| Persistent business data | tasks, projects, comments | Postgres | Optimistic concurrency (`version`), 409 on stale write | REST write → outbox → WS broadcast |
| Document collaboration state | page bodies | Yjs updates in Postgres (+ periodic snapshot) | CRDT merge | WS (y-protocols sync + awareness) |
| Ephemeral presence | who is viewing, cursors | memory / Redis with TTL | last value wins, no persistence | WS awareness |
| Notifications | mentions, assignments | Postgres | append-only, unique `eventId` | WS + email/desktop |
| Automation events | trigger fired | Postgres outbox | idempotent consumers keyed by `eventId` | worker queue |

A task edit never goes through a CRDT; it is a small validated REST mutation.

## 2. Already in place (Phase 1)
- Every mutation writes an `OutboxEvent` in the **same transaction** as the change, with a UUID `id`, topic (e.g. `task.updated`) and the new record version.
- Records carry `version`, so clients can discard stale or duplicate events (`event.version <= local.version` → ignore).

## 3. Phase 3 flow
```
REST write ─txn─► Postgres (row + OutboxEvent)
                     │
            worker relay (SELECT … FOR UPDATE SKIP LOCKED, batch, mark publishedAt)
                     │
              Redis pub/sub channel ws:{workspaceId}
                     │
          API WS gateway(s) ──► subscribed clients (permission re-checked on subscribe)
```
- Client subscribes to `workspace:{id}` after auth; server checks membership. Revoked membership closes the subscription.
- Each message: `{eventId, topic, entityId, version, payload}`. Client keeps a de-dup set of recent `eventId`s.
- **Reconnection**: exponential backoff with jitter (0.5s → 30s). On reconnect the client sends `lastEventAt`; server replays outbox events since then (retained 7 days) or tells client to refetch.
- **Connection health**: heartbeat ping every 25s; UI indicator states Connected / Reconnecting / Offline.
- **Saved state**: UI shows "Saved" only after the REST response; WS echo of own change is de-duplicated by `eventId`.

## 4. Documents (Yjs)
- Server is a Yjs provider (y-websocket protocol implemented in the Nest gateway or Hocuspocus, decided by spike).
- Updates appended to `DocumentYjsUpdate`; compacted to snapshot every N updates; `DocumentVersion` snapshots for history/restore.
- Permission check on connect and on every write message (viewers are read-only).

## 5. Desktop offline (after online collaboration is reliable)
- SQLite cache of entities the user has accessed; outbound queue of mutations with `expectedVersion`.
- On reconnect: replay queue; 409 conflicts go to a visible "Needs review" list. Never silently overwrite newer server data.
- Documents: offline Yjs updates merge naturally.

## 6. Tests required
Two-client propagation, reconnection after forced disconnect, duplicate event delivery, stale-write rejection, permission revocation mid-session.
