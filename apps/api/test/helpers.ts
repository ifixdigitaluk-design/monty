import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import type { AppConfig } from '../src/config';

export async function createTestApp(overrides: Partial<AppConfig> = {}) {
  const app = await createApp(overrides);
  await app.listen(0, "127.0.0.1"); // a listening server is reused by supertest (no per-request ephemeral servers)
  return app;
}

const TABLES = [
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
    await pool.query(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
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
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const orgs = await agent.get('/api/v1/organisations');
  const personal = orgs.body.organisations[0];
  return {
    agent,
    user: res.body.user as { id: string; email: string; name: string },
    email,
    personalOrgId: personal.id as string,
    workspaceId: personal.workspaces[0].id as string,
  };
}

/** Convenience: sends a JSON mutation with the required client header. */
export function send(agent: request.Agent, method: 'post' | 'patch' | 'put' | 'delete', url: string, body?: unknown) {
  const req = agent[method](url).set('X-Monty-Client', 'web');
  return body === undefined ? req : req.send(body as object);
}
