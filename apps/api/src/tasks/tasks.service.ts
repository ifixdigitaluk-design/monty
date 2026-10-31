import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, max, notInArray, sql } from 'drizzle-orm';
import { DbOrTx, isUniqueViolation, projects, Task, tasks } from '@monty/database';
import type { CreateTaskInput, MyTaskDto, TaskDto, UpdateTaskInput } from '@monty/validation';
import { diff, recordChange } from '../activity/activity';
import { badRequest, conflict } from '../common/errors';
import { toTaskDto } from '../common/mappers';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';
import { CollaborationService } from '../collaboration/collaboration.service';

const TRACKED = ['title', 'status', 'priority', 'assigneeId', 'startDate', 'dueDate', 'blockedReason', 'estimateMinutes', 'milestoneId'] as const;
const SORT_GAP = 1024;

@Injectable()
export class TasksService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly collab: CollaborationService,
  ) {}

  async list(userId: string, projectId: string): Promise<TaskDto[]> {
    await this.access.requireProject(userId, projectId, 'workspace.read');
    const rows = await this.dbs.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt));
    return rows.map(toTaskDto);
  }

  async create(userId: string, projectId: string, input: CreateTaskInput): Promise<{ task: TaskDto; created: boolean }> {
    const { project } = await this.access.requireProject(userId, projectId, 'task.create');
    if (input.id) {
      const existing = await this.findForReplay(input.id, userId, projectId);
      if (existing) return { task: existing, created: false };
    }
    if (input.startDate && input.dueDate && input.startDate > input.dueDate) {
      throw badRequest('Start date must be on or before the due date');
    }
    await this.access.assertCanBeAssigned(input.assigneeId, project.workspaceId, 'assigneeId');
    await this.collab.assertMilestoneInProject(input.milestoneId, projectId);
    if (input.parentTaskId) {
      const parent = await this.dbs.db.query.tasks.findFirst({
        where: and(eq(tasks.id, input.parentTaskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)),
      });
      if (!parent) {
        throw badRequest('Parent task must belong to the same project', [{ path: 'parentTaskId', message: 'Not found in project' }]);
      }
    }

    try {
      const t = await this.dbs.db.transaction(async (tx) => {
        const [last] = await tx.select({ m: max(tasks.sortOrder) }).from(tasks).where(eq(tasks.projectId, projectId));
        const status = input.status ?? 'TODO';
        const [t] = await tx
          .insert(tasks)
          .values({
            id: input.id,
            organisationId: project.organisationId,
            workspaceId: project.workspaceId,
            projectId,
            parentTaskId: input.parentTaskId ?? null,
            title: input.title,
            description: input.description ?? '',
            status,
            priority: input.priority ?? 'NONE',
            assigneeId: input.assigneeId ?? null,
            creatorId: userId,
            startDate: input.startDate ?? null,
            dueDate: input.dueDate ?? null,
            estimateMinutes: input.estimateMinutes ?? null,
            blockedReason: input.blockedReason || null,
            milestoneId: input.milestoneId ?? null,
            sortOrder: (last?.m ?? 0) + SORT_GAP,
            completedAt: status === 'DONE' ? new Date() : null,
          })
          .returning();
        await recordChange(tx, {
          organisationId: t!.organisationId,
          workspaceId: t!.workspaceId,
          projectId,
          actorId: userId,
          entityType: 'task',
          entityId: t!.id,
          action: 'created',
          entityVersion: t!.version,
          data: { title: t!.title },
          payload: { ...toTaskDto(t!) },
        });
        if (t!.assigneeId) await this.notifyAssigned(tx, t!, userId, project.name);
        return t!;
      });
      return { task: toTaskDto(t), created: true };
    } catch (err) {
      if (input.id && isUniqueViolation(err)) {
        const existing = await this.findForReplay(input.id, userId, projectId);
        if (existing) return { task: existing, created: false };
      }
      throw err;
    }
  }

  /** Idempotent replay: the same creator re-sending the same id gets the original record. */
  private async findForReplay(id: string, userId: string, projectId: string): Promise<TaskDto | null> {
    const existing = await this.dbs.db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    if (!existing) return null;
    if (existing.creatorId !== userId || existing.projectId !== projectId || existing.deletedAt) {
      throw conflict('CONFLICT', 'This id is already in use');
    }
    return toTaskDto(existing);
  }

  async update(userId: string, taskId: string, input: UpdateTaskInput): Promise<TaskDto> {
    const { task } = await this.access.requireTask(userId, taskId, 'task.update');
    if (input.assigneeId !== undefined) await this.access.assertCanBeAssigned(input.assigneeId, task.workspaceId, 'assigneeId');
    if (input.milestoneId !== undefined) await this.collab.assertMilestoneInProject(input.milestoneId, task.projectId);
    const start = input.startDate !== undefined ? input.startDate : task.startDate;
    const due = input.dueDate !== undefined ? input.dueDate : task.dueDate;
    if (start && due && start > due) throw badRequest('Start date must be on or before the due date');

    const { expectedVersion, ...changes } = input;
    const statusChanging = changes.status !== undefined && changes.status !== task.status;
    const updated = await this.dbs.db.transaction(async (tx) => {
      const [t] = await tx
        .update(tasks)
        .set({
          ...changes,
          blockedReason: changes.blockedReason === undefined ? undefined : changes.blockedReason || null,
          ...(statusChanging ? { completedAt: changes.status === 'DONE' ? new Date() : null } : {}),
          version: sql`${tasks.version} + 1`,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion), isNull(tasks.deletedAt)))
        .returning();
      if (!t) return null;
      await recordChange(tx, {
        organisationId: t.organisationId,
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        actorId: userId,
        entityType: 'task',
        entityId: t.id,
        action: 'updated',
        entityVersion: t.version,
        data: { title: t.title, changes: diff(task, t, TRACKED) },
        payload: { ...toTaskDto(t) },
      });
      if (t.assigneeId && t.assigneeId !== task.assigneeId) await this.notifyAssigned(tx, t, userId);
      return t;
    });
    if (!updated) {
      const current = await this.dbs.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      throw conflict('VERSION_CONFLICT', 'This task was changed by someone else. Reload to see the latest version.', {
        current: current ? toTaskDto(current) : null,
      });
    }
    return toTaskDto(updated);
  }

  async remove(userId: string, taskId: string): Promise<void> {
    const { task } = await this.access.requireTask(userId, taskId, 'task.delete');
    await this.dbs.db.transaction(async (tx) => {
      const now = new Date();
      const [t] = await tx
        .update(tasks)
        .set({ deletedAt: now, version: sql`${tasks.version} + 1` })
        .where(eq(tasks.id, taskId))
        .returning();
      await tx
        .update(tasks)
        .set({ deletedAt: now, version: sql`${tasks.version} + 1` })
        .where(and(eq(tasks.parentTaskId, taskId), isNull(tasks.deletedAt)));
      await recordChange(tx, {
        organisationId: task.organisationId,
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        actorId: userId,
        entityType: 'task',
        entityId: taskId,
        action: 'deleted',
        entityVersion: t!.version,
        data: { title: task.title },
        payload: { id: taskId },
      });
    });
  }

  async mine(userId: string): Promise<MyTaskDto[]> {
    const workspaceIds = await this.access.accessibleWorkspaceIds(userId);
    if (workspaceIds.length === 0) return [];
    const rows = await this.dbs.db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.projectId), isNull(projects.deletedAt)))
      .where(
        and(
          eq(tasks.assigneeId, userId),
          isNull(tasks.deletedAt),
          notInArray(tasks.status, ['DONE', 'CANCELLED']),
          inArray(tasks.workspaceId, workspaceIds),
        ),
      )
      .orderBy(sql`${tasks.dueDate} asc nulls last`, asc(tasks.createdAt))
      .limit(500);
    return rows.map(({ task, projectName }) => ({ ...toTaskDto(task), projectName }));
  }

  private async notifyAssigned(tx: DbOrTx, t: Task, actorId: string, projectName?: string) {
    await this.collab.notify(
      {
        recipients: [t.assigneeId!],
        actorId,
        organisationId: t.organisationId,
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        type: 'assigned',
        entityType: 'task',
        entityId: t.id,
        data: { taskTitle: t.title, projectName: projectName ?? null },
        dedupeKey: `assigned:${t.id}:${t.version}`,
      },
      tx,
    );
  }
}
