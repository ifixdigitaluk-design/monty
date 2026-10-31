import { Inject, Injectable } from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import { loginChallenges, mfaRecoveryCodes, users } from '@monty/database';
import type { MfaSetupDto, MfaStatusDto, UserDto } from '@monty/validation';
import { AuditService, ClientInfo } from '../audit/audit.service';
import { decrypt, encrypt } from '../common/encryption';
import { AppException, badRequest, conflict, notFound } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { AuthService, toUserDto } from './auth.service';
import { hashToken } from './crypto';
import { newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from './totp';

const MAX_CHALLENGE_ATTEMPTS = 5;
const wrongPassword = () => new AppException(403, 'FORBIDDEN', 'That password is not correct.');
const wrongCode = () => new AppException(401, 'MFA_INVALID', 'That code is not correct or has already been used.');

/**
 * Two-factor authentication (TOTP authenticator apps + single-use recovery codes).
 * Secrets are encrypted at rest; recovery codes are stored hashed; each TOTP step is accepted once.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly dbs: DbService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private async user(userId: string) {
    const u = await this.dbs.db.query.users.findFirst({ where: and(eq(users.id, userId), isNull(users.deletedAt)) });
    if (!u) throw notFound('User');
    return u;
  }
  private secretOf(u: typeof users.$inferSelect) {
    return decrypt(this.config.dataKey, u.mfaSecret!, `mfa:${u.id}`).toString();
  }

  async status(userId: string): Promise<MfaStatusDto> {
    const u = await this.user(userId);
    const [r] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
    return { enabled: !!u.mfaEnabledAt, enabledAt: u.mfaEnabledAt?.toISOString() ?? null, recoveryCodesRemaining: u.mfaEnabledAt ? (r?.n ?? 0) : 0 };
  }

  /** Step 1: password re-check, new secret (not active until confirmed with a code). */
  async setup(userId: string, password: string): Promise<MfaSetupDto> {
    const u = await this.user(userId);
    if (!(await verify(u.passwordHash, password).catch(() => false))) throw wrongPassword();
    if (u.mfaEnabledAt) throw conflict('CONFLICT', 'Two-factor authentication is already on. Turn it off first to set up a new device.');
    const secret = newTotpSecret();
    await this.dbs.db.update(users).set({ mfaSecret: encrypt(this.config.dataKey, secret, `mfa:${u.id}`), mfaLastStep: null }).where(eq(users.id, u.id));
    const url = otpauthUrl(secret, u.email);
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret, otpauthUrl: url, qrSvgDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  }

  /** Step 2: a valid code proves the app is set up. Returns recovery codes (shown once). */
  async enable(userId: string, code: string, client: ClientInfo): Promise<{ recoveryCodes: string[] }> {
    const u = await this.user(userId);
    if (u.mfaEnabledAt) throw conflict('CONFLICT', 'Two-factor authentication is already on.');
    if (!u.mfaSecret) throw badRequest('Start the setup first.');
    const step = verifyTotp(this.secretOf(u), code, u.mfaLastStep);
    if (step === null) throw wrongCode();
    const codes = newRecoveryCodes();
    await this.dbs.db.update(users).set({ mfaEnabledAt: new Date(), mfaLastStep: step }).where(eq(users.id, u.id));
    await this.dbs.db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, u.id));
    await this.dbs.db.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId: u.id, codeHash: hashToken(c.replace(/-/g, '')) })));
    await this.audit.record({ actorId: u.id, action: 'auth.mfa_enabled', targetType: 'user', targetId: u.id, client });
    return { recoveryCodes: codes };
  }

  /** Checks a TOTP code or consumes a recovery code. Updates replay protection. */
  private async checkSecondFactor(u: typeof users.$inferSelect, code?: string, recoveryCode?: string): Promise<'totp' | 'recovery' | null> {
    if (code) {
      const step = verifyTotp(this.secretOf(u), code, u.mfaLastStep);
      if (step === null) return null;
      // Conditional update: two concurrent requests with the same code can't both win.
      const res = await this.dbs.db
        .update(users)
        .set({ mfaLastStep: step })
        .where(and(eq(users.id, u.id), sql`coalesce(${users.mfaLastStep}, -1) < ${step}`))
        .returning({ id: users.id });
      return res.length ? 'totp' : null;
    }
    if (recoveryCode) {
      const res = await this.dbs.db
        .update(mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(mfaRecoveryCodes.userId, u.id), eq(mfaRecoveryCodes.codeHash, hashToken(recoveryCode)), isNull(mfaRecoveryCodes.usedAt)))
        .returning({ id: mfaRecoveryCodes.id });
      return res.length ? 'recovery' : null;
    }
    return null;
  }

  async disable(userId: string, password: string, code: string | undefined, recoveryCode: string | undefined, client: ClientInfo) {
    const u = await this.user(userId);
    if (!(await verify(u.passwordHash, password).catch(() => false))) throw wrongPassword();
    if (!u.mfaEnabledAt) return;
    if (!(await this.checkSecondFactor(u, code, recoveryCode))) throw wrongCode();
    await this.dbs.db.update(users).set({ mfaEnabledAt: null, mfaSecret: null, mfaLastStep: null }).where(eq(users.id, u.id));
    await this.dbs.db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, u.id));
    await this.audit.record({ actorId: u.id, action: 'auth.mfa_disabled', targetType: 'user', targetId: u.id, client });
  }

  async regenerateRecoveryCodes(userId: string, code: string, client: ClientInfo): Promise<{ recoveryCodes: string[] }> {
    const u = await this.user(userId);
    if (!u.mfaEnabledAt) throw badRequest('Two-factor authentication is off.');
    if (!(await this.checkSecondFactor(u, code))) throw wrongCode();
    const codes = newRecoveryCodes();
    await this.dbs.db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, u.id));
    await this.dbs.db.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId: u.id, codeHash: hashToken(c.replace(/-/g, '')) })));
    await this.audit.record({ actorId: u.id, action: 'auth.mfa_recovery_regenerated', targetType: 'user', targetId: u.id, client });
    return { recoveryCodes: codes };
  }

  /** Second step of sign-in. The challenge expires after 5 minutes or 5 wrong attempts. */
  async completeLogin(mfaToken: string, code: string | undefined, recoveryCode: string | undefined, client: ClientInfo): Promise<{ user: UserDto; token: string }> {
    const [ch] = await this.dbs.db.select().from(loginChallenges).where(eq(loginChallenges.tokenHash, hashToken(mfaToken))).for('update');
    const expired = () => new AppException(401, 'UNAUTHENTICATED', 'This sign-in attempt expired. Enter your email and password again.');
    if (!ch || ch.usedAt || ch.expiresAt.getTime() <= Date.now() || ch.attempts >= MAX_CHALLENGE_ATTEMPTS) throw expired();
    const u = await this.user(ch.userId);
    const via = u.mfaEnabledAt ? await this.checkSecondFactor(u, code, recoveryCode) : null;
    if (!via) {
      await this.dbs.db.update(loginChallenges).set({ attempts: sql`${loginChallenges.attempts} + 1` }).where(eq(loginChallenges.id, ch.id));
      await this.audit.recordSafely({ actorId: u.id, action: 'auth.login_mfa_failed', targetType: 'user', targetId: u.id, client });
      throw wrongCode();
    }
    await this.dbs.db.update(loginChallenges).set({ usedAt: new Date() }).where(eq(loginChallenges.id, ch.id));
    const token = await this.auth.createSession(u.id, client);
    await this.audit.recordSafely({ actorId: u.id, action: 'auth.login', targetType: 'user', targetId: u.id, data: { mfa: via }, client });
    return { user: toUserDto(u), token };
  }
}
