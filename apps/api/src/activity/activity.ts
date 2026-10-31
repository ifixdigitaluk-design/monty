import { sql } from 'drizzle-orm';
import { activityEvents, DbOrTx, outboxEvents } from '@monty/database';

export interface ChangeRecord {
  organisationId: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  entityType: 'project' | 'task';
  entityId: string;
  action: 'created' | 'updated' | 'deleted';
  entityVersion: number;
  data?: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * Writes the user-visible activity entry and the outbox event in the caller's transaction,
 * so a change is never persisted without its event (and vice versa).
 */
export async function recordChange(tx: DbOrTx, c: ChangeRecord): Promise<void> {
  await tx.insert(activityEvents).values({
    organisationId: c.organisationId,
    workspaceId: c.workspaceId,
    projectId: c.projectId,
    actorId: c.actorId,
    entityType: c.entityType,
    entityId: c.entityId,
    action: c.action,
    data: c.data ?? {},
  });
  const [event] = await tx
    .insert(outboxEvents)
    .values({
      organisationId: c.organisationId,
      workspaceId: c.workspaceId,
      projectId: c.projectId,
      actorId: c.actorId,
      topic: `${c.entityType}.${c.action}`,
      entityId: c.entityId,
      entityVersion: c.entityVersion,
      // _origin lets the automation engine ignore changes it caused itself (no loops); _changes lets it see what moved.
      // Neither leaves the server: clients only receive the pointer built by toRealtimeEvent.
      payload: sql`${JSON.stringify({ ...c.payload, ...(c.data?.changes ? { _changes: c.data.changes } : {}) })}::jsonb || jsonb_build_object('_origin', coalesce(nullif(current_setting('app.origin', true), ''), 'user'))`,
    })
    .returning({ id: outboxEvents.id, createdAt: outboxEvents.createdAt });
  // Postgres delivers NOTIFY only when the transaction commits, so listeners never see rolled-back changes.
  // The payload is a pointer (no entity data): clients refetch through the normal permission-checked API.
  await tx.execute(sql`select pg_notify('monty_outbox', ${JSON.stringify(toRealtimeEvent({
    id: event!.id,
    createdAt: event!.createdAt,
    workspaceId: c.workspaceId,
    projectId: c.projectId,
    topic: `${c.entityType}.${c.action}`,
    entityId: c.entityId,
    entityVersion: c.entityVersion,
    actorId: c.actorId,
  }))})`);
}

export interface RealtimeEvent {
  id: string;
  at: string;
  workspaceId: string;
  projectId: string | null;
  topic: string;
  entityId: string;
  version: number | null;
  actorId: string | null;
}

export function toRealtimeEvent(e: {
  id: string;
  createdAt: Date;
  workspaceId: string;
  projectId: string | null;
  topic: string;
  entityId: string;
  entityVersion: number | null;
  actorId: string | null;
}): RealtimeEvent {
  return {
    id: e.id,
    at: e.createdAt.toISOString(),
    workspaceId: e.workspaceId,
    projectId: e.projectId,
    topic: e.topic,
    entityId: e.entityId,
    version: e.entityVersion,
    actorId: e.actorId,
  };
}

/** Field-level diff for activity history. Only scalar, non-sensitive fields. */
export function diff<T extends object>(before: T, after: T, fields: readonly (keyof T & string)[]) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    const a = before[f] ?? null;
    const b = after[f] ?? null;
    if (a !== b) changes[f] = { from: a, to: b };
  }
  return changes;
}
