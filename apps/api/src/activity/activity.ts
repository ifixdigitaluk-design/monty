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
  await tx.insert(outboxEvents).values({
    organisationId: c.organisationId,
    workspaceId: c.workspaceId,
    topic: `${c.entityType}.${c.action}`,
    entityId: c.entityId,
    entityVersion: c.entityVersion,
    payload: c.payload,
  });
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
