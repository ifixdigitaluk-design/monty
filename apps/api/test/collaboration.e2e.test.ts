import type { INestApplication } from '@nestjs/common';
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

type U = Awaited<ReturnType<typeof signUp>>;

/** Owner with a team workspace; `member` joins as workspace MEMBER, `viewer` as VIEWER. */
async function team() {
  const owner = await signUp(app, 'Owner');
  const member = await signUp(app, 'Mia');
  const viewer = await signUp(app, 'Vic');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Team' })).body.organisation;
  const wsId = org.workspaces[0].id as string;
  for (const [u, role] of [[member, 'MEMBER'], [viewer, 'VIEWER']] as const) {
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, u.user.id]);
    await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, $3)`, [wsId, u.user.id, role]);
  }
  const project = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Launch' })).body.project;
  return { owner, member, viewer, org, wsId, project };
}
const newTask = async (u: U, projectId: string, body: object) =>
  (await send(u.agent, 'post', `/api/v1/projects/${projectId}/tasks`, body)).body.task;

describe('milestones', () => {
  it('create, attach tasks, progress counts, complete, delete detaches tasks', async () => {
    const { owner, project } = await team();
    const m = await send(owner.agent, 'post', `/api/v1/projects/${project.id}/milestones`, { name: 'Beta', dueDate: '2030-03-01' });
    expect(m.status).toBe(201);
    const t1 = await newTask(owner, project.id, { title: 'A', milestoneId: m.body.milestone.id });
    await newTask(owner, project.id, { title: 'B', milestoneId: m.body.milestone.id, status: 'DONE' });
    let list = (await owner.agent.get(`/api/v1/projects/${project.id}/milestones`)).body.milestones;
    expect(list[0]).toMatchObject({ name: 'Beta', taskTotal: 2, taskDone: 1, completedAt: null });

    const done = await send(owner.agent, 'patch', `/api/v1/milestones/${m.body.milestone.id}`, { expectedVersion: 1, completed: true });
    expect(done.body.milestone.completedAt).not.toBeNull();
    expect((await send(owner.agent, 'patch', `/api/v1/milestones/${m.body.milestone.id}`, { expectedVersion: 1, name: 'x' })).status).toBe(409);

    expect((await send(owner.agent, 'delete', `/api/v1/milestones/${m.body.milestone.id}`)).status).toBe(204);
    list = (await owner.agent.get(`/api/v1/projects/${project.id}/milestones`)).body.milestones;
    expect(list).toEqual([]);
    const tasks = (await owner.agent.get(`/api/v1/projects/${project.id}/tasks`)).body.tasks;
    expect(tasks.find((t: { id: string }) => t.id === t1.id).milestoneId).toBeNull();
  });

  it('rejects a milestone from another project and viewers cannot create milestones', async () => {
    const { owner, viewer, project, wsId } = await team();
    const other = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Other' })).body.project;
    const m = (await send(owner.agent, 'post', `/api/v1/projects/${other.id}/milestones`, { name: 'M' })).body.milestone;
    expect((await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'x', milestoneId: m.id })).status).toBe(400);
    expect((await send(viewer.agent, 'post', `/api/v1/projects/${project.id}/milestones`, { name: 'No' })).status).toBe(403);
  });
});

describe('task dependencies', () => {
  it('adds, lists, rejects cycles / duplicates / cross-project, and feeds readiness', async () => {
    const { owner, project, wsId } = await team();
    const a = await newTask(owner, project.id, { title: 'Design', dueDate: '2030-02-01' });
    const b = await newTask(owner, project.id, { title: 'Build', dueDate: '2030-01-15' });
    const c = await newTask(owner, project.id, { title: 'Ship' });

    const ab = await send(owner.agent, 'post', `/api/v1/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id });
    expect(ab.status).toBe(201);
    expect((await send(owner.agent, 'post', `/api/v1/tasks/${c.id}/dependencies`, { dependsOnTaskId: b.id })).status).toBe(201);
    expect((await send(owner.agent, 'post', `/api/v1/tasks/${a.id}/dependencies`, { dependsOnTaskId: c.id })).status).toBe(400); // cycle
    expect((await send(owner.agent, 'post', `/api/v1/tasks/${a.id}/dependencies`, { dependsOnTaskId: a.id })).status).toBe(400); // self
    expect((await send(owner.agent, 'post', `/api/v1/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id })).status).toBe(409); // duplicate
    const other = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Other' })).body.project;
    const x = await newTask(owner, other.id, { title: 'X' });
    expect((await send(owner.agent, 'post', `/api/v1/tasks/${a.id}/dependencies`, { dependsOnTaskId: x.id })).status).toBe(400);

    const deps = (await owner.agent.get(`/api/v1/projects/${project.id}/dependencies`)).body.dependencies;
    expect(deps).toHaveLength(2);

    const r = (await owner.agent.get(`/api/v1/projects/${project.id}/readiness?today=2030-01-01`)).body.readiness;
    expect(r.checks.find((ch: { id: string }) => ch.id === 'dependencies_ordered')).toMatchObject({ passed: false, affectedTaskIds: [b.id] });
    expect(r.health.waitingTasks).toBe(2);

    expect((await send(owner.agent, 'delete', `/api/v1/tasks/${b.id}/dependencies/${ab.body.dependency.id}`)).status).toBe(204);
    const r2 = (await owner.agent.get(`/api/v1/projects/${project.id}/readiness?today=2030-01-01`)).body.readiness;
    expect(r2.checks.find((ch: { id: string }) => ch.id === 'dependencies_ordered').passed).toBe(true);
  });

  it('concurrent opposite edges cannot both succeed (no cycle)', async () => {
    const { owner, project } = await team();
    const a = await newTask(owner, project.id, { title: 'A' });
    const b = await newTask(owner, project.id, { title: 'B' });
    const [r1, r2] = await Promise.all([
      send(owner.agent, 'post', `/api/v1/tasks/${a.id}/dependencies`, { dependsOnTaskId: b.id }),
      send(owner.agent, 'post', `/api/v1/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 400]);
  });
});

