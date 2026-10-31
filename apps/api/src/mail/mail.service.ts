import { Controller, Get, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Query } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DbOrTx, emailDeliveryAttempts, emailOutbox } from '@monty/database';
import { AppConfig, CONFIG } from '../config';
import { Public } from '../common/auth-context';
import { decrypt, encrypt } from '../common/encryption';
import { notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { RealtimeService } from '../realtime/realtime.service';
import { trackJob } from '../observability/metrics';
import { classifySendError, LogTransport, MailMessage, MailTransport, SmtpTransport } from './transports';

const LEASE_MS = 2 * 60_000; // longer than the SMTP client's worst case (10 s connect + 10 s greeting + 20 s socket)
const MAX_BACKOFF_MS = 60 * 60_000;
const BATCH = 20;

export interface EnqueueOptions {
  /** Same key = same logical email; a second enqueue is ignored. */
  idempotencyKey: string;
  userId?: string | null;
  /** Do not send after this moment (the link inside has expired). */
  expiresAt?: Date | null;
}

/** Exponential backoff with ±20 % jitter: base, 2×base, 4×base … capped at 1 hour. Exported for tests. */
export function backoffMs(attempt: number, baseMs: number, random = Math.random): number {
  const raw = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.8 + random() * 0.4));
}

/**
 * Durable email delivery.
 *
 * - `enqueue` writes to `email_outbox` inside the caller's transaction (transactional outbox): if the change rolls
 *   back, no email; if it commits, the email will be attempted even if the provider is down or the process restarts.
 * - A worker claims due rows with `FOR UPDATE SKIP LOCKED` (safe with several API instances), sends outside any
 *   database transaction, and records every attempt. Temporary failures (network, SMTP 4xx) are retried with
 *   exponential backoff up to MAIL_MAX_ATTEMPTS; permanent failures (SMTP 5xx) stop immediately.
 * - Delivery is at-least-once: a crash after the provider accepted a message but before it was marked sent
 *   causes one resend. Every message carries a stable Message-ID so it can be recognised as the same message.
 * - Message bodies (which contain one-time links) are encrypted at rest and wiped once delivery is final.
 *   Logs contain the kind, recipient domain and outcome only.
 */
