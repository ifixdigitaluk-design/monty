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

async function team() {
  const owner = await signUp(app, 'Olga');
  const admin = await signUp(app, 'Adam');
  const member = await signUp(app, 'Mia');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Acme' })).body.organisation;
  const ws = org.workspaces[0].id as string;
  await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`, [org.id, admin.user.id, member.user.id]);
  await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'MEMBER')`, [ws, member.user.id]);
  return { owner, admin, member, org, ws };
}

describe('chat channels: owners and workspace admins manage any channel', () => {
  it('several channels; delete by creator or workspace admin, not by other members; messages go with it', async () => {
    const { owner, admin, member, ws } = await team();
    const mk = async (who: typeof owner, name: string) => (await send(who.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name })).body.channel;
    const a = await mk(member, 'sales');
    const b = await mk(member, 'marketing');
    await mk(owner, 'general');
    const list = (await owner.agent.get(`/api/v1/workspaces/${ws}/channels`)).body.channels;
    expect(list.map((c: { name: string }) => c.name).sort()).toEqual(['general', 'marketing', 'sales']);
    // The owner didn't create #sales but can manage it; Mia created it; Adam (org admin) can too.
    expect(list.find((c: { name: string }) => c.name === 'sales').canManage).toBe(true);
    expect((await member.agent.get(`/api/v1/workspaces/${ws}/channels`)).body.channels.find((c: { name: string }) => c.name === 'general').canManage).toBe(false);

    await send(member.agent, 'post', `/api/v1/channels/${a.id}/messages`, { body: 'hello' });
    expect((await send(member.agent, 'delete', `/api/v1/channels/${(await owner.agent.get(`/api/v1/workspaces/${ws}/channels`)).body.channels.find((c: { name: string }) => c.name === 'general').id}`)).status).toBe(403);
    expect((await send(owner.agent, 'patch', `/api/v1/channels/${a.id}`, { name: 'sales-uk' })).body.channel.name).toBe('sales-uk');
    expect((await send(owner.agent, 'delete', `/api/v1/channels/${a.id}`)).status).toBe(204);
    expect((await send(admin.agent, 'delete', `/api/v1/channels/${b.id}`)).status).toBe(204);
    expect((await query(`select count(*)::int as n from messages`))[0]).toEqual({ n: 0 });
    expect((await owner.agent.get(`/api/v1/workspaces/${ws}/channels`)).body.channels.map((c: { name: string }) => c.name)).toEqual(['general']);
    const audit = await query<{ action: string }>(`select action from audit_logs where action = 'chat.channel_deleted'`);
    expect(audit).toHaveLength(2);
  });
});

describe('workspaces (departments): rename and delete', () => {
  it('org owners/admins rename and delete; members cannot; the last workspace and personal ones are kept', async () => {
    const { owner, admin, member, org, ws } = await team();
    const sales = (await send(owner.agent, 'post', `/api/v1/organisations/${org.id}/workspaces`, { name: 'Sales' })).body.workspace;
    expect((await send(member.agent, 'patch', `/api/v1/workspaces/${ws}`, { name: 'X' })).status).toBe(403);
    expect((await send(admin.agent, 'patch', `/api/v1/workspaces/${sales.id}`, { name: 'Sales UK' })).body.workspace.name).toBe('Sales UK');
    expect((await send(owner.agent, 'delete', `/api/v1/workspaces/${sales.id}`, { confirmName: 'Sales' })).status).toBe(400);
    expect((await send(member.agent, 'delete', `/api/v1/workspaces/${sales.id}`, { confirmName: 'Sales UK' })).status).toBe(404); // not a member: can't even see it
    expect((await send(owner.agent, 'delete', `/api/v1/workspaces/${sales.id}`, { confirmName: 'Sales UK' })).status).toBe(204);
    const orgs = (await owner.agent.get('/api/v1/organisations')).body.organisations;
    expect(orgs.find((o: { id: string }) => o.id === org.id).workspaces.map((w: { name: string }) => w.name)).toEqual(['General']);
    expect((await owner.agent.get(`/api/v1/workspaces/${sales.id}/projects`)).status).toBe(404);
    // The last one stays.
    const last = await send(owner.agent, 'delete', `/api/v1/workspaces/${ws}`, { confirmName: 'General' });
    expect(last.status).toBe(400);
    expect(last.body.error.message).toMatch(/at least one workspace/);
    expect((await send(owner.agent, 'delete', `/api/v1/workspaces/${owner.workspaceId}`, { confirmName: 'Personal' })).status).toBe(400);
  });
});

describe('plans: owners choose', () => {
  it('owner switches plan (audited); limits follow; admins and members cannot', async () => {
    const { owner, admin, org } = await team();
    expect((await owner.agent.get(`/api/v1/organisations/${org.id}/usage`)).body.plan).toBe('FREE');
    expect((await send(admin.agent, 'put', `/api/v1/organisations/${org.id}/plan`, { plan: 'ENTERPRISE' })).status).toBe(403);
    expect((await send(owner.agent, 'put', `/api/v1/organisations/${org.id}/plan`, { plan: 'GOLD' })).status).toBe(400);
    const res = await send(owner.agent, 'put', `/api/v1/organisations/${org.id}/plan`, { plan: 'ENTERPRISE' });
    expect(res.body).toMatchObject({ plan: 'ENTERPRISE', limits: { members: null, projects: null } });
    // Free allowed 5 members; Enterprise lets the 6th+ invitation through.
    for (let i = 0; i < 6; i++) {
      expect((await send(owner.agent, 'post', `/api/v1/organisations/${org.id}/invitations`, { email: `staff${i}@example.com`, role: 'MEMBER' })).status).toBe(201);
    }
    const [a] = await query<{ data: Record<string, unknown> }>(`select data from audit_logs where action = 'organisation.plan_changed'`);
    expect(a!.data).toEqual({ from: 'FREE', to: 'ENTERPRISE' });
  });
});
