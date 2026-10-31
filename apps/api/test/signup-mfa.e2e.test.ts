import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, currentStep, hotp } from '../src/auth/totp';
import { MailService } from '../src/mail/mail.service';
import { LogTransport } from '../src/mail/transports';
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

const PW = 'correct-horse-battery';
const register = (body: object, a: INestApplication = app) => send(request.agent(a.getHttpServer()), 'post', '/api/v1/auth/register', body);
const login = (email: string, password = PW) => send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/login', { email, password });
const drain = (a: INestApplication = app) => a.get(MailService).drain();
const code = (secret: string, offset = 0) => hotp(base32Decode(secret), currentStep() + offset);

describe('sign-up does not reveal which emails have accounts', () => {
  it('new and existing addresses get byte-identical responses; the owner is emailed instead', async () => {
    const existing = await signUp(app, 'Owner');
    const fresh = await register({ email: `new-${Date.now()}@example.com`, name: 'New', password: PW });
    const dup = await register({ email: existing.email, name: 'Attacker', password: 'another-password-1' });
    for (const r of [fresh, dup]) {
      expect(r.status).toBe(202);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect(dup.body).toEqual(fresh.body);
    await drain();
    const notice = mailbox.messages(existing.email).filter((m) => m.kind === 'account_exists');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.text).toContain('/forgot-password');
    // The attacker's password did not replace anything and no second account exists.
    expect((await query(`select count(*)::int as n from users where email = $1`, [existing.email]))[0]).toEqual({ n: 1 });
    expect((await login(existing.email, 'another-password-1')).status).toBe(401);
    // Repeated attempts within the hour send one notice, not a stream.
    await register({ email: existing.email, name: 'Attacker', password: 'another-password-1' });
    await drain();
    expect(mailbox.messages(existing.email).filter((m) => m.kind === 'account_exists')).toHaveLength(1);
  });

  it('invite-only mode: first account bootstraps, others need a pending invitation; responses never differ', async () => {
    const closed = await createTestApp({ signupMode: 'invite' });
    const own = closed.get(MailService).transport as LogTransport;
    // Both apps share the database queue, so either worker may deliver a message.
    const box = { messages: (to: string) => [...own.messages(to), ...mailbox.messages(to)] };
    try {
      const first = await signUp(closed, 'Admin'); // bootstrap
      const outsider = `out-${Date.now()}@example.com`;
      const blocked = await register({ email: outsider, name: 'Out', password: PW }, closed);
      expect(blocked.status).toBe(202);
      await drain(closed);
      await drain();
      expect(box.messages(outsider).map((m) => m.kind)).toEqual(['signup_invite_only']);
      expect(await query(`select 1 from users where email = $1`, [outsider])).toHaveLength(0);

      const org = (await send(first.agent, 'post', '/api/v1/organisations', { name: 'Team' })).body.organisation;
      const invited = `inv-${Date.now()}@example.com`;
      await send(first.agent, 'post', `/api/v1/organisations/${org.id}/invitations`, { email: invited, role: 'MEMBER' });
      const ok = await register({ email: invited, name: 'Inv', password: PW }, closed);
      expect(ok.body).toEqual(blocked.body);
      await drain(closed);
      await drain();
      expect(box.messages(invited).map((m) => m.kind).sort()).toEqual(['email_verification', 'invitation']);
      expect(await query(`select 1 from users where email = $1`, [invited])).toHaveLength(1);
    } finally {
      await closed.close();
    }
  });
});

