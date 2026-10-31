import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { canInWorkspace, wouldCreateCycle } from '@monty/domain';
import { comments, DbOrTx, milestones, notifications, taskDependencies, tasks, users } from '@monty/database';
import {
  CommentDto,
  CreateCommentInput,
  CreateMilestoneInput,
  DependencyDto,
  extractMentions,
  MilestoneDto,
  NotificationDto,
  UpdateMilestoneInput,
} from '@monty/validation';
import { recordChange } from '../activity/activity';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';

export interface NotifyInput {
  recipients: string[];
  actorId: string;
  organisationId: string;
  workspaceId: string;
  projectId: string | null;
  type: 'mention' | 'assigned' | 'comment' | 'automation';
  entityType: 'task' | 'comment' | 'message' | 'crm_activity';
  entityId: string;
  data: Record<string, unknown>;
  dedupeKey: string;
  /** Automations notify on behalf of their author, who may also be a recipient. */
  includeActor?: boolean;
}

@Injectable()
export class CollaborationService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
  ) {}

  // ---------- notifications ----------

  /** Fans out a notification to recipients who can see the workspace (never to the actor). Idempotent by dedupeKey. */
  async notify(n: NotifyInput, db: DbOrTx = this.dbs.db): Promise<number> {
    const unique = [...new Set(n.recipients)].filter((u) => n.includeActor || u !== n.actorId);
    const allowed: string[] = [];
    for (const u of unique) if (await this.access.workspaceAccess(u, n.workspaceId, db)) allowed.push(u);
    if (allowed.length === 0) return 0;
    await db
      .insert(notifications)
      .values(
        allowed.map((userId) => ({
          userId,
          organisationId: n.organisationId,
          workspaceId: n.workspaceId,
          projectId: n.projectId,
          type: n.type,
          entityType: n.entityType,
          entityId: n.entityId,
          actorId: n.actorId,
          data: n.data,
          dedupeKey: n.dedupeKey,
        })),
      )
      .onConflictDoNothing();
    return allowed.length;
  }

  async listNotifications(userId: string, unreadOnly: boolean): Promise<{ notifications: NotificationDto[]; unread: number }> {
    const db = this.dbs.db;
    const rows = await db
      .select({ n: notifications, actorName: users.name })
      .from(notifications)
      .leftJoin(users, eq(users.id, notifications.actorId))
      .where(and(eq(notifications.userId, userId), unreadOnly ? isNull(notifications.readAt) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    const [{ n: unread } = { n: 0 }] = await db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return {
      unread,
      notifications: rows.map(({ n, actorName }) => ({
        id: n.id,
        type: n.type as NotificationDto['type'],
        entityType: n.entityType,
        entityId: n.entityId,
        projectId: n.projectId,
        actor: n.actorId ? { id: n.actorId, name: actorName ?? 'Someone' } : null,
        data: n.data,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
    };
  }

  async markRead(userId: string, ids?: string[]): Promise<number> {
    const res = await this.dbs.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined))
      .returning({ id: notifications.id });
    return res.length;
  }

  // ---------- milestones ----------

  async listMilestones(userId: string, projectId: string): Promise<MilestoneDto[]> {
    await this.access.requireProject(userId, projectId, 'workspace.read');
    const db = this.dbs.db;
    const rows = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.projectId, projectId), isNull(milestones.deletedAt)))
      .orderBy(sql`${milestones.dueDate} asc nulls last`, asc(milestones.createdAt));
    const counts = await db
      .select({ milestoneId: tasks.milestoneId, status: tasks.status, n: count() })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .groupBy(tasks.milestoneId, tasks.status);
    return rows.map((m) => {
      const mine = counts.filter((c) => c.milestoneId === m.id && c.status !== 'CANCELLED');
      return {
        id: m.id,
        projectId: m.projectId,
        name: m.name,
        dueDate: m.dueDate,
        completedAt: m.completedAt?.toISOString() ?? null,
        version: m.version,
        taskTotal: mine.reduce((a, c) => a + c.n, 0),
        taskDone: mine.filter((c) => c.status === 'DONE').reduce((a, c) => a + c.n, 0),
      };
    });
  }

  async createMilestone(userId: string, projectId: string, input: CreateMilestoneInput): Promise<MilestoneDto> {
    const { project } = await this.access.requireProject(userId, projectId, 'project.update');
    if (input.id) {
      const existing = await this.dbs.db.query.milestones.findFirst({ where: eq(milestones.id, input.id) });
      if (existing) {
        if (existing.projectId !== projectId || existing.createdById !== userId) throw conflict('CONFLICT', 'This id is already in use');
        return (await this.listMilestones(userId, projectId)).find((m) => m.id === existing.id)!;
      }
    }
    const m = await this.dbs.db.transaction(async (tx) => {
      const [m] = await tx
        .insert(milestones)
        .values({
          id: input.id,
          organisationId: project.organisationId,
          workspaceId: project.workspaceId,
          projectId,
          name: input.name,
          dueDate: input.dueDate ?? null,
          createdById: userId,
        })
        .returning();
      await recordChange(tx, {
        organisationId: project.organisationId, workspaceId: project.workspaceId, projectId, actorId: userId,
        entityType: 'project', entityId: projectId, action: 'updated', entityVersion: project.version,
        data: { milestone: m!.name, change: 'milestone_added' }, payload: { milestoneId: m!.id },
      });
      return m!;
    });
    return { id: m.id, projectId, name: m.name, dueDate: m.dueDate, completedAt: null, version: m.version, taskTotal: 0, taskDone: 0 };
  }

  async updateMilestone(userId: string, milestoneId: string, input: UpdateMilestoneInput): Promise<MilestoneDto> {
    const m = await this.dbs.db.query.milestones.findFirst({ where: and(eq(milestones.id, milestoneId), isNull(milestones.deletedAt)) });
    if (!m) throw notFound('Milestone');
    await this.access.requireProject(userId, m.projectId, 'project.update');
    const { expectedVersion, completed, ...rest } = input;
    const [updated] = await this.dbs.db
      .update(milestones)
      .set({
        ...rest,
        ...(completed === undefined ? {} : { completedAt: completed ? (m.completedAt ?? new Date()) : null }),
        version: sql`${milestones.version} + 1`,
      })
      .where(and(eq(milestones.id, milestoneId), eq(milestones.version, expectedVersion)))
      .returning();
    if (!updated) throw conflict('VERSION_CONFLICT', 'This milestone was changed by someone else. Reload to see the latest version.');
    return (await this.listMilestones(userId, m.projectId)).find((x) => x.id === milestoneId)!;
  }

  async deleteMilestone(userId: string, milestoneId: string): Promise<void> {
    const m = await this.dbs.db.query.milestones.findFirst({ where: and(eq(milestones.id, milestoneId), isNull(milestones.deletedAt)) });
    if (!m) throw notFound('Milestone');
    await this.access.requireProject(userId, m.projectId, 'project.update');
    await this.dbs.db.transaction(async (tx) => {
      await tx.update(tasks).set({ milestoneId: null, version: sql`${tasks.version} + 1` }).where(eq(tasks.milestoneId, milestoneId));
      await tx.update(milestones).set({ deletedAt: new Date() }).where(eq(milestones.id, milestoneId));
    });
  }

  /** Used by task create/update: the milestone must be live and in the same project. */
  async assertMilestoneInProject(milestoneId: string | null | undefined, projectId: string): Promise<void> {
    if (!milestoneId) return;
    const m = await this.dbs.db.query.milestones.findFirst({
      where: and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId), isNull(milestones.deletedAt)),
    });
    if (!m) throw badRequest('Milestone must belong to the same project', [{ path: 'milestoneId', message: 'Not found in project' }]);
  }

  // ---------- dependencies ----------

  async listDependencies(userId: string, projectId: string): Promise<DependencyDto[]> {
    await this.access.requireProject(userId, projectId, 'workspace.read');
    const rows = await this.dbs.db
      .select({ id: taskDependencies.id, taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .innerJoin(tasks, and(eq(tasks.id, taskDependencies.taskId), isNull(tasks.deletedAt)))
      .where(eq(tasks.projectId, projectId));
    return rows;
  }

  async addDependency(userId: string, taskId: string, dependsOnTaskId: string): Promise<DependencyDto> {
    const { task } = await this.access.requireTask(userId, taskId, 'task.update');
    return this.dbs.db.transaction(async (tx) => {
      const [other] = await tx
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.id, dependsOnTaskId), isNull(tasks.deletedAt)));
      if (!other || other.projectId !== task.projectId) {
        throw badRequest('A task can only depend on another task in the same project', [{ path: 'dependsOnTaskId', message: 'Not found in project' }]);
      }
      // Serialise graph changes per project so two concurrent edges can't form a cycle.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'deps:' + task.projectId}))`);
      const edges = await tx
        .select({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
        .where(eq(tasks.projectId, task.projectId));
      if (edges.some((e) => e.taskId === taskId && e.dependsOnTaskId === dependsOnTaskId)) {
        throw conflict('CONFLICT', 'This dependency already exists');
      }
      if (wouldCreateCycle(edges, taskId, dependsOnTaskId)) {
        throw badRequest('That would create a circular dependency', [{ path: 'dependsOnTaskId', message: 'Creates a cycle' }]);
      }
      const [d] = await tx
        .insert(taskDependencies)
        .values({ organisationId: task.organisationId, taskId, dependsOnTaskId })
        .returning({ id: taskDependencies.id, taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId });
      await recordChange(tx, {
        organisationId: task.organisationId, workspaceId: task.workspaceId, projectId: task.projectId, actorId: userId,
        entityType: 'task', entityId: taskId, action: 'updated', entityVersion: task.version,
        data: { title: task.title, change: 'dependency_added', dependsOnTaskId }, payload: { dependency: d },
      });
      return d!;
    });
  }

  async removeDependency(userId: string, taskId: string, dependencyId: string): Promise<void> {
    await this.access.requireTask(userId, taskId, 'task.update');
    const res = await this.dbs.db
      .delete(taskDependencies)
      .where(and(eq(taskDependencies.id, dependencyId), eq(taskDependencies.taskId, taskId)))
      .returning({ id: taskDependencies.id });
    if (res.length === 0) throw notFound('Dependency');
  }

  // ---------- comments ----------

  async listComments(userId: string, projectId: string, taskId: string | null): Promise<CommentDto[]> {
    await this.access.requireProject(userId, projectId, 'workspace.read');
    const rows = await this.dbs.db
      .select({ c: comments, authorName: users.name })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.projectId, projectId), taskId ? eq(comments.taskId, taskId) : isNull(comments.taskId), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt))
      .limit(500);
    return rows.map(({ c, authorName }) => this.toCommentDto(c, authorName));
  }

  async createComment(userId: string, projectId: string, taskId: string | null, input: CreateCommentInput): Promise<CommentDto> {
    const { project, role } = await this.access.requireProject(userId, projectId, 'workspace.read');
    if (!canInWorkspace(role, 'task.create')) throw forbidden('Viewers can read discussions but not post in them.');
    let task: { id: string; title: string; assigneeId: string | null; creatorId: string } | undefined;
    if (taskId) {
      task = await this.dbs.db.query.tasks.findFirst({
        where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)),
        columns: { id: true, title: true, assigneeId: true, creatorId: true },
      });
      if (!task) throw notFound('Task');
    }
    if (input.id) {
      const existing = await this.dbs.db.query.comments.findFirst({ where: eq(comments.id, input.id) });
      if (existing) {
        if (existing.authorId !== userId || existing.projectId !== projectId) throw conflict('CONFLICT', 'This id is already in use');
        const [author] = await this.dbs.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
        return this.toCommentDto(existing, author?.name ?? '');
      }
    }
    const mentioned = extractMentions(input.body);
    return this.dbs.db.transaction(async (tx) => {
      const [c] = await tx
        .insert(comments)
        .values({
          id: input.id,
          organisationId: project.organisationId,
          workspaceId: project.workspaceId,
          projectId,
          taskId,
          authorId: userId,
          body: input.body,
        })
        .returning();
      const base = {
        actorId: userId, organisationId: project.organisationId, workspaceId: project.workspaceId, projectId,
        entityType: 'comment' as const, entityId: c!.id,
        data: { projectName: project.name, taskId, taskTitle: task?.title ?? null, excerpt: input.body.slice(0, 140) },
      };
      await this.notify({ ...base, recipients: mentioned, type: 'mention', dedupeKey: `mention:${c!.id}` }, tx);
      if (task) {
        const followers = [task.assigneeId, task.creatorId].filter((u): u is string => !!u && !mentioned.includes(u));
        await this.notify({ ...base, recipients: followers, type: 'comment', dedupeKey: `comment:${c!.id}` }, tx);
      }
      await recordChange(tx, {
        organisationId: project.organisationId, workspaceId: project.workspaceId, projectId, actorId: userId,
        entityType: taskId ? 'task' : 'project', entityId: taskId ?? projectId, action: 'updated', entityVersion: project.version,
        data: { title: task?.title ?? project.name, change: 'comment_added' }, payload: { commentId: c!.id },
      });
      const [author] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId));
      return this.toCommentDto(c!, author?.name ?? '');
    });
  }

  async deleteComment(userId: string, commentId: string): Promise<void> {
    const c = await this.dbs.db.query.comments.findFirst({ where: and(eq(comments.id, commentId), isNull(comments.deletedAt)) });
    if (!c) throw notFound('Comment');
    const { role } = await this.access.requireProject(userId, c.projectId, 'workspace.read');
    if (c.authorId !== userId && !canInWorkspace(role, 'workspace.manage')) throw forbidden('You can only delete your own comments.');
    await this.dbs.db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
  }

  private toCommentDto(c: typeof comments.$inferSelect, authorName: string): CommentDto {
    return {
      id: c.id,
      projectId: c.projectId,
      taskId: c.taskId,
      author: { id: c.authorId, name: authorName },
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      editedAt: c.editedAt?.toISOString() ?? null,
    };
  }
}