describe('comments, mentions and notifications', () => {
  it('mentions and task followers are notified; only recipients see their notifications', async () => {
    const { owner, member, viewer, project } = await team();
    const outsider = await signUp(app, 'Out');
    const task = await newTask(owner, project.id, { title: 'Write copy', assigneeId: member.user.id });

    // Assignment notifies Mia.
    let inbox = (await member.agent.get('/api/v1/me/notifications')).body;
    expect(inbox.unread).toBe(1);
    expect(inbox.notifications[0]).toMatchObject({ type: 'assigned', entityId: task.id, actor: { name: 'Owner' } });

    const body = `Can you review? <@${viewer.user.id}> <@${outsider.user.id}>`;
    const c = await send(owner.agent, 'post', `/api/v1/tasks/${task.id}/comments`, { body });
    expect(c.status).toBe(201);
    expect(c.body.comment).toMatchObject({ body, taskId: task.id, author: { name: 'Owner' } });

    // Vic was mentioned; Mia (assignee) gets a comment notification; the outsider gets nothing.
    const vic = (await viewer.agent.get('/api/v1/me/notifications')).body;
    expect(vic.notifications.map((n: { type: string }) => n.type)).toEqual(['mention']);
    expect(vic.notifications[0].data.excerpt).toContain('Can you review?');
    inbox = (await member.agent.get('/api/v1/me/notifications')).body;
    expect(inbox.notifications.map((n: { type: string }) => n.type)).toEqual(['comment', 'assigned']);
    expect((await outsider.agent.get('/api/v1/me/notifications')).body.notifications).toEqual([]);
    // The author is never notified of their own comment.
    expect((await owner.agent.get('/api/v1/me/notifications')).body.notifications).toEqual([]);

    // Mark read.
    expect((await send(member.agent, 'post', '/api/v1/me/notifications/read', { ids: [inbox.notifications[0].id] })).body).toEqual({ updated: 1 });
    expect((await member.agent.get('/api/v1/me/notifications?unread=1')).body.notifications).toHaveLength(1);
    // Marking someone else's notification does nothing (RLS + user filter).
    expect((await send(viewer.agent, 'post', '/api/v1/me/notifications/read', { ids: [inbox.notifications[1].id] })).body).toEqual({ updated: 0 });
    expect((await send(member.agent, 'post', '/api/v1/me/notifications/read', {})).body).toEqual({ updated: 1 });

    const thread = (await viewer.agent.get(`/api/v1/tasks/${task.id}/comments`)).body.comments;
    expect(thread).toHaveLength(1);
  });

  it('viewers can read but not post; authors and workspace admins can delete', async () => {
    const { owner, member, viewer, project } = await team();
    expect((await send(viewer.agent, 'post', `/api/v1/projects/${project.id}/comments`, { body: 'hi' })).status).toBe(403);
    const mine = (await send(member.agent, 'post', `/api/v1/projects/${project.id}/comments`, { body: 'Kick-off notes' })).body.comment;
    expect((await viewer.agent.get(`/api/v1/projects/${project.id}/comments`)).body.comments).toHaveLength(1);
    const ownerComment = (await send(owner.agent, 'post', `/api/v1/projects/${project.id}/comments`, { body: 'Owner note' })).body.comment;
    expect((await send(member.agent, 'delete', `/api/v1/comments/${ownerComment.id}`)).status).toBe(403);
    expect((await send(member.agent, 'delete', `/api/v1/comments/${mine.id}`)).status).toBe(204);
    expect((await send(owner.agent, 'delete', `/api/v1/comments/${ownerComment.id}`)).status).toBe(204);
    expect((await owner.agent.get(`/api/v1/projects/${project.id}/comments`)).body.comments).toEqual([]);
  });

  it('outsiders cannot read or post comments', async () => {
    const { owner, project } = await team();
    const out = await signUp(app, 'Out');
    const task = await newTask(owner, project.id, { title: 'T' });
    expect((await out.agent.get(`/api/v1/tasks/${task.id}/comments`)).status).toBe(404);
    expect((await send(out.agent, 'post', `/api/v1/tasks/${task.id}/comments`, { body: 'x' })).status).toBe(404);
    expect((await out.agent.get(`/api/v1/projects/${project.id}/milestones`)).status).toBe(404);
  });

  it('idempotent comment create', async () => {
    const { owner, project } = await team();
    const id = crypto.randomUUID();
    const a = await send(owner.agent, 'post', `/api/v1/projects/${project.id}/comments`, { id, body: 'Once' });
    const b = await send(owner.agent, 'post', `/api/v1/projects/${project.id}/comments`, { id, body: 'Once' });
    expect(a.status).toBe(201);
    expect(b.body.comment.id).toBe(id);
    expect(await query('select 1 from comments')).toHaveLength(1);
  });
});
