import { Injectable } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { DbOrTx, sessions, users, userTokens } from '@monty/database';
import type { ConfirmPasswordResetInput, RequestPasswordResetInput } from '@monty/validation';
import { AuditService, ClientInfo } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { DbService } from '../db/db.service';
import { MailService } from '../mail/mail.service';
import { passwordResetEmail, verifyEmailEmail } from '../mail/templates';
import { ARGON_OPTS, hashToken, newSecret } from './crypto';

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TTL_MS = 7 * 86_400_000; // 7 days

type Purpose = 'PASSWORD_RESET' | 'EMAIL_VERIFICATION';

const invalidLink = () => new AppException(400, 'VALIDATION_FAILED', 'This link is invalid or has expired. Request a new one.');

/**
 * Password reset and email verification.
 * - Responses never reveal whether an email address has an account.
 * - Tokens are 256-bit, stored hashed, single-use, short-lived, and bound to the email they were sent to.
 */
@Injectable()
export class AccountRecoveryService {
  constructor(
    private readonly dbs: DbService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  private async issue(db: DbOrTx, userId: string, email: string, purpose: Purpose, ttlMs: number): Promise<string> {
    // Only the newest link of each kind works.
    await db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(userTokens.userId, userId), eq(userTokens.purpose, purpose), isNull(userTokens.usedAt)));
    const token = newSecret();
    await db.insert(userTokens).values({ userId, purpose, email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) });
    return token;
  }

  /** Locks and validates a token inside the caller's transaction. */
  private async consume(tx: DbOrTx, rawToken: string, purpose: Purpose) {
    const [row] = await tx
      .select({ t: userTokens, user: users })
      .from(userTokens)
      .innerJoin(users, eq(users.id, userTokens.userId))
      .where(and(eq(userTokens.tokenHash, hashToken(rawToken)), eq(userTokens.purpose, purpose)))
      .limit(1)
      .for('update');
    if (!row || row.t.usedAt || row.t.expiresAt.getTime() <= Date.now() || row.user.deletedAt) throw invalidLink();
    // If the account email changed since the link was sent, the link no longer proves anything.
    if (row.user.email !== row.t.email) throw invalidLink();
    await tx.update(userTokens).set({ usedAt: new Date() }).where(eq(userTokens.id, row.t.id));
    return row;
  }

  // ---------- email verification ----------

  async sendVerification(userId: string): Promise<boolean> {
    const user = await this.dbs.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user || user.deletedAt || user.emailVerifiedAt) return false;
    const token = await this.issue(this.dbs.db, user.id, user.email, 'EMAIL_VERIFICATION', VERIFY_TTL_MS);
    return this.mail.send(verifyEmailEmail(user.email, user.name, this.mail.link(`/verify-email?token=${token}`)));
  }

  async verifyEmail(rawToken: string, client: ClientInfo): Promise<void> {
    await this.dbs.db.transaction(async (tx) => {
      const { user } = await this.consume(tx, rawToken, 'EMAIL_VERIFICATION');
      if (!user.emailVerifiedAt) await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
      await this.audit.record({ actorId: user.id, action: 'auth.email_verified', targetType: 'user', targetId: user.id, client }, tx);
    });
  }

  // ---------- password reset ----------

  /**
   * Always resolves the same way. When the account exists, issues a token and emails it.
   * The email is sent without awaiting so response time doesn't reveal whether the account exists.
   */
  async requestPasswordReset(input: RequestPasswordResetInput, client: ClientInfo): Promise<void> {
    const user = await this.dbs.db.query.users.findFirst({ where: eq(users.email, input.email) });
    if (!user || user.deletedAt) return;
    const token = await this.issue(this.dbs.db, user.id, user.email, 'PASSWORD_RESET', RESET_TTL_MS);
    await this.audit.recordSafely({ actorId: user.id, action: 'auth.password_reset_requested', targetType: 'user', targetId: user.id, client });
    void this.mail.send(passwordResetEmail(user.email, user.name, this.mail.link(`/reset-password?token=${token}`)));
  }

  /** Sets the new password, marks the email verified (the link proves inbox access) and signs out every session. */
  async confirmPasswordReset(input: ConfirmPasswordResetInput, client: ClientInfo): Promise<void> {
    const passwordHash = await hash(input.password, ARGON_OPTS);
    await this.dbs.db.transaction(async (tx) => {
      const { user } = await this.consume(tx, input.token, 'PASSWORD_RESET');
      await tx
        .update(users)
        .set({ passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date() })
        .where(eq(users.id, user.id));
      await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      await this.audit.record({ actorId: user.id, action: 'auth.password_reset', targetType: 'user', targetId: user.id, client }, tx);
    });
  }
}
