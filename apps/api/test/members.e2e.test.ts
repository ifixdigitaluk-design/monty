import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

type User = Awaited<ReturnType<typeof signUp>>;

async function team(owner: User, name = 'Acme') {
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name })).body.organisation;
  return { orgId: org.id as string, wsId: org.workspaces[0].id as string };
}

/** Invites `invitee` and accepts as them; returns the invitation API response. */
async function inviteAndAccept(owner: User, invitee: User, orgId: string, body: object = {}) {
  const inv = await send(owner.agent, 'post', `/api/v1/organisations/${orgId}/invitations`, { email: invitee.email, role: 'MEMBER', ...body });
  expect(inv.status).toBe(201);
  const token = new URLSearchParams(inv.body.invitation.invitePath.split('?')[1]).get('token')!;
  const acc = await send(invitee.agent, 'post', `/api/v1/invitations/${token}/accept`);
  expect(acc.status).toBe(200);
  return { inv: inv.body.invitation, token, accepted: acc.body };
}

const tokenOf = (path: string) => new URLSearchParams(path.split('?')[1]).get('token')!;

describe('invitations (B-01)', () => {
  it('invite → preview → accept grants org and workspace access', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const { orgId, wsId } = await team(owner);
    const project = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Shared' })).body.project;

    expect((await bob.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(404);

    const inv = await send(owner.agent, 'post', `/api/v1/organisations/${orgId}/invitations`, {
      email: bob.email.toUpperCase(),
      role: 'MEMBER',
      workspaceId: wsId,
      workspaceRole: 'MEMBER',
    });
    expect(inv.status).toBe(201);
    expect(inv.body.invitation).toMatchObject({ email: bob.email, role: 'MEMBER', workspaceName: 'General', status: 'pending' });
    const token = tokenOf(inv.body.invitation.invitePath);

    // The raw token is never stored.
    expect(await query('select 1 from invitations where token_hash = $1', [token])).toHaveLength(0);

    const preview = await request(app.getHttpServer()).get(`/api/v1/invitations/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.invitation).toMatchObject({ organisationName: 'Acme', invitedByName: 'Owner', status: 'pending' });

    const acc = await send(bob.agent, 'post', `/api/v1/invitations/${token}/accept`);
    expect(acc.body).toEqual({ organisationId: orgId, workspaceId: wsId });
    expect((await bob.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(200);

    // Single use.
    const again = await send(bob.agent, 'post', `/api/v1/invitations/${token}/accept`);
    expect(again.status).toBe(410);
    expect((await request(app.getHttpServer()).get(`/api/v1/invitations/${token}`)).body.invitation.status).toBe('accepted');
  });

  it('cannot be accepted by a different account (forwarded link)', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const eve = await signUp(app, 'Eve');
    const { orgId } = await team(owner);
    const inv = await send(owner.agent, 'post', `/api/v1/organisations/${orgId}/invitations`, { email: bob.email, role: 'ADMIN' });
    const res = await send(eve.agent, 'post', `/api/v1/invitations/${tokenOf(inv.body.invitation.invitePath)}/accept`);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain(bob.email);
    expect(await query('select 1 from organisation_memberships where user_id = $1', [eve.user.id])).toHaveLength(1); // only personal
  });

  it('expired and revoked invitations cannot be used', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const { orgId } = await team(owner);
    const inv = await send(owner.agent, 'post', `/api/v1/organisations/${orgId}/invitations`, { email: bob.email, role: 'MEMBER' });
    const token = tokenOf(inv.body.invitation.invitePath);
    await query(`update invitations set expires_at = now() - interval '1 minute' where id = $1`, [inv.body.invitation.id]);
    expect((await send(bob.agent, 'post', `/api/v1/invitations/${token}/accept`)).status).toBe(410);

    // An expired invite does not block a fresh one.
    const fresh = await send(owner.agent, 'post', `/api/v1/organisations/${orgId}/invitations`, { email: bob.email, role: 'MEMBER' });
    expect(fresh.status).toBe(201);
    expect((await send(owner.agent, 'delete', `/api/v1/organisations/${orgId}/invitations/${fresh.body.invitation.id}`)).status).toBe(204);
    expect((await send(bob.agent, 'post', `/api/v1/invitations/${tokenOf(fresh.body.invitation.invitePath)}/accept`)).status).toBe(410);
  });

  it('rejects duplicates, existing members, owner invites, personal orgs and non-admin inviters', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const carl = await signUp(app, 'Carl');
    const { orgId } = await team(owner);
    const url = `/api/v1/organisations/${orgId}/invitations`;

    expect((await send(owner.agent, 'post', url, { email: 'new@example.com', role: 'MEMBER' })).status).toBe(201);
    expect((await send(owner.agent, 'post', url, { email: 'new@example.com', role: 'GUEST' })).status).toBe(409);
    expect((await send(owner.agent, 'post', url, { email: owner.email, role: 'MEMBER' })).status).toBe(409);
    expect((await send(owner.agent, 'post', url, { email: 'x@example.com', role: 'OWNER' })).status).toBe(400);
    expect(
      (await send(owner.agent, 'post', `/api/v1/organisations/${owner.personalOrgId}/invitations`, { email: 'y@example.com', role: 'MEMBER' })).status,
    ).toBe(400);

    await inviteAndAccept(owner, bob, orgId);
    expect((await send(bob.agent, 'post', url, { email: carl.email, role: 'MEMBER' })).status).toBe(403);
    expect((await bob.agent.get(url)).status).toBe(403);
    // Outsiders can't even see the organisation exists.
    expect((await send(carl.agent, 'post', url, { email: 'z@example.com', role: 'MEMBER' })).status).toBe(404);
  });

  it('rejects a workspace from another organisation', async () => {
    const owner = await signUp(app, 'Owner');
    const { orgId } = await team(owner, 'A');
    const other = await team(owner, 'B');
    const res = await send(owner.agent, 'post', `/api/v1/organisations/${orgId}/invitations`, {
      email: 'n@example.com',
      role: 'MEMBER',
      workspaceId: other.wsId,
      workspaceRole: 'VIEWER',
    });
    expect(res.status).toBe(400);
  });

  it('applies the invited role on acceptance', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const { orgId } = await team(owner);
    await inviteAndAccept(owner, bob, orgId, { role: 'ADMIN' });
    // Re-invite is blocked because Bob is now a member, so check the rule via a direct pending row instead.
    const members = (await owner.agent.get(`/api/v1/organisations/${orgId}/members`)).body.members;
    expect(members.find((m: { id: string }) => m.id === bob.user.id).role).toBe('ADMIN');
  });

  it('lists pending invitations for admins', async () => {
    const owner = await signUp(app, 'Owner');
    const { orgId } = await team(owner);
    await send(owner.agent, 'post', `/api/v1/organisations/${orgId}/invitations`, { email: 'p@example.com', role: 'GUEST' });
    const list = await owner.agent.get(`/api/v1/organisations/${orgId}/invitations`);
    expect(list.body.invitations).toHaveLength(1);
    expect(list.body.invitations[0]).not.toHaveProperty('invitePath');
  });
});

describe('member management (B-02)', () => {
  it('lists members with workspace access', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const { orgId, wsId } = await team(owner);
    await inviteAndAccept(owner, bob, orgId, { workspaceId: wsId, workspaceRole: 'VIEWER' });
    const res = await bob.agent.get(`/api/v1/organisations/${orgId}/members`);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual(['Bob:MEMBER', 'Owner:OWNER']);
    expect(res.body.members[0].workspaces).toEqual([{ id: wsId, name: 'General', role: 'VIEWER' }]);
  });

  it('owner safeguards: last owner cannot be demoted or leave; admins cannot touch owners', async () => {
    const owner = await signUp(app, 'Owner');
    const admin = await signUp(app, 'Admin');
    const { orgId } = await team(owner);
    await inviteAndAccept(owner, admin, orgId, { role: 'ADMIN' });
    const m = (u: User) => `/api/v1/organisations/${orgId}/members/${u.user.id}`;

    expect((await send(owner.agent, 'patch', m(owner), { role: 'ADMIN' })).status).toBe(403);
    expect((await send(owner.agent, 'delete', m(owner))).status).toBe(403);
    expect((await send(admin.agent, 'patch', m(owner), { role: 'MEMBER' })).status).toBe(403);
    expect((await send(admin.agent, 'delete', m(owner))).status).toBe(403);
    expect((await send(admin.agent, 'patch', m(admin), { role: 'OWNER' })).status).toBe(403);

    // Owner promotes admin → two owners → original owner may now step down.
    expect((await send(owner.agent, 'patch', m(admin), { role: 'OWNER' })).status).toBe(204);
    expect((await send(owner.agent, 'patch', m(owner), { role: 'MEMBER' })).status).toBe(204);
    const owners = await query(`select 1 from organisation_memberships where organisation_id = $1 and role = 'OWNER'`, [orgId]);
    expect(owners).toHaveLength(1);
  });

  it('concurrent demotions can never leave zero owners', async () => {
    const a = await signUp(app, 'A');
    const b = await signUp(app, 'B');
    const { orgId } = await team(a);
    await inviteAndAccept(a, b, orgId, { role: 'ADMIN' });
    await send(a.agent, 'patch', `/api/v1/organisations/${orgId}/members/${b.user.id}`, { role: 'OWNER' });
    // Each owner tries to demote the other at the same time.
    const [r1, r2] = await Promise.all([
      send(a.agent, 'patch', `/api/v1/organisations/${orgId}/members/${b.user.id}`, { role: 'MEMBER' }),
      send(b.agent, 'patch', `/api/v1/organisations/${orgId}/members/${a.user.id}`, { role: 'MEMBER' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([204, 403]);
    const owners = await query(`select 1 from organisation_memberships where organisation_id = $1 and role = 'OWNER'`, [orgId]);
    expect(owners).toHaveLength(1);
  });

  it('removing a member revokes all their workspace access in that org only', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const { orgId, wsId } = await team(owner);
    await inviteAndAccept(owner, bob, orgId, { workspaceId: wsId, workspaceRole: 'MEMBER' });
    const p = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'X' })).body.project;
    expect((await bob.agent.get(`/api/v1/projects/${p.id}`)).status).toBe(200);

    expect((await send(owner.agent, 'delete', `/api/v1/organisations/${orgId}/members/${bob.user.id}`)).status).toBe(204);
    expect((await bob.agent.get(`/api/v1/projects/${p.id}`)).status).toBe(404);
    expect(await query('select 1 from workspace_memberships where user_id = $1 and workspace_id = $2', [bob.user.id, wsId])).toHaveLength(0);
    // Bob's personal workspace is untouched.
    expect((await bob.agent.get(`/api/v1/workspaces/${bob.workspaceId}/projects`)).status).toBe(200);
  });

  it('a member can leave an organisation', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const { orgId } = await team(owner);
    await inviteAndAccept(owner, bob, orgId);
    expect((await send(bob.agent, 'delete', `/api/v1/organisations/${orgId}/members/${bob.user.id}`)).status).toBe(204);
    const orgs = (await bob.agent.get('/api/v1/organisations')).body.organisations;
    expect(orgs.map((o: { id: string }) => o.id)).not.toContain(orgId);
  });

  it('personal organisations cannot be left or have roles changed', async () => {
    const me = await signUp(app, 'Solo');
    expect((await send(me.agent, 'delete', `/api/v1/organisations/${me.personalOrgId}/members/${me.user.id}`)).status).toBe(400);
  });
});

describe('workspace access management', () => {
  it('admins grant, change and remove workspace access; members cannot', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const carl = await signUp(app, 'Carl');
    const { orgId, wsId } = await team(owner);
    await inviteAndAccept(owner, bob, orgId);
    await inviteAndAccept(owner, carl, orgId);
    const url = (u: User) => `/api/v1/workspaces/${wsId}/members/${u.user.id}`;

    // Bob has org membership only: no workspace access yet.
    expect((await bob.agent.get(`/api/v1/workspaces/${wsId}/projects`)).status).toBe(404);
    const list = (await owner.agent.get(`/api/v1/workspaces/${wsId}/members`)).body.members;
    expect(list.find((m: { id: string }) => m.id === bob.user.id)).toMatchObject({ workspaceRole: null, effectiveRole: null });

    expect((await send(owner.agent, 'put', url(bob), { role: 'VIEWER' })).status).toBe(204);
    expect((await bob.agent.get(`/api/v1/workspaces/${wsId}/projects`)).status).toBe(200);
    expect((await send(bob.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'No' })).status).toBe(403);

    expect((await send(owner.agent, 'put', url(bob), { role: 'MEMBER' })).status).toBe(204);
    expect((await send(bob.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Yes' })).status).toBe(201);

    // A member cannot manage access, and only sees people who already have access.
    expect((await send(bob.agent, 'put', url(carl), { role: 'MEMBER' })).status).toBe(403);
    const bobView = (await bob.agent.get(`/api/v1/workspaces/${wsId}/members`)).body.members;
    expect(bobView.map((m: { name: string }) => m.name)).toEqual(['Bob', 'Owner']);

    expect((await send(owner.agent, 'delete', url(bob))).status).toBe(204);
    expect((await bob.agent.get(`/api/v1/workspaces/${wsId}/projects`)).status).toBe(404);
  });

  it('cannot grant workspace access to someone outside the organisation', async () => {
    const owner = await signUp(app, 'Owner');
    const stranger = await signUp(app, 'Stranger');
    const { wsId } = await team(owner);
    expect((await send(owner.agent, 'put', `/api/v1/workspaces/${wsId}/members/${stranger.user.id}`, { role: 'VIEWER' })).status).toBe(400);
  });
});

describe('audit log (B-04)', () => {
  it('records security and admin events with actor and IP, visible to org admins only', async () => {
    const owner = await signUp(app, 'Owner');
    const bob = await signUp(app, 'Bob');
    const { orgId } = await team(owner);
    await inviteAndAccept(owner, bob, orgId);
    await send(owner.agent, 'patch', `/api/v1/organisations/${orgId}/members/${bob.user.id}`, { role: 'ADMIN' });
    await send(owner.agent, 'post', `/api/v1/organisations/${orgId}/workspaces`, { name: 'Ops' });

    const res = await owner.agent.get(`/api/v1/organisations/${orgId}/audit`);
    expect(res.status).toBe(200);
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['workspace.created', 'member.role_changed', 'invitation.accepted', 'invitation.created', 'organisation.created']);
    const roleChange = res.body.entries[1];
    expect(roleChange).toMatchObject({ actor: { name: 'Owner' }, targetId: bob.user.id, data: { from: 'MEMBER', to: 'ADMIN' } });
    expect(roleChange.ip).toBeTruthy();
    // No secrets in audit data.
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);

    const member = await signUp(app, 'Member');
    await inviteAndAccept(owner, member, orgId);
    expect((await member.agent.get(`/api/v1/organisations/${orgId}/audit`)).status).toBe(403);
  });

  it('records authentication events, including failed logins', async () => {
    const u = await signUp(app, 'Auth');
    const agent = request.agent(app.getHttpServer());
    await send(agent, 'post', '/api/v1/auth/login', { email: u.email, password: 'wrong-password!' });
    await send(agent, 'post', '/api/v1/auth/login', { email: 'nobody@example.com', password: 'wrong-password!' });
    await send(agent, 'post', '/api/v1/auth/login', { email: u.email, password: 'correct-horse-battery' });
    await send(agent, 'post', '/api/v1/auth/logout');
    const rows = await query<{ action: string; actor_id: string | null; data: Record<string, unknown> }>(
      `select action, actor_id, data from audit_logs where organisation_id is null order by created_at`,
    );
    expect(rows.map((r) => r.action)).toEqual(['auth.registered', 'auth.login_failed', 'auth.login_failed', 'auth.login', 'auth.logout']);
    expect(rows[1]).toMatchObject({ actor_id: u.user.id, data: { email: u.email } });
    expect(rows[2]).toMatchObject({ actor_id: null, data: {} }); // unknown emails are not stored
  });
});
