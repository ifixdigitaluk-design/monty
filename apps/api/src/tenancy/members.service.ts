import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import {
  canChangeRole,
  canInOrg,
  canInvite,
  canInWorkspace,
  canRemoveMember,
  effectiveWorkspaceRole,
  higherOrgRole,
  MembershipDecision,
  OrgRole,
  WorkspaceRole,
} from '@monty/domain';
import {
  DbOrTx,
  Invitation,
  invitations,
  isUniqueViolation,
  organisationMemberships,
  organisations,
  users,
  workspaceMemberships,
  workspaces,
} from '@monty/database';
import type {
  CreatedInvitationDto,
  CreateInvitationInput,
  InvitationDto,
  InvitationPreviewDto,
  InvitationStatus,
  OrgMemberDto,
  WorkspaceMemberDto,
} from '@monty/validation';
import { AuditService, ClientInfo } from '../audit/audit.service';
import { AppException, badRequest, conflict, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { AccessService } from './access.service';
import { MailService } from '../mail/mail.service';
import { invitationEmail } from '../mail/templates';
import { EntitlementsService } from '../billing/entitlements.service';

const INVITE_TTL_DAYS = 7;
const WS_RANK: Record<WorkspaceRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2 };
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

function enforce(decision: MembershipDecision): void {
  if (!decision.ok) throw forbidden(decision.reason);
}

function statusOf(i: Invitation, now = Date.now()): InvitationStatus {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (i.expiresAt.getTime() <= now) return 'expired';
  return 'pending';
}

