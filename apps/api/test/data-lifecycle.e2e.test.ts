import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { MailService } from '../src/mail/mail.service';
import { LogTransport } from '../src/mail/transports';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

let app: INestApplication;
let mailbox: LogTransport;
beforeAll(async () => {
  app = await createTestApp();
  mailbox = app.get(MailService).transport as LogTransport;
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  mailbox.clear();
});

type U = Awaited<ReturnType<typeof signUp>>;
const PASSWORD = 'correct-horse-battery';

async function team() {
  const owner = await signUp(app, 'Olive');
  const member = await signUp(app, 'Milo');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Acme' })).body.organisation;
  const wsId = org.workspaces[0].id as string;
  await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, member.user.id]);
  await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'MEMBER')`, [wsId, member.user.id]);
  const project = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Launch' })).body.project;
  return { owner, member, org, wsId, project };
}
async function mailTo(to: string, kind: string) {
  await app.get(MailService).drain();
  const m = mailbox.messages(to).filter((x) => x.kind === kind).pop();
  if (!m) throw new Error(`no ${kind} mail for ${to}`);
  return m;
}
const tokenIn = (text: string, path: string) => new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(text)![1]!;
const login = (email: string) => request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Monty-Client', 'web').send({ email, password: PASSWORD });

describe('personal data export', () => {
  it('contains only the user’s own data, is encrypted at rest and needs both the session and the one-time token', async () => {
    const { owner, member, project } = await team();
    await send(member.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'Milo task', assigneeId: member.user.id });
    await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'Owner private task' });
    const stranger = await signUp(app, 'Stranger');
    const sp = (await send(stranger.agent, 'post', `/api/v1/workspaces/${stranger.workspaceId}/projects`, { name: 'Secret' })).body.project;
    await send(stranger.agent, 'post', `/api/v1/projects/${sp.id}/tasks`, { title: 'Stranger task', assigneeId: stranger.user.id });

    const created = await send(member.agent, 'post', '/api/v1/me/exports');
    expect(created.status).toBe(201);
    const ex = created.body.export;
    expect(ex.downloadPath).toMatch(/^\/api\/v1\/me\/exports\/[0-9a-f-]+\/download\?token=/);
    expect(Date.parse(ex.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);

    const [row] = await query<{ content: string }>(`select content from data_exports`);
    expect(row!.content).toMatch(/^v1\./);
    expect(row!.content).not.toContain(member.email);

    const dl = await member.agent.get(ex.downloadPath);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="monty-export-/);
    expect(dl.headers['cache-control']).toContain('no-store');
    const data = JSON.parse(Buffer.isBuffer(dl.body) ? dl.body.toString() : dl.text);
    expect(data.account.email).toBe(member.email);
    expect(data.tasks.map((t: { title: string }) => t.title)).toEqual(['Milo task']);
    expect(data.organisations.map((o: { name: string }) => o.name).sort()).toEqual(['Acme', "Milo's space"]);
    expect(JSON.stringify(data)).not.toContain('Owner private task');
    expect(JSON.stringify(data)).not.toContain('Stranger task');
    expect(JSON.stringify(data)).not.toContain(owner.email);
    expect(data.securityLog.map((a: { action: string }) => a.action)).toContain('auth.registered');

    // Another signed-in user with the full link, a wrong token, or no session: nothing.
    expect((await stranger.agent.get(ex.downloadPath)).status).toBe(404);
    expect((await member.agent.get(ex.downloadPath.replace(/token=.*/, 'token=' + 'x'.repeat(43)))).status).toBe(404);
    expect((await request(app.getHttpServer()).get(ex.downloadPath)).status).toBe(401);
    expect((await stranger.agent.get('/api/v1/me/exports')).body.exports).toEqual([]);

    // Cool-down, then expiry, then purge.
    expect((await send(member.agent, 'post', '/api/v1/me/exports')).status).toBe(429);
    await query(`update data_exports set expires_at = now() - interval '1 second'`);
    expect((await member.agent.get(ex.downloadPath)).status).toBe(410);
    expect((await app.get(MaintenanceService).runNow()).dataExports).toBe(1);
    expect(await query(`select 1 from data_exports`)).toHaveLength(0);
  });
});

describe('account deletion', () => {
  it('needs the password, and is blocked while the user is the only owner of a team with other members', async () => {
    const { owner, member, org } = await team();
    expect((await send(owner.agent, 'post', '/api/v1/me/deletion-request', { password: 'wrong-password-123' })).status).toBe(403);
    const blocked = await send(owner.agent, 'post', '/api/v1/me/deletion-request', { password: PASSWORD });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.blockers).toEqual([{ organisationId: org.id, name: 'Acme', memberCount: 2 }]);
    expect((await owner.agent.get('/api/v1/me/deletion-blockers')).body.blockers).toHaveLength(1);
    // Transfer ownership → no longer blocked.
    expect((await send(owner.agent, 'patch', `/api/v1/organisations/${org.id}/members/${member.user.id}`, { role: 'OWNER' })).status).toBe(204);
    expect((await send(owner.agent, 'post', '/api/v1/me/deletion-request', { password: PASSWORD })).status).toBe(202);
  });

  it('erases the account after email confirmation; shared records stay with the organisation, anonymised', async () => {
    const { owner, member, org, project } = await team();
    const t = (await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'Shared', assigneeId: member.user.id })).body.task;
    await send(member.agent, 'post', `/api/v1/tasks/${t.id}/comments`, { body: 'Milo was here' });
    const mp = (await send(member.agent, 'post', `/api/v1/workspaces/${member.workspaceId}/projects`, { name: 'Milo personal' })).body.project;
    // An invitation to Milo's address recorded in the org audit log.
    await query(`insert into audit_logs (organisation_id, actor_id, action, data, ip) values ($1, $2, 'invitation.created', $3, '10.0.0.1')`, [org.id, owner.user.id, JSON.stringify({ email: member.email })]);
    await login(member.email); // account-level security events with IP
    await send(member.agent, 'post', '/api/v1/me/exports');

    expect((await send(member.agent, 'post', '/api/v1/me/deletion-request', { password: PASSWORD })).status).toBe(202);
    const token = tokenIn((await mailTo(member.email, 'account_deletion')).text, '/account/delete');

    // Not without typing DELETE, not with someone else's session.
    expect((await send(member.agent, 'post', '/api/v1/me/deletion-confirm', { token, confirm: 'delete' })).status).toBe(400);
    expect((await send(owner.agent, 'post', '/api/v1/me/deletion-confirm', { token, confirm: 'DELETE' })).status).toBe(400);

    const done = await send(member.agent, 'post', '/api/v1/me/deletion-confirm', { token, confirm: 'DELETE' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ deleted: true, erasedOrganisations: 1 });
    expect(String(done.headers['set-cookie'])).toMatch(/monty_session=;/);

    // Signed out everywhere, cannot sign in, the address can register again.
    expect((await member.agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await login(member.email)).status).toBe(401);
    const [tomb] = await query<{ email: string; name: string; deleted_at: Date }>(`select email, name, deleted_at from users where id = $1`, [member.user.id]);
    expect(tomb).toMatchObject({ name: 'Deleted user', email: `deleted-${member.user.id}@deleted.invalid` });
    expect(tomb!.deleted_at).not.toBeNull();
    expect((await signUp(app, 'Milo')).user.id).not.toBe(member.user.id);

    // Personal organisation and its project are gone; the team organisation keeps its records.
    expect(await query(`select 1 from projects where id = $1`, [mp.id])).toHaveLength(0);
    expect(await query(`select 1 from organisations where personal_owner_id = $1`, [member.user.id])).toHaveLength(0);
    const tasks = (await owner.agent.get(`/api/v1/projects/${project.id}/tasks`)).body.tasks;
    expect(tasks[0]).toMatchObject({ title: 'Shared', assigneeId: null });
    const comments = (await owner.agent.get(`/api/v1/tasks/${t.id}/comments`)).body.comments;
    expect(comments[0].author.name).toBe('Deleted user');
    const members = (await owner.agent.get(`/api/v1/organisations/${org.id}/members`)).body.members;
    expect(members.map((m: { id: string }) => m.id)).toEqual([owner.user.id]);

    // Personal data removed from security records, sessions, tokens, exports and mail queue.
    for (const table of ['sessions', 'user_tokens', 'data_exports', 'notifications']) {
      expect(await query(`select 1 from ${table} where user_id = $1`, [member.user.id]), table).toHaveLength(0);
    }
    expect(await query(`select 1 from email_outbox where to_address = $1 and user_id is not distinct from $2`, [member.email, member.user.id])).toHaveLength(0);
    const audit = await query<{ action: string; organisation_id: string | null; ip: string | null; user_agent: string | null; data: Record<string, unknown> }>(
      `select action, organisation_id, ip, user_agent, data from audit_logs where actor_id = $1 or data->>'email' is not null`,
      [member.user.id],
    );
    expect(audit.filter((a) => a.organisation_id === null).map((a) => a.action)).toEqual(['account.deleted']);
    const own = await query<{ ip: string | null; user_agent: string | null }>(`select ip, user_agent from audit_logs where actor_id = $1`, [member.user.id]);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((a) => a.ip === null && a.user_agent === null)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(member.email);
    expect(audit.find((a) => a.action === 'invitation.created')!.data.email).toBe('[erased]');

    // The link is single-use.
    expect((await send(member.agent, 'post', '/api/v1/me/deletion-confirm', { token, confirm: 'DELETE' })).status).toBe(401);
  });

  it('erases team organisations the user was the only member of, and rejects expired links', async () => {
    const u = await signUp(app, 'Solo');
    const org = (await send(u.agent, 'post', '/api/v1/organisations', { name: 'Just me' })).body.organisation;
    await send(u.agent, 'post', '/api/v1/me/deletion-request', { password: PASSWORD });
    const token = tokenIn((await mailTo(u.email, 'account_deletion')).text, '/account/delete');
    await query(`update user_tokens set expires_at = now() - interval '1 second' where purpose = 'ACCOUNT_DELETION'`);
    expect((await send(u.agent, 'post', '/api/v1/me/deletion-confirm', { token, confirm: 'DELETE' })).status).toBe(400);

    await send(u.agent, 'post', '/api/v1/me/deletion-request', { password: PASSWORD });
    mailbox.clear();
    await send(u.agent, 'post', '/api/v1/me/deletion-request', { password: PASSWORD });
    const fresh = tokenIn((await mailTo(u.email, 'account_deletion')).text, '/account/delete');
    const res = await send(u.agent, 'post', '/api/v1/me/deletion-confirm', { token: fresh, confirm: 'DELETE' });
    expect(res.body).toMatchObject({ deleted: true, erasedOrganisations: 2 });
    expect(await query(`select 1 from organisations where id = $1`, [org.id])).toHaveLength(0);
  });
});

describe('organisation rename and deletion', () => {
  it('admins rename; members cannot; outsiders get 404', async () => {
    const { owner, member, org } = await team();
    const stranger = await signUp(app, 'Out');
    expect((await send(member.agent, 'patch', `/api/v1/organisations/${org.id}`, { name: 'X' })).status).toBe(403);
    expect((await send(stranger.agent, 'patch', `/api/v1/organisations/${org.id}`, { name: 'X' })).status).toBe(404);
    expect((await send(owner.agent, 'patch', `/api/v1/organisations/${org.id}`, { name: '  Acme Ltd ' })).body.organisation.name).toBe('Acme Ltd');
    const orgs = (await member.agent.get('/api/v1/organisations')).body.organisations;
    expect(orgs.find((o: { id: string }) => o.id === org.id).name).toBe('Acme Ltd');
    expect((await query<{ data: unknown }>(`select data from audit_logs where action = 'organisation.renamed'`))[0]!.data).toEqual({ from: 'Acme', to: 'Acme Ltd' });
  });

  it('only an owner can schedule deletion, with the exact name and password; personal workspaces cannot be deleted this way', async () => {
    const { owner, member, org } = await team();
    const admin = await signUp(app, 'Ada');
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'ADMIN')`, [org.id, admin.user.id]);
    const url = `/api/v1/organisations/${org.id}`;
    expect((await send(member.agent, 'delete', url, { confirmName: 'Acme', password: PASSWORD })).status).toBe(403);
    expect((await send(admin.agent, 'delete', url, { confirmName: 'Acme', password: PASSWORD })).status).toBe(403);
    expect((await send(owner.agent, 'delete', url, { confirmName: 'acme', password: PASSWORD })).status).toBe(400);
    expect((await send(owner.agent, 'delete', url, { confirmName: 'Acme', password: 'not-the-password' })).status).toBe(403);
    expect((await send(owner.agent, 'delete', `/api/v1/organisations/${owner.personalOrgId}`, { confirmName: 'Personal', password: PASSWORD })).status).toBe(400);
    expect((await send(owner.agent, 'delete', url, {})).status).toBe(400);
    expect(await query(`select 1 from organisations where id = $1 and deleted_at is null`, [org.id])).toHaveLength(1);
  });

  it('scheduled deletion hides the organisation at once, notifies members, can be restored, and is purged after the grace period', async () => {
    const { owner, member, org, wsId, project } = await team();
    const t = (await send(member.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'Doomed' })).body.task;
    await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/documents`, { title: 'Doc', body: 'x' });

    const del = await send(owner.agent, 'delete', `/api/v1/organisations/${org.id}`, { confirmName: 'Acme', password: PASSWORD });
    expect(del.status).toBe(200);
    expect(Date.parse(del.body.organisation.purgeAfter) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    // Hidden from everyone immediately.
    expect((await member.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(404);
    expect((await member.agent.get('/api/v1/organisations')).body.organisations.map((o: { id: string }) => o.id)).not.toContain(org.id);
    expect((await send(member.agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, title: 'x' })).status).toBe(404);
    // Members are told; only owners see it as restorable.
    expect((await mailTo(member.email, 'organisation_deletion_scheduled')).subject).toBe('Acme is scheduled for deletion');
    expect((await member.agent.get('/api/v1/organisations/pending-deletion')).body.organisations).toEqual([]);
    expect((await owner.agent.get('/api/v1/organisations/pending-deletion')).body.organisations).toMatchObject([{ id: org.id, name: 'Acme' }]);
    expect((await send(member.agent, 'post', `/api/v1/organisations/${org.id}/restore`)).status).toBe(403);

    expect((await send(owner.agent, 'post', `/api/v1/organisations/${org.id}/restore`)).status).toBe(204);
    expect((await member.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(200);

    // Schedule again and let the grace period pass.
    await send(owner.agent, 'delete', `/api/v1/organisations/${org.id}`, { confirmName: 'Acme', password: PASSWORD });
    expect((await app.get(MaintenanceService).runNow()).organisations).toBe(0); // not yet due
    await query(`update organisations set purge_after = now() - interval '1 second' where id = $1`, [org.id]);
    expect((await app.get(MaintenanceService).runNow()).organisations).toBe(1);
    for (const [table, col] of [['organisations', 'id'], ['workspaces', 'organisation_id'], ['projects', 'organisation_id'], ['tasks', 'organisation_id'], ['documents', 'organisation_id'], ['activity_events', 'organisation_id'], ['audit_logs', 'organisation_id']]) {
      expect(await query(`select 1 from ${table} where ${col} = $1`, [org.id]), table).toHaveLength(0);
    }
    // People keep their accounts; a content-free record of the purge remains.
    expect((await member.agent.get('/api/v1/auth/me')).status).toBe(200);
    expect(await query(`select 1 from audit_logs where action = 'organisation.purged' and target_id = $1`, [org.id])).toHaveLength(1);
    expect((await send(owner.agent, 'post', `/api/v1/organisations/${org.id}/restore`)).status).toBe(404);
  });
});
