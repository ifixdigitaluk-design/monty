import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AutomationsService, ruleMatches } from '../src/automations/automations.service';
import { isPrivateAddress, sendWebhook } from '../src/automations/webhook';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

let app: INestApplication;
let engine: AutomationsService;
let webhookCalls: { url: string; body: string; secret: string }[] = [];
let webhookFailuresLeft = 0;

beforeAll(async () => {
  app = await createTestApp();
  engine = app.get(AutomationsService);
  engine.setRetryDelay(10);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  webhookCalls = [];
  webhookFailuresLeft = 0;
  engine.useWebhookSender(async (url, body, secret) => {
    webhookCalls.push({ url, body, secret });
    if (webhookFailuresLeft > 0) {
      webhookFailuresLeft -= 1;
      throw new Error('connection reset');
    }
    return { status: 200 };
  });
});

type U = Awaited<ReturnType<typeof signUp>>;

async function team() {
  const owner = await signUp(app, 'Owner');
  const member = await signUp(app, 'Mia');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Team' })).body.organisation;
  const wsId = org.workspaces[0].id as string;
  await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, member.user.id]);
  await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'MEMBER')`, [wsId, member.user.id]);
  const project = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Launch' })).body.project;
  return { owner, member, org, wsId, project };
}
const newTask = async (u: U, projectId: string, body: object) => (await send(u.agent, 'post', `/api/v1/projects/${projectId}/tasks`, body)).body.task;
const getTask = async (u: U, projectId: string, id: string) =>
  (await u.agent.get(`/api/v1/projects/${projectId}/tasks`)).body.tasks.find((t: { id: string }) => t.id === id);

/** Events reach the engine through Postgres NOTIFY; wait until a condition holds, then until all work is done. */
async function eventually<T>(fn: () => Promise<T | undefined | null | false>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    await engine.drain();
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const runs = () => query<{ status: string; attempts: number; error: string | null; event_key: string }>(`select status, attempts, error, event_key from automation_runs order by created_at`);
const settle = async () => {
  await new Promise((r) => setTimeout(r, 300));
  await engine.drain();
};

describe('automation rules API', () => {
  it('admins create, list, update with version checks and delete; members cannot manage', async () => {
    const { owner, member, wsId } = await team();
    const body = { name: 'Escalate urgent', trigger: 'task.created', conditions: { priority: 'URGENT' }, actions: [{ type: 'notify', to: ['creator'], message: 'Urgent task created' }] };
    expect((await send(member.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, body)).status).toBe(403);
    const created = await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, body);
    expect(created.status).toBe(201);
    const rule = created.body.automation;
    expect(rule).toMatchObject({ name: 'Escalate urgent', enabled: true, version: 1, webhookSecret: null, createdBy: { name: 'Owner' }, lastRun: null });

    expect((await owner.agent.get(`/api/v1/workspaces/${wsId}/automations`)).body.automations).toHaveLength(1);
    expect((await member.agent.get(`/api/v1/workspaces/${wsId}/automations`)).status).toBe(403);

    const off = await send(owner.agent, 'patch', `/api/v1/automations/${rule.id}`, { expectedVersion: 1, enabled: false });
    expect(off.body.automation).toMatchObject({ enabled: false, version: 2 });
    expect((await send(owner.agent, 'patch', `/api/v1/automations/${rule.id}`, { expectedVersion: 1, name: 'x' })).status).toBe(409);
    expect((await send(member.agent, 'patch', `/api/v1/automations/${rule.id}`, { expectedVersion: 2, name: 'x' })).status).toBe(403);

    expect((await send(owner.agent, 'delete', `/api/v1/automations/${rule.id}`)).status).toBe(204);
    expect((await owner.agent.get(`/api/v1/workspaces/${wsId}/automations`)).body.automations).toEqual([]);
    const audit = await query<{ action: string }>(`select action from audit_logs where action like 'automation.%' order by created_at`);
    expect(audit.map((a) => a.action)).toEqual(['automation.created', 'automation.updated', 'automation.deleted']);
  });

  it('validates input strictly: unknown fields, http webhooks, private hosts, foreign users, toStatus misuse', async () => {
    const { owner, wsId } = await team();
    const outsider = await signUp(app, 'Out');
    const url = `/api/v1/workspaces/${wsId}/automations`;
    const base = { name: 'R', trigger: 'task.created' };
    const bad = [
      { ...base, actions: [{ type: 'notify', to: ['creator'], message: 'x' }], extra: 1 },
      { ...base, actions: [{ type: 'webhook', url: 'http://example.com/hook' }] },
      { ...base, actions: [{ type: 'webhook', url: 'https://localhost/hook' }] },
      { ...base, actions: [] },
      { ...base, conditions: { toStatus: 'DONE' }, actions: [{ type: 'set_priority', priority: 'HIGH' }] },
      { ...base, actions: [{ type: 'assign', assigneeId: outsider.user.id }] },
    ];
    for (const b of bad) expect((await send(owner.agent, 'post', url, b)).status, JSON.stringify(b)).toBe(400);
  });

  it('enforces the plan limit for automation rules', async () => {
    const { owner, wsId } = await team();
    const body = { name: 'R', trigger: 'task.created', actions: [{ type: 'set_priority', priority: 'LOW' }] };
    for (let i = 0; i < 3; i++) expect((await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, body)).status).toBe(201);
    const over = await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, body);
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('another organisation cannot see or change a rule (404)', async () => {
    const { owner, wsId } = await team();
    const stranger = await signUp(app, 'Stranger');
    const rule = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, { name: 'R', trigger: 'task.created', actions: [{ type: 'set_priority', priority: 'LOW' }] })).body.automation;
    expect((await stranger.agent.get(`/api/v1/workspaces/${wsId}/automations`)).status).toBe(404);
    expect((await send(stranger.agent, 'patch', `/api/v1/automations/${rule.id}`, { expectedVersion: 1, enabled: false })).status).toBe(404);
    expect((await stranger.agent.get(`/api/v1/automations/${rule.id}/runs`)).status).toBe(404);
  });
});

describe('automation engine', () => {
  it('status change to IN_REVIEW notifies, re-prioritises and reassigns; runs once and does not loop', async () => {
    const { owner, member, wsId, project } = await team();
    await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, {
      name: 'Review finished work',
      trigger: 'task.status_changed',
      conditions: { toStatus: 'IN_REVIEW' },
      actions: [
        { type: 'notify', to: ['creator', 'assignee'], message: 'Ready for review' },
        { type: 'set_priority', priority: 'HIGH' },
        { type: 'assign', assigneeId: owner.user.id },
      ],
    });
    // A rule that would loop forever if automation-made changes re-triggered rules.
    await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, {
      name: 'Bump on any update',
      trigger: 'task.updated',
      actions: [{ type: 'set_priority', priority: 'URGENT' }],
    });

    const t = await newTask(member, project.id, { title: 'Write copy', assigneeId: member.user.id });
    await send(member.agent, 'patch', `/api/v1/tasks/${t.id}`, { expectedVersion: 1, status: 'IN_REVIEW' });

    await eventually(async () => (await runs()).filter((r) => r.status !== 'RUNNING').length === 2);
    await settle();
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);

    const after = await getTask(owner, project.id, t.id);
    expect(after.assigneeId).toBe(owner.user.id);
    // Both rules acted on the user's change exactly once; neither reacted to the other's (automation) change.
    expect(['HIGH', 'URGENT']).toContain(after.priority);
    expect(after.version).toBeLessThanOrEqual(4);

    const inbox = (await member.agent.get('/api/v1/me/notifications')).body.notifications;
    expect(inbox.find((n: { type: string }) => n.type === 'automation')).toMatchObject({ data: { message: 'Ready for review', ruleName: 'Review finished work' } });

    const rules = (await owner.agent.get(`/api/v1/workspaces/${wsId}/automations`)).body.automations;
    expect(rules.every((r: { lastRun: { status: string } | null }) => r.lastRun?.status === 'SUCCEEDED')).toBe(true);
    const runList = (await owner.agent.get(`/api/v1/automations/${rules[0].id}/runs`)).body.runs;
    expect(runList[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 1, taskId: t.id });
  });

  it('conditions filter which tasks a rule acts on', async () => {
    const { owner, wsId, project } = await team();
    await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, {
      name: 'Urgent → in progress',
      trigger: 'task.created',
      conditions: { priority: 'URGENT', projectId: project.id },
      actions: [{ type: 'set_status', status: 'IN_PROGRESS' }],
    });
    const urgent = await newTask(owner, project.id, { title: 'Fire', priority: 'URGENT' });
    const calm = await newTask(owner, project.id, { title: 'Calm', priority: 'LOW' });
    await eventually(async () => (await getTask(owner, project.id, urgent.id)).status === 'IN_PROGRESS');
    await settle();
    expect((await getTask(owner, project.id, calm.id)).status).toBe('TODO');
    expect(await runs()).toHaveLength(1);
  });

  it('disabled rules do nothing', async () => {
    const { owner, wsId, project } = await team();
    await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, { name: 'Off', enabled: false, trigger: 'task.created', actions: [{ type: 'set_priority', priority: 'HIGH' }] });
    const t = await newTask(owner, project.id, { title: 'A' });
    await settle();
    expect((await getTask(owner, project.id, t.id)).priority).toBe('NONE');
    expect(await runs()).toHaveLength(0);
  });

  it('skips (does not act) when the rule author is no longer a workspace admin', async () => {
    const { owner, member, org, wsId, project } = await team();
    // Promote Mia to org admin, she creates a rule, then is demoted back to member.
    await query(`update organisation_memberships set role = 'ADMIN' where organisation_id = $1 and user_id = $2`, [org.id, member.user.id]);
    expect((await send(member.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, { name: 'Mia rule', trigger: 'task.created', actions: [{ type: 'set_priority', priority: 'HIGH' }] })).status).toBe(201);
    await query(`update organisation_memberships set role = 'MEMBER' where organisation_id = $1 and user_id = $2`, [org.id, member.user.id]);

    const t = await newTask(owner, project.id, { title: 'A' });
    const [run] = await eventually(async () => {
      const r = await runs();
      return r.length && r[0]!.status !== 'RUNNING' ? r : null;
    });
    expect(run).toMatchObject({ status: 'SKIPPED', error: 'The rule author is no longer an admin of this workspace' });
    expect((await getTask(owner, project.id, t.id)).priority).toBe('NONE');
  });

  it('webhooks are signed with the rule secret and retried on failure (max 3 attempts)', async () => {
    const { owner, wsId, project } = await team();
    const rule = (
      await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, {
        name: 'Tell Slack',
        trigger: 'task.created',
        actions: [{ type: 'webhook', url: 'https://hooks.example.com/monty' }],
      })
    ).body.automation;
    expect(rule.webhookSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);

    webhookFailuresLeft = 1;
    await newTask(owner, project.id, { title: 'Ship it' });
    const [ok] = await eventually(async () => {
      const r = await runs();
      return r[0]?.status === 'SUCCEEDED' ? r : null;
    });
    expect(ok!.attempts).toBe(2);
    expect(webhookCalls).toHaveLength(2);
    expect(webhookCalls[0]!.secret).toBe(rule.webhookSecret);
    expect(JSON.parse(webhookCalls[0]!.body)).toMatchObject({ event: 'task.created', task: { title: 'Ship it' }, rule: { name: 'Tell Slack' } });

    webhookFailuresLeft = 5;
    await newTask(owner, project.id, { title: 'Broken' });
    const failed = await eventually(async () => {
      const r = await runs();
      return r[1]?.status === 'FAILED' ? r[1] : null;
    });
    expect(failed).toMatchObject({ attempts: 3, error: 'connection reset' });
  });

  it('overdue sweep acts once per task and due date', async () => {
    const { owner, wsId, project } = await team();
    await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/automations`, {
      name: 'Overdue → urgent',
      trigger: 'task.overdue',
      actions: [{ type: 'set_priority', priority: 'URGENT' }, { type: 'notify', to: ['creator'], message: 'This task is overdue' }],
    });
    const late = await newTask(owner, project.id, { title: 'Late', dueDate: '2020-01-01' });
    await newTask(owner, project.id, { title: 'Future', dueDate: '2999-01-01' });
    await newTask(owner, project.id, { title: 'Done late', dueDate: '2020-01-01', status: 'DONE' });
    await settle();

    expect(await engine.sweepOverdue()).toBe(1);
    expect(await engine.sweepOverdue()).toBe(0); // idempotent
    expect((await getTask(owner, project.id, late.id)).priority).toBe('URGENT');
    const inbox = (await owner.agent.get('/api/v1/me/notifications')).body.notifications;
    expect(inbox.filter((n: { type: string }) => n.type === 'automation')).toHaveLength(1);
    expect((await runs())[0]!.event_key).toBe(`overdue:${late.id}:2020-01-01`);
  });
});

