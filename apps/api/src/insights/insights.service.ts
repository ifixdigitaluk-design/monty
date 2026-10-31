import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { addDays, evaluateReadiness, groupMyTasks, IsoDate, toPrefixTsQuery } from '@monty/domain';
import { activityEvents, milestones, notifications, projects, taskDependencies, tasks, users, workspaces } from '@monty/database';
import type { CalendarEntryDto, HomeDto, SearchResultDto } from '@monty/validation';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';

const NONE = ['00000000-0000-0000-0000-000000000000'];

/** Cross-workspace read models: search, calendar and the home dashboard. Always limited to workspaces the caller can read. */
@Injectable()
export class InsightsService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
  ) {}

  async search(userId: string, q: string, limit = 20): Promise<SearchResultDto[]> {
    const tsq = toPrefixTsQuery(q);
    if (!tsq) return [];
    const ws = await this.access.accessibleWorkspaceIds(userId);
    if (ws.length === 0) return [];
    const wsList = sql.join(ws.map((id) => sql`${id}::uuid`), sql`, `);
    const opts = 'StartSel=[[, StopSel=]], MaxWords=18, MinWords=6, ShortWord=2, MaxFragments=1';
    // Each branch is permission-scoped twice: explicitly by workspace list and by row-level security.
    const result = await this.dbs.db.execute(sql`
      with q as (select to_tsquery('simple', ${tsq}) as query)
      select * from (
        select 'project' as type, p.id, p.name as title,
               ts_headline('simple', coalesce(nullif(p.objective, ''), p.description, p.name), q.query, ${opts}) as snippet,
               p.id::text as project_id, p.name as project_name, null::uuid as task_id, w.id as workspace_id, w.name as workspace_name,
               ts_rank(p.search, q.query) * 1.2 as rank, null::uuid as channel_id, null::uuid as parent_id
        from projects p join workspaces w on w.id = p.workspace_id, q
        where p.search @@ q.query and p.deleted_at is null and p.workspace_id in (${wsList})
        union all
        select 'task', t.id, t.title,
               ts_headline('simple', coalesce(nullif(t.description, ''), t.title), q.query, ${opts}),
               p.id::text, p.name, t.id, w.id, w.name, ts_rank(t.search, q.query), null::uuid, null::uuid
        from tasks t join projects p on p.id = t.project_id and p.deleted_at is null join workspaces w on w.id = t.workspace_id, q
        where t.search @@ q.query and t.deleted_at is null and t.workspace_id in (${wsList})
        union all
        select 'comment', c.id, coalesce(t.title, p.name),
               ts_headline('simple', regexp_replace(c.body, '<@[0-9a-fA-F-]{36}>', '@…', 'g'), q.query, ${opts}),
               p.id::text, p.name, c.task_id, w.id, w.name, ts_rank(c.search, q.query) * 0.8, null::uuid, null::uuid
        from comments c join projects p on p.id = c.project_id and p.deleted_at is null
             left join tasks t on t.id = c.task_id join workspaces w on w.id = c.workspace_id, q
        where c.search @@ q.query and c.deleted_at is null and (t.id is null or t.deleted_at is null) and c.workspace_id in (${wsList})
        union all
        select 'document', d.id, d.title,
               ts_headline('simple', coalesce(nullif(d.body, ''), d.title), q.query, ${opts}),
               coalesce(d.project_id::text, ''), coalesce(p.name, w.name), null::uuid, w.id, w.name, ts_rank(d.search, q.query), null::uuid, null::uuid
        from documents d join workspaces w on w.id = d.workspace_id left join projects p on p.id = d.project_id, q
        where d.search @@ q.query and d.deleted_at is null and d.workspace_id in (${wsList})
        union all
        -- Chat messages: row-level security limits these to channels the user can see (public, or member of).
        select 'message', m.id, case when ch.kind = 'dm' then 'Direct message' else '#' || ch.name end,
               ts_headline('simple', regexp_replace(m.body, '<@[0-9a-fA-F-]{36}>', '@…', 'g'), q.query, ${opts}),
               '', w.name, null::uuid, w.id, w.name, ts_rank(m.search, q.query) * 0.7, ch.id, m.parent_id
        from messages m join channels ch on ch.id = m.channel_id join workspaces w on w.id = m.workspace_id, q
        where m.search @@ q.query and m.deleted_at is null and m.workspace_id in (${wsList})
        union all
        -- Database rows (title and page). The database id travels in channel_id.
        select 'database_row', r.id, coalesce(nullif(r.title, ''), 'Untitled'),
               ts_headline('simple', coalesce(nullif(r.body, ''), r.title), q.query, ${opts}),
               '', db.name, null::uuid, w.id, w.name, ts_rank(r.search, q.query) * 0.9, db.id, null::uuid
        from database_rows r join databases db on db.id = r.database_id and db.deleted_at is null join workspaces w on w.id = r.workspace_id, q
        where r.search @@ q.query and r.deleted_at is null and r.workspace_id in (${wsList})
      ) r
      order by rank desc, title asc
      limit ${limit}`);
    return (result.rows as Record<string, string | null>[]).map((r) => ({
      type: r.type as SearchResultDto['type'],
      id: r.id!,
      title: r.title!,
      snippet: r.snippet ?? '',
      projectId: r.project_id!,
      projectName: r.project_name!,
      taskId: r.task_id ?? null,
      workspaceId: r.workspace_id!,
      workspaceName: r.workspace_name!,
      ...(r.type === 'message' ? { channelId: r.channel_id!, parentId: r.parent_id ?? null } : {}),
      ...(r.type === 'database_row' ? { databaseId: r.channel_id! } : {}),
    }));
  }

  async calendar(userId: string, from: IsoDate, to: IsoDate, mineOnly: boolean): Promise<CalendarEntryDto[]> {
    const ws = await this.access.accessibleWorkspaceIds(userId);
    if (ws.length === 0) return [];
    const db = this.dbs.db;
    const taskRows = await db
      .select({ t: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.projectId), isNull(projects.deletedAt)))
      .where(
        and(
          inArray(tasks.workspaceId, ws),
          isNull(tasks.deletedAt),
          notInArray(tasks.status, ['CANCELLED']),
          gte(tasks.dueDate, from),
          lte(tasks.dueDate, to),
          mineOnly ? eq(tasks.assigneeId, userId) : undefined,
        ),
      )
      .limit(1000);
    const msRows = mineOnly
      ? []
      : await db
          .select({ m: milestones, projectName: projects.name })
          .from(milestones)
          .innerJoin(projects, and(eq(projects.id, milestones.projectId), isNull(projects.deletedAt)))
          .where(and(inArray(milestones.workspaceId, ws), isNull(milestones.deletedAt), gte(milestones.dueDate, from), lte(milestones.dueDate, to)))
          .limit(500);
    return [
      ...taskRows.map(({ t, projectName }) => ({
        kind: 'task' as const, id: t.id, title: t.title, date: t.dueDate!, projectId: t.projectId, projectName,
        status: t.status, assigneeId: t.assigneeId, done: t.status === 'DONE',
      })),
      ...msRows.map(({ m, projectName }) => ({
        kind: 'milestone' as const, id: m.id, title: m.name, date: m.dueDate!, projectId: m.projectId, projectName,
        status: null, assigneeId: null, done: m.completedAt !== null,
      })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }

  async home(userId: string, today: IsoDate): Promise<HomeDto> {
    const ws = await this.access.accessibleWorkspaceIds(userId);
    const db = this.dbs.db;
    const wsIds = ws.length ? ws : NONE;

    const mine = await db
      .select({ id: tasks.id, dueDate: tasks.dueDate })
      .from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.projectId), isNull(projects.deletedAt)))
      .where(and(eq(tasks.assigneeId, userId), inArray(tasks.workspaceId, wsIds), isNull(tasks.deletedAt), notInArray(tasks.status, ['DONE', 'CANCELLED'])));
    const g = groupMyTasks(mine, today);
    const [{ n: unread } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

    // Projects that need attention: active ones at risk/blocked, and drafts that are not ready yet.
    const live = await db
      .select({ p: projects, workspaceName: workspaces.name })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(and(inArray(projects.workspaceId, wsIds), isNull(projects.deletedAt), inArray(projects.lifecycle, ['DRAFT', 'ACTIVE'])))
      .orderBy(desc(projects.updatedAt))
      .limit(30);
    const ids = live.map((l) => l.p.id);
    const allTasks = ids.length
      ? await db
          .select({ id: tasks.id, projectId: tasks.projectId, title: tasks.title, status: tasks.status, assigneeId: tasks.assigneeId, dueDate: tasks.dueDate, blockedReason: tasks.blockedReason })
          .from(tasks)
          .where(and(inArray(tasks.projectId, ids), isNull(tasks.deletedAt)))
      : [];
    const edges = allTasks.length
      ? await db.select().from(taskDependencies).where(inArray(taskDependencies.taskId, allTasks.map((t) => t.id)))
      : [];
    const attention: HomeDto['attention'] = [];
    for (const { p, workspaceName } of live) {
      const r = evaluateReadiness(
        { objective: p.objective, ownerId: p.ownerId, targetDate: p.targetDate, lifecycle: p.lifecycle },
        allTasks
          .filter((t) => t.projectId === p.id)
          .map((t) => ({ ...t, dependsOn: edges.filter((e) => e.taskId === t.id).map((e) => e.dependsOnTaskId) })),
        today,
      );
      if (['AT_RISK', 'BLOCKED', 'DRAFT'].includes(r.computedStatus)) {
        attention.push({ projectId: p.id, projectName: p.name, workspaceName, computedStatus: r.computedStatus, reasons: r.statusReasons.slice(0, 3) });
      }
    }
    const order: Record<string, number> = { BLOCKED: 0, AT_RISK: 1, DRAFT: 2 };
    attention.sort((a, b) => order[a.computedStatus]! - order[b.computedStatus]!);

    const recent = await db
      .select({ e: activityEvents, actorName: users.name })
      .from(activityEvents)
      .innerJoin(users, eq(users.id, activityEvents.actorId))
      .where(inArray(activityEvents.workspaceId, wsIds))
      .orderBy(desc(activityEvents.createdAt))
      .limit(15);

    return {
      counts: {
        overdue: g.overdue.length,
        today: g.today.length,
        thisWeek: g.thisWeek.length,
        open: mine.length,
        unreadNotifications: unread,
      },
      attention: attention.slice(0, 10),
      recentActivity: recent.map(({ e, actorName }) => ({
        id: e.id, actor: { id: e.actorId, name: actorName }, entityType: e.entityType, entityId: e.entityId,
        action: e.action, data: e.data, createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  static weekWindow(today: IsoDate) {
    return { from: today, to: addDays(today, 6) };
  }
}
