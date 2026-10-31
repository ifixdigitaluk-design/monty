import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
});

async function createProject(agent: Awaited<ReturnType<typeof signUp>>['agent'], workspaceId: string, body: object = {}) {
  const res = await send(agent, 'post', `/api/v1/workspaces/${workspaceId}/projects`, { name: 'Website relaunch', ...body });
  expect(res.status).toBe(201);
  return res.body.project as { id: string; version: number };
}

describe('projects (AC-3, AC-6)', () => {
  it('creates, lists, reads and persists a project', async () => {
    const { agent, workspaceId, user } = await signUp(app, 'Pm');
    const p = await createProject(agent, workspaceId, { objective: 'Ship it', ownerId: user.id, targetDate: '2026-12-01' });
    const list = await agent.get(`/api/v1/workspaces/${workspaceId}/projects`);
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0]).toMatchObject({ id: p.id, taskTotal: 0, taskDone: 0 });
    const get = await agent.get(`/api/v1/projects/${p.id}`);
    expect(get.body.project).toMatchObject({
      name: 'Website relaunch',
      objective: 'Ship it',
      ownerId: user.id,
      targetDate: '2026-12-01',
      lifecycle: 'DRAFT',
      role: 'ADMIN',
      version: 1,
    });
    expect(get.body.project.members.map((m: { id: string }) => m.id)).toEqual([user.id]);
  });

  it('updates with optimistic concurrency and rejects stale writes without changing data', async () => {
    const { agent, workspaceId } = await signUp(app, 'Occ');
    const p = await createProject(agent, workspaceId);
    const ok = await send(agent, 'patch', `/api/v1/projects/${p.id}`, { expectedVersion: 1, name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.project.version).toBe(2);

    const stale = await send(agent, 'patch', `/api/v1/projects/${p.id}`, { expectedVersion: 1, name: 'Lost update' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.current.name).toBe('Renamed');
    const [row] = await query<{ name: string; version: number }>('select name, version from projects where id = $1', [p.id]);
    expect(row).toEqual({ name: 'Renamed', version: 2 });
  });

  it('rejects owners who are not workspace members', async () => {
    const a = await signUp(app, 'A');
    const b = await signUp(app, 'B');
    const res = await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'X', ownerId: b.user.id });
    expect(res.status).toBe(400);
  });

  it('validates date ordering', async () => {
    const { agent, workspaceId } = await signUp(app, 'D');
    const res = await send(agent, 'post', `/api/v1/workspaces/${workspaceId}/projects`, {
      name: 'X',
      startDate: '2026-12-02',
      targetDate: '2026-12-01',
    });
    expect(res.status).toBe(400);
  });

  it('soft-deletes projects', async () => {
    const { agent, workspaceId } = await signUp(app, 'Del');
    const p = await createProject(agent, workspaceId);
    expect((await send(agent, 'delete', `/api/v1/projects/${p.id}`)).status).toBe(204);
    expect((await agent.get(`/api/v1/projects/${p.id}`)).status).toBe(404);
    const rows = await query<{ deleted_at: Date | null }>('select deleted_at from projects where id = $1', [p.id]);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it('idempotent create: replaying the same id returns the original (AC-7)', async () => {
    const { agent, workspaceId } = await signUp(app, 'Idem');
    const id = randomUUID();
    const first = await send(agent, 'post', `/api/v1/workspaces/${workspaceId}/projects`, { id, name: 'Once' });
    const again = await send(agent, 'post', `/api/v1/workspaces/${workspaceId}/projects`, { id, name: 'Once' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.project.id).toBe(id);
    expect(await query('select id from projects')).toHaveLength(1);
  });
});

describe('tasks (AC-3, AC-6, AC-7)', () => {
  it('creates tasks and subtasks, lists them, and updates status', async () => {
    const { agent, workspaceId, user } = await signUp(app, 'T');
    const p = await createProject(agent, workspaceId);
    const t = await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, {
      title: 'Design homepage',
      assigneeId: user.id,
      dueDate: '2026-11-15',
      priority: 'HIGH',
    });
    expect(t.status).toBe(201);
    const sub = await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Hero image', parentTaskId: t.body.task.id });
    expect(sub.status).toBe(201);
    expect(sub.body.task.sortOrder).toBeGreaterThan(t.body.task.sortOrder);

    const list = await agent.get(`/api/v1/projects/${p.id}/tasks`);
    expect(list.body.tasks.map((x: { title: string }) => x.title)).toEqual(['Design homepage', 'Hero image']);

    const done = await send(agent, 'patch', `/api/v1/tasks/${t.body.task.id}`, { expectedVersion: 1, status: 'DONE' });
    expect(done.status).toBe(200);
    expect(done.body.task.completedAt).not.toBeNull();
    const reopen = await send(agent, 'patch', `/api/v1/tasks/${t.body.task.id}`, { expectedVersion: 2, status: 'TODO' });
    expect(reopen.body.task.completedAt).toBeNull();

    const counts = await agent.get(`/api/v1/workspaces/${workspaceId}/projects`);
    expect(counts.body.projects[0]).toMatchObject({ taskTotal: 2, taskDone: 0 });
  });

  it('rejects a parent task from another project', async () => {
    const { agent, workspaceId } = await signUp(app, 'Par');
    const p1 = await createProject(agent, workspaceId);
    const p2 = await createProject(agent, workspaceId);
    const t = await send(agent, 'post', `/api/v1/projects/${p1.id}/tasks`, { title: 'In p1' });
    const res = await send(agent, 'post', `/api/v1/projects/${p2.id}/tasks`, { title: 'Bad', parentTaskId: t.body.task.id });
    expect(res.status).toBe(400);
  });

  it('stale task update returns 409 and keeps newer data', async () => {
    const { agent, workspaceId } = await signUp(app, 'Stale');
    const p = await createProject(agent, workspaceId);
    const t = (await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Original' })).body.task;
    await send(agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, title: 'Newer' });
    const stale = await send(agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, title: 'Older' });
    expect(stale.status).toBe(409);
    const [row] = await query<{ title: string }>('select title from tasks where id = $1', [t.id]);
    expect(row!.title).toBe('Newer');
  });

  it('concurrent creates with the same id produce exactly one task', async () => {
    const { agent, workspaceId } = await signUp(app, 'Race');
    const p = await createProject(agent, workspaceId);
    const id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { id, title: 'Once' })),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await query('select id from tasks where id = $1', [id])).toHaveLength(1);
  });

  it('deleting a task soft-deletes its subtasks', async () => {
    const { agent, workspaceId } = await signUp(app, 'Cascade');
    const p = await createProject(agent, workspaceId);
    const parent = (await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Parent' })).body.task;
    await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Child', parentTaskId: parent.id });
    expect((await send(agent, 'delete', `/api/v1/tasks/${parent.id}`)).status).toBe(204);
    expect((await agent.get(`/api/v1/projects/${p.id}/tasks`)).body.tasks).toHaveLength(0);
  });

  it('writes activity and outbox events in the same transaction (F-12)', async () => {
    const { agent, workspaceId } = await signUp(app, 'Act');
    const p = await createProject(agent, workspaceId);
    const t = (await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Track me' })).body.task;
    await send(agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, status: 'IN_PROGRESS' });

    const activity = await agent.get(`/api/v1/projects/${p.id}/activity`);
    expect(activity.body.activity.map((a: { entityType: string; action: string }) => `${a.entityType}.${a.action}`)).toEqual([
      'task.updated',
      'task.created',
      'project.created',
    ]);
    expect(activity.body.activity[0].data.changes).toEqual({ status: { from: 'TODO', to: 'IN_PROGRESS' } });

    const outbox = await query<{ topic: string; entity_version: number }>(
      'select topic, entity_version from outbox_events order by created_at',
    );
    expect(outbox).toEqual([
      { topic: 'project.created', entity_version: 1 },
      { topic: 'task.created', entity_version: 1 },
      { topic: 'task.updated', entity_version: 2 },
    ]);
  });
});

