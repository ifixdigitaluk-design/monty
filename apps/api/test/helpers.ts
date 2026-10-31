import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import type { AppConfig } from '../src/config';
import { MailService } from '../src/mail/mail.service';
import { LogTransport } from '../src/mail/transports';

export async function createTestApp(overrides: Partial<AppConfig> = {}) {
  const app = await createApp(overrides);
  await app.listen(0, "127.0.0.1"); // a listening server is reused by supertest (no per-request ephemeral servers)
  return app;
}

const TABLES = [
  'login_challenges',
  'mfa_recovery_codes',
  'data_exports',
  'email_delivery_attempts',
  'email_outbox',
  'automation_runs',
  'automation_rules',
  'ai_proposals',
  'document_versions',
  'documents',
  'notifications',
  'comments',
  'milestones',
  'invitations',
  'audit_logs',
  'user_tokens',
  'outbox_events',
  'activity_events',
  'task_dependencies',
  'tasks',
  'projects',
  'workspace_memberships',
  'workspaces',
  'organisation_memberships',
  'organisations',
  'sessions',
  'users',
];

export async function resetDb() {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    // Background workers of the app under test (mail delivery, automations) may still be writing; TRUNCATE can
    // deadlock with them. That is a test-harness race, so retry instead of failing the next test.
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.query(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  } finally {
    await pool.end();
  }
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    return (await pool.query(sql, params)).rows as T[];
  } finally {
    await pool.end();
  }
}

let counter = 0;

/** Registers a fresh user and returns a cookie-carrying agent plus their personal workspace. */
export async function signUp(app: INestApplication, name = 'User') {
  counter += 1;
  const email = `${name.toLowerCase().replace(/\W/g, '')}${counter}-${Date.now()}@example.com`;
  const agent = request.agent(app.getHttpServer());
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-Monty-Client', 'web')
    .send({ email, name, password: 'correct-horse-battery' });
  if (res.status !== 202) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  await completeSignUp(app, agent, email);
  const me = await agent.get('/api/v1/auth/me');
  if (me.status !== 200) throw new Error(`sign-in after sign-up failed: ${me.status}`);
  const orgs = await agent.get('/api/v1/organisations');
  const personal = orgs.body.organisations[0];
  return {
    agent,
    user: me.body.user as { id: string; email: string; name: string },
    email,
    personalOrgId: personal.id as string,
    workspaceId: personal.workspaces[0].id as string,
  };
}

/**
 * Sign-up now ends with "check your email". With the log transport the helper follows the emailed link
 * (exactly like a user); with other transports (SMTP tests) it marks the address confirmed and signs in.
 */
export async function completeSignUp(app: INestApplication, agent: request.Agent, email: string) {
  const mail = app.get(MailService);
  if (mail.transport instanceof LogTransport) {
    await mail.drain();
    const msg = mail.transport.messages(email).filter((m) => m.kind === 'email_verification').pop();
    const token = msg && /verify-email\?token=([A-Za-z0-9_-]+)/.exec(msg.text)?.[1];
    if (!token) {
      // Another test app sharing the database queue delivered it to its own in-memory mailbox.
      await query(`update users set email_verified_at = now() where email = $1`, [email]);
      const l = await agent.post('/api/v1/auth/login').set('X-Monty-Client', 'web').send({ email, password: 'correct-horse-battery' });
      if (l.status !== 200) throw new Error(`login failed: ${l.status}`);
      return;
    }
    const v = await agent.post('/api/v1/auth/verify-email').set('X-Monty-Client', 'web').send({ token });
    if (v.status !== 200 || !v.body.signedIn) throw new Error(`verify failed: ${v.status} ${JSON.stringify(v.body)}`);
    return;
  }
  await query(`update users set email_verified_at = now() where email = $1`, [email]);
  const l = await agent.post('/api/v1/auth/login').set('X-Monty-Client', 'web').send({ email, password: 'correct-horse-battery' });
  if (l.status !== 200) throw new Error(`login failed: ${l.status}`);
}

/** Convenience: sends a JSON mutation with the required client header. */
export function send(agent: request.Agent, method: 'post' | 'patch' | 'put' | 'delete', url: string, body?: unknown) {
  const req = agent[method](url).set('X-Monty-Client', 'web');
  return body === undefined ? req : req.send(body as object);
}
