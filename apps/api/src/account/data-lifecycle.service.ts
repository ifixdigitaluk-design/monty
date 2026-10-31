import { gunzipSync, gzipSync } from 'node:zlib';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import { and, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { canInOrg } from '@monty/domain';
import { dataExports, organisationMemberships, organisations, users, userTokens } from '@monty/database';
import type { CreatedDataExportDto, DataExportDto, DeletionBlockerDto, PendingOrganisationDeletionDto } from '@monty/validation';
import { AuditService, ClientInfo } from '../audit/audit.service';
import { hashToken, newSecret } from '../auth/crypto';
import { decrypt, encrypt } from '../common/encryption';
import { AppException, badRequest, conflict, forbidden, notFound } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { MailService } from '../mail/mail.service';
import { accountDeletionEmail, organisationDeletionEmail } from '../mail/templates';

/** See docs/DATA_LIFECYCLE.md for the rules these constants implement. */
export const LIFECYCLE = {
  exportTtlMs: 24 * 3_600_000,
  exportCooldownMs: 10 * 60_000,
  deletionTokenTtlMs: 3_600_000,
  organisationGraceDays: 30,
} as const;

const wrongPassword = () => new AppException(403, 'FORBIDDEN', 'That password is not correct.');
const invalidLink = () => new AppException(400, 'VALIDATION_FAILED', 'This link is invalid or has expired. Request a new one from Settings.');

/**
 * Personal data export, account deletion and organisation deletion.
 *
 * Authenticated requests already run in the caller's RLS transaction, so everything read for an export is limited to
 * what the user can see. Cross-organisation erasure steps run with the system context inside the same transaction:
 * either the whole deletion happens or none of it does.
 */
@Injectable()
export class DataLifecycleService {
  private readonly logger = new Logger('DataLifecycle');

  constructor(
    private readonly dbs: DbService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private async requirePassword(userId: string, password: string) {
    const user = await this.dbs.db.query.users.findFirst({ where: and(eq(users.id, userId), isNull(users.deletedAt)) });
    if (!user) throw notFound('Account');
    const ok = await verify(user.passwordHash, password).catch(() => false);
    if (!ok) throw wrongPassword();
    return user;
  }

  // ======================= exports =======================

  async listExports(userId: string): Promise<DataExportDto[]> {
    const rows = await this.dbs.db
      .select()
      .from(dataExports)
      .where(and(eq(dataExports.userId, userId), gt(dataExports.expiresAt, new Date())))
      .orderBy(desc(dataExports.createdAt));
    return rows.map((r) => this.exportDto(r));
  }

  private exportDto(r: typeof dataExports.$inferSelect): DataExportDto {
    return { id: r.id, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(), sizeBytes: r.sizeBytes, downloadedAt: r.downloadedAt?.toISOString() ?? null };
  }

  async createExport(userId: string, client: ClientInfo): Promise<CreatedDataExportDto> {
    const [recent] = await this.dbs.db
      .select({ createdAt: dataExports.createdAt })
      .from(dataExports)
      .where(and(eq(dataExports.userId, userId), gt(dataExports.createdAt, new Date(Date.now() - LIFECYCLE.exportCooldownMs))))
      .limit(1);
    if (recent) throw new AppException(429, 'RATE_LIMITED', 'You created an export a few minutes ago. Download that one, or try again in 10 minutes.');

    const data = await this.collect(userId);
    const json = JSON.stringify(data, null, 2);
    const id = crypto.randomUUID();
    const token = newSecret();
    const content = encrypt(this.config.dataKey, gzipSync(json), id);
    const [row] = await this.dbs.db
      .insert(dataExports)
      .values({ id, userId, content, sizeBytes: Buffer.byteLength(json), downloadTokenHash: hashToken(token), expiresAt: new Date(Date.now() + LIFECYCLE.exportTtlMs) })
      .returning();
    await this.audit.record({ actorId: userId, action: 'account.export_created', targetType: 'data_export', targetId: id, data: { sizeBytes: row!.sizeBytes }, client });
    return { ...this.exportDto(row!), downloadPath: `/api/v1/me/exports/${id}/download?token=${token}` };
  }

  /** Requires the owner's session AND the one-time token; returns the JSON document. */
  async download(userId: string, exportId: string, token: string, client: ClientInfo): Promise<{ filename: string; body: Buffer }> {
    const row = await this.dbs.db.query.dataExports.findFirst({ where: and(eq(dataExports.id, exportId), eq(dataExports.userId, userId)) });
    if (!row || row.downloadTokenHash !== hashToken(token)) throw notFound('Export');
    if (row.expiresAt.getTime() <= Date.now()) throw new AppException(410, 'NOT_FOUND', 'This export has expired. Create a new one from Settings.');
    const body = gunzipSync(decrypt(this.config.dataKey, row.content, row.id));
    await this.dbs.db.update(dataExports).set({ downloadedAt: new Date() }).where(eq(dataExports.id, row.id));
    await this.audit.record({ actorId: userId, action: 'account.export_downloaded', targetType: 'data_export', targetId: row.id, client });
    return { filename: `monty-export-${row.createdAt.toISOString().slice(0, 10)}.json`, body };
  }

  /** Everything about the user that the user can see, plus their own security records. Read under the user's RLS context. */
  private async collect(userId: string) {
    const q = <T>(query: ReturnType<typeof sql>) => this.dbs.db.execute<T & Record<string, unknown>>(query).then((r) => r.rows);
    const [user] = await q(sql`select id, email, name, email_verified_at, created_at from users where id = ${userId}`);
    const sessions = await q(sql`select created_at, last_seen_at, expires_at, revoked_at, ip, user_agent from sessions where user_id = ${userId} order by created_at`);
    const organisations = await q(sql`
      select o.id, o.name, o.kind, m.role, m.created_at as joined_at from organisation_memberships m
      join organisations o on o.id = m.organisation_id where m.user_id = ${userId} order by m.created_at`);
    const workspaceMemberships = await q(sql`
      select w.id, w.name, wm.role from workspace_memberships wm join workspaces w on w.id = wm.workspace_id where wm.user_id = ${userId}`);
    const tasks = await q(sql`
      select t.id, t.project_id, t.title, t.description, t.status, t.priority, t.due_date, t.created_at,
             (t.creator_id = ${userId}) as created_by_you, (t.assignee_id = ${userId}) as assigned_to_you
      from tasks t where (t.creator_id = ${userId} or t.assignee_id = ${userId}) and t.deleted_at is null order by t.created_at`);
    const projects = await q(sql`select id, name, objective, description, created_at from projects where created_by_id = ${userId} and deleted_at is null`);
    const comments = await q(sql`select id, project_id, task_id, body, created_at, edited_at from comments where author_id = ${userId} and deleted_at is null order by created_at`);
    const documents = await q(sql`select id, title, body, created_at, updated_at from documents where created_by_id = ${userId} and deleted_at is null`);
    const messages = await q(sql`
      select m.id, c.name as channel, c.kind as channel_kind, m.parent_id, m.body, m.created_at, m.edited_at
      from messages m join channels c on c.id = m.channel_id where m.author_id = ${userId} and m.deleted_at is null order by m.created_at`);
    const databaseRows = await q(sql`
      select r.id, d.name as database, r.title, r.values, r.body, r.created_at, r.updated_at
      from database_rows r join databases d on d.id = r.database_id
      where r.created_by_id = ${userId} and r.deleted_at is null and d.deleted_at is null order by r.created_at`);
    const notifications = await q(sql`select type, entity_type, data, created_at, read_at from notifications where user_id = ${userId} order by created_at`);
    const aiRequests = await q(sql`select id, project_id, status, provider, input, created_at from ai_proposals where requested_by_id = ${userId}`);
    const automations = await q(sql`select id, name, trigger, conditions, actions, enabled, created_at from automation_rules where created_by_id = ${userId} and deleted_at is null`);
    // Account-level security events (sign-ins etc.) have no organisation, so RLS hides them: read only this user's.
    const securityLog = await this.dbs.runAsSystem(() =>
      q(sql`select action, target_type, created_at, ip, user_agent from audit_logs where actor_id = ${userId} order by created_at`),
    );
    return {
      format: 'monty-personal-data-export/v1',
      generatedAt: new Date().toISOString(),
      note:
        'Your account and the content you created or were assigned in organisations you still belong to. Content other people created, and organisations you have left, are not included.',
      account: user,
      sessions,
      organisations,
      workspaceMemberships,
      projectsCreated: projects,
      tasks,
      comments,
      documentsCreated: documents,
      chatMessages: messages,
      databaseRowsCreated: databaseRows,
      notifications,
      aiRequests,
      automations,
      securityLog,
    };
  }

  // ======================= account deletion =======================

  /** Team organisations the user alone owns and that have other members: ownership must be transferred first. */
  async deletionBlockers(userId: string): Promise<DeletionBlockerDto[]> {
    return this.dbs.runAsSystem(async () => {
      const r = await this.dbs.db.execute<{ id: string; name: string; members: number }>(sql`
        select o.id, o.name, (select count(*)::int from organisation_memberships m2 where m2.organisation_id = o.id) as members
        from organisations o
        join organisation_memberships m on m.organisation_id = o.id and m.user_id = ${userId} and m.role = 'OWNER'
        where o.kind = 'TEAM' and o.deleted_at is null
          and not exists (select 1 from organisation_memberships m3 where m3.organisation_id = o.id and m3.role = 'OWNER' and m3.user_id <> ${userId})
          and exists (select 1 from organisation_memberships m4 where m4.organisation_id = o.id and m4.user_id <> ${userId})`);
      return r.rows.map((x) => ({ organisationId: x.id, name: x.name, memberCount: x.members }));
    });
  }

  private async assertNoBlockers(userId: string) {
    const blockers = await this.deletionBlockers(userId);
    if (blockers.length) {
      throw conflict(
        'CONFLICT',
        `You are the only owner of ${blockers.map((b) => `“${b.name}”`).join(', ')}. Make someone else an owner or delete ${blockers.length > 1 ? 'those organisations' : 'that organisation'} first.`,
        { blockers },
      );
    }
  }

  async requestAccountDeletion(userId: string, password: string, client: ClientInfo): Promise<{ emailQueued: boolean }> {
    const user = await this.requirePassword(userId, password);
    await this.assertNoBlockers(userId);
    await this.dbs.db.update(userTokens).set({ usedAt: new Date() }).where(and(eq(userTokens.userId, userId), eq(userTokens.purpose, 'ACCOUNT_DELETION'), isNull(userTokens.usedAt)));
    const token = newSecret();
    const expiresAt = new Date(Date.now() + LIFECYCLE.deletionTokenTtlMs);
    const [t] = await this.dbs.db
      .insert(userTokens)
      .values({ userId, purpose: 'ACCOUNT_DELETION', email: user.email, tokenHash: hashToken(token), expiresAt })
      .returning({ id: userTokens.id });
    const emailQueued = await this.mail.enqueue(
      accountDeletionEmail(user.email, user.name, this.mail.link(`/account/delete?token=${token}`)),
      { idempotencyKey: `account-deletion:${t!.id}`, userId, expiresAt },
    );
    await this.audit.record({ actorId: userId, action: 'account.deletion_requested', targetType: 'user', targetId: userId, client });
    return { emailQueued };
  }

  /**
   * Irreversibly erases the account. Requires the signed-in user AND the emailed token (proves inbox access, so a
   * stolen session alone cannot delete an account). Runs as one transaction.
   */
  async confirmAccountDeletion(userId: string, rawToken: string): Promise<{ erasedOrganisations: number }> {
    const [tok] = await this.dbs.db
      .select()
      .from(userTokens)
      .where(and(eq(userTokens.tokenHash, hashToken(rawToken)), eq(userTokens.purpose, 'ACCOUNT_DELETION')))
      .for('update');
    if (!tok || tok.userId !== userId || tok.usedAt || tok.expiresAt.getTime() <= Date.now()) throw invalidLink();
    const user = await this.dbs.db.query.users.findFirst({ where: and(eq(users.id, userId), isNull(users.deletedAt)) });
    if (!user || user.email !== tok.email) throw invalidLink();
    await this.assertNoBlockers(userId);

    return this.dbs.runAsSystem(async () => {
      const db = this.dbs.db;
      // 1. Organisations that would be left with nobody (personal org, team orgs where they are the only member): erase now.
      const solo = await db.execute<{ id: string }>(sql`
        select o.id from organisations o join organisation_memberships m on m.organisation_id = o.id and m.user_id = ${userId}
        where not exists (select 1 from organisation_memberships m2 where m2.organisation_id = o.id and m2.user_id <> ${userId})`);
      for (const o of solo.rows) await db.delete(organisations).where(eq(organisations.id, o.id));

      // 2. Leave every remaining organisation; their records stay with the organisation, attributed to "Deleted user".
      await db.execute(sql`update tasks set assignee_id = null, version = version + 1 where assignee_id = ${userId}`);
      await db.execute(sql`update automation_rules set enabled = false where created_by_id = ${userId}`);
      await db.execute(sql`delete from workspace_memberships where user_id = ${userId}`);
      await db.execute(sql`delete from channel_members where user_id = ${userId}`);
      await db.execute(sql`delete from message_reactions where user_id = ${userId}`);
      await db.execute(sql`delete from organisation_memberships where user_id = ${userId}`);
      await db.execute(sql`delete from notifications where user_id = ${userId}`);
      await db.execute(sql`delete from invitations where lower(email) = lower(${user.email}) and accepted_at is null`);

      // 3. Personal and security data.
      await db.execute(sql`delete from sessions where user_id = ${userId}`);
      await db.execute(sql`delete from user_tokens where user_id = ${userId}`);
      await db.execute(sql`delete from login_challenges where user_id = ${userId}`);
      await db.execute(sql`delete from mfa_recovery_codes where user_id = ${userId}`);
      await db.execute(sql`delete from data_exports where user_id = ${userId}`);
      await db.execute(sql`delete from email_outbox where user_id = ${userId} or lower(to_address) = lower(${user.email})`);
      // Account-level security events (sign-ins, resets…) are deleted; organisation audit entries keep the action and
      // the pseudonymous user id (organisations need to know what happened) but lose IP, user agent and email.
      await db.execute(sql`delete from audit_logs where organisation_id is null and actor_id = ${userId}`);
      await db.execute(sql`update audit_logs set ip = null, user_agent = null where actor_id = ${userId}`);
      await db.execute(sql`
        update audit_logs set data = jsonb_set(data, '{email}', '"[erased]"')
        where data ? 'email' and lower(data->>'email') = lower(${user.email})`);

      // 4. The user row stays as a tombstone so foreign keys (authorship) remain valid; nothing identifying is kept.
      await db
        .update(users)
        .set({ email: `deleted-${userId}@deleted.invalid`, name: 'Deleted user', passwordHash: '!', emailVerifiedAt: null, mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null, deletedAt: new Date() })
        .where(eq(users.id, userId));
      await this.audit.record({ actorId: userId, action: 'account.deleted', targetType: 'user', targetId: userId, data: { erasedOrganisations: solo.rows.length } });
      this.logger.log(JSON.stringify({ msg: 'account_deleted', erasedOrganisations: solo.rows.length }));
      return { erasedOrganisations: solo.rows.length };
    });
  }

  // ======================= organisations =======================

  private async membership(userId: string, organisationId: string) {
    const [row] = await this.dbs.db
      .select({ role: organisationMemberships.role, org: organisations })
      .from(organisationMemberships)
      .innerJoin(organisations, eq(organisations.id, organisationMemberships.organisationId))
      .where(and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, userId)));
    return row ?? null;
  }

  async rename(userId: string, organisationId: string, name: string, client: ClientInfo) {
    const m = await this.membership(userId, organisationId);
    if (!m || m.org.deletedAt) throw notFound('Organisation');
    if (!canInOrg(m.role, 'org.manage')) throw forbidden();
    const trimmed = name.trim();
    await this.dbs.db.update(organisations).set({ name: trimmed }).where(eq(organisations.id, organisationId));
    await this.audit.record({ organisationId, actorId: userId, action: 'organisation.renamed', targetType: 'organisation', targetId: organisationId, data: { from: m.org.name, to: trimmed }, client });
    return { id: organisationId, name: trimmed };
  }

  /** Owner-only; team organisations only. Hidden immediately, erased after the grace period unless restored. */
  async scheduleDeletion(userId: string, organisationId: string, confirmName: string, password: string, client: ClientInfo): Promise<PendingOrganisationDeletionDto> {
    const m = await this.membership(userId, organisationId);
    if (!m || m.org.deletedAt) throw notFound('Organisation');
    if (m.role !== 'OWNER') throw forbidden('Only an owner can delete an organisation.');
    if (m.org.kind === 'PERSONAL') throw badRequest('Your personal workspace is deleted together with your account (Settings → Delete account).');
    if (confirmName.trim() !== m.org.name) throw badRequest('Type the organisation name exactly to confirm.', [{ path: 'confirmName', message: 'Does not match' }]);
    const actor = await this.requirePassword(userId, password);
    const deletedAt = new Date();
    const purgeAfter = new Date(deletedAt.getTime() + LIFECYCLE.organisationGraceDays * 86_400_000);
    const members = await this.dbs.db
      .select({ id: users.id, email: users.email })
      .from(organisationMemberships)
      .innerJoin(users, eq(users.id, organisationMemberships.userId))
      .where(and(eq(organisationMemberships.organisationId, organisationId), isNull(users.deletedAt)));
    await this.dbs.db.update(organisations).set({ deletedAt, purgeAfter, deletionRequestedById: userId }).where(eq(organisations.id, organisationId));
    await this.audit.record({ organisationId, actorId: userId, action: 'organisation.deletion_scheduled', targetType: 'organisation', targetId: organisationId, data: { purgeAfter: purgeAfter.toISOString(), members: members.length }, client });
    const date = purgeAfter.toISOString().slice(0, 10);
    for (const member of members) {
      await this.mail.enqueue(organisationDeletionEmail(member.email, m.org.name, actor.name, date, this.mail.link('/home')), {
        idempotencyKey: `org-deletion:${organisationId}:${deletedAt.getTime()}:${member.id}`,
        userId: member.id,
      });
    }
    return { id: organisationId, name: m.org.name, deletedAt: deletedAt.toISOString(), purgeAfter: purgeAfter.toISOString() };
  }

  async pendingDeletions(userId: string): Promise<PendingOrganisationDeletionDto[]> {
    const rows = await this.dbs.db
      .select({ org: organisations })
      .from(organisationMemberships)
      .innerJoin(organisations, eq(organisations.id, organisationMemberships.organisationId))
      .where(and(eq(organisationMemberships.userId, userId), eq(organisationMemberships.role, 'OWNER'), isNotNull(organisations.deletedAt), gt(organisations.purgeAfter, new Date())));
    return rows.map(({ org }) => ({ id: org.id, name: org.name, deletedAt: org.deletedAt!.toISOString(), purgeAfter: org.purgeAfter!.toISOString() }));
  }

  async restore(userId: string, organisationId: string, client: ClientInfo) {
    const m = await this.membership(userId, organisationId);
    if (!m || !m.org.deletedAt || !m.org.purgeAfter || m.org.purgeAfter.getTime() <= Date.now()) throw notFound('Organisation');
    if (m.role !== 'OWNER') throw forbidden('Only an owner can restore an organisation.');
    await this.dbs.db.update(organisations).set({ deletedAt: null, purgeAfter: null, deletionRequestedById: null }).where(eq(organisations.id, organisationId));
    await this.audit.record({ organisationId, actorId: userId, action: 'organisation.restored', targetType: 'organisation', targetId: organisationId, client });
  }

  /** Maintenance: permanently erases organisations whose grace period has ended (cascades to all their data). */
  async purgeDueOrganisations(): Promise<number> {
    return this.dbs.runAsSystem(async () => {
      const due = await this.dbs.db
        .select({ id: organisations.id })
        .from(organisations)
        .where(and(isNotNull(organisations.deletedAt), isNotNull(organisations.purgeAfter), lt(organisations.purgeAfter, new Date())))
        .limit(20);
      for (const o of due) {
        await this.dbs.allowLongStatements(300_000);
        await this.dbs.db.delete(organisations).where(eq(organisations.id, o.id));
        // The organisation's own audit trail is erased with it; keep a content-free record that the purge happened.
        await this.audit.record({ action: 'organisation.purged', targetType: 'organisation', targetId: o.id });
      }
      if (due.length) this.logger.log(JSON.stringify({ msg: 'organisations_purged', count: due.length }));
      return due.length;
    });
  }
}
