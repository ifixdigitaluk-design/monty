import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { canInOrg, effectiveWorkspaceRole } from '@monty/domain';
import {
  DbOrTx,
  organisationMemberships,
  organisations,
  workspaceMemberships,
  workspaces,
} from '@monty/database';
import type { CreateOrganisationInput, CreateWorkspaceInput, OrganisationDto, WorkspaceSummaryDto } from '@monty/validation';
import { badRequest, forbidden, notFound } from '../common/errors';
import { randomSuffix, slugify } from '../common/slug';
import { AuditService, ClientInfo } from '../audit/audit.service';
import { DbService } from '../db/db.service';

@Injectable()
export class OrganisationsService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  async listForUser(userId: string): Promise<OrganisationDto[]> {
    const db = this.dbs.db;
    const memberships = await db
      .select({ org: organisations, role: organisationMemberships.role })
      .from(organisationMemberships)
      .innerJoin(organisations, and(eq(organisations.id, organisationMemberships.organisationId), isNull(organisations.deletedAt)))
      .where(eq(organisationMemberships.userId, userId));
    if (memberships.length === 0) return [];

    const orgIds = memberships.map((m) => m.org.id);
    // Sequential on purpose: inside a request transaction all queries share one connection (no parallel queries).
    const wsRows = await db
      .select()
      .from(workspaces)
      .where(and(inArray(workspaces.organisationId, orgIds), isNull(workspaces.deletedAt)))
      .orderBy(asc(workspaces.createdAt));
    const wsMemberships = await db.select().from(workspaceMemberships).where(eq(workspaceMemberships.userId, userId));
    const wsRole = new Map(wsMemberships.map((m) => [m.workspaceId, m.role]));

    return memberships
      .sort((a, b) =>
        a.org.kind === b.org.kind
          ? a.org.createdAt.getTime() - b.org.createdAt.getTime()
          : a.org.kind === 'PERSONAL'
            ? -1
            : 1,
      )
      .map((m) => {
        const list: WorkspaceSummaryDto[] = [];
        for (const w of wsRows) {
          if (w.organisationId !== m.org.id) continue;
          const role = effectiveWorkspaceRole(m.role, wsRole.get(w.id));
          if (role) list.push({ id: w.id, name: w.name, slug: w.slug, role });
        }
        return { id: m.org.id, name: m.org.name, slug: m.org.slug, kind: m.org.kind, role: m.role, workspaces: list };
      });
  }

  async create(userId: string, input: CreateOrganisationInput, client: ClientInfo = {}): Promise<OrganisationDto> {
    return this.dbs.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organisations)
        .values({ name: input.name, slug: `${slugify(input.name)}-${randomSuffix()}`, kind: 'TEAM' })
        .returning();
      await tx.insert(organisationMemberships).values({ organisationId: org!.id, userId, role: 'OWNER' });
      const ws = await this.createWorkspaceTx(tx, org!.id, 'General', userId);
      await this.audit.record(
        { organisationId: org!.id, actorId: userId, action: 'organisation.created', targetType: 'organisation', targetId: org!.id, data: { name: org!.name }, client },
        tx,
      );
      return {
        id: org!.id,
        name: org!.name,
        slug: org!.slug,
        kind: 'TEAM' as const,
        role: 'OWNER' as const,
        workspaces: [{ id: ws.id, name: ws.name, slug: ws.slug, role: 'ADMIN' as const }],
      };
    });
  }

  async createWorkspace(userId: string, organisationId: string, input: CreateWorkspaceInput, client: ClientInfo = {}): Promise<WorkspaceSummaryDto> {
    const [membership] = await this.dbs.db
      .select({ role: organisationMemberships.role })
      .from(organisationMemberships)
      .innerJoin(organisations, and(eq(organisations.id, organisationMemberships.organisationId), isNull(organisations.deletedAt)))
      .where(and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, userId)))
      .limit(1);
    if (!membership) throw notFound('Organisation');
    if (!canInOrg(membership.role, 'workspace.create')) throw forbidden('Only organisation owners and admins can create workspaces');
    const ws = await this.dbs.db.transaction(async (tx) => {
      const ws = await this.createWorkspaceTx(tx, organisationId, input.name, userId);
      await this.audit.record(
        { organisationId, actorId: userId, action: 'workspace.created', targetType: 'workspace', targetId: ws.id, data: { name: ws.name }, client },
        tx,
      );
      return ws;
    });
    return { id: ws.id, name: ws.name, slug: ws.slug, role: 'ADMIN' };
  }

  /** Owners and admins of the organisation manage its workspaces (departments). */
  private async manageableWorkspace(userId: string, workspaceId: string) {
    const [row] = await this.dbs.db
      .select({ ws: workspaces, role: organisationMemberships.role, kind: organisations.kind })
      .from(workspaces)
      .innerJoin(organisations, and(eq(organisations.id, workspaces.organisationId), isNull(organisations.deletedAt)))
      .innerJoin(organisationMemberships, and(eq(organisationMemberships.organisationId, workspaces.organisationId), eq(organisationMemberships.userId, userId)))
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      .limit(1);
    if (!row) throw notFound('Workspace');
    if (!canInOrg(row.role, 'workspace.create')) throw forbidden('Only organisation owners and admins can rename or delete workspaces');
    return row;
  }

  async renameWorkspace(userId: string, workspaceId: string, name: string, client: ClientInfo = {}): Promise<WorkspaceSummaryDto> {
    const { ws } = await this.manageableWorkspace(userId, workspaceId);
    await this.dbs.db.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId));
    await this.audit.record({ organisationId: ws.organisationId, actorId: userId, action: 'workspace.renamed', targetType: 'workspace', targetId: ws.id, data: { from: ws.name, to: name }, client });
    return { id: ws.id, name, slug: ws.slug, role: 'ADMIN' };
  }

  /** Hides the workspace and everything in it. An organisation always keeps at least one workspace. */
  async deleteWorkspace(userId: string, workspaceId: string, confirmName: string, client: ClientInfo = {}): Promise<void> {
    const { ws, kind } = await this.manageableWorkspace(userId, workspaceId);
    if (kind === 'PERSONAL') throw badRequest('Your personal workspace can’t be deleted.');
    if (confirmName.trim() !== ws.name) throw badRequest('Type the workspace name exactly to confirm.', [{ path: 'confirmName', message: 'Does not match' }]);
    const [{ n }] = (await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaces)
      .where(and(eq(workspaces.organisationId, ws.organisationId), isNull(workspaces.deletedAt)))) as [{ n: number }];
    if (n <= 1) throw badRequest('An organisation needs at least one workspace. Create another one first.');
    await this.dbs.db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, workspaceId));
    await this.audit.record({ organisationId: ws.organisationId, actorId: userId, action: 'workspace.deleted', targetType: 'workspace', targetId: ws.id, data: { name: ws.name }, client });
  }

  private async createWorkspaceTx(tx: DbOrTx, organisationId: string, name: string, creatorId: string) {
    const base = slugify(name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const [clash] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.organisationId, organisationId), eq(workspaces.slug, slug)))
        .limit(1);
      if (clash) continue;
      // A concurrent insert of the same slug violates the unique constraint and aborts the transaction (500, retryable).
      const [ws] = await tx.insert(workspaces).values({ organisationId, name, slug }).returning();
      await tx.insert(workspaceMemberships).values({ workspaceId: ws!.id, userId: creatorId, role: 'ADMIN' });
      return ws!;
    }
    throw new Error('Could not allocate a unique workspace slug');
  }
}