describe('readiness endpoint (AC-9)', () => {
  it('reflects real data and changes when data changes', async () => {
    const { agent, workspaceId, user } = await signUp(app, 'Ready');
    const p = await createProject(agent, workspaceId);
    const r1 = (await agent.get(`/api/v1/projects/${p.id}/readiness?today=2026-10-31`)).body.readiness;
    expect(r1.ready).toBe(false);
    expect(r1.computedStatus).toBe('DRAFT');
    expect(r1.checks.filter((c: { passed: boolean }) => !c.passed).map((c: { id: string }) => c.id)).toEqual([
      'objective_defined',
      'owner_assigned',
      'target_date_set',
      'has_tasks',
    ]);

    await send(agent, 'patch', `/api/v1/projects/${p.id}`, {
      expectedVersion: 1,
      objective: 'Relaunch',
      ownerId: user.id,
      targetDate: '2026-12-01',
    });
    const t = (await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Unassigned work' })).body.task;
    const r2 = (await agent.get(`/api/v1/projects/${p.id}/readiness?today=2026-10-31`)).body.readiness;
    const assigned = r2.checks.find((c: { id: string }) => c.id === 'tasks_assigned');
    expect(assigned).toMatchObject({ passed: false, affectedTaskIds: [t.id] });
    expect(r2.ready).toBe(false);

    await send(agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, assigneeId: user.id });
    const r3 = (await agent.get(`/api/v1/projects/${p.id}/readiness?today=2026-10-31`)).body.readiness;
    expect(r3.ready).toBe(true);
    expect(r3.computedStatus).toBe('READY_TO_START');

    await send(agent, 'patch', `/api/v1/projects/${p.id}`, { expectedVersion: 2, lifecycle: 'ACTIVE' });
    await send(agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 2, blockedReason: 'Waiting for copy' });
    const r4 = (await agent.get(`/api/v1/projects/${p.id}/readiness?today=2026-10-31`)).body.readiness;
    expect(r4.computedStatus).toBe('BLOCKED');
  });

  it('rejects an invalid today parameter', async () => {
    const { agent, workspaceId } = await signUp(app, 'Q');
    const p = await createProject(agent, workspaceId);
    expect((await agent.get(`/api/v1/projects/${p.id}/readiness?today=yesterday`)).status).toBe(400);
  });
});

describe('my tasks', () => {
  it('returns open tasks assigned to me across workspaces, with project names', async () => {
    const { agent, workspaceId, user } = await signUp(app, 'Me');
    const p = await createProject(agent, workspaceId, { name: 'Alpha' });
    await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Mine later', assigneeId: user.id, dueDate: '2027-01-01' });
    await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Mine soon', assigneeId: user.id, dueDate: '2026-11-01' });
    await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Mine done', assigneeId: user.id, status: 'DONE' });
    await send(agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Not mine' });

    const org = (await send(agent, 'post', '/api/v1/organisations', { name: 'Team' })).body.organisation;
    const p2 = await createProject(agent, org.workspaces[0].id, { name: 'Beta' });
    await send(agent, 'post', `/api/v1/projects/${p2.id}/tasks`, { title: 'Team task', assigneeId: user.id });

    const res = await agent.get('/api/v1/me/tasks');
    expect(res.body.tasks.map((t: { title: string; projectName: string }) => `${t.projectName}:${t.title}`)).toEqual([
      'Alpha:Mine soon',
      'Alpha:Mine later',
      'Beta:Team task',
    ]);
  });
});
