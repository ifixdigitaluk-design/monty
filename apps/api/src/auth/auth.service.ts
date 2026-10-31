import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { MailService } from '../mail/mail.service';
import { accountExistsEmail, inviteOnlyEmail } from '../mail/templates';
import { randomBytes } from 'node:crypto';
import { ARGON_OPTS, hashToken } from './crypto';
import {
  invitations,
  isUniqueViolation,
  loginChallenges,
  organisationMemberships,
  organisations,
  sessions,
  users,
  workspaceMemberships,
  workspaces,
} from '@monty/database';
import type { LoginInput, RegisterInput, SessionDto, UserDto } from '@monty/validation';
import { AppConfig, CONFIG } from '../config';
import { AppException, notFound } from '../common/errors';
import { randomSuffix } from '../common/slug';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { AccountRecoveryService } from './account-recovery.service';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;
const MAX_FAILED_LOGINS = 10;



export interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = '';

  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly recovery: AccountRecoveryService,
    private readonly mail: MailService,
  ) {}

  async onModuleInit() {
    // Used to equalise timing when an email does not exist.
    this.dummyHash = await hash(randomBytes(16).toString('hex'), ARGON_OPTS);
  }

  /**
   * Sign-up never reveals whether an email already has an account: the response is always "check your email".
   * - New address (and allowed by SIGNUP_MODE): the account is created unverified and a confirmation link is emailed;
   *   following it confirms the address and signs the user in.
   * - Existing address: no new account; the owner is emailed a sign-in / reset link instead.
   * - Invite-only mode without a pending invitation: the address is told an invitation is needed.
   * Argon2 hashing runs on every path so timing is similar.
   */
  async register(input: RegisterInput, client: ClientInfo): Promise<void> {
    const passwordHash = await hash(input.password, ARGON_OPTS);
    const existing = await this.dbs.db.query.users.findFirst({ where: eq(users.email, input.email) });
    if (existing) return this.notifyExisting(existing, client);
    if (!(await this.signupAllowed(input.email))) {
      const day = new Date().toISOString().slice(0, 10);
      await this.mail.enqueue(inviteOnlyEmail(input.email, this.mail.link('/login')), { idempotencyKey: `invite-only:${input.email}:${day}` });
      await this.audit.recordSafely({ action: 'auth.register_blocked', data: { reason: 'invite_only' }, client: toClient(client) });
      return;
    }
    let user;
    try {
      user = await this.dbs.db.transaction(async (tx) => {
        const [u] = await tx.insert(users).values({ email: input.email, name: input.name, passwordHash }).returning();
        // Row-level security: act as the new user for the rest of sign-up.
        await this.dbs.setCurrentUser(tx, u!.id);
        const [org] = await tx
          .insert(organisations)
          .values({ name: `${input.name}'s space`, slug: `personal-${randomSuffix(6)}`, kind: 'PERSONAL', personalOwnerId: u!.id })
          .returning();
        await tx.insert(organisationMemberships).values({ organisationId: org!.id, userId: u!.id, role: 'OWNER' });
        const [ws] = await tx.insert(workspaces).values({ organisationId: org!.id, name: 'Personal', slug: 'personal' }).returning();
        await tx.insert(workspaceMemberships).values({ workspaceId: ws!.id, userId: u!.id, role: 'ADMIN' });
        await this.audit.record({ actorId: u!.id, action: 'auth.registered', targetType: 'user', targetId: u!.id, client: toClient(client) }, tx);
        return u!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost a race with a concurrent sign-up for the same address: same outcome as "already exists".
        const other = await this.dbs.db.query.users.findFirst({ where: eq(users.email, input.email) });
        if (other) return this.notifyExisting(other, client);
      }
      throw err;
    }
    await this.recovery.sendVerification(user.id, input.next);
  }

  private async notifyExisting(user: typeof users.$inferSelect, client: ClientInfo) {
    if (user.deletedAt) return;
    const hour = Math.floor(Date.now() / 3_600_000);
    await this.mail.enqueue(accountExistsEmail(user.email, user.name, this.mail.link('/login'), this.mail.link('/forgot-password')), {
      idempotencyKey: `account-exists:${user.id}:${hour}`,
      userId: user.id,
    });
    await this.audit.recordSafely({ actorId: user.id, action: 'auth.register_existing_email', targetType: 'user', targetId: user.id, client: toClient(client) });
  }

  private async signupAllowed(email: string): Promise<boolean> {
    if (this.config.signupMode === 'open') return true;
    return this.dbs.runAsSystem(async () => {
      const [anyUser] = await this.dbs.db.select({ id: users.id }).from(users).limit(1);
      if (!anyUser) return true; // bootstrap: the very first account
      const [inv] = await this.dbs.db
        .select({ id: invitations.id })
        .from(invitations)
        .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
        .limit(1);
      return !!inv;
    });
  }

  /**
   * Password sign-in. Accounts must have confirmed their email (unconfirmed ones get a fresh link, rate-limited).
   * Accounts with two-factor authentication get a short-lived challenge instead of a session.
   */
  async login(input: LoginInput, client: ClientInfo): Promise<{ user: UserDto; token: string } | { mfaToken: string }> {
    const user = await this.dbs.db.query.users.findFirst({ where: eq(users.email, input.email) });
    // Per-account brute-force protection (the IP rate limit doesn't stop distributed guessing).
    if (user && (await this.recentFailures(user.id)) >= MAX_FAILED_LOGINS) {
      throw new AppException(429, 'RATE_LIMITED', 'Too many sign-in attempts. Wait 15 minutes, or reset your password.');
    }
    const valid = await verify(user?.passwordHash && user.passwordHash !== '!' ? user.passwordHash : this.dummyHash, input.password).catch(() => false);
    if (!user || user.deletedAt || !valid) {
      await this.audit.recordSafely({
        actorId: user?.id ?? null,
        action: 'auth.login_failed',
        // Record the attempted email only when it belongs to a real account (avoid storing arbitrary input).
        data: user ? { email: user.email } : {},
        client: toClient(client),
      });
      throw new AppException(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (!user.emailVerifiedAt) {
      await this.recovery.sendVerification(user.id, undefined, { cooldown: true });
      throw new AppException(403, 'EMAIL_NOT_VERIFIED', 'Confirm your email address first. We’ve sent you a new link — it signs you in.');
    }
    if (user.mfaEnabledAt) {
      const mfaToken = randomBytes(32).toString('base64url');
      await this.dbs.db.insert(loginChallenges).values({ userId: user.id, tokenHash: hashToken(mfaToken), expiresAt: new Date(Date.now() + 5 * 60_000) });
      await this.audit.recordSafely({ actorId: user.id, action: 'auth.login_mfa_challenge', targetType: 'user', targetId: user.id, client: toClient(client) });
      return { mfaToken };
    }
    const token = await this.createSession(user.id, client);
    await this.audit.recordSafely({ actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, client: toClient(client) });
    return { user: toUserDto(user), token };
  }

  private async recentFailures(userId: string): Promise<number> {
    return this.dbs.runAsSystem(async () => {
      const r = await this.dbs.db.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_logs where actor_id = ${userId} and action in ('auth.login_failed', 'auth.login_mfa_failed') and created_at > now() - interval '15 minutes'
            and created_at > coalesce((select max(created_at) from audit_logs where actor_id = ${userId} and action in ('auth.login', 'auth.password_reset')), 'epoch')`,
      );
      return r.rows[0]?.n ?? 0;
    });
  }

  /** Signs in after the emailed confirmation link (not for accounts with two-factor authentication). */
  async sessionAfterVerification(userId: string, client: ClientInfo): Promise<{ user: UserDto; token: string }> {
    const user = await this.dbs.db.query.users.findFirst({ where: and(eq(users.id, userId), isNull(users.deletedAt)) });
    if (!user) throw notFound('User');
    const token = await this.createSession(user.id, client);
    await this.audit.recordSafely({ actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, data: { via: 'email_link' }, client: toClient(client) });
    return { user: toUserDto(user), token };
  }

  async createSession(userId: string, client: ClientInfo): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.dbs.db.insert(sessions).values({
      userId,
      tokenHash: hashToken(token),
      userAgent: client.userAgent?.slice(0, 300) ?? null,
      ip: client.ip ?? null,
      expiresAt: new Date(Date.now() + this.config.sessionTtlDays * DAY_MS),
    });
    return token;
  }

  /** Returns the active session for a raw token, extending it (sliding expiry) at most every 5 minutes. */
  async resolveSession(token: string): Promise<{ id: string; userId: string } | null> {
    if (token.length > 200) return null;
    const [row] = await this.dbs.db
      .select({ session: sessions, userDeletedAt: users.deletedAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1);
    const now = Date.now();
    if (!row || row.session.revokedAt || row.session.expiresAt.getTime() <= now || row.userDeletedAt) return null;
    if (now - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.dbs.db
        .update(sessions)
        .set({ lastSeenAt: new Date(now), expiresAt: new Date(now + this.config.sessionTtlDays * DAY_MS) })
        .where(eq(sessions.id, row.session.id));
    }
    return { id: row.session.id, userId: row.session.userId };
  }

  async me(userId: string): Promise<UserDto> {
    const user = await this.dbs.db.query.users.findFirst({ where: and(eq(users.id, userId), isNull(users.deletedAt)) });
    if (!user) throw notFound('User');
    return toUserDto(user);
  }

  async revoke(userId: string, sessionId: string, client: ClientInfo = {}, reason: 'logout' | 'revoke' = 'revoke'): Promise<void> {
    const res = await this.dbs.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (res.length === 0) throw notFound('Session');
    await this.audit.recordSafely({
      actorId: userId,
      action: reason === 'logout' ? 'auth.logout' : 'session.revoked',
      targetType: 'session',
      targetId: sessionId,
      client: toClient(client),
    });
  }

  async listSessions(userId: string, currentSessionId: string): Promise<SessionDto[]> {
    const rows = await this.dbs.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastSeenAt));
    return rows.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      current: s.id === currentSessionId,
    }));
  }
}

export function toUserDto(u: { id: string; email: string; name: string; emailVerifiedAt: Date | null; mfaEnabledAt?: Date | null }): UserDto {
  return { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerifiedAt !== null, mfaEnabled: !!u.mfaEnabledAt };
}

function toClient(c: ClientInfo) {
  return { ip: c.ip, userAgent: c.userAgent };
}
