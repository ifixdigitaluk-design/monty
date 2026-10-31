import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, createPublicKey, JsonWebKey, randomBytes, timingSafeEqual, verify as verifySig } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { sessions, userIdentities, users } from '@monty/database';
import type { UserDto } from '@monty/validation';
import { AuditService } from '../audit/audit.service';
import { decrypt, encrypt } from '../common/encryption';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { AuthService, ClientInfo, toUserDto } from './auth.service';

/** Short reason codes shown on the sign-in page (never details an attacker could use). */
export type GoogleFailure = 'google_cancelled' | 'google_failed' | 'google_expired' | 'google_not_allowed' | 'google_unverified' | 'google_domain';
export class GoogleSignInError extends Error {
  constructor(
    readonly code: GoogleFailure,
    readonly detail: string,
  ) {
    super(detail);
  }
}

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  next: string | null;
  exp: number;
}
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const PENDING_MS = 10 * 60_000;
const SAFE_NEXT = /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]*$/;
const b64url = (b: Buffer) => b.toString('base64url');
const sameString = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * "Continue with Google" (OpenID Connect authorization code flow with PKCE, state and nonce).
 *
 * Linking rules (an identity is the provider's stable `sub`, never the email):
 * - Known identity → sign in that account.
 * - New identity, Google-verified email matching an account → link it. If that account's own email was never
 *   confirmed, its password is disabled and its sessions are ended: whoever set it never proved the address.
 * - No account → create one (same rules as sign-up, including invite-only mode), email already confirmed.
 * - Accounts with two-factor on still need their code: Google replaces the password, not the second factor.
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger('GoogleSignIn');
  private discovery: { at: number; doc: Discovery } | null = null;
  private keys = new Map<string, JsonWebKey>();
  private keysAt = 0;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly dbs: DbService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  get enabled() {
    return this.config.google !== null;
  }

  private get g() {
    if (!this.config.google) throw new GoogleSignInError('google_failed', 'not configured');
    return this.config.google;
  }

  get redirectUri() {
    return `${this.config.appUrl}/api/v1/auth/google/callback`;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new GoogleSignInError('google_failed', `${new URL(url).pathname} ${res.status} ${body.error ?? ''}`);
    return body;
  }

  private async meta(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.at < 3_600_000) return this.discovery.doc;
    const doc = await this.fetchJson<Discovery>(`${this.g.issuer}/.well-known/openid-configuration`);
    if (doc.issuer.replace(/\/$/, '') !== this.g.issuer) throw new GoogleSignInError('google_failed', 'issuer mismatch in discovery');
    this.discovery = { at: Date.now(), doc };
    return doc;
  }

  private async key(kid: string): Promise<JsonWebKey | null> {
    if (!this.keys.has(kid) && Date.now() - this.keysAt > 60_000) {
      const { keys } = await this.fetchJson<{ keys: (JsonWebKey & { kid: string })[] }>((await this.meta()).jwks_uri);
      this.keys = new Map(keys.map((k) => [k.kid, k]));
      this.keysAt = Date.now();
    }
    return this.keys.get(kid) ?? null;
  }

  /** Step 1: where to send the browser, plus the sealed cookie that remembers this attempt. */
  async start(next: string | undefined): Promise<{ url: string; cookie: string }> {
    const pending: Pending = {
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(32)),
      next: next && SAFE_NEXT.test(next) && next.length <= 500 ? next : null,
      exp: Date.now() + PENDING_MS,
    };
    const m = await this.meta();
    const url = new URL(m.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: this.g.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: b64url(createHash('sha256').update(pending.verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
      ...(this.g.allowedDomains.length === 1 ? { hd: this.g.allowedDomains[0]! } : {}),
    }).toString();
    return { url: url.toString(), cookie: encrypt(this.config.dataKey, JSON.stringify(pending), 'oidc') };
  }

  /** Step 2: the provider sent the browser back. Returns a session, or a two-factor challenge. */
  async callback(
    query: { code?: string; state?: string; error?: string },
    sealed: string | undefined,
    client: ClientInfo,
  ): Promise<{ next: string | null } & ({ user: UserDto; token: string } | { mfaToken: string })> {
    let pending: Pending;
    try {
      pending = JSON.parse(decrypt(this.config.dataKey, sealed ?? '', 'oidc').toString()) as Pending;
    } catch {
      throw new GoogleSignInError('google_expired', 'missing or unreadable state cookie');
    }
    if (pending.exp < Date.now()) throw new GoogleSignInError('google_expired', 'attempt expired');
    if (!query.state || !sameString(query.state, pending.state)) throw new GoogleSignInError('google_expired', 'state mismatch');
    if (query.error) throw new GoogleSignInError('google_cancelled', `provider error ${query.error.slice(0, 50)}`);
    if (!query.code) throw new GoogleSignInError('google_failed', 'no code');

    const m = await this.meta();
    const tokens = await this.fetchJson<{ id_token?: string }>(m.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: this.redirectUri,
        client_id: this.g.clientId,
        client_secret: this.g.clientSecret,
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (!tokens.id_token) throw new GoogleSignInError('google_failed', 'no id_token');
    const claims = await this.verifyIdToken(tokens.id_token, pending.nonce, m.issuer);

    const email = claims.email.toLowerCase();
    if (claims.email_verified !== true) throw new GoogleSignInError('google_unverified', 'email not verified by provider');
    if (this.g.allowedDomains.length) {
      const domain = email.split('@')[1] ?? '';
      if (!this.g.allowedDomains.includes(domain) && !(claims.hd && this.g.allowedDomains.includes(claims.hd.toLowerCase()))) {
        throw new GoogleSignInError('google_domain', `domain ${domain} not allowed`);
      }
    }

    const user = await this.resolveUser(claims.sub, email, (claims.name ?? '').trim() || email.split('@')[0]!, client);
    if (user.mfaEnabledAt) return { next: pending.next, mfaToken: await this.auth.startMfaChallenge(user.id, client) };
    const token = await this.auth.createSession(user.id, client);
    await this.audit.recordSafely({ actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, data: { via: 'google' }, client });
    return { next: pending.next, user: toUserDto(user), token };
  }

  /** Verifies an RS256 ID token against the provider's published keys and the expected claims. */
  async verifyIdToken(idToken: string, nonce: string, issuer: string) {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new GoogleSignInError('google_failed', 'malformed id_token');
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: { iss?: string; aud?: string | string[]; azp?: string; exp?: number; iat?: number; nonce?: string; sub?: string; email?: string; email_verified?: boolean | string; name?: string; hd?: string };
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString());
      claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    } catch {
      throw new GoogleSignInError('google_failed', 'undecodable id_token');
    }
    if (header.alg !== 'RS256' || !header.kid) throw new GoogleSignInError('google_failed', `unexpected alg ${header.alg}`);
    const jwk = await this.key(header.kid);
    if (!jwk) throw new GoogleSignInError('google_failed', 'unknown signing key');
    const ok = verifySig('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
    if (!ok) throw new GoogleSignInError('google_failed', 'bad signature');

    const now = Math.floor(Date.now() / 1000);
    // Google documents both forms of its issuer.
    const issuers = issuer === 'https://accounts.google.com' ? [issuer, 'accounts.google.com'] : [issuer];
    if (!claims.iss || !issuers.includes(claims.iss)) throw new GoogleSignInError('google_failed', 'wrong issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.g.clientId) || (aud.length > 1 && claims.azp !== this.g.clientId)) throw new GoogleSignInError('google_failed', 'wrong audience');
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new GoogleSignInError('google_expired', 'id_token expired');
    if (typeof claims.iat === 'number' && claims.iat > now + 300) throw new GoogleSignInError('google_failed', 'id_token from the future');
    if (!claims.nonce || !sameString(claims.nonce, nonce)) throw new GoogleSignInError('google_failed', 'nonce mismatch');
    if (!claims.sub || !claims.email) throw new GoogleSignInError('google_failed', 'missing subject or email');
    return { ...claims, sub: claims.sub, email: claims.email, email_verified: claims.email_verified === true || claims.email_verified === 'true' };
  }

  private async resolveUser(subject: string, email: string, name: string, client: ClientInfo) {
    return this.dbs.runAsSystem(async () => {
      const db = this.dbs.db;
      const [linked] = await db
        .select({ user: users })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.provider, 'google'), eq(userIdentities.subject, subject)))
        .limit(1);
      if (linked) {
        if (linked.user.deletedAt) throw new GoogleSignInError('google_not_allowed', 'account deleted');
        await db.update(userIdentities).set({ lastUsedAt: new Date(), email }).where(and(eq(userIdentities.provider, 'google'), eq(userIdentities.subject, subject)));
        return linked.user;
      }

      const existing = await db.query.users.findFirst({ where: and(eq(users.email, email), isNull(users.deletedAt)) });
      if (existing) {
        if (!existing.emailVerifiedAt) {
          // The password on an unconfirmed account was set by someone who never proved they own this address.
          await db.update(users).set({ emailVerifiedAt: new Date(), passwordHash: '!' }).where(eq(users.id, existing.id));
          await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, existing.id), isNull(sessions.revokedAt)));
          existing.emailVerifiedAt = new Date();
        }
        await db.insert(userIdentities).values({ userId: existing.id, provider: 'google', subject, email, lastUsedAt: new Date() });
        await this.audit.recordSafely({ actorId: existing.id, action: 'auth.identity_linked', targetType: 'user', targetId: existing.id, data: { provider: 'google' }, client });
        return existing;
      }

      if (!(await this.auth.signupAllowed(email))) {
        await this.audit.recordSafely({ action: 'auth.register_blocked', data: { reason: 'invite_only', via: 'google' }, client });
        throw new GoogleSignInError('google_not_allowed', 'invite only');
      }
      const user = await this.auth.createAccount({ email, name: name.slice(0, 200), passwordHash: '!', emailVerifiedAt: new Date(), via: 'google' }, client);
      await db.insert(userIdentities).values({ userId: user.id, provider: 'google', subject, email, lastUsedAt: new Date() });
      return user;
    });
  }

  logFailure(err: GoogleSignInError | Error) {
    this.logger.warn(JSON.stringify({ msg: 'google_sign_in_failed', code: err instanceof GoogleSignInError ? err.code : 'google_failed', detail: err.message.slice(0, 200) }));
  }
}
