import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { Client } from 'pg';
import { outboxEvents, users } from '@monty/database';
import { RealtimeEvent, toRealtimeEvent } from '../activity/activity';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';

interface Subscriber {
  id: number;
  userId: string;
  userName: string;
  sessionId: string;
  workspaceId: string;
  projectId: string | null;
  res: Response;
}

const HEARTBEAT_MS = 25_000;
const RECHECK_MS = 60_000;
const REPLAY_LIMIT = 500;

/**
 * Live updates over Server-Sent Events.
 *
 * - Writes emit `pg_notify` inside their transaction (see recordChange), so only committed changes are announced,
 *   and every API instance receives every event — no extra broker is needed for fan-out.
 * - Events are pointers (topic, entity id, version). Clients refetch through the normal permission-checked API,
 *   so a live event can never leak data the user couldn't otherwise read.
 * - Reconnection: browsers resend `Last-Event-ID`; missed events are replayed from the outbox under the user's RLS
 *   context, or the client is told to fully refresh if too much was missed.
 * - Access is re-checked every minute; removed members and revoked sessions are disconnected.
 * - Presence (who is viewing a project) is in-memory per instance: correct for a single instance; a shared store
 *   is needed before running several API instances behind a load balancer (see REALTIME_ARCHITECTURE.md).
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Realtime');
  private readonly subscribers = new Map<number, Subscriber>();
  private listener: Client | null = null;
  private nextId = 1;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;

  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    // Chat events carry their audience: everyone in the workspace (public channels) or the member list.
    this.listen('monty_chat', (payload) => {
      if (!payload) return;
      try {
        const e = JSON.parse(payload) as { workspaceId: string; memberIds: string[] | null } & Record<string, unknown>;
        const { memberIds, ...pointer } = e;
        for (const s of this.subscribers.values()) {
          if (s.workspaceId !== e.workspaceId) continue;
          if (memberIds && !memberIds.includes(s.userId)) continue;
          this.write(s, 'chat', pointer);
        }
      } catch {
        /* ignore malformed payloads */
      }
    });
    // Database (Notion-style) changes go to everyone in the workspace, like other workspace changes.
    this.listen('monty_db', (payload) => {
      if (!payload) return;
      try {
        const e = JSON.parse(payload) as { workspaceId: string } & Record<string, unknown>;
        for (const s of this.subscribers.values()) if (s.workspaceId === e.workspaceId) this.write(s, 'database', e);
      } catch {
        /* ignore malformed payloads */
      }
    });
    await this.connectListener();
    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.recheckAccess(), RECHECK_MS));
  }

  async onModuleDestroy() {
    this.stopping = true;
    this.timers.forEach(clearInterval);
    for (const s of this.subscribers.values()) s.res.end();
    this.subscribers.clear();
    await this.listener?.end().catch(() => undefined);
  }

  /** Dedicated connection for LISTEN; reconnects with backoff if the database restarts. */
  private async connectListener(attempt = 0): Promise<void> {
    if (this.stopping) return;
    const client = new Client({ connectionString: this.config.databaseUrl });
    client.on('error', (err) => {
      this.logger.warn(JSON.stringify({ msg: 'listener_error', error: String(err) }));
    });
    client.on('end', () => {
      if (this.stopping) return;
      this.listener = null;
      const delay = Math.min(30_000, 500 * 2 ** attempt);
      setTimeout(() => void this.connectListener(attempt + 1), delay);
      // Tell clients to refresh: events may have been missed while disconnected.
      for (const s of this.subscribers.values()) this.write(s, 'reset', { reason: 'server_reconnected' });
    });
    client.on('notification', (msg) => {
      const extra = this.channels.get(msg.channel);
      if (extra) {
        for (const cb of extra) {
          try {
            cb(msg.payload ?? '');
          } catch {
            /* a consumer's failure must not affect others */
          }
        }
        return;
      }
      if (msg.channel !== 'monty_outbox' || !msg.payload) return;
      try {
        this.dispatch(JSON.parse(msg.payload) as RealtimeEvent);
      } catch {
        /* ignore malformed payloads */
      }
    });
    try {
      await client.connect();
      await client.query('LISTEN monty_outbox');
      for (const ch of this.channels.keys()) await client.query(`LISTEN ${ch}`);
      this.listener = client;
      // A reconnect may have missed notifications: let consumers catch up.
      if (attempt > 0) for (const cbs of this.channels.values()) for (const cb of cbs) cb('');
    } catch (err) {
      this.logger.warn(JSON.stringify({ msg: 'listener_connect_failed', error: String(err) }));
      await client.end().catch(() => undefined);
      if (!this.stopping) setTimeout(() => void this.connectListener(attempt + 1), Math.min(30_000, 500 * 2 ** attempt));
    }
  }

  private readonly listeners: ((e: RealtimeEvent) => void)[] = [];
  private readonly channels = new Map<string, ((payload: string) => void)[]>();

  /** Subscribes to an additional Postgres NOTIFY channel on the shared listener connection. */
  listen(channel: 'monty_mail' | 'monty_chat' | 'monty_db', cb: (payload: string) => void) {
    const first = !this.channels.has(channel);
    this.channels.set(channel, [...(this.channels.get(channel) ?? []), cb]);
    if (first && this.listener) void this.listener.query(`LISTEN ${channel}`).catch(() => undefined);
  }

  /** In-process consumers of committed changes (e.g. the automation engine). Every instance receives every event. */
  onEvent(listener: (e: RealtimeEvent) => void) {
    this.listeners.push(listener);
  }

  private dispatch(e: RealtimeEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.logger.warn(JSON.stringify({ msg: 'listener_failed', error: String(err) }));
      }
    }
    for (const s of this.subscribers.values()) {
      if (s.workspaceId === e.workspaceId) this.write(s, 'change', e, e.id);
    }
  }

  private write(s: Subscriber, event: string, data: unknown, id?: string) {
    if (s.res.writableEnded) return;
    s.res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private heartbeat() {
    for (const s of this.subscribers.values()) if (!s.res.writableEnded) s.res.write(`: ping ${Date.now()}\n\n`);
  }

  async subscribe(opts: {
    userId: string;
    sessionId: string;
    workspaceId: string;
    projectId: string | null;
    lastEventId: string | null;
    res: Response;
  }): Promise<void> {
    const { res } = opts;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 2000\n\n');

    const [me] = await this.dbs.db.select({ name: users.name }).from(users).where(eq(users.id, opts.userId));
    const sub: Subscriber = { id: this.nextId++, userName: me?.name ?? 'Someone', ...opts };
    this.subscribers.set(sub.id, sub);
    this.write(sub, 'ready', { connected: true, listener: this.listener !== null });

    if (opts.lastEventId) await this.replay(sub, opts.lastEventId);
    this.broadcastPresence(sub.workspaceId, sub.projectId);

    res.on('close', () => {
      this.subscribers.delete(sub.id);
      this.broadcastPresence(sub.workspaceId, sub.projectId);
    });
  }

  /** Re-sends events the client missed while disconnected, read under the user's RLS context. */
  private async replay(sub: Subscriber, lastEventId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(lastEventId)) return this.write(sub, 'reset', { reason: 'unknown_cursor' });
    const missed = await this.dbs.runAsUser(sub.userId, async () => {
      const [cursor] = await this.dbs.db
        .select({ createdAt: outboxEvents.createdAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, lastEventId));
      if (!cursor) return null;
      return this.dbs.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.workspaceId, sub.workspaceId),
            or(gt(outboxEvents.createdAt, cursor.createdAt), and(eq(outboxEvents.createdAt, cursor.createdAt), gt(outboxEvents.id, lastEventId))),
          ),
        )
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(REPLAY_LIMIT + 1);
    });
    if (missed === null || missed.length > REPLAY_LIMIT) return this.write(sub, 'reset', { reason: missed ? 'too_many_missed' : 'unknown_cursor' });
    for (const e of missed) {
      this.write(
        sub,
        'change',
        toRealtimeEvent({ ...e, workspaceId: e.workspaceId!, projectId: e.projectId, actorId: e.actorId }),
        e.id,
      );
    }
  }

  private broadcastPresence(workspaceId: string, projectId: string | null) {
    if (!projectId) return;
    const viewers = [...this.subscribers.values()].filter((s) => s.workspaceId === workspaceId && s.projectId === projectId);
    const unique = [...new Map(viewers.map((v) => [v.userId, { userId: v.userId, name: v.userName }])).values()];
    for (const v of viewers) this.write(v, 'presence', { projectId, viewers: unique });
  }

  /** Disconnects subscribers who lost access or whose session ended. */
  private async recheckAccess() {
    for (const s of [...this.subscribers.values()]) {
      try {
        const ok = await this.dbs.runAsUser(s.userId, async () => {
          const [session] = await this.dbs.db.execute<{ ok: boolean }>(
            sql`select (revoked_at is null and expires_at > now()) as ok from sessions where id = ${s.sessionId}`,
          ).then((r) => r.rows);
          return !!session?.ok && (await this.access.workspaceAccess(s.userId, s.workspaceId)) !== null;
        });
        if (!ok) {
          this.write(s, 'revoked', { reason: 'access_changed' });
          s.res.end();
          this.subscribers.delete(s.id);
        }
      } catch (err) {
        this.logger.warn(JSON.stringify({ msg: 'recheck_failed', error: String(err) }));
      }
    }
  }

  /** Test hook: run the access re-check now. */
  async recheckNow() {
    await this.recheckAccess();
  }

  stats() {
    return { subscribers: this.subscribers.size, listening: this.listener !== null };
  }
}
