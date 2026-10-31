import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetDb, send, signUp } from './helpers';

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

describe('search', () => {
  it('finds projects, tasks and comments by prefix, only within accessible workspaces', async () => {
    const a = await signUp(app, 'Alice');
    const b = await signUp(app, 'Bob');
    const p = (await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'Website redesign', objective: 'New marketing homepage' })).body.project;
    const t = (await send(a.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Homepage hero', description: 'Photography for the hero banner' })).body.task;
    await send(a.agent, 'post', `/api/v1/tasks/${t.id}/comments`, { body: 'Banner photography booked for Tuesday' });
    await send(b.agent, 'post', `/api/v1/workspaces/${b.workspaceId}/projects`, { name: 'Homepage for Bob' });

    const res = await a.agent.get('/api/v1/search?q=homep');
    expect(res.status).toBe(200);
    const kinds = res.body.results.map((r: { type: string; title: string }) => `${r.type}:${r.title}`);
    expect(kinds).toContain('task:Homepage hero');
    expect(kinds).toContain('project:Website redesign');
    expect(kinds.join()).not.toContain('Bob'); // other tenant never appears

    const photo = (await a.agent.get('/api/v1/search?q=photograph banner')).body.results;
    expect(photo.map((r: { type: string }) => r.type).sort()).toEqual(['comment', 'task']);
    expect(photo.find((r: { type: string }) => r.type === 'comment')).toMatchObject({ taskId: t.id, projectId: p.id });
    expect(photo[0].snippet).toMatch(/\[\[/);

    // Operator characters cannot break or inject into the query.
    expect((await a.agent.get(`/api/v1/search?q=${encodeURIComponent("'):* | !")}`)).body.results).toEqual([]);
    expect((await a.agent.get('/api/v1/search?q=')).status).toBe(400);
    // Deleted items disappear.
    await send(a.agent, 'delete', `/api/v1/tasks/${t.id}`);
    expect((await a.agent.get('/api/v1/search?q=hero')).body.results).toEqual([]);
  });
});

describe('calendar', () => {
  it('returns tasks and milestones in range; mine filter; range limits', async () => {
    const a = await signUp(app, 'Cal');
    const p = (await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'P' })).body.project;
    await send(a.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Mine', dueDate: '2030-03-10', assigneeId: a.user.id });
    await send(a.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Unassigned', dueDate: '2030-03-05' });
    await send(a.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Outside', dueDate: '2030-05-01' });
    await send(a.agent, 'post', `/api/v1/projects/${p.id}/milestones`, { name: 'Beta', dueDate: '2030-03-20' });

    const all = (await a.agent.get('/api/v1/calendar?from=2030-03-01&to=2030-03-31')).body.entries;
    expect(all.map((e: { kind: string; title: string }) => `${e.kind}:${e.title}`)).toEqual(['task:Unassigned', 'task:Mine', 'milestone:Beta']);
    const mine = (await a.agent.get('/api/v1/calendar?from=2030-03-01&to=2030-03-31&mine=1')).body.entries;
    expect(mine.map((e: { title: string }) => e.title)).toEqual(['Mine']);
    expect((await a.agent.get('/api/v1/calendar?from=2030-01-01&to=2030-12-31')).status).toBe(400);
  });
});

describe('home dashboard', () => {
  it('summarises my work and flags projects needing attention', async () => {
    const a = await signUp(app, 'Home');
    const p = (await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'Late project', objective: 'x', ownerId: a.user.id, targetDate: '2030-12-01' })).body.project;
    await send(a.agent, 'patch', `/api/v1/projects/${p.id}`, { expectedVersion: 1, lifecycle: 'ACTIVE' });
    await send(a.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Overdue', dueDate: '2030-01-01', assigneeId: a.user.id });
    await send(a.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Today', dueDate: '2030-01-10', assigneeId: a.user.id });
    await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'Empty draft' });

    const h = (await a.agent.get('/api/v1/me/home?today=2030-01-10')).body;
    expect(h.counts).toMatchObject({ overdue: 1, today: 1, open: 2 });
    const att = h.attention.map((x: { projectName: string; computedStatus: string }) => `${x.projectName}:${x.computedStatus}`);
    expect(att).toEqual(['Late project:AT_RISK', 'Empty draft:DRAFT']);
    expect(h.recentActivity.length).toBeGreaterThan(0);
  });
});
