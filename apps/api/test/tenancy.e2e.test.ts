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

/**
 * Invitations ship in Phase 1b; until then tests add memberships directly in the database
 * to exercise the permission model end to end.
 */
async function addOrgMember(orgId: string, userId: string, role: 'ADMIN' | 'MEMBER' | 'GUEST') {
  await query('insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, $3)', [orgId, userId, role]);
}
async function addWorkspaceMember(workspaceId: string, userId: string, role: 'ADMIN' | 'MEMBER' | 'VIEWER') {
  await query('insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, $3)', [workspaceId, userId, role]);
}

describe('cross-tenant isolation (AC-4)', () => {
  it('another user cannot read, modify or discover a private workspace, project or task', async () => {
    const a = await signUp(app, 'Alice');
    const b = await signUp(app, 'Bob');
    const p = (await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'Secret' })).body.project;
    const t = (await send(a.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Secret task' })).body.task;

    const attempts = [
      b.agent.get(`/api/v1/workspaces/${a.workspaceId}/projects`),
      send(b.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'Intrude' }),
      b.agent.get(`/api/v1/projects/${p.id}`),
      b.agent.get(`/api/v1/projects/${p.id}/tasks`),
      b.agent.get(`/api/v1/projects/${p.id}/readiness`),
      b.agent.get(`/api/v1/projects/${p.id}/activity`),
      send(b.agent, 'patch', `/api/v1/projects/${p.id}`, { expectedVersion: 1, name: 'Pwned' }),
      send(b.agent, 'delete', `/api/v1/projects/${p.id}`),
      send(b.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Intrude' }),
      send(b.agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, title: 'Pwned' }),
      send(b.agent, 'delete', `/api/v1/tasks/${t.id}`),
      send(b.agent, 'post', `/api/v1/organisations/${a.personalOrgId}/workspaces`, { name: 'Intrude' }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }

    const [proj] = await query<{ name: string }>('select name from projects where id = $1', [p.id]);
    expect(proj!.name).toBe('Secret');
    expect(await query('select id from tasks')).toHaveLength(1);
    expect((await b.agent.get('/api/v1/me/tasks')).body.tasks).toEqual([]);
    const bOrgs = (await b.agent.get('/api/v1/organisations')).body.organisations;
    expect(bOrgs.map((o: { id: string }) => o.id)).not.toContain(a.personalOrgId);
  });

  it('cannot assign tasks to users outside the workspace', async () => {
    const a = await signUp(app, 'Alice');
    const b = await signUp(app, 'Bob');
    const p = (await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'X' })).body.project;
    const res = await send(a.agent, 'post', `/api/v1/projects/${p.id}/tasks`, { title: 'Y', assigneeId: b.user.id });
    expect(res.status).toBe(400);
  });

  it('treats malformed ids as not found', async () => {
    const a = await signUp(app, 'Alice');
    expect((await a.agent.get('/api/v1/projects/not-a-uuid')).status).toBe(404);
  });
});

