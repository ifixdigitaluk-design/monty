import { Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { auditLogs, DbOrTx, users } from '@monty/database';
import type { AuditEntryDto } from '@monty/validation';
import { DbService } from '../db/db.service';

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

export interface AuditEvent {
  organisationId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
  client?: ClientInfo;
}

/**
 * Security/admin audit trail (separate from product activity).
 * Pass the caller's transaction so the audit row commits or rolls back with the change it describes.
 * Never put secrets, tokens or passwords in `data`.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly dbs: DbService) {}

  async record(event: AuditEvent, db: DbOrTx = this.dbs.db): Promise<void> {
    await db.insert(auditLogs).values({
      organisationId: event.organisationId ?? null,
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      data: event.data ?? {},
      ip: event.client?.ip ?? null,
      userAgent: event.client?.userAgent?.slice(0, 300) ?? null,
    });
  }

  /** For events outside a transaction (e.g. failed logins): a failure to audit must not break the request, but is logged. */
  async recordSafely(event: AuditEvent): Promise<void> {
    try {
      await this.record(event);
    } catch (err) {
      this.logger.error(JSON.stringify({ msg: 'audit_write_failed', action: event.action, error: String(err) }));
    }
  }

  async listForOrganisation(organisationId: string, limit = 200): Promise<AuditEntryDto[]> {
    const rows = await this.dbs.db
      .select({ a: auditLogs, actorName: users.name })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(eq(auditLogs.organisationId, organisationId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return rows.map(({ a, actorName }) => ({
      id: a.id,
      action: a.action,
      actor: a.actorId ? { id: a.actorId, name: actorName ?? 'Deleted user' } : null,
      targetType: a.targetType,
      targetId: a.targetId,
      data: a.data,
      ip: a.ip,
      createdAt: a.createdAt.toISOString(),
    }));
  }
}
