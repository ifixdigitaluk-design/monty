import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import {
  isUniqueViolation,
  organisationMemberships,
  organisations,
  sessions,
  users,
  workspaceMemberships,
  workspaces,
} from '@monty/database';
import type { LoginInput, RegisterInput, SessionDto, UserDto } from '@monty/validation';
import { AppConfig, CONFIG } from '../config';
import { AppException, conflict, notFound } from '../common/errors';
import { randomSuffix } from '../common/slug';
import { DbService } from '../db/db.service';

const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP baseline for Argon2id
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

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
  ) {}

  async onModuleInit() {
    // Used to equalise timing when an email does not exist.
    this.dummyHash = await hash(randomBytes(16).toString('hex'), ARGON_OPTS);
  }

  async register(input: RegisterInput, client: ClientInfo): Promise<{ user: UserDto; token: string }> {
    const passwordHash = await hash(input.password, ARGON_OPTS);
    let user;
    try {
      user = await this.dbs.db.transaction(async (tx) => {
        const [u] = await tx.insert(users).values({ email: input.email, name: input.name, passwordHash }).returning();
        const [org] = await tx
          .insert(organisations)
          .values({ name: `${input.name}'s space`, slug: `personal-${randomSuffix(6)}`, kind: 'PERSONAL', personalOwnerId: u!.id })
          .returning();
        await tx.insert(organisationMemberships).values({ organisationId: org!.id, userId: u!.id, role: 'OWNER' });
        const [ws] = await tx.insert(workspaces).values({ organisationId: org!.id, name: 'Personal', slug: 'personal' }).returning();
        await tx.insert(workspaceMemberships).values({ workspaceId: ws!.id, userId: u!.id, role: 'ADMIN' });
        return u!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
    const token = await this.createSession(user.id, client);
    return { user: toUserDto(user), token };
  }

  async login(input: LoginInput, client: ClientInfo): Promise<{ user: UserDto; token: string }> {
    const user = await this.dbs.db.query.users.findFirst({ where: eq(users.email, input.email) });
    const valid = await verify(user?.passwordHash ?? this.dummyHash, input.password);
    if (!user || user.deletedAt || !valid) {
      throw new AppException(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    const token = await this.createSession(user.id, client);
    return { user: toUserDto(user), token };
  }

  private async createSession(userId: string, client: ClientInfo): Promise<string> {
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

  async revoke(userId: string, sessionId: string): Promise<void> {
    const res = await this.dbs.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (res.length === 0) throw notFound('Session');
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

function toUserDto(u: { id: string; email: string; name: string }): UserDto {
  return { id: u.id, email: u.email, name: u.name };
}