@Injectable()
export class MembersService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ---------- helpers ----------

  /** The caller's role in a live organisation; 404 if they are not a member (no existence leak). */
  private async orgContext(userId: string, organisationId: string, db: DbOrTx = this.dbs.db) {
    const [row] = await db
      .select({ org: organisations, role: organisationMemberships.role })
      .from(organisationMemberships)
      .innerJoin(organisations, and(eq(organisations.id, organisationMemberships.organisationId), isNull(organisations.deletedAt)))
      .where(and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, userId)))
      .limit(1);
    if (!row) throw notFound('Organisation');
    return row;
  }

  /** Locks the organisation's membership rows so owner-count checks cannot race. */
  private async lockedMemberships(tx: DbOrTx, organisationId: string) {
    return tx
      .select({ userId: organisationMemberships.userId, role: organisationMemberships.role })
      .from(organisationMemberships)
      .where(eq(organisationMemberships.organisationId, organisationId))
      .for('update');
  }

  // ---------- members ----------

  async listMembers(userId: string, organisationId: string): Promise<OrgMemberDto[]> {
    const { role } = await this.orgContext(userId, organisationId);
    if (!canInOrg(role, 'org.read')) throw forbidden();
    const db = this.dbs.db;
    const members = await db
      .select({ m: organisationMemberships, u: users })
      .from(organisationMemberships)
      .innerJoin(users, and(eq(users.id, organisationMemberships.userId), isNull(users.deletedAt)))
      .where(eq(organisationMemberships.organisationId, organisationId))
      .orderBy(asc(users.name));
    const wsRows = await db
      .select({ userId: workspaceMemberships.userId, id: workspaces.id, name: workspaces.name, role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .innerJoin(workspaces, and(eq(workspaces.id, workspaceMemberships.workspaceId), isNull(workspaces.deletedAt)))
      .where(eq(workspaces.organisationId, organisationId))
      .orderBy(asc(workspaces.name));
    return members.map(({ m, u }) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
      workspaces: wsRows.filter((w) => w.userId === u.id).map(({ id, name, role }) => ({ id, name, role })),
    }));
  }

  async changeRole(actorId: string, organisationId: string, targetUserId: string, newRole: OrgRole, client: ClientInfo) {
    await this.dbs.db.transaction(async (tx) => {
      const { org } = await this.orgContext(actorId, organisationId, tx);
      if (org.kind === 'PERSONAL') throw badRequest('Personal organisations have a single owner.');
      const rows = await this.lockedMemberships(tx, organisationId);
      const actor = rows.find((r) => r.userId === actorId);
      const target = rows.find((r) => r.userId === targetUserId);
      if (!target) throw notFound('Member');
      if (target.role === newRole) return;
      enforce(
        canChangeRole({
          actorRole: actor?.role,
          targetCurrentRole: target.role,
          newRole,
          ownerCount: rows.filter((r) => r.role === 'OWNER').length,
        }),
      );
      await tx
        .update(organisationMemberships)
        .set({ role: newRole })
        .where(and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, targetUserId)));
      await this.audit.record(
        {
          organisationId,
          actorId,
          action: 'member.role_changed',
          targetType: 'user',
          targetId: targetUserId,
          data: { from: target.role, to: newRole },
          client,
        },
        tx,
      );
    });
  }

  async removeMember(actorId: string, organisationId: string, targetUserId: string, client: ClientInfo) {
    await this.dbs.db.transaction(async (tx) => {
      const { org } = await this.orgContext(actorId, organisationId, tx);
      if (org.kind === 'PERSONAL') throw badRequest('You cannot leave or remove members from a personal organisation.');
      const rows = await this.lockedMemberships(tx, organisationId);
      const actor = rows.find((r) => r.userId === actorId);
      const target = rows.find((r) => r.userId === targetUserId);
      if (!target) throw notFound('Member');
      const isSelf = actorId === targetUserId;
      enforce(
        canRemoveMember({
          actorRole: actor?.role,
          targetRole: target.role,
          isSelf,
          ownerCount: rows.filter((r) => r.role === 'OWNER').length,
        }),
      );
      // Audit first: once someone leaves, row-level security no longer lets them write rows for this organisation.
      await this.audit.record(
        {
          organisationId,
          actorId,
          action: isSelf ? 'member.left' : 'member.removed',
          targetType: 'user',
          targetId: targetUserId,
          data: { role: target.role },
          client,
        },
        tx,
      );
      const orgWorkspaceIds = tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.organisationId, organisationId));
      await tx
        .delete(workspaceMemberships)
        .where(and(eq(workspaceMemberships.userId, targetUserId), inArray(workspaceMemberships.workspaceId, orgWorkspaceIds)));
      await tx
        .delete(organisationMemberships)
        .where(and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, targetUserId)));
    });
  }

  // ---------- workspace access ----------

  async listWorkspaceMembers(userId: string, workspaceId: string): Promise<WorkspaceMemberDto[]> {
    const { workspace, role } = await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const canManage = canInWorkspace(role, 'workspace.manage');
    const rows = await this.dbs.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        orgRole: organisationMemberships.role,
        workspaceRole: workspaceMemberships.role,
      })
      .from(organisationMemberships)
      .innerJoin(users, and(eq(users.id, organisationMemberships.userId), isNull(users.deletedAt)))
      .leftJoin(
        workspaceMemberships,
        and(eq(workspaceMemberships.userId, organisationMemberships.userId), eq(workspaceMemberships.workspaceId, workspaceId)),
      )
      .where(eq(organisationMemberships.organisationId, workspace.organisationId))
      .orderBy(asc(users.name));
    return rows
      .map((r) => ({ ...r, effectiveRole: effectiveWorkspaceRole(r.orgRole, r.workspaceRole) }))
      // Only workspace admins see org members who don't have access yet (so they can grant it).
      .filter((r) => canManage || r.effectiveRole !== null);
  }

  async setWorkspaceMember(actorId: string, workspaceId: string, targetUserId: string, role: WorkspaceRole, client: ClientInfo) {
    const { workspace } = await this.access.requireWorkspace(actorId, workspaceId, 'workspace.manage');
    const [membership] = await this.dbs.db
      .select({ role: organisationMemberships.role })
      .from(organisationMemberships)
      .where(and(eq(organisationMemberships.organisationId, workspace.organisationId), eq(organisationMemberships.userId, targetUserId)))
      .limit(1);
    if (!membership) throw badRequest('Add this person to the organisation first (invite them).');
    await this.dbs.db.transaction(async (tx) => {
      await tx
        .insert(workspaceMemberships)
        .values({ workspaceId, userId: targetUserId, role })
        .onConflictDoUpdate({ target: [workspaceMemberships.workspaceId, workspaceMemberships.userId], set: { role } });
      await this.audit.record(
        {
          organisationId: workspace.organisationId,
          actorId,
          action: 'workspace_member.set',
          targetType: 'user',
          targetId: targetUserId,
          data: { workspaceId, workspaceName: workspace.name, role },
          client,
        },
        tx,
      );
    });
  }

  async removeWorkspaceMember(actorId: string, workspaceId: string, targetUserId: string, client: ClientInfo) {
    const { workspace } = await this.access.requireWorkspace(actorId, workspaceId, 'workspace.manage');
    await this.dbs.db.transaction(async (tx) => {
      const removed = await tx
        .delete(workspaceMemberships)
        .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, targetUserId)))
        .returning({ id: workspaceMemberships.id });
      if (removed.length === 0) throw notFound('Workspace member');
      await this.audit.record(
        {
          organisationId: workspace.organisationId,
          actorId,
          action: 'workspace_member.removed',
          targetType: 'user',
          targetId: targetUserId,
          data: { workspaceId, workspaceName: workspace.name },
          client,
        },
        tx,
      );
    });
  }

  // ---------- invitations ----------

  async createInvitation(actorId: string, organisationId: string, input: CreateInvitationInput, client: ClientInfo): Promise<CreatedInvitationDto> {
    const { org, role } = await this.orgContext(actorId, organisationId);
    enforce(canInvite(role, input.role));
    if (org.kind === 'PERSONAL') throw badRequest('Create a team organisation to invite people.');

    let workspaceName: string | null = null;
    if (input.workspaceId) {
      const [ws] = await this.dbs.db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.organisationId, organisationId), isNull(workspaces.deletedAt)))
        .limit(1);
      if (!ws) throw badRequest('That workspace is not in this organisation.', [{ path: 'workspaceId', message: 'Not found' }]);
      workspaceName = ws.name;
    }

    const [existingMember] = await this.dbs.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(
        organisationMemberships,
        and(eq(organisationMemberships.userId, users.id), eq(organisationMemberships.organisationId, organisationId)),
      )
      .where(eq(users.email, input.email))
      .limit(1);
    if (existingMember) throw conflict('CONFLICT', 'This person is already a member of the organisation.');
    await this.entitlements.assertWithinLimit(organisationId, 'members');

    const token = randomBytes(32).toString('base64url');
    try {
      const inv = await this.dbs.db.transaction(async (tx) => {
        // One open invitation per email: a still-valid one blocks; an expired one is closed so a fresh one can be sent.
        const [open] = await tx
          .select({ id: invitations.id, expiresAt: invitations.expiresAt })
          .from(invitations)
          .where(
            and(
              eq(invitations.organisationId, organisationId),
              eq(invitations.email, input.email),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .for('update');
        if (open && open.expiresAt.getTime() > Date.now()) {
          throw conflict('CONFLICT', 'An invitation for this email is already pending. Revoke it to send a new one.');
        }
        if (open) await tx.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, open.id));
        const [inv] = await tx
          .insert(invitations)
          .values({
            organisationId,
            email: input.email,
            role: input.role,
            workspaceId: input.workspaceId ?? null,
            workspaceRole: input.workspaceRole ?? null,
            tokenHash: hashToken(token),
            invitedById: actorId,
            expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
          })
          .returning();
        await this.audit.record(
          {
            organisationId,
            actorId,
            action: 'invitation.created',
            targetType: 'invitation',
            targetId: inv!.id,
            data: { email: input.email, role: input.role, workspaceId: input.workspaceId ?? null, workspaceRole: input.workspaceRole ?? null },
            client,
          },
          tx,
        );
        return inv!;
      });
      const [inviter] = await this.dbs.db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
      const invitePath = `/invite?token=${token}`;
      // Queued durably; `emailSent` now means "queued for delivery" (delivery is retried if the provider is down).
      const emailSent = await this.mail.enqueue(
        invitationEmail(input.email, inviter?.name ?? 'A teammate', org.name, input.role, this.mail.link(invitePath)),
        { idempotencyKey: `invite:${inv.id}`, expiresAt: inv.expiresAt },
      );
      return {
        ...this.toInvitationDto(inv, inviter?.name ?? '', workspaceName),
        invitePath,
        emailSent,
      };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('CONFLICT', 'An invitation for this email is already pending.');
      throw err;
    }
  }

  async listInvitations(actorId: string, organisationId: string): Promise<InvitationDto[]> {
    const { role } = await this.orgContext(actorId, organisationId);
    if (!canInOrg(role, 'org.manage')) throw forbidden();
    const rows = await this.dbs.db
      .select({ i: invitations, inviterName: users.name, workspaceName: workspaces.name })
      .from(invitations)
      .innerJoin(users, eq(users.id, invitations.invitedById))
      .leftJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .where(and(eq(invitations.organisationId, organisationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .orderBy(desc(invitations.createdAt));
    return rows.map((r) => this.toInvitationDto(r.i, r.inviterName, r.workspaceName));
  }

  async revokeInvitation(actorId: string, organisationId: string, invitationId: string, client: ClientInfo): Promise<void> {
    const { role } = await this.orgContext(actorId, organisationId);
    if (!canInOrg(role, 'org.manage')) throw forbidden();
    await this.dbs.db.transaction(async (tx) => {
      const res = await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.id, invitationId),
            eq(invitations.organisationId, organisationId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ email: invitations.email });
      if (res.length === 0) throw notFound('Invitation');
      await this.audit.record(
        { organisationId, actorId, action: 'invitation.revoked', targetType: 'invitation', targetId: invitationId, data: { email: res[0]!.email }, client },
        tx,
      );
    });
  }

  /** Public preview so the invitee can see what they are joining before signing in. */
  async previewInvitation(token: string): Promise<InvitationPreviewDto> {
    // System context: the caller is not (yet) a member, and possession of the secret token is the authorisation.
    const [row] = await this.dbs.runAsSystem(() => this.previewQuery(token));
    if (!row || row.orgDeleted) throw notFound('Invitation');
    return {
      organisationName: row.orgName,
      invitedByName: row.inviterName,
      email: row.i.email,
      role: row.i.role,
      workspaceName: row.workspaceName,
      status: statusOf(row.i),
    };
  }

  private previewQuery(token: string) {
    return this.dbs.db
      .select({ i: invitations, orgName: organisations.name, orgDeleted: organisations.deletedAt, inviterName: users.name, workspaceName: workspaces.name })
      .from(invitations)
      .innerJoin(organisations, eq(organisations.id, invitations.organisationId))
      .innerJoin(users, eq(users.id, invitations.invitedById))
      .leftJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .where(eq(invitations.tokenHash, hashToken(token)))
      .limit(1);
  }

  async acceptInvitation(userId: string, token: string, client: ClientInfo): Promise<{ organisationId: string; workspaceId: string | null }> {
    // System context: the invitee cannot see the organisation's rows until this succeeds; the token authorises it.
    return this.dbs.runAsSystem(() => this.dbs.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, hashToken(token))).limit(1).for('update');
      if (!inv) throw notFound('Invitation');
      const status = statusOf(inv);
      if (status !== 'pending') throw new AppException(410, 'CONFLICT', `This invitation is ${status}. Ask for a new one.`);
      const [org] = await tx.select().from(organisations).where(and(eq(organisations.id, inv.organisationId), isNull(organisations.deletedAt)));
      if (!org) throw notFound('Invitation');
      const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (!user || user.email !== inv.email) {
        throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that email address to accept it.`);
      }

      const [existing] = await tx
        .select({ role: organisationMemberships.role })
        .from(organisationMemberships)
        .where(and(eq(organisationMemberships.organisationId, inv.organisationId), eq(organisationMemberships.userId, userId)))
        .for('update');
      if (!existing) {
        await tx.insert(organisationMemberships).values({ organisationId: inv.organisationId, userId, role: inv.role });
      } else if (higherOrgRole(existing.role, inv.role) !== existing.role) {
        await tx
          .update(organisationMemberships)
          .set({ role: inv.role })
          .where(and(eq(organisationMemberships.organisationId, inv.organisationId), eq(organisationMemberships.userId, userId)));
      }

      let workspaceId: string | null = null;
      if (inv.workspaceId && inv.workspaceRole) {
        const [ws] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.id, inv.workspaceId), isNull(workspaces.deletedAt)));
        if (ws) {
          workspaceId = ws.id;
          const [wm] = await tx
            .select({ role: workspaceMemberships.role })
            .from(workspaceMemberships)
            .where(and(eq(workspaceMemberships.workspaceId, ws.id), eq(workspaceMemberships.userId, userId)));
          if (!wm) {
            await tx.insert(workspaceMemberships).values({ workspaceId: ws.id, userId, role: inv.workspaceRole });
          } else if (WS_RANK[inv.workspaceRole] > WS_RANK[wm.role]) {
            await tx
              .update(workspaceMemberships)
              .set({ role: inv.workspaceRole })
              .where(and(eq(workspaceMemberships.workspaceId, ws.id), eq(workspaceMemberships.userId, userId)));
          }
        }
      }

      await tx.update(invitations).set({ acceptedAt: new Date(), acceptedById: userId }).where(eq(invitations.id, inv.id));
      await this.audit.record(
        {
          organisationId: inv.organisationId,
          actorId: userId,
          action: 'invitation.accepted',
          targetType: 'invitation',
          targetId: inv.id,
          data: { role: inv.role, workspaceId, previousRole: existing?.role ?? null },
          client,
        },
        tx,
      );
      return { organisationId: inv.organisationId, workspaceId };
    }));
  }

  async usage(actorId: string, organisationId: string) {
    const { role } = await this.orgContext(actorId, organisationId);
    if (!canInOrg(role, 'org.read')) throw forbidden();
    return this.entitlements.summary(organisationId);
  }

  /** Owners choose the plan (no payment step: Monty runs as a self-hosted internal tool). */
  async setPlan(actorId: string, organisationId: string, plan: 'FREE' | 'PRO' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE', client: ClientInfo = {}) {
    const { role } = await this.orgContext(actorId, organisationId);
    if (role !== 'OWNER') throw forbidden('Only organisation owners can change the plan.');
    const [before] = await this.dbs.db.select({ plan: organisations.plan }).from(organisations).where(eq(organisations.id, organisationId));
    await this.dbs.db.update(organisations).set({ plan }).where(eq(organisations.id, organisationId));
    await this.audit.record({ organisationId, actorId, action: 'organisation.plan_changed', targetType: 'organisation', targetId: organisationId, data: { from: before?.plan, to: plan }, client });
    return this.entitlements.summary(organisationId);
  }

  async auditLog(actorId: string, organisationId: string) {
    const { role } = await this.orgContext(actorId, organisationId);
    if (!canInOrg(role, 'org.manage')) throw forbidden();
    return this.audit.listForOrganisation(organisationId);
  }

  private toInvitationDto(i: Invitation, inviterName: string, workspaceName: string | null): InvitationDto {
    return {
      id: i.id,
      email: i.email,
      role: i.role,
      workspaceId: i.workspaceId,
      workspaceName,
      workspaceRole: i.workspaceRole,
      invitedBy: { id: i.invitedById, name: inviterName },
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
      status: statusOf(i),
    };
  }
}
