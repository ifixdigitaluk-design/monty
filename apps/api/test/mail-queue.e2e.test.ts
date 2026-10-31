import type { INestApplication } from '@nestjs/common';
import { createServer } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { backoffMs, MailService } from '../src/mail/mail.service';
import { classifySendError } from '../src/mail/transports';
import { createTestApp, query, resetDb, send, signUp } from './helpers';
import { startSmtpServer } from './smtp-test-server';

type Smtp = Awaited<ReturnType<typeof startSmtpServer>>;
let apps: INestApplication[] = [];
let smtp: Smtp | null = null;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

async function appWithSmtp(port: number, mail: Partial<ReturnType<typeof loadConfig>['mail']> = {}) {
  const base = loadConfig();
  const app = await createTestApp({
    appUrl: 'http://localhost:3000',
    mail: {
      ...base.mail,
      transport: 'smtp',
      from: 'Monty <no-reply@monty.test>',
      smtp: { host: '127.0.0.1', port, secure: false, rejectUnauthorized: false },
      retryBaseMs: 30,
      maxAttempts: 3,
      pollMs: 60_000, // tests drive delivery explicitly
      ...mail,
    },
  });
  apps.push(app);
  return app;
}
const outbox = () =>
  query<{ id: string; status: string; attempts: number; payload: string | null; last_error: string | null; kind: string; next_attempt_at: Date }>(
    `select id, status, attempts, payload, last_error, kind, next_attempt_at from email_outbox order by created_at`,
  );
const attempts = () => query<{ attempt: number; outcome: string; smtp_code: number | null }>(`select attempt, outcome, smtp_code from email_delivery_attempts order by created_at`);
/** Runs the worker until everything due is done, waiting out short retry delays. */
async function deliverAll(app: INestApplication, ms = 3000) {
  const mail = app.get(MailService);
  const end = Date.now() + ms;
  for (;;) {
    await mail.drain();
    const rows = await outbox();
    if (rows.every((r) => r.status !== 'PENDING' && r.status !== 'SENDING') || Date.now() > end) return rows;
    await new Promise((r) => setTimeout(r, 40));
  }
}

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
  await smtp?.close();
  smtp = null;
});