describe('automation units', () => {
  it('ruleMatches', () => {
    const t = { id: 't', projectId: 'p', workspaceId: 'w', title: 'x', status: 'TODO', priority: 'HIGH', assigneeId: null, creatorId: 'u', dueDate: null };
    expect(ruleMatches({}, t, undefined)).toBe(true);
    expect(ruleMatches({ priority: 'HIGH', status: 'TODO', assigneeId: null }, t, undefined)).toBe(true);
    expect(ruleMatches({ assigneeId: '00000000-0000-4000-8000-000000000000' }, t, undefined)).toBe(false);
    expect(ruleMatches({ toStatus: 'DONE' }, t, { status: { from: 'TODO', to: 'DONE' } })).toBe(true);
    expect(ruleMatches({ toStatus: 'DONE' }, t, { status: { from: 'DONE', to: 'TODO' } })).toBe(false);
    expect(ruleMatches({ projectId: 'q' }, t, undefined)).toBe(false);
  });

  it('isPrivateAddress blocks internal ranges and allows public ones', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('sendWebhook refuses non-https, private IP literals and hosts resolving to private addresses', async () => {
    await expect(sendWebhook('http://example.com', '{}', 's')).rejects.toThrow(/https/);
    await expect(sendWebhook('https://127.0.0.1/x', '{}', 's')).rejects.toThrow(/non-public/);
    await expect(sendWebhook('https://[::1]/x', '{}', 's')).rejects.toThrow(/non-public/);
    await expect(sendWebhook('https://localhost/x', '{}', 's')).rejects.toThrow(/non-public/);
  });

  it('signature format is t=<ts>,v1=<hmac of "ts.body">', async () => {
    const { signature } = await import('../src/automations/webhook');
    const s = signature('secret', 1700000000, '{"a":1}');
    expect(s).toBe(`t=1700000000,v1=${createHmac('sha256', 'secret').update('1700000000.{"a":1}').digest('hex')}`);
  });
});