describe('roles inside a team organisation (AC-5)', () => {
  async function teamSetup() {
    const owner = await signUp(app, 'Owner');
    const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Acme Agency' })).body.organisation;
    const wsId = org.workspaces[0].id as string;
    const project = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Client site' })).body.project;
    const task = (await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'Brief' })).body.task;
    return { owner, org, wsId, project, task };
  }

  it('viewer can read but every write is 403', async () => {
    const { org, wsId, project, task } = await teamSetup();
    const viewer = await signUp(app, 'Viewer');
    await addOrgMember(org.id, viewer.user.id, 'MEMBER');
    await addWorkspaceMember(wsId, viewer.user.id, 'VIEWER');

    expect((await viewer.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(200);
    expect((await viewer.agent.get(`/api/v1/projects/${project.id}/tasks`)).status).toBe(200);
    const writes = await Promise.all([
      send(viewer.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'No' }),
      send(viewer.agent, 'patch', `/api/v1/projects/${project.id}`, { expectedVersion: 1, name: 'No' }),
      send(viewer.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'No' }),
      send(viewer.agent, 'patch', `/api/v1/tasks/${task.id}`, { expectedVersion: 1, title: 'No' }),
      send(viewer.agent, 'delete', `/api/v1/tasks/${task.id}`),
      send(viewer.agent, 'post', `/api/v1/organisations/${org.id}/workspaces`, { name: 'No' }),
    ]);
    expect(writes.map((w) => w.status)).toEqual([403, 403, 403, 403, 403, 403]);
  });

  it('org member without workspace membership cannot see the workspace', async () => {
    const { org, wsId, project } = await teamSetup();
    const m = await signUp(app, 'Member');
    await addOrgMember(org.id, m.user.id, 'MEMBER');
    expect((await m.agent.get(`/api/v1/workspaces/${wsId}/projects`)).status).toBe(404);
    expect((await m.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(404);
    const orgs = (await m.agent.get('/api/v1/organisations')).body.organisations;
    expect(orgs.find((o: { id: string }) => o.id === org.id).workspaces).toEqual([]);
  });

  it('workspace member can work on tasks but cannot delete projects they did not create', async () => {
    const { org, wsId, project, task } = await teamSetup();
    const m = await signUp(app, 'Member');
    await addOrgMember(org.id, m.user.id, 'MEMBER');
    await addWorkspaceMember(wsId, m.user.id, 'MEMBER');

    expect((await send(m.agent, 'patch', `/api/v1/tasks/${task.id}`, { expectedVersion: 1, assigneeId: m.user.id })).status).toBe(200);
    expect((await send(m.agent, 'delete', `/api/v1/projects/${project.id}`)).status).toBe(403);
    const own = (await send(m.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Mine' })).body.project;
    expect((await send(m.agent, 'delete', `/api/v1/projects/${own.id}`)).status).toBe(204);
    const detail = (await m.agent.get(`/api/v1/projects/${project.id}`)).body.project;
    expect(detail.members.map((u: { name: string }) => u.name).sort()).toEqual(['Member', 'Owner']);
  });

  it('org admin administers every workspace without explicit membership', async () => {
    const { org, project } = await teamSetup();
    const admin = await signUp(app, 'Admin');
    await addOrgMember(org.id, admin.user.id, 'ADMIN');
    expect((await send(admin.agent, 'delete', `/api/v1/projects/${project.id}`)).status).toBe(204);
    expect((await send(admin.agent, 'post', `/api/v1/organisations/${org.id}/workspaces`, { name: 'Ops' })).status).toBe(201);
  });

  it('a personal user can join an organisation and keeps their personal workspace', async () => {
    const { org, wsId } = await teamSetup();
    const free = await signUp(app, 'Freelancer');
    await addOrgMember(org.id, free.user.id, 'GUEST');
    await addWorkspaceMember(wsId, free.user.id, 'ADMIN'); // guests are capped at MEMBER
    const orgs = (await free.agent.get('/api/v1/organisations')).body.organisations;
    expect(orgs.map((o: { kind: string }) => o.kind)).toEqual(['PERSONAL', 'TEAM']);
    expect(orgs[1].workspaces[0].role).toBe('MEMBER');
  });

  it('removing a membership immediately removes access', async () => {
    const { org, wsId, project } = await teamSetup();
    const m = await signUp(app, 'Leaver');
    await addOrgMember(org.id, m.user.id, 'MEMBER');
    await addWorkspaceMember(wsId, m.user.id, 'MEMBER');
    expect((await m.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(200);
    await query('delete from organisation_memberships where user_id = $1', [m.user.id]);
    expect((await m.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(404);
  });
});

describe('database integrity', () => {
  it('composite foreign keys reject a task whose project is in another workspace', async () => {
    const a = await signUp(app, 'Alice');
    const b = await signUp(app, 'Bob');
    const p = (await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'X' })).body.project;
    const [bOrg] = await query<{ organisation_id: string }>('select organisation_id from workspaces where id = $1', [b.workspaceId]);
    await expect(
      query(
        `insert into tasks (organisation_id, workspace_id, project_id, title, creator_id) values ($1, $2, $3, 'evil', $4)`,
        [bOrg!.organisation_id, b.workspaceId, p.id, b.user.id],
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('at most one personal organisation per user', async () => {
    const a = await signUp(app, 'Alice');
    await expect(
      query(`insert into organisations (name, slug, kind, personal_owner_id) values ('dup', 'dup-x', 'PERSONAL', $1)`, [a.user.id]),
    ).rejects.toThrow(/unique/);
  });
});
