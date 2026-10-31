import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service';
import { escapeHtml, invitationEmail } from '../src/mail/templates';
import { LogTransport } from '../src/mail/transports';
import { loadConfig } from '../src/config';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

let app: INestApplication;
let mailbox: LogTransport;

beforeAll(async () => {
  app = await createTestApp();
  mailbox = app.get(MailService).transport as LogTransport;
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  mailbox.clear();
});

const tokenFrom = (text: string, path: string) => {
  const m = new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(text);
  if (!m) throw new Error(`no ${path} link in: ${text}`);
  return m[1]!;
};
const lastMail = (to: string, kind: string) => {
  const all = mailbox.messages(to).filter((m) => m.kind === kind);
  return all[all.length - 1]!;
};
const settle = () => new Promise((r) => setTimeout(r, 50)); // reset emails are sent without awaiting

describe('email verification (B-05)', () => {
  it('sign-up sends a verification link that verifies the account once', async () => {
    const u = await signUp(app, 'Vera');
    expect((await u.agent.get('/api/v1/auth/me')).body.user.emailVerified).toBe(false);

    const mail = lastMail(u.email, 'email_verification');
    expect(mail.subject).toBe('Confirm your email for Monty');
    const token = tokenFrom(mail.text, '/verify-email');
    expect(mail.text).toContain('http://localhost:3000/verify-email?token=');

    expect((await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/verify-email', { token })).status).toBe(204);
    expect((await u.agent.get('/api/v1/auth/me')).body.user.emailVerified).toBe(true);
    // Single use.
    expect((await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/verify-email', { token })).status).toBe(400);
  });

  it('resend issues a new link and invalidates the old one', async () => {
    const u = await signUp(app, 'Res');
    const first = tokenFrom(lastMail(u.email, 'email_verification').text, '/verify-email');
    const r = await send(u.agent, 'post', '/api/v1/auth/verify-email/resend');
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ sent: true });
    const second = tokenFrom(lastMail(u.email, 'email_verification').text, '/verify-email');
    expect(second).not.toBe(first);
    expect((await send(u.agent, 'post', '/api/v1/auth/verify-email', { token: first })).status).toBe(400);
    expect((await send(u.agent, 'post', '/api/v1/auth/verify-email', { token: second })).status).toBe(204);
    // Nothing to resend once verified.
    expect((await send(u.agent, 'post', '/api/v1/auth/verify-email/resend')).body).toEqual({ sent: false });
  });

  it('rejects expired and malformed tokens', async () => {
    const u = await signUp(app, 'Exp');
    const token = tokenFrom(lastMail(u.email, 'email_verification').text, '/verify-email');
    await query(`update user_tokens set expires_at = now() - interval '1 second'`);
    expect((await send(u.agent, 'post', '/api/v1/auth/verify-email', { token })).status).toBe(400);
    expect((await send(u.agent, 'post', '/api/v1/auth/verify-email', { token: 'short' })).status).toBe(400);
  });

  it('only stores token hashes', async () => {
    const u = await signUp(app, 'Hash');
    const token = tokenFrom(lastMail(u.email, 'email_verification').text, '/verify-email');
    expect(await query('select 1 from user_tokens where token_hash = $1', [token])).toHaveLength(0);
  });
});

describe('password reset (B-06)', () => {
  it('gives the same response for known and unknown emails, and only emails real accounts', async () => {
    const u = await signUp(app, 'Pat');
    const agent = request.agent(app.getHttpServer());
    const known = await send(agent, 'post', '/api/v1/auth/password-reset', { email: u.email.toUpperCase() });
    const unknown = await send(agent, 'post', '/api/v1/auth/password-reset', { email: 'nobody@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    await settle();
    expect(mailbox.messages('nobody@example.com')).toHaveLength(0);
    expect(lastMail(u.email, 'password_reset').subject).toBe('Reset your Monty password');
  });

  it('resets the password, signs out every session, verifies the email, and works once', async () => {
    const u = await signUp(app, 'Rita');
    const other = request.agent(app.getHttpServer());
    await send(other, 'post', '/api/v1/auth/login', { email: u.email, password: 'correct-horse-battery' });

    await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/password-reset', { email: u.email });
    await settle();
    const token = tokenFrom(lastMail(u.email, 'password_reset').text, '/reset-password');

    const anon = request.agent(app.getHttpServer());
    expect((await send(anon, 'post', '/api/v1/auth/password-reset/confirm', { token, password: 'short' })).status).toBe(400);
    expect((await send(anon, 'post', '/api/v1/auth/password-reset/confirm', { token, password: 'a-brand-new-password' })).status).toBe(204);

    expect((await u.agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await other.get('/api/v1/auth/me')).status).toBe(401);
    expect((await send(anon, 'post', '/api/v1/auth/login', { email: u.email, password: 'correct-horse-battery' })).status).toBe(401);
    const login = await send(anon, 'post', '/api/v1/auth/login', { email: u.email, password: 'a-brand-new-password' });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(true);

    expect((await send(anon, 'post', '/api/v1/auth/password-reset/confirm', { token, password: 'another-password-1' })).status).toBe(400);
  });

  it('a newer reset link invalidates older ones; links expire', async () => {
    const u = await signUp(app, 'Old');
    const agent = request.agent(app.getHttpServer());
    await send(agent, 'post', '/api/v1/auth/password-reset', { email: u.email });
    await settle();
    const first = tokenFrom(lastMail(u.email, 'password_reset').text, '/reset-password');
    await send(agent, 'post', '/api/v1/auth/password-reset', { email: u.email });
    await settle();
    const second = tokenFrom(lastMail(u.email, 'password_reset').text, '/reset-password');
    expect((await send(agent, 'post', '/api/v1/auth/password-reset/confirm', { token: first, password: 'new-password-123' })).status).toBe(400);
    await query(`update user_tokens set expires_at = now() - interval '1 second' where purpose = 'PASSWORD_RESET'`);
    expect((await send(agent, 'post', '/api/v1/auth/password-reset/confirm', { token: second, password: 'new-password-123' })).status).toBe(400);
  });

  it('a verification token cannot be used as a reset token', async () => {
    const u = await signUp(app, 'Mix');
    const token = tokenFrom(lastMail(u.email, 'email_verification').text, '/verify-email');
    const res = await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/password-reset/confirm', { token, password: 'new-password-123' });
    expect(res.status).toBe(400);
  });

  it('is audited', async () => {
    const u = await signUp(app, 'Aud');
    await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/password-reset', { email: u.email });
    await settle();
    const token = tokenFrom(lastMail(u.email, 'password_reset').text, '/reset-password');
    await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/password-reset/confirm', { token, password: 'new-password-123' });
    const rows = await query<{ action: string }>(`select action from audit_logs where actor_id = $1 order by created_at`, [u.user.id]);
    expect(rows.map((r) => r.action)).toEqual(['auth.registered', 'auth.password_reset_requested', 'auth.password_reset']);
  });
});

describe('invitation emails', () => {
  it('emails the invitee a working link and reports emailSent', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Acme <script>' })).body.organisation;
    const inv = await send(owner.agent, 'post', `/api/v1/organisations/${org.id}/invitations`, { email: bob.email, role: 'MEMBER' });
    expect(inv.body.invitation.emailSent).toBe(true);
    const mail = lastMail(bob.email, 'invitation');
    expect(mail.subject).toBe('Owner invited you to Acme <script> on Monty');
    expect(mail.html).toContain('Acme &lt;script&gt;'); // user-controlled names are escaped in HTML
    expect(mail.html).not.toContain('<script>');
    const token = tokenFrom(mail.text, '/invite');
    expect((await send(bob.agent, 'post', `/api/v1/invitations/${token}/accept`)).status).toBe(200);
  });
});

describe('dev mailbox and config guards', () => {
  it('dev mailbox is available with the log transport outside production', async () => {
    const u = await signUp(app, 'Box');
    const res = await request(app.getHttpServer()).get(`/api/v1/dev/mailbox?to=${encodeURIComponent(u.email)}`);
    expect(res.status).toBe(200);
    expect(res.body.messages[0].kind).toBe('email_verification');
  });

  it('production refuses to start without SMTP or with a non-https APP_URL', () => {
    const base = { DATABASE_URL: 'postgresql://x', NODE_ENV: 'production' };
    expect(() => loadConfig({ ...base, APP_URL: 'https://app.example.com' })).toThrow(/MAIL_TRANSPORT=smtp/);
    expect(() => loadConfig({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', APP_URL: 'http://app.example.com' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, MAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_HOST/);
    expect(loadConfig({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', APP_URL: 'https://app.example.com' }).mail.transport).toBe('smtp');
  });

  it('escapes HTML in templates', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    expect(invitationEmail('a@b.co', '<b>Eve</b>', 'Org', 'MEMBER', 'https://x/invite?token=abc').html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
  });
});
