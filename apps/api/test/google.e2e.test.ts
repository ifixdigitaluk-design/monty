import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, currentStep, hotp } from '../src/auth/totp';
import type { AppConfig } from '../src/config';
// The same local identity provider the browser tests use (stands in for Google; real RS256 + PKCE).
import { startFakeOidc } from './fake-oidc.mjs';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

type Idp = Awaited<ReturnType<typeof startFakeOidc>>;
let idp: Idp;
let app: INestApplication;
const google = (over: Partial<NonNullable<AppConfig['google']>> = {}): Partial<AppConfig> => ({
  google: { clientId: idp.clientId, clientSecret: idp.clientSecret, issuer: idp.issuer, allowedDomains: [], ...over },
});

beforeAll(async () => {
  idp = await startFakeOidc();
  app = await createTestApp(google());
});
afterAll(async () => {
  await app.close();
  await idp.close();
});
beforeEach(async () => {
  await resetDb();
});

/** Runs the whole browser round trip: start → provider (chooses an identity) → callback. */
async function googleSignIn(
  agent: request.Agent,
  identity: Record<string, string>,
  opts: { next?: string; tamperState?: boolean } = {},
) {
  const start = await agent.get(`/api/v1/auth/google/start${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}`);
  expect(start.status).toBe(302);
  const auth = new URL(start.headers.location as string);
  for (const [k, v] of Object.entries(identity)) auth.searchParams.set(k, v);
  const atIdp = await fetch(auth, { redirect: 'manual' });
  expect(atIdp.status).toBe(302);
  const back = new URL(atIdp.headers.get('location')!);
  expect(back.pathname).toBe('/api/v1/auth/google/callback');
  if (opts.tamperState) back.searchParams.set('state', 'forged');
  return agent.get(`/api/v1/auth/google/callback${back.search}`);
}
const fresh = (a: INestApplication = app) => request.agent(a.getHttpServer());
const hasSession = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c) => c.startsWith('monty_session=') && !c.includes('Expires=Thu, 01 Jan 1970')) ?? false;

