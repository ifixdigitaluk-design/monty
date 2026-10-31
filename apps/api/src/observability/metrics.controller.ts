import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Header, Inject, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { Public } from '../common/auth-context';
import { notFound, unauthenticated } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import { metrics } from './metrics';

/**
 * Prometheus scrape endpoint. Disabled (404) unless METRICS_TOKEN is set; requires `Authorization: Bearer <token>`.
 * Exposes counts and timings only — no names, emails, ids or content.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly dbs: DbService,
    private readonly mail: MailService,
    private readonly realtime: RealtimeService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(@Req() req: Request): Promise<string> {
    const expected = this.config.metricsToken;
    if (!expected) throw notFound();
    const given = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1] ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthenticated();

    const pool = this.dbs.poolStats();
    const rt = this.realtime.stats();
    const g: { name: string; help: string; value: number; labels?: Record<string, string> }[] = [
      { name: 'monty_build_info', help: 'Build information', value: 1, labels: { release: this.config.release, environment: this.config.nodeEnv } },
      { name: 'monty_process_uptime_seconds', help: 'Process uptime', value: Math.round((Date.now() - metrics.startedAt) / 1000) },
      { name: 'monty_process_resident_memory_bytes', help: 'Resident set size', value: process.memoryUsage().rss },
      { name: 'monty_process_heap_used_bytes', help: 'V8 heap used', value: process.memoryUsage().heapUsed },
      { name: 'monty_event_loop_delay_p99_seconds', help: 'Event loop delay, 99th percentile since start', value: metrics.loopDelay.percentile(99) / 1e9 },
      { name: 'monty_db_pool_connections', help: 'Database pool connections', value: pool.total, labels: { state: 'total' } },
      { name: 'monty_db_pool_connections', help: 'Database pool connections', value: pool.idle, labels: { state: 'idle' } },
      { name: 'monty_db_pool_waiting_requests', help: 'Requests waiting for a database connection (alert if sustained > 0)', value: pool.waiting },
      { name: 'monty_db_pool_max', help: 'Configured pool size', value: pool.max },
      { name: 'monty_realtime_subscribers', help: 'Open live-update streams on this instance', value: rt.subscribers },
      { name: 'monty_realtime_listener_up', help: '1 if the Postgres LISTEN connection is up', value: rt.listening ? 1 : 0 },
    ];
    let dbUp = 1;
    try {
      const q = await this.mail.queueStats();
      for (const status of ['PENDING', 'SENDING', 'SENT', 'FAILED', 'EXPIRED']) {
        g.push({ name: 'monty_email_queue_messages', help: 'Emails in the delivery queue by status', value: q.byStatus[status] ?? 0, labels: { status } });
      }
      g.push({ name: 'monty_email_overdue_messages', help: 'Pending emails due more than 5 minutes ago (alert if > 0 for 15 min)', value: q.overdue });
      g.push({ name: 'monty_email_failed_last_24h', help: 'Emails that failed permanently or expired in the last 24 hours', value: q.failedLast24h });
      const runs = await this.dbs.runAsSystem(() =>
        this.dbs.db.execute<{ failed_1h: number; failed_24h: number; stuck: number }>(sql`
          select count(*) filter (where status = 'FAILED' and created_at > now() - interval '1 hour')::int as failed_1h,
                 count(*) filter (where status = 'FAILED' and created_at > now() - interval '24 hours')::int as failed_24h,
                 count(*) filter (where status = 'RUNNING' and created_at < now() - interval '10 minutes')::int as stuck
          from automation_runs`),
      );
      const r = runs.rows[0]!;
      g.push({ name: 'monty_automation_runs_failed', help: 'Failed automation runs', value: r.failed_1h, labels: { window: '1h' } });
      g.push({ name: 'monty_automation_runs_failed', help: 'Failed automation runs', value: r.failed_24h, labels: { window: '24h' } });
      g.push({ name: 'monty_automation_runs_stuck', help: 'Automation runs still RUNNING after 10 minutes', value: r.stuck });
    } catch {
      dbUp = 0;
    }
    g.push({ name: 'monty_db_up', help: '1 if the metrics queries reached the database', value: dbUp });
    return metrics.render(g);
  }
}