describe('durable email delivery over real SMTP', () => {
  it('delivers the sign-up verification email; body is encrypted while queued and wiped after sending', async () => {
    smtp = await startSmtpServer();
    const app = await appWithSmtp(smtp.port);
    const u = await signUp(app, 'Sam');

    const [row] = await deliverAll(app);
    expect(row).toMatchObject({ status: 'SENT', attempts: 1, payload: null });
    expect(await attempts()).toEqual([{ attempt: 1, outcome: 'SENT', smtp_code: null }]);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]!.to).toEqual([u.email]);
    expect(smtp.received[0]!.messageId).toBe(`<${row!.id}@localhost>`);
    const token = /verify-email\?token=3D([A-Za-z0-9_=\r\n-]+)|verify-email\?token=([A-Za-z0-9_-]+)/.exec(smtp.received[0]!.raw);
    expect(token).not.toBeNull();
  });

  it('retries temporary failures (SMTP 451) with backoff, then delivers', async () => {
    smtp = await startSmtpServer();
    let n = 0;
    smtp.state.respond = () => (++n <= 2 ? 'temporary' : 'ok');
    const app = await appWithSmtp(smtp.port);
    await signUp(app, 'Tia');
    const mail = app.get(MailService);
    await mail.drain();
    const afterFirst = (await outbox())[0]!;
    expect(afterFirst).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(afterFirst.last_error).toMatch(/451/);
    expect(afterFirst.next_attempt_at.getTime()).toBeGreaterThan(Date.now() - 5);

    const [row] = await deliverAll(app);
    expect(row).toMatchObject({ status: 'SENT', attempts: 3, payload: null });
    expect(await attempts()).toEqual([
      { attempt: 1, outcome: 'TEMPORARY_FAILURE', smtp_code: 451 },
      { attempt: 2, outcome: 'TEMPORARY_FAILURE', smtp_code: 451 },
      { attempt: 3, outcome: 'SENT', smtp_code: null },
    ]);
    expect(smtp.received).toHaveLength(1);
  });

  it('stops immediately on a permanent failure (SMTP 550) and wipes the body', async () => {
    smtp = await startSmtpServer();
    smtp.state.respond = () => 'permanent';
    const app = await appWithSmtp(smtp.port);
    await signUp(app, 'Pat');
    const [row] = await deliverAll(app);
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1, payload: null });
    expect(row!.last_error).toMatch(/550/);
    expect(await attempts()).toEqual([{ attempt: 1, outcome: 'PERMANENT_FAILURE', smtp_code: 550 }]);
    // Sign-up itself succeeded; the user can resend from the app.
    expect((await query(`select 1 from users`)).length).toBe(1);
  });

  it('gives up after the maximum number of attempts when the provider stays unreachable', async () => {
    const app = await appWithSmtp(await freePort()); // nothing listening: ECONNREFUSED
    await signUp(app, 'Max');
    const [row] = await deliverAll(app);
    expect(row).toMatchObject({ status: 'FAILED', attempts: 3, payload: null });
    expect(row!.last_error).toMatch(/ECONNREFUSED|ESOCKET|ECONNECTION/);
    expect((await attempts()).map((a) => a.outcome)).toEqual(['TEMPORARY_FAILURE', 'TEMPORARY_FAILURE', 'TEMPORARY_FAILURE']);
  });

  it('survives an application restart: queued while the provider is down, delivered by the next process, link works', async () => {
    const port = await freePort();
    const first = await appWithSmtp(port, { maxAttempts: 10, retryBaseMs: 60_000 });
    const u = await signUp(first, 'Rae');
    await first.get(MailService).drain(); // one failed attempt while the provider is down
    const queued = (await outbox())[0]!;
    expect(queued).toMatchObject({ kind: 'email_verification', status: 'PENDING', attempts: 1 });
    expect(queued.payload).toMatch(/^v1\./);
    expect(queued.payload).not.toContain('verify-email'); // the link (and its token) is not readable at rest
    await first.close();
    apps = apps.filter((a) => a !== first);
    await query(`update email_outbox set next_attempt_at = now()`); // the retry is now due (time passes while down)

    smtp = await startSmtpServer(port);
    const second = await appWithSmtp(port, { maxAttempts: 10, retryBaseMs: 10 });
    const [row] = await deliverAll(second);
    expect(row).toMatchObject({ status: 'SENT', attempts: 2 });
    const raw = smtp.received[0]!.raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(raw)![1]!;
    const res = await request(second.getHttpServer()).post('/api/v1/auth/verify-email').set('X-Monty-Client', 'web').send({ token });
    expect(res.status).toBe(204);
    expect((await query<{ v: Date | null }>(`select email_verified_at as v from users where id = $1`, [u.user.id]))[0]!.v).not.toBeNull();
  });

  it('a message claimed by a crashed worker is re-sent once its lease expires, with the same Message-ID', async () => {
    smtp = await startSmtpServer();
    let ok = false;
    smtp.state.respond = () => (ok ? 'ok' : 'temporary');
    const app = await appWithSmtp(smtp.port, { retryBaseMs: 60_000 });
    await signUp(app, 'Cal');
    await app.get(MailService).drain();
    // Simulate a worker that claimed the row and died mid-send (lease already expired).
    await query(`update email_outbox set status = 'SENDING', locked_until = now() - interval '1 second'`);
    ok = true;
    const [row] = await deliverAll(app);
    expect(row).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(smtp.received[0]!.messageId).toBe(`<${row!.id}@localhost>`);
  });

  it('is idempotent per logical email and never sends a link after it expired', async () => {
    smtp = await startSmtpServer();
    const app = await appWithSmtp(smtp.port);
    const mail = app.get(MailService);
    const msg = { to: 'a@example.com', subject: 'S', text: 'T', html: '<p>T</p>', kind: 'test' };
    expect(await mail.enqueue(msg, { idempotencyKey: 'k1' })).toBe(true);
    expect(await mail.enqueue(msg, { idempotencyKey: 'k1' })).toBe(false);
    expect(await mail.enqueue(msg, { idempotencyKey: 'k2', expiresAt: new Date(Date.now() - 1000) })).toBe(true);
    const rows = await deliverAll(app);
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'EXPIRED']);
    expect(smtp.received).toHaveLength(1);
  });

  it('a request that rolls back does not leave an email behind (transactional outbox)', async () => {
    smtp = await startSmtpServer();
    const app = await appWithSmtp(smtp.port);
    const u = await signUp(app, 'Org');
    await deliverAll(app);
    const org = (await send(u.agent, 'post', '/api/v1/organisations', { name: 'Team' })).body.organisation;
    // Invalid workspace id → the invitation transaction fails → nothing queued.
    const bad = await send(u.agent, 'post', `/api/v1/organisations/${org.id}/invitations`, { email: 'x@example.com', role: 'MEMBER', workspaceId: '00000000-0000-4000-8000-000000000000', workspaceRole: 'MEMBER' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await outbox()).filter((r) => r.kind === 'invitation')).toHaveLength(0);
    const ok = await send(u.agent, 'post', `/api/v1/organisations/${org.id}/invitations`, { email: 'x@example.com', role: 'MEMBER' });
    expect(ok.body.invitation.emailSent).toBe(true);
    await deliverAll(app);
    expect(smtp.received.map((m) => m.to[0])).toContain('x@example.com');
  });

  it('request transactions cannot read the queue (RLS: system context only)', async () => {
    smtp = await startSmtpServer();
    const app = await appWithSmtp(smtp.port);
    const u = await signUp(app, 'Rls');
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [u.user.id]);
      expect((await c.query('select count(*)::int as n from email_outbox')).rows[0].n).toBe(0);
      await c.query('rollback');
    } finally {
      c.release();
      await pool.end();
    }
    expect((await outbox()).length).toBe(1);
  });
});

describe('mail policy units', () => {
  it('backoff doubles from the base, is capped at one hour and jittered ±20 %', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((a) => backoffMs(a, 30_000, mid))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(20, 30_000, mid)).toBe(3_600_000);
    expect(backoffMs(1, 30_000, () => 0)).toBe(24_000);
    expect(backoffMs(1, 30_000, () => 1)).toBe(36_000);
  });

  it('classifies SMTP and network errors', () => {
    expect(classifySendError({ responseCode: 550, code: 'EENVELOPE', message: 'no such user' }).kind).toBe('permanent');
    expect(classifySendError({ responseCode: 451, message: 'try later' }).kind).toBe('temporary');
    expect(classifySendError({ responseCode: 535, code: 'EAUTH', message: 'bad credentials' }).kind).toBe('temporary');
    expect(classifySendError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }).kind).toBe('temporary');
    expect(classifySendError(new Error('x'.repeat(1000))).message.length).toBeLessThan(230);
  });

  it('production requires a 32-byte DATA_ENCRYPTION_KEY and refuses insecure SMTP TLS settings', () => {
    const base = { DATABASE_URL: 'postgresql://x', NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', APP_URL: 'https://app.example.com' };
    expect(() => loadConfig(base)).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(loadConfig({ ...base, DATA_ENCRYPTION_KEY: key }).dataKey.length).toBe(32);
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: key, SMTP_TLS_REJECT_UNAUTHORIZED: 'false' })).toThrow(/not allowed in production/);
  });
});
