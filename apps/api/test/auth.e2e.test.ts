import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('health', () => {
  it('reports database connectivity', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff'); // helmet
  });
});

describe('registration (AC-1)', () => {
  it('creates user, personal org, workspace and memberships atomically', async () => {
    const { agent, user, workspaceId } = await signUp(app, 'Ana');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);

    const orgs = await agent.get('/api/v1/organisations');
    expect(orgs.body.organisations).toHaveLength(1);
    expect(orgs.body.organisations[0]).toMatchObject({ kind: 'PERSONAL', role: 'OWNER' });
    expect(orgs.body.organisations[0].workspaces).toEqual([
      { id: workspaceId, name: 'Personal', slug: 'personal', role: 'ADMIN' },
    ]);

    const [row] = await query<{ password_hash: string }>('select password_hash from users where id = $1', [user.id]);
    expect(row!.password_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('sets an HttpOnly SameSite=Lax session cookie and stores only the token hash', async () => {
    const { email } = await signUp(app, 'Cookie');
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Monty-Client', 'web').send({ email, password: 'correct-horse-battery' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/monty_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const token = /monty_session=([^;]+)/.exec(cookie)![1]!;
    const rows = await query('select 1 from sessions where token_hash = $1', [token]);
    expect(rows).toHaveLength(0);
  });

  it('a duplicate email (case-insensitive) gets the same answer as a new one and creates nothing', async () => {
    const { email } = await signUp(app, 'Dup');
    const res = await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/register', {
      email: email.toUpperCase(),
      name: 'Dup2',
      password: 'correct-horse-battery',
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('check_email');
    expect(res.headers['set-cookie']).toBeUndefined();
    const orgs = await query('select id from organisations');
    expect(orgs).toHaveLength(1);
  });

  it('validates input and rejects unknown fields', async () => {
    const agent = request.agent(app.getHttpServer());
    const short = await send(agent, 'post', '/api/v1/auth/register', { email: 'a@b.co', name: 'A', password: 'x' });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('VALIDATION_FAILED');
    const extra = await send(agent, 'post', '/api/v1/auth/register', {
      email: 'a@b.co',
      name: 'A',
      password: 'correct-horse-battery',
      role: 'ADMIN',
    });
    expect(extra.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Monty-Client', 'web')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('login and sessions (AC-2, AC-10)', () => {
  it('returns the same 401 for unknown email and wrong password', async () => {
    const { email } = await signUp(app, 'Lo');
    const agent = request.agent(app.getHttpServer());
    const wrong = await send(agent, 'post', '/api/v1/auth/login', { email, password: 'wrong-password!' });
    const unknown = await send(agent, 'post', '/api/v1/auth/login', { email: 'nobody@example.com', password: 'wrong-password!' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('logs in, lists sessions, and logout revokes server-side', async () => {
    const { email } = await signUp(app, 'Sess');
    const agent = request.agent(app.getHttpServer());
    const login = await send(agent, 'post', '/api/v1/auth/login', { email, password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    const sessions = await agent.get('/api/v1/auth/sessions');
    expect(sessions.body.sessions).toHaveLength(2); // register + login
    expect(sessions.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const out = await send(agent, 'post', '/api/v1/auth/logout');
    expect(out.status).toBe(204);
    // Replaying the old cookie must fail: revocation is server-side, not just a cleared cookie.
    const replay = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });

  it('can revoke another of its own sessions but not someone else’s', async () => {
    const a = await signUp(app, 'Rev');
    const b = await signUp(app, 'Other');
    const agent2 = request.agent(app.getHttpServer());
    await send(agent2, 'post', '/api/v1/auth/login', { email: a.email, password: 'correct-horse-battery' });
    const list = await a.agent.get('/api/v1/auth/sessions');
    const other = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect((await send(b.agent, 'delete', `/api/v1/auth/sessions/${other.id}`)).status).toBe(404);
    expect((await send(a.agent, 'delete', `/api/v1/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await agent2.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('accepts a bearer token (desktop clients)', async () => {
    const { email } = await signUp(app, 'Desk');
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Monty-Client', 'desktop').send({ email, password: 'correct-horse-battery' });
    const token = /monty_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]!;
    const me = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
  });

  it('requires authentication on protected routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/organisations');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('CSRF protection (AC-8)', () => {
  it('rejects mutations without the client header', async () => {
    const { agent } = await signUp(app, 'Csrf');
    const res = await agent.post('/api/v1/organisations').send({ name: 'Evil' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('rejects mutations from a foreign Origin', async () => {
    const { agent } = await signUp(app, 'Csrf2');
    const res = await agent
      .post('/api/v1/organisations')
      .set('X-Monty-Client', 'web')
      .set('Origin', 'https://evil.example')
      .send({ name: 'Evil' });
    expect(res.status).toBe(403);
  });

  it('allows mutations from an allowed Origin', async () => {
    const { agent } = await signUp(app, 'Csrf3');
    const res = await agent
      .post('/api/v1/organisations')
      .set('X-Monty-Client', 'web')
      .set('Origin', 'http://localhost:3000')
      .send({ name: 'Good Co' });
    expect(res.status).toBe(201);
  });
});

describe('rate limiting', () => {
  it('limits auth attempts', async () => {
    const limited = await createTestApp({ authRateLimit: 3 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await request(limited.getHttpServer())
          .post('/api/v1/auth/login')
          .set('X-Monty-Client', 'web')
          .send({ email: 'x@example.com', password: 'whatever-123' });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });
});