describe('two-factor authentication', () => {
  async function enabled() {
    const u = await signUp(app, 'Mfa');
    expect((await send(u.agent, 'post', '/api/v1/auth/mfa/setup', { password: 'wrong-password-1' })).status).toBe(403);
    const setup = (await send(u.agent, 'post', '/api/v1/auth/mfa/setup', { password: PW })).body;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Monty%3A.+\?secret=[A-Z2-7]+&issuer=Monty/);
    expect(setup.qrSvgDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect((await send(u.agent, 'post', '/api/v1/auth/mfa/enable', { code: '000000' })).status).toBe(401);
    const en = await send(u.agent, 'post', '/api/v1/auth/mfa/enable', { code: code(setup.secret) });
    expect(en.status).toBe(200);
    expect(en.body.recoveryCodes).toHaveLength(10);
    return { u, secret: setup.secret as string, recovery: en.body.recoveryCodes as string[] };
  }

  it('setup needs the password and a working code; secrets are encrypted and recovery codes hashed', async () => {
    const { u, secret, recovery } = await enabled();
    expect((await u.agent.get('/api/v1/auth/mfa')).body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
    expect((await u.agent.get('/api/v1/auth/me')).body.user.mfaEnabled).toBe(true);
    const [row] = await query<{ mfa_secret: string }>(`select mfa_secret from users where id = $1`, [u.user.id]);
    expect(row!.mfa_secret).toMatch(/^v1\./);
    expect(row!.mfa_secret).not.toContain(secret);
    const hashes = await query<{ code_hash: string }>(`select code_hash from mfa_recovery_codes where user_id = $1`, [u.user.id]);
    expect(hashes.map((h) => h.code_hash).join()).not.toContain(recovery[0]!.replace(/-/g, ''));
    const audit = await query<{ action: string }>(`select action from audit_logs where action like 'auth.mfa%'`);
    expect(audit.map((a) => a.action)).toEqual(['auth.mfa_enabled']);
  });

  it('password sign-in then requires a code; codes cannot be replayed; wrong attempts lock the challenge', async () => {
    const { u, secret } = await enabled();
    const step1 = await login(u.email);
    expect(step1.status).toBe(200);
    expect(step1.body).toMatchObject({ mfaRequired: true });
    expect(step1.headers['set-cookie']).toBeUndefined();

    const agent = request.agent(app.getHttpServer());
    expect((await send(agent, 'post', '/api/v1/auth/login/mfa', { mfaToken: step1.body.mfaToken, code: '123456' })).status).toBe(401);
    // The code used to enable two-factor (current step) is already spent: replay refused.
    expect((await send(agent, 'post', '/api/v1/auth/login/mfa', { mfaToken: step1.body.mfaToken, code: code(secret) })).status).toBe(401);
    const ok = await send(agent, 'post', '/api/v1/auth/login/mfa', { mfaToken: step1.body.mfaToken, code: code(secret, 1) });
    expect(ok.status).toBe(200);
    expect((await agent.get('/api/v1/auth/me')).body.user.email).toBe(u.email);
    // The challenge is single use.
    expect((await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/login/mfa', { mfaToken: step1.body.mfaToken, code: code(secret, 1) })).status).toBe(401);

    const step2 = await login(u.email);
    for (let i = 0; i < 5; i++) await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/login/mfa', { mfaToken: step2.body.mfaToken, code: '000000' });
    const locked = await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/login/mfa', { mfaToken: step2.body.mfaToken, code: code(secret, 1) });
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('a recovery code signs in once; disabling needs the password and a second factor', async () => {
    const { u, secret, recovery } = await enabled();
    const ch = (await login(u.email)).body.mfaToken;
    const agent = request.agent(app.getHttpServer());
    expect((await send(agent, 'post', '/api/v1/auth/login/mfa', { mfaToken: ch, recoveryCode: recovery[0]!.toUpperCase() })).status).toBe(200);
    const ch2 = (await login(u.email)).body.mfaToken;
    expect((await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/login/mfa', { mfaToken: ch2, recoveryCode: recovery[0] })).status).toBe(401);
    expect((await agent.get('/api/v1/auth/mfa')).body.recoveryCodesRemaining).toBe(9);

    expect((await send(agent, 'post', '/api/v1/auth/mfa/disable', { password: 'nope-nope-nope', code: code(secret, 1) })).status).toBe(403);
    expect((await send(agent, 'post', '/api/v1/auth/mfa/disable', { password: PW, code: '000000' })).status).toBe(401);
    expect((await send(agent, 'post', '/api/v1/auth/mfa/disable', { password: PW, recoveryCode: recovery[1] })).status).toBe(204);
    const plain = await login(u.email);
    expect(plain.body.user.mfaEnabled).toBe(false);
  });

  it('the emailed confirmation link never bypasses two-factor', async () => {
    const { u } = await enabled();
    await query(`update users set email_verified_at = null where id = $1`, [u.user.id]);
    await send(u.agent, 'post', '/api/v1/auth/verify-email/resend');
    await drain();
    const msg = mailbox.messages(u.email).filter((m) => m.kind === 'email_verification').pop()!;
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(msg.text)![1]!;
    const fresh = request.agent(app.getHttpServer());
    const res = await send(fresh, 'post', '/api/v1/auth/verify-email', { token });
    expect(res.body).toEqual({ verified: true, signedIn: false });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await fresh.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('per-account brute-force protection', () => {
  it('locks password sign-in for an account after 10 failures in 15 minutes; a successful reset clears it', async () => {
    const u = await signUp(app, 'Brute');
    for (let i = 0; i < 10; i++) expect((await login(u.email, `wrong-password-${i}`)).status).toBe(401);
    const locked = await login(u.email);
    expect(locked.status).toBe(429);
    await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/password-reset', { email: u.email });
    await drain();
    const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mailbox.messages(u.email).filter((m) => m.kind === 'password_reset').pop()!.text)![1]!;
    expect((await send(request.agent(app.getHttpServer()), 'post', '/api/v1/auth/password-reset/confirm', { token, password: 'brand-new-password-1' })).status).toBe(204);
    expect((await login(u.email, 'brand-new-password-1')).status).toBe(200);
  });
});
