import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transientDbFailure } from '../src/common/db-errors';
import { AppConfig, loadConfig } from '../src/config';
import { DbService } from '../src/db/db.service';
import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { createTestApp, resetDb, send, signUp } from './helpers';

let app: INestApplication | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});
beforeEach(async () => {
  await resetDb();
});

async function appWith(t: Partial<AppConfig['timeouts']>, extra: Partial<AppConfig> = {}) {
  const base = loadConfig();
  app = await createTestApp({ timeouts: { ...base.timeouts, ...t }, ...extra });
  return app;
}
const owner = () => new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });

describe('database and request timeouts', () => {
  it('applies the configured limits to every API connection (production defaults)', async () => {
    const cfg = loadConfig();
    expect(cfg.timeouts).toEqual({ statementMs: 15_000, idleInTransactionMs: 60_000, lockMs: 5_000, connectMs: 5_000, requestMs: 40_000 });
    const a = await appWith({});
    const dbs = a.get(DbService);
    const r = await dbs.runAsSystem(async () =>
      (await dbs.db.execute<{ s: string; i: string; l: string }>(sql`select current_setting('statement_timeout') s, current_setting('idle_in_transaction_session_timeout') i, current_setting('lock_timeout') l`)).rows[0],
    );
    expect(r).toEqual({ s: '15s', i: '1min', l: '5s' });
  });

  it('cancels a slow query (statement_timeout) and the pool keeps working', async () => {
    const a = await appWith({ statementMs: 300 });
    const dbs = a.get(DbService);
    const started = Date.now();
    const err = await dbs.runAsSystem(() => dbs.db.execute(sql`select pg_sleep(3)`)).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(transientDbFailure(err)).toBe('statement_timeout');
    expect((await dbs.runAsSystem(() => dbs.db.execute(sql`select 1 as ok`))).rows[0]).toEqual({ ok: 1 });
  });

  it('maintenance jobs may run longer statements than requests', async () => {
    const a = await appWith({ statementMs: 300 });
    const dbs = a.get(DbService);
    await expect(
      dbs.runAsSystem(async () => {
        await dbs.allowLongStatements(5_000);
        return dbs.db.execute(sql`select pg_sleep(0.6)`);
      }),
    ).resolves.toBeDefined();
    await expect(a.get(MaintenanceService).runNow()).resolves.toMatchObject({ outboxEvents: 0 });
  });

  it('terminates a transaction left idle (interrupted request) and recovers', async () => {
    const a = await appWith({ idleInTransactionMs: 36_000 });
    const dbs = a.get(DbService);
    // The configured minimum is above the AI timeout, so lower it for this session only to keep the test fast.
    const err = await dbs
      .runAsSystem(async () => {
        await dbs.db.execute(sql`set local idle_in_transaction_session_timeout = 300`);
        await new Promise((r) => setTimeout(r, 800)); // application stalls while holding the transaction
        await dbs.db.execute(sql`select 1`);
      })
      .catch((e) => e);
    expect(transientDbFailure(err)).toMatch(/idle_transaction_timeout|connection_lost/);
    expect((await dbs.runAsSystem(() => dbs.db.execute(sql`select 2 as ok`))).rows[0]).toEqual({ ok: 2 });
  });

  it('a request blocked by a row lock fails fast with 503 instead of hanging, and nothing is half-saved', async () => {
    const a = await appWith({ lockMs: 300 });
    const u = await signUp(a, 'Lock');
    const p = (await send(u.agent, 'post', `/api/v1/workspaces/${u.workspaceId}/projects`, { name: 'P' })).body.project;
    const t = (await send(u.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'A' })).body.task;
    const pool = owner();
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('select id from tasks where id = $1 for update', [t.id]);
      const started = Date.now();
      const res = await send(u.agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, title: 'B' });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('2');
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      await c.query('rollback');
    } finally {
      c.release();
      await pool.end();
    }
    const after = (await u.agent.get(`/api/v1/projects/${p.id}/tasks`)).body.tasks[0];
    expect(after).toMatchObject({ title: 'A', version: 1 });
    expect((await send(u.agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, title: 'B' })).status).toBe(200);
  });

  it('when every pooled connection is busy, requests get 503 after the acquisition timeout, then recover', async () => {
    const a = await appWith({ connectMs: 300 }, { dbPoolMax: 2 });
    const u = await signUp(a, 'Pool');
    const dbs = a.get(DbService);
    const hold = [1, 2].map(() => dbs.runAsSystem(() => dbs.db.execute(sql`select pg_sleep(1.2)`)));
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const res = await u.agent.get('/api/v1/organisations');
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1000);
    await Promise.all(hold);
    expect((await u.agent.get('/api/v1/organisations')).status).toBe(200);
  });

  it('recovers when the database kills all API connections (e.g. failover/restart)', async () => {
    const a = await appWith({});
    const u = await signUp(a, 'Recover');
    expect((await u.agent.get('/api/v1/organisations')).status).toBe(200);
    // A role may terminate its own sessions; this kills every API connection like a database restart would.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await pool.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'monty_app' and datname = current_database() and pid <> pg_backend_pid()`);
    await pool.end();
    await new Promise((r) => setTimeout(r, 200));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await u.agent.get('/api/v1/organisations')).status);
    // At most the first request may hit a dying connection (503, never a crash); the pool then reconnects.
    expect(statuses.slice(1)).toEqual([200, 200]);
    expect(statuses[0] === 200 || statuses[0] === 503).toBe(true);
    expect((await a.get(DbService).runAsSystem(() => a.get(DbService).db.execute(sql`select 1 as ok`))).rows[0]).toEqual({ ok: 1 });
  });

  it('answers 503 REQUEST_TIMEOUT when a handler exceeds the request limit, without a second response', async () => {
    const a = await appWith({ requestMs: 300, lockMs: 3_000 });
    const u = await signUp(a, 'Slow');
    const p = (await send(u.agent, 'post', `/api/v1/workspaces/${u.workspaceId}/projects`, { name: 'P' })).body.project;
    const t = (await send(u.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'A' })).body.task;
    const pool = owner();
    const c = await pool.connect();
    await c.query('begin');
    await c.query('select id from tasks where id = $1 for update', [t.id]);
    const res = await send(u.agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, title: 'B' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('REQUEST_TIMEOUT');
    await c.query('rollback');
    c.release();
    await pool.end();
    await new Promise((r) => setTimeout(r, 300));
    expect((await u.agent.get('/api/v1/organisations')).status).toBe(200); // server still healthy
  });

  it('refuses an idle-transaction limit shorter than the AI request window', () => {
    expect(() => loadConfig({ ...process.env, DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '20000' })).toThrow(/must exceed 35000/);
  });

  it('classifies transient failures', () => {
    expect(transientDbFailure({ code: '57014' })).toBe('statement_timeout');
    expect(transientDbFailure(new Error('wrapper', { cause: { code: '55P03' } }))).toBe('lock_timeout');
    expect(transientDbFailure(new Error('timeout exceeded when trying to connect'))).toBe('pool_timeout');
    expect(transientDbFailure(new Error('duplicate key'))).toBeNull();
  });
});