@Injectable()
export class MailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Mail');
  readonly transport: MailTransport;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private rerun = false;
  private stopping = false;
  private lastRunAt: Date | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly dbs: DbService,
    private readonly realtime: RealtimeService,
  ) {
    this.transport =
      config.mail.transport === 'smtp' && config.mail.smtp ? new SmtpTransport(config.mail.smtp) : new LogTransport();
  }

  onModuleInit() {
    // Committed enqueues notify immediately; polling covers retries and missed notifications.
    this.realtime.listen('monty_mail', () => this.kick());
    this.timer = setInterval(() => this.kick(), this.config.mail.pollMs);
    this.timer.unref();
    this.kick();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined); // graceful shutdown: finish the batch in flight
    if (this.transport instanceof SmtpTransport) this.transport.close();
  }

  /** Absolute link into the web app. */
  link(pathWithQuery: string): string {
    return `${this.config.appUrl}${pathWithQuery}`;
  }

  /**
   * Queues an email in the current transaction (or `db` if given). Returns whether a new row was queued.
   * Never sends inline: callers can't accidentally make a request depend on the provider being up.
   */
  async enqueue(message: MailMessage, opts: EnqueueOptions, db?: DbOrTx): Promise<boolean> {
    const insert = async (tx: DbOrTx) => {
      const rows = await tx
        .insert(emailOutbox)
        .values({
          idempotencyKey: opts.idempotencyKey,
          kind: message.kind,
          toAddress: message.to,
          userId: opts.userId ?? null,
          payload: encrypt(this.config.dataKey, JSON.stringify({ subject: message.subject, text: message.text, html: message.html }), opts.idempotencyKey),
          maxAttempts: this.config.mail.maxAttempts,
          expiresAt: opts.expiresAt ?? null,
        })
        .onConflictDoNothing({ target: emailOutbox.idempotencyKey })
        .returning({ id: emailOutbox.id });
      await tx.execute(sql`select pg_notify('monty_mail', '')`); // delivered on commit
      return rows.length > 0;
    };
    const queued = db
      ? await (async () => {
          // email_outbox is system-only under RLS; lift it for this one statement inside the caller's transaction.
          await db.execute(sql`select set_config('app.system', 'on', true)`);
          try {
            return await insert(db);
          } finally {
            await db.execute(sql`select set_config('app.system', '', true)`);
          }
        })()
      : await this.dbs.runAsSystem(() => insert(this.dbs.db));
    this.logger.log(JSON.stringify({ msg: queued ? 'mail_queued' : 'mail_duplicate_ignored', kind: message.kind, toDomain: message.to.split('@')[1] }));
    return queued;
  }

  /** Starts a delivery run unless one is in progress (then schedules one more). */
  kick() {
    if (this.stopping) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = trackJob('mail_delivery', () => this.processDue())
      .catch((err) => {
        this.logger.error(JSON.stringify({ msg: 'mail_worker_failed', error: String(err).slice(0, 300) }));
        return 0;
      })
      .finally(() => {
        this.running = null;
        if (this.rerun) {
          this.rerun = false;
          this.kick();
        }
      });
  }

  /** Test hook: processes until nothing is due right now. */
  async drain(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      await this.running;
      const n = await this.processDue();
      if (n === 0 && !this.running) return;
    }
  }

  status() {
    return { lastRunAt: this.lastRunAt?.toISOString() ?? null, transport: this.transport.name };
  }

  /** Claims and processes one batch of due messages. Returns how many were processed. */
  async processDue(): Promise<number> {
    this.lastRunAt = new Date();
    const claimed = await this.dbs.runAsSystem(async () => {
      const r = await this.dbs.db.execute<{ id: string }>(sql`
        update email_outbox set status = 'SENDING', locked_until = now() + make_interval(secs => ${LEASE_MS / 1000}), attempts = attempts + 1
        where id in (
          select id from email_outbox
          where (status = 'PENDING' and next_attempt_at <= now()) or (status = 'SENDING' and locked_until < now())
          order by next_attempt_at
          limit ${BATCH}
          for update skip locked)
        returning id`);
      const ids = r.rows.map((x) => x.id);
      return ids.length ? this.dbs.db.select().from(emailOutbox).where(inArray(emailOutbox.id, ids)) : [];
    });
    for (const row of claimed) await this.deliver(row);
    return claimed.length;
  }

  private async deliver(row: typeof emailOutbox.$inferSelect) {
    const toDomain = row.toAddress.split('@')[1];
    const finish = (values: Partial<typeof emailOutbox.$inferInsert>, attempt?: Omit<typeof emailDeliveryAttempts.$inferInsert, 'emailId' | 'attempt'>) =>
      this.dbs.runAsSystem(async () => {
        await this.dbs.db.update(emailOutbox).set({ lockedUntil: null, ...values }).where(and(eq(emailOutbox.id, row.id), eq(emailOutbox.status, 'SENDING')));
        if (attempt) await this.dbs.db.insert(emailDeliveryAttempts).values({ emailId: row.id, attempt: row.attempts, ...attempt });
      });

    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      await finish({ status: 'EXPIRED', payload: null, finishedAt: new Date(), lastError: 'Link expired before it could be delivered' });
      this.logger.warn(JSON.stringify({ msg: 'mail_expired', kind: row.kind, toDomain, attempts: row.attempts - 1 }));
      return;
    }
    if (!row.payload) {
      await finish({ status: 'FAILED', finishedAt: new Date(), lastError: 'Message body missing' });
      return;
    }
    let message: MailMessage;
    try {
      const body = JSON.parse(decrypt(this.config.dataKey, row.payload, row.idempotencyKey).toString()) as Omit<MailMessage, 'to' | 'kind'>;
      message = { ...body, to: row.toAddress, kind: row.kind };
    } catch {
      // Wrong DATA_ENCRYPTION_KEY or tampering: retrying can't help, and the body must not be sent garbled.
      await finish({ status: 'FAILED', payload: null, finishedAt: new Date(), lastError: 'Could not decrypt message (check DATA_ENCRYPTION_KEY)' });
      this.logger.error(JSON.stringify({ msg: 'mail_decrypt_failed', kind: row.kind }));
      return;
    }

    const started = Date.now();
    try {
      await this.transport.send(this.config.mail.from, message, { messageId: `<${row.id}@${new URL(this.config.appUrl).hostname}>` });
      const durationMs = Date.now() - started;
      await finish({ status: 'SENT', payload: null, sentAt: new Date(), finishedAt: new Date(), lastError: null }, { outcome: 'SENT', durationMs });
      this.logger.log(JSON.stringify({ msg: 'mail_sent', kind: row.kind, toDomain, attempt: row.attempts, transport: this.transport.name, ms: durationMs }));
    } catch (err) {
      const durationMs = Date.now() - started;
      const c = classifySendError(err);
      const exhausted = row.attempts >= row.maxAttempts;
      if (c.kind === 'permanent' || exhausted) {
        await finish(
          { status: 'FAILED', payload: null, finishedAt: new Date(), lastError: c.message },
          { outcome: c.kind === 'permanent' ? 'PERMANENT_FAILURE' : 'TEMPORARY_FAILURE', smtpCode: c.smtpCode, error: c.message, durationMs },
        );
        this.logger.error(JSON.stringify({ msg: 'mail_failed_final', kind: row.kind, toDomain, attempts: row.attempts, reason: c.kind === 'permanent' ? 'permanent' : 'max_attempts', error: c.message }));
      } else {
        const delay = backoffMs(row.attempts, this.config.mail.retryBaseMs);
        await finish(
          { status: 'PENDING', nextAttemptAt: new Date(Date.now() + delay), lastError: c.message },
          { outcome: 'TEMPORARY_FAILURE', smtpCode: c.smtpCode, error: c.message, durationMs },
        );
        this.logger.warn(JSON.stringify({ msg: 'mail_retry_scheduled', kind: row.kind, toDomain, attempt: row.attempts, retryInMs: delay, error: c.message }));
      }
    }
  }

  /** Queue health for monitoring (counts only). */
  async queueStats() {
    return this.dbs.runAsSystem(async () => {
      const r = await this.dbs.db.execute<{ status: string; n: number; oldest: string | null }>(
        sql`select status, count(*)::int as n, min(created_at)::text as oldest from email_outbox group by status`,
      );
      const due = await this.dbs.db.execute<{ n: number }>(
        sql`select count(*)::int as n from email_outbox where status = 'PENDING' and next_attempt_at <= now() - interval '5 minutes'`,
      );
      const failed24h = await this.dbs.db.execute<{ n: number }>(
        sql`select count(*)::int as n from email_outbox where status in ('FAILED', 'EXPIRED') and finished_at > now() - interval '24 hours'`,
      );
      return {
        byStatus: Object.fromEntries(r.rows.map((x) => [x.status, x.n])) as Record<string, number>,
        overdue: due.rows[0]?.n ?? 0,
        failedLast24h: failed24h.rows[0]?.n ?? 0,
      };
    });
  }
}

/**
 * Development-only mailbox so developers and end-to-end tests can read emails without a real provider.
 * Only registered when MAIL_TRANSPORT=log and NODE_ENV is not production (see AppModule), and it re-checks both here.
 */
@Controller('dev/mailbox')
export class DevMailboxController {
  constructor(
    private readonly mail: MailService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  list(@Query('to') to?: string) {
    if (this.config.isProduction || !(this.mail.transport instanceof LogTransport)) throw notFound();
    return { messages: this.mail.transport.messages(to) };
  }
}
