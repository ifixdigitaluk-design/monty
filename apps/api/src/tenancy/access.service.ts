import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { canInWorkspace, effectiveWorkspaceRole, WorkspaceAction, WorkspaceRole } from '@monty/domain';
import {
  DbOrTx,
  organisationMemberships,
  organisations,
  Project,
  projects,
  Task,
  tasks,
  users,
  workspaceMemberships,
  workspaces,
} from '@monty/database';
import { badRequest, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';

export interface WorkspaceAccess {
  workspace: { id: string; name: string; slug: string; organisationId: string };
  role: WorkspaceRole;
}

/**
 * Single place where "can this user do X here?" is answered for the API.
 * Unreadable resources produce 404 (no existence leak); readable-but-not-permitted produce 403.
 */
@Injectable()
export class AccessService {
  constructor(private readonly dbs: DbService) {}

  async workspaceAccess(userId: string, workspaceId: string, db: DbOrTx = this.dbs.db): Promise<WorkspaceAccess | null> {
    const [row] = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        organisationId: workspaces.organisationId,
        orgRole: organisationMemberships.role,
        wsRole: workspaceMemberships.role,
      })
      .from(workspaces)
      .innerJoin(organisations, and(eq(organisations.id, workspaces.organisationId), isNull(organisations.deletedAt)))
      .leftJoin(
        organisationMemberships,
        and(eq(organisationMemberships.organisationId, workspaces.organisationId), eq(organisationMemberships.userId, userId)),
      )
      .leftJoin(
        workspaceMemberships,
        and(eq(workspaceMemberships.workspaceId, workspaces.id), eq(workspaceMemberships.userId, userId)),
      )
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      .limit(1);
    if (!row) return null;
    const role = effectiveWorkspaceRole(row.orgRole, row.wsRole);
    if (!role) return null;
    return { workspace: { id: row.id, name: row.name, slug: row.slug, organisationId: row.organisationId }, role };
  }

  async requireWorkspace(userId: string, workspaceId: string, action: WorkspaceAction): Promise<WorkspaceAccess> {
    const access = await this.workspaceAccess(userId, workspaceId);
    if (!access) throw notFound('Workspace');
    if (!canInWorkspace(access.role, action)) throw forbidden();
    return access;
  }

  async requireProject(userId: string, projectId: string, action: WorkspaceAction): Promise<WorkspaceAccess & { project: Project }> {
    const project = await this.dbs.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), isNull(projects.deletedAt)),
    });
    if (!project) throw notFound('Project');
    const access = await this.workspaceAccess(userId, project.workspaceId);
    if (!access) throw notFound('Project');
    if (!canInWorkspace(access.role, action, { isCreator: project.createdById === userId })) throw forbidden();
    return { ...access, project };
  }

  async requireTask(userId: string, taskId: string, action: WorkspaceAction): Promise<WorkspaceAccess & { task: Task }> {
    const [row] = await this.dbs.db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.projectId), isNull(projects.deletedAt)))
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
      .limit(1);
    if (!row) throw notFound('Task');
    const access = await this.workspaceAccess(userId, row.task.workspaceId);
    if (!access) throw notFound('Task');
    if (!canInWorkspace(access.role, action)) throw forbidden();
    return { ...access, task: row.task };
  }

  /** Assignees and owners must themselves be able to see the workspace. */
  async assertCanBeAssigned(candidateUserId: string | null | undefined, workspaceId: string, field: string): Promise<void> {
    if (!candidateUserId) return;
    const access = await this.workspaceAccess(candidateUserId, workspaceId);
    if (!access) throw badRequest(`${field} must be a member of this workspace`, [{ path: field, message: 'Not a workspace member' }]);
  }

  /** All workspaces the user can read, across organisations. */
  async accessibleWorkspaceIds(userId: string): Promise<string[]> {
    const db = this.dbs.db;
    const orgRows = await db
      .select({ organisationId: organisationMemberships.organisationId, role: organisationMemberships.role })
      .from(organisationMemberships)
      .innerJoin(organisations, and(eq(organisations.id, organisationMemberships.organisationId), isNull(organisations.deletedAt)))
      .where(eq(organisationMemberships.userId, userId));
    if (orgRows.length === 0) return [];
    const wsRows = await db
      .select({ workspaceId: workspaceMemberships.workspaceId, role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, userId));
    const orgRole = new Map(orgRows.map((m) => [m.organisationId, m.role]));
    const wsRole = new Map(wsRows.map((m) => [m.workspaceId, m.role]));
    const ws = await db
      .select({ id: workspaces.id, organisationId: workspaces.organisationId })
      .from(workspaces)
      .where(and(inArray(workspaces.organisationId, [...orgRole.keys()]), isNull(workspaces.deletedAt)));
    return ws.filter((w) => effectiveWorkspaceRole(orgRole.get(w.organisationId), wsRole.get(w.id)) !== null).map((w) => w.id);
  }

  /** Users who can access a workspace (candidates for assignment). */
  async workspaceMembers(workspaceId: string, organisationId: string) {
    const db = this.dbs.db;
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, orgRole: organisationMemberships.role, wsRole: workspaceMemberships.role })
      .from(organisationMemberships)
      .innerJoin(users, and(eq(users.id, organisationMemberships.userId), isNull(users.deletedAt)))
      .leftJoin(
        workspaceMemberships,
        and(eq(workspaceMemberships.userId, organisationMemberships.userId), eq(workspaceMemberships.workspaceId, workspaceId)),
      )
      .where(eq(organisationMemberships.organisationId, organisationId));
    return rows
      .filter((r) => effectiveWorkspaceRole(r.orgRole, r.wsRole) !== null)
      .map(({ id, name, email }) => ({ id, name, email }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
