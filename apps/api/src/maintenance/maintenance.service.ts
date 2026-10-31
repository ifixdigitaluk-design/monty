import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DataLifecycleService } from '../account/data-lifecycle.service';
import { DbService } from '../db/db.service';

/** Retention periods. Outbox events only need to outlive the longest client reconnect gap (replay window). */
export const RETENTION = {
  outboxDays: 7,
  expiredSessionDays: 30,
  usedTokenDays: 7,
  automationRunDays: 90,
  /** Delivered/failed email metadata (no bodies: those are wiped on completion). */
  finishedEmailDays: 30,
} as const;
const INTERVAL_MS = 60 * 60_000;
const BATCH = 5_000;

/**
 * Housekeeping that keeps tables from growing without bound. Deletes in bounded batches so a large backlog never
 * holds long locks. Safe to run on several instances at once (deletes are idempotent).
 * Activity history and audit logs are intentionally NOT pruned: they are user-visible / compliance records.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Maintenance');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dbs: DbService,
    private readonly lifecycle: DataLifecycleService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runNow().catch((err) => this.logger.error(JSON.stringify({ msg: 'maintenance_failed', error: String(err) }))), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async purge(table: string, condition: ReturnType<typeof sql>): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.dbs.runAsSystem(async () => {
        // Bulk deletes may legitimately take longer than a request's 15 s statement limit.
        await this.dbs.allowLongStatements(120_000);
        const r = await this.dbs.db.execute(
          sql`delete from ${sql.identifier(table)} where ctid in (select ctid from ${sql.identifier(table)} where ${condition} limit ${BATCH})`,
        );
        return r.rowCount ?? 0;
      });
      total += n;
      if (n < BATCH) return total;
    }
  }

  async runNow(): Promise<Record<string, number>> {
    const days = (d: number) => sql`now() - make_interval(days => ${d})`;
    const result = {
      outboxEvents: await this.purge('outbox_events', sql`created_at < ${days(RETENTION.outboxDays)}`),
      sessions: await this.purge('sessions', sql`(expires_at < ${days(RETENTION.expiredSessionDays)}) or (revoked_at is not null and revoked_at < ${days(RETENTION.expiredSessionDays)})`),
      userTokens: await this.purge('user_tokens', sql`(used_at is not null and used_at < ${days(RETENTION.usedTokenDays)}) or expires_at < ${days(RETENTION.usedTokenDays)}`),
      automationRuns: await this.purge('automation_runs', sql`created_at < ${days(RETENTION.automationRunDays)}`),
      dataExports: await this.purge('data_exports', sql`expires_at < now()`),
      organisations: await this.lifecycle.purgeDueOrganisations(),
      emails: await this.purge('email_outbox', sql`status in ('SENT', 'FAILED', 'EXPIRED') and finished_at < ${days(RETENTION.finishedEmailDays)}`),
    };
    this.logger.log(JSON.stringify({ msg: 'maintenance_done', ...result }));
    return result;
  }
}