describe('Google sign-in (OpenID Connect)', () => {
  it('advertises the provider and sends the browser to it with PKCE, state and nonce', async () => {
    expect((await fresh().get('/api/v1/auth/providers')).body).toEqual({ google: true });
    const start = await fresh().get('/api/v1/auth/google/start');
    const url = new URL(start.headers.location as string);
    expect(url.origin).toBe(idp.issuer);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: idp.clientId,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      redirect_uri: 'http://localhost:3000/api/v1/auth/google/callback',
    });
    expect(url.searchParams.get('state')).toHaveLength(32);
    expect(url.searchParams.get('nonce')).toHaveLength(32);
    const cookie = (start.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('monty_oidc='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth\/google/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toContain(url.searchParams.get('state')!); // sealed, not readable
  });

  it('creates a confirmed account on first sign-in, then signs the same person in again', async () => {
    const agent = fresh();
    const res = await googleSignIn(agent, { email: 'Grace@Example.com', name: 'Grace Hopper' }, { next: '/databases' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/databases');
    expect(hasSession(res)).toBe(true);
    const me = (await agent.get('/api/v1/auth/me')).body.user;
    expect(me).toMatchObject({ email: 'grace@example.com', name: 'Grace Hopper', emailVerified: true });
    expect((await agent.get('/api/v1/organisations')).body.organisations).toHaveLength(1);
    const [u] = await query<{ password_hash: string }>(`select password_hash from users where id = $1`, [me.id]);
    expect(u!.password_hash).toBe('!'); // no password until they set one with "Forgot password"

    const again = fresh();
    const second = await googleSignIn(again, { email: 'grace@example.com', name: 'Grace Hopper' });
    expect(second.headers.location).toBe('/home');
    expect((await again.get('/api/v1/auth/me')).body.user.id).toBe(me.id);
    expect((await query(`select count(*)::int as n from users`))[0]).toEqual({ n: 1 });
    const audit = await query<{ action: string; data: Record<string, unknown> }>(`select action, data from audit_logs where actor_id = $1 order by created_at`, [me.id]);
    expect(audit.map((a) => a.action)).toEqual(['auth.registered', 'auth.login', 'auth.login']);
    expect(audit[0]!.data).toEqual({ via: 'google' });
  });

  it('links to an existing confirmed account (password keeps working)', async () => {
    const ann = await signUp(app, 'Ann');
    const agent = fresh();
    await googleSignIn(agent, { email: ann.email });
    expect((await agent.get('/api/v1/auth/me')).body.user.id).toBe(ann.user.id);
    const pw = await fresh().post('/api/v1/auth/login').set('X-Monty-Client', 'web').send({ email: ann.email, password: 'correct-horse-battery' });
    expect(pw.status).toBe(200);
    expect((await query(`select provider from user_identities where user_id = $1`, [ann.user.id])).map((r) => r.provider)).toEqual(['google']);
  });

  it('an unconfirmed account squatting the address loses its password when the real owner signs in with Google', async () => {
    await fresh().post('/api/v1/auth/register').set('X-Monty-Client', 'web').send({ email: 'victim@example.com', name: 'Squatter', password: 'squatters-password' });
    const owner = fresh();
    await googleSignIn(owner, { email: 'victim@example.com', name: 'Real Owner' });
    expect((await owner.get('/api/v1/auth/me')).body.user).toMatchObject({ email: 'victim@example.com', emailVerified: true });
    const squatter = await fresh().post('/api/v1/auth/login').set('X-Monty-Client', 'web').send({ email: 'victim@example.com', password: 'squatters-password' });
    expect(squatter.status).toBe(401);
  });

  it('still asks for the two-factor code', async () => {
    const u = await signUp(app, 'Mfa');
    const setup = (await send(u.agent, 'post', '/api/v1/auth/mfa/setup', { password: 'correct-horse-battery' })).body;
    const code = () => hotp(base32Decode(setup.secret), currentStep());
    expect((await send(u.agent, 'post', '/api/v1/auth/mfa/enable', { code: code() })).status).toBe(200);
    // Use the next time step so the code isn't a replay of the one used to enable.
    await query(`update users set mfa_last_step = mfa_last_step - 5 where id = $1`, [u.user.id]);

    const agent = fresh();
    const res = await googleSignIn(agent, { email: u.email }, { next: '/inbox' });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.location as string, 'http://x');
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('next')).toBe('/inbox');
    expect(hasSession(res)).toBe(false);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    const done = await send(agent, 'post', '/api/v1/auth/login/mfa', { mfaToken: to.searchParams.get('mfa'), code: code() });
    expect(done.status).toBe(200);
    expect((await agent.get('/api/v1/auth/me')).body.user.id).toBe(u.user.id);
  });

  it.each([
    ['nonce', 'google_failed'],
    ['aud', 'google_failed'],
    ['iss', 'google_failed'],
    ['sig', 'google_failed'],
    ['exp', 'google_expired'],
  ])('refuses an ID token with a bad %s', async (tamper, code) => {
    const agent = fresh();
    const res = await googleSignIn(agent, { email: 'mallory@example.com', tamper });
    expect(res.headers.location).toBe(`/login?error=${code}`);
    expect(hasSession(res)).toBe(false);
    expect((await query(`select count(*)::int as n from users`))[0]).toEqual({ n: 0 });
  });

  it('refuses forged state, a missing cookie, unverified emails, cancellations and code reuse; ignores unsafe next', async () => {
    expect((await googleSignIn(fresh(), { email: 'a@example.com' }, { tamperState: true })).headers.location).toBe('/login?error=google_expired');
    expect((await googleSignIn(fresh(), { email: 'a@example.com', email_verified: 'false' })).headers.location).toBe('/login?error=google_unverified');
    expect((await googleSignIn(fresh(), { email: 'a@example.com', deny: '1' })).headers.location).toBe('/login?error=google_cancelled');

    // The callback URL replayed in another browser (no state cookie) is useless.
    const agent = fresh();
    const start = await agent.get('/api/v1/auth/google/start?next=//evil.example/x');
    const auth = new URL(start.headers.location as string);
    auth.searchParams.set('email', 'b@example.com');
    const back = new URL((await fetch(auth, { redirect: 'manual' })).headers.get('location')!);
    expect((await fresh().get(`/api/v1/auth/google/callback${back.search}`)).headers.location).toBe('/login?error=google_expired');
    // The real browser completes it; the unsafe "next" was dropped.
    const ok = await agent.get(`/api/v1/auth/google/callback${back.search}`);
    expect(ok.headers.location).toBe('/home');
    // Same code again: the state cookie was cleared and the provider refuses reuse.
    const tokenCalls = idp.stats.tokenRequests;
    expect((await agent.get(`/api/v1/auth/google/callback${back.search}`)).headers.location).toBe('/login?error=google_expired');
    expect(idp.stats.tokenRequests).toBe(tokenCalls);
  });

  it('enforces the allowed-domain list and invite-only mode', async () => {
    const strict = await createTestApp({ ...google({ allowedDomains: ['monty.test'] }), signupMode: 'invite' });
    try {
      const start = await fresh(strict).get('/api/v1/auth/google/start');
      expect(new URL(start.headers.location as string).searchParams.get('hd')).toBe('monty.test');
      const run = async (email: string) => {
        const agent = fresh(strict);
        const s = await agent.get('/api/v1/auth/google/start');
        const auth = new URL(s.headers.location as string);
        auth.searchParams.set('email', email);
        const back = new URL((await fetch(auth, { redirect: 'manual' })).headers.get('location')!);
        return { agent, res: await agent.get(`/api/v1/auth/google/callback${back.search}`) };
      };
      expect((await run('outsider@gmail.com')).res.headers.location).toBe('/login?error=google_domain');
      // First account bootstraps the instance even in invite-only mode.
      const first = await run('boss@monty.test');
      expect(first.res.headers.location).toBe('/home');
      expect((await run('newbie@monty.test')).res.headers.location).toBe('/login?error=google_not_allowed');
      // With an invitation, the colleague can join with Google.
      const org = (await send(first.agent, 'post', '/api/v1/organisations', { name: 'Co' })).body.organisation;
      expect((await send(first.agent, 'post', `/api/v1/organisations/${org.id}/invitations`, { email: 'newbie@monty.test', role: 'MEMBER' })).status).toBe(201);
      expect((await run('newbie@monty.test')).res.headers.location).toBe('/home');
    } finally {
      await strict.close();
    }
  });

  it('is off without configuration', async () => {
    const plain = await createTestApp({ google: null });
    try {
      expect((await fresh(plain).get('/api/v1/auth/providers')).body).toEqual({ google: false });
      expect((await fresh(plain).get('/api/v1/auth/google/start')).headers.location).toBe('/login?error=google_failed');
    } finally {
      await plain.close();
    }
  });
});
