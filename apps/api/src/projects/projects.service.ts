import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { evaluateReadiness, IsoDate, ReadinessReport } from '@monty/domain';
import { activityEvents, isUniqueViolation, projects, taskDependencies, tasks, users } from '@monty/database';
import type {
  ActivityDto,
  CreateProjectInput,
  ProjectDetailDto,
  ProjectDto,
  ProjectListItemDto,
  UpdateProjectInput,
} from '@monty/validation';
import { diff, recordChange } from '../activity/activity';
import { badRequest, conflict } from '../common/errors';
import { toProjectDto } from '../common/mappers';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';
import { EntitlementsService } from '../billing/entitlements.service';

const TRACKED = ['name', 'objective', 'lifecycle', 'priority', 'ownerId', 'startDate', 'targetDate'] as const;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(userId: string, workspaceId: string) {
    const { workspace, role } = await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const db = this.dbs.db;
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
      .orderBy(desc(projects.createdAt));
    const counts = await db
      .select({ projectId: tasks.projectId, status: tasks.status, n: count() })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt), ne(tasks.status, 'CANCELLED')))
      .groupBy(tasks.projectId, tasks.status);
    const tally = new Map<string, { total: number; done: number }>();
    for (const c of counts) {
      const t = tally.get(c.projectId) ?? { total: 0, done: 0 };
      t.total += c.n;
      if (c.status === 'DONE') t.done += c.n;
      tally.set(c.projectId, t);
    }
    const items: ProjectListItemDto[] = rows.map((p) => ({
      ...toProjectDto(p),
      taskTotal: tally.get(p.id)?.total ?? 0,
      taskDone: tally.get(p.id)?.done ?? 0,
    }));
    return { projects: items, workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, role } };
  }

  async create(userId: string, workspaceId: string, input: CreateProjectInput): Promise<{ project: ProjectDto; created: boolean }> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'project.create');
    if (input.id) {
      const existing = await this.findForReplay(input.id, userId, workspaceId);
      if (existing) return { project: existing, created: false };
    }
    if (input.startDate && input.targetDate && input.startDate > input.targetDate) {
      throw badRequest('Start date must be on or before the target date');
    }
    await this.access.assertCanBeAssigned(input.ownerId, workspaceId, 'ownerId');
    await this.entitlements.assertWithinLimit(workspace.organisationId, 'projects');

    try {
      const p = await this.dbs.db.transaction(async (tx) => {
        const [p] = await tx
          .insert(projects)
          .values({
            id: input.id,
            organisationId: workspace.organisationId,
            workspaceId,
            name: input.name,
            objective: input.objective ?? '',
            description: input.description ?? '',
            priority: input.priority ?? 'NONE',
            ownerId: input.ownerId ?? null,
            startDate: input.startDate ?? null,
            targetDate: input.targetDate ?? null,
            createdById: userId,
          })
          .returning();
        await recordChange(tx, {
          organisationId: p!.organisationId,
          workspaceId,
          projectId: p!.id,
          actorId: userId,
          entityType: 'project',
          entityId: p!.id,
          action: 'created',
          entityVersion: p!.version,
          data: { name: p!.name },
          payload: { ...toProjectDto(p!) },
        });
        return p!;
      });
      return { project: toProjectDto(p), created: true };
    } catch (err) {
      if (input.id && isUniqueViolation(err)) {
        const existing = await this.findForReplay(input.id, userId, workspaceId);
        if (existing) return { project: existing, created: false };
      }
      throw err;
    }
  }

  /** Idempotent replay: the same creator re-sending the same id gets the original record. */
  private async findForReplay(id: string, userId: string, workspaceId: string): Promise<ProjectDto | null> {
    const existing = await this.dbs.db.query.projects.findFirst({ where: eq(projects.id, id) });
    if (!existing) return null;
    if (existing.createdById !== userId || existing.workspaceId !== workspaceId || existing.deletedAt) {
      throw conflict('CONFLICT', 'This id is already in use');
    }
    return toProjectDto(existing);
  }

  async get(userId: string, projectId: string): Promise<ProjectDetailDto> {
    const { project, role, workspace } = await this.access.requireProject(userId, projectId, 'workspace.read');
    const members = await this.access.workspaceMembers(workspace.id, workspace.organisationId);
    return { ...toProjectDto(project), role, members, workspaceName: workspace.name };
  }

  async update(userId: string, projectId: string, input: UpdateProjectInput): Promise<ProjectDto> {
    const { project, workspace } = await this.access.requireProject(userId, projectId, 'project.update');
    if (input.ownerId !== undefined) await this.access.assertCanBeAssigned(input.ownerId, workspace.id, 'ownerId');
    const start = input.startDate !== undefined ? input.startDate : project.startDate;
    const target = input.targetDate !== undefined ? input.targetDate : project.targetDate;
    if (start && target && start > target) throw badRequest('Start date must be on or before the target date');

    const { expectedVersion, ...changes } = input;
    const updated = await this.dbs.db.transaction(async (tx) => {
      const [p] = await tx
        .update(projects)
        .set({ ...changes, version: sql`${projects.version} + 1` })
        .where(and(eq(projects.id, projectId), eq(projects.version, expectedVersion), isNull(projects.deletedAt)))
        .returning();
      if (!p) return null;
      await recordChange(tx, {
        organisationId: p.organisationId,
        workspaceId: p.workspaceId,
        projectId: p.id,
        actorId: userId,
        entityType: 'project',
        entityId: p.id,
        action: 'updated',
        entityVersion: p.version,
        data: { changes: diff(project, p, TRACKED) },
        payload: { ...toProjectDto(p) },
      });
      return p;
    });
    if (!updated) {
      const current = await this.dbs.db.query.projects.findFirst({ where: eq(projects.id, projectId) });
      throw conflict('VERSION_CONFLICT', 'This project was changed by someone else. Reload to see the latest version.', {
        current: current ? toProjectDto(current) : null,
      });
    }
    return toProjectDto(updated);
  }

  async remove(userId: string, projectId: string): Promise<void> {
    const { project } = await this.access.requireProject(userId, projectId, 'project.delete');
    await this.dbs.db.transaction(async (tx) => {
      const [p] = await tx
        .update(projects)
        .set({ deletedAt: new Date(), version: sql`${projects.version} + 1` })
        .where(eq(projects.id, projectId))
        .returning();
      await recordChange(tx, {
        organisationId: project.organisationId,
        workspaceId: project.workspaceId,
        projectId,
        actorId: userId,
        entityType: 'project',
        entityId: projectId,
        action: 'deleted',
        entityVersion: p!.version,
        data: { name: project.name },
        payload: { id: projectId },
      });
    });
  }

  async readiness(userId: string, projectId: string, today: IsoDate): Promise<ReadinessReport> {
    const { project } = await this.access.requireProject(userId, projectId, 'workspace.read');
    const rows = await this.dbs.db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        assigneeId: tasks.assigneeId,
        dueDate: tasks.dueDate,
        blockedReason: tasks.blockedReason,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
    const edges = await this.dbs.db
      .select({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .where(inArray(taskDependencies.taskId, rows.length ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000']));
    const deps = new Map<string, string[]>();
    for (const e of edges) deps.set(e.taskId, [...(deps.get(e.taskId) ?? []), e.dependsOnTaskId]);
    return evaluateReadiness(
      { objective: project.objective, ownerId: project.ownerId, targetDate: project.targetDate, lifecycle: project.lifecycle },
      rows.map((r) => ({ ...r, dependsOn: deps.get(r.id) ?? [] })),
      today,
    );
  }

  async activity(userId: string, projectId: string): Promise<ActivityDto[]> {
    await this.access.requireProject(userId, projectId, 'workspace.read');
    const rows = await this.dbs.db
      .select({ e: activityEvents, actorName: users.name })
      .from(activityEvents)
      .innerJoin(users, eq(users.id, activityEvents.actorId))
      .where(eq(activityEvents.projectId, projectId))
      .orderBy(desc(activityEvents.createdAt))
      .limit(100);
    return rows.map(({ e, actorName }) => ({
      id: e.id,
      actor: { id: e.actorId, name: actorName },
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      data: e.data,
      createdAt: e.createdAt.toISOString(),
    }));
  }
}
