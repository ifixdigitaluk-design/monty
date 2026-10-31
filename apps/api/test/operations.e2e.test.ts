import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
});

describe('operations', () => {
  it('health and readiness endpoints', async () => {
    const server = app.getHttpServer();
    expect((await request(server).get('/api/v1/health')).body).toEqual({ status: 'ok', db: 'ok' });
    const ready = await request(server).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ok', db: 'ok', realtime: 'ok' });
  });

  it('maintenance purges only data past its retention period', async () => {
    const u = await signUp(app, 'Ops');
    const p = (await send(u.agent, 'post', `/api/v1/workspaces/${u.workspaceId}/projects`, { name: 'P' })).body.project;
    await send(u.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'A' });
    await send(u.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'B' });
    // Age one outbox event beyond retention and add an old revoked session.
    await query(`update outbox_events set created_at = now() - interval '8 days' where id = (select id from outbox_events order by created_at limit 1)`);
    const before = (await query<{ n: number }>(`select count(*)::int as n from outbox_events`))[0]!.n;
    await query(
      `insert into sessions (user_id, token_hash, expires_at, revoked_at, created_at) values ($1, 'old-hash-x', now() - interval '40 days', now() - interval '40 days', now() - interval '60 days')`,
      [u.user.id],
    );

    const result = await app.get(MaintenanceService).runNow();
    expect(result).toMatchObject({ outboxEvents: 1, sessions: 1 });
    expect((await query<{ n: number }>(`select count(*)::int as n from outbox_events`))[0]!.n).toBe(before - 1);
    // Activity history and the user's live session are untouched.
    expect((await query<{ n: number }>(`select count(*)::int as n from activity_events`))[0]!.n).toBeGreaterThanOrEqual(3);
    expect((await u.agent.get('/api/v1/auth/me')).status).toBe(200);
    expect(await app.get(MaintenanceService).runNow()).toMatchObject({ outboxEvents: 0, sessions: 0 });
  });
});
