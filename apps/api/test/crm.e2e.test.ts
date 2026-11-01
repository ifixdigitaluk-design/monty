import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crmCompanies, crmDeals } from '@monty/database';
import { DbService } from '../src/db/db.service';
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
  const owner = await signUp(app, 'Sam');
  const mia = await signUp(app, 'Mia');
  const vic = await signUp(app, 'Vic');
  const outsider = await signUp(app, 'Otto');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Sales Co' })).body.organisation;
  const ws = org.workspaces[0].id as string;
  for (const [u, role] of [[mia, 'MEMBER'], [vic, 'VIEWER']] as const) {
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, u.user.id]);
    await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, $3)`, [ws, u.user.id, role]);
  }
  return { owner, mia, vic, outsider, ws };
}
const api = (p: string) => `/api/v1${p}`;

describe('CRM', () => {
  it('companies → contacts → deals with links, owner defaults and a pipeline summary', async () => {
    const { owner, mia, ws } = await team();
    const acme = await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/companies`), { name: 'Acme Ltd', website: 'https://acme.test', industry: 'Manufacturing' });
    expect(acme.status).toBe(201);
    expect(acme.body.company).toMatchObject({ name: 'Acme Ltd', owner: { id: owner.user.id, name: 'Sam' }, contactCount: 0, openDeals: [] });
    const companyId = acme.body.company.id;
    const jo = (await send(mia.agent, 'post', api(`/workspaces/${ws}/crm/contacts`), { name: 'Jo Bloggs', email: 'Jo@Acme.test', jobTitle: 'Buyer', companyId })).body.contact;
    expect(jo).toMatchObject({ email: 'jo@acme.test', company: { id: companyId, name: 'Acme Ltd' }, owner: { name: 'Mia' } });

    const deal = (await send(mia.agent, 'post', api(`/workspaces/${ws}/crm/deals`), { title: 'Acme rollout', companyId, contactId: jo.id, value: 1_250_000, stage: 'proposal', expectedClose: '2026-12-01' })).body.deal;
    expect(deal).toMatchObject({ stage: 'proposal', value: 1_250_000, currency: 'GBP', closedAt: null, contact: { name: 'Jo Bloggs' } });
    await send(mia.agent, 'post', api(`/workspaces/${ws}/crm/deals`), { title: 'Small add-on', companyId, value: 50_000 });

    const detail = (await owner.agent.get(api(`/crm/companies/${companyId}`))).body;
    expect(detail.company).toMatchObject({ contactCount: 1, openDeals: [{ currency: 'GBP', value: 1_300_000 }] });
    expect(detail.contacts.map((c: { name: string }) => c.name)).toEqual(['Jo Bloggs']);
    expect(detail.deals).toHaveLength(2);

    // Winning sets closedAt; moving back to an open stage clears it.
    const won = (await send(owner.agent, 'patch', api(`/crm/deals/${deal.id}`), { stage: 'won' })).body.deal;
    expect(won.closedAt).not.toBeNull();
    const summary = (await owner.agent.get(api(`/workspaces/${ws}/crm/summary`))).body;
    expect(summary.pipeline[0]).toMatchObject({ currency: 'GBP', openValue: 50_000, weighted: 5_000, wonThisMonth: 1_250_000 });
    expect(summary.winRate).toBe(1);
    expect(summary.counts).toEqual({ companies: 1, contacts: 1, openDeals: 1 });
    const reopened = (await send(owner.agent, 'patch', api(`/crm/deals/${deal.id}`), { stage: 'negotiation' })).body.deal;
    expect(reopened.closedAt).toBeNull();

    // Search covers CRM records.
    const hits = (await owner.agent.get(api('/search?q=acme'))).body.results.map((r: { type: string }) => r.type);
    expect(hits).toEqual(expect.arrayContaining(['crm_company', 'crm_deal']));
    expect((await owner.agent.get(api(`/workspaces/${ws}/crm/contacts?q=buyer`))).body.contacts).toHaveLength(1);
  });

  it('rejects links to other workspaces, non-member owners and bad values', async () => {
    const { owner, outsider, ws } = await team();
    const theirs = (await send(outsider.agent, 'post', api(`/workspaces/${outsider.workspaceId}/crm/companies`), { name: 'Rival' })).body.company;
    expect((await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/contacts`), { name: 'X', companyId: theirs.id })).status).toBe(400);
    expect((await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/companies`), { name: 'Y', ownerId: outsider.user.id })).status).toBe(400);
    expect((await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/deals`), { title: 'Z', value: -5 })).status).toBe(400);
    expect((await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/deals`), { title: 'Z', currency: 'pounds' })).status).toBe(400);
    expect((await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/companies`), { name: 'W', website: 'javascript:alert(1)' })).status).toBe(400);
  });

  it('activities and follow-ups: timeline, assignment notifies, "my follow-ups", done', async () => {
    const { owner, mia, ws } = await team();
    const c = (await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/companies`), { name: 'Globex' })).body.company;
    expect((await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/activities`), { type: 'note', subject: 'Orphan' })).status).toBe(400);
    const note = (await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/activities`), { type: 'call', subject: 'Intro call', body: 'Interested in Q1', companyId: c.id })).body.activity;
    expect(note).toMatchObject({ type: 'call', dueAt: null, assignee: null, company: { name: 'Globex' } });
    const due = new Date(Date.now() + 86400_000).toISOString();
    const fu = (await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/activities`), { type: 'task', subject: 'Send pricing', companyId: c.id, dueAt: due, assigneeId: mia.user.id })).body.activity;
    expect(fu.assignee).toEqual({ id: mia.user.id, name: 'Mia' });

    const inbox = (await mia.agent.get(api('/me/notifications'))).body.notifications;
    expect(inbox).toEqual([expect.objectContaining({ type: 'assigned', entityType: 'crm_activity', entityId: fu.id })]);
    expect((await mia.agent.get(api(`/workspaces/${ws}/crm/activities?mine=1&open=1`))).body.activities.map((a: { id: string }) => a.id)).toEqual([fu.id]);
    expect((await owner.agent.get(api(`/workspaces/${ws}/crm/activities?mine=1&open=1`))).body.activities).toEqual([]);

    const done = (await send(mia.agent, 'patch', api(`/crm/activities/${fu.id}`), { done: true })).body.activity;
    expect(done.doneAt).not.toBeNull();
    expect((await mia.agent.get(api(`/workspaces/${ws}/crm/summary`))).body.myFollowUps).toEqual([]);
    const timeline = (await owner.agent.get(api(`/crm/companies/${c.id}`))).body.activities.map((a: { subject: string }) => a.subject);
    expect(timeline).toEqual(['Send pricing', 'Intro call']);
    // Only the author or a workspace admin deletes history.
    expect((await send(mia.agent, 'delete', api(`/crm/activities/${note.id}`))).status).toBe(403);
    expect((await send(owner.agent, 'delete', api(`/crm/activities/${note.id}`))).status).toBe(204);
  });

  it('quotes: sequential numbers (even concurrently), server-side totals, accepted quotes are locked', async () => {
    const { owner, mia, ws } = await team();
    const lines = [
      { description: 'Design', quantity: 1.5, unitPrice: 8333, taxRate: 20 },
      { description: 'Hosting (12 months)', quantity: 12, unitPrice: 999, taxRate: 0 },
    ];
    const results = await Promise.all([1, 2, 3, 4].map((i) => send(i % 2 ? owner.agent : mia.agent, 'post', api(`/workspaces/${ws}/crm/quotes`), { title: `Quote ${i}`, lines })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(results.map((r) => r.body.quote.number).sort()).toEqual(['Q-0001', 'Q-0002', 'Q-0003', 'Q-0004']);
    const q = results[0]!.body.quote;
    expect(q).toMatchObject({ subtotal: 24488, tax: 2500, total: 26988, status: 'draft' });
    // Clients can't set totals.
    expect((await send(owner.agent, 'patch', api(`/crm/quotes/${q.id}`), { total: 1 })).status).toBe(400);
    const edited = (await send(owner.agent, 'patch', api(`/crm/quotes/${q.id}`), { lines: [{ description: 'Day rate', quantity: 2, unitPrice: 50000, taxRate: 20 }] })).body.quote;
    expect(edited).toMatchObject({ subtotal: 100000, tax: 20000, total: 120000 });
    await send(owner.agent, 'patch', api(`/crm/quotes/${q.id}`), { status: 'accepted' });
    expect((await send(owner.agent, 'patch', api(`/crm/quotes/${q.id}`), { lines: [] })).status).toBe(400);
    expect((await send(owner.agent, 'patch', api(`/crm/quotes/${q.id}`), { notes: 'Signed copy received' })).status).toBe(200);
  });

  it('permissions and isolation: viewers read only; outsiders get 404; RLS hides other tenants', async () => {
    const { owner, vic, outsider, ws } = await team();
    const c = (await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/companies`), { name: 'Secret client' })).body.company;
    const d = (await send(owner.agent, 'post', api(`/workspaces/${ws}/crm/deals`), { title: 'Secret deal', companyId: c.id, value: 100 })).body.deal;
    expect((await vic.agent.get(api(`/crm/companies/${c.id}`))).status).toBe(200);
    expect((await send(vic.agent, 'post', api(`/workspaces/${ws}/crm/companies`), { name: 'Nope' })).status).toBe(403);
    expect((await send(vic.agent, 'patch', api(`/crm/deals/${d.id}`), { stage: 'won' })).status).toBe(403);
    for (const r of [
      await outsider.agent.get(api(`/crm/companies/${c.id}`)),
      await outsider.agent.get(api(`/crm/deals/${d.id}`)),
      await outsider.agent.get(api(`/workspaces/${ws}/crm/summary`)),
      await send(outsider.agent, 'patch', api(`/crm/deals/${d.id}`), { title: 'x' }),
      await send(outsider.agent, 'delete', api(`/crm/companies/${c.id}`)),
    ]) expect(r.status).toBe(404);
    expect((await outsider.agent.get(api('/search?q=secret'))).body.results).toEqual([]);
    const dbs = app.get(DbService);
    const peek = async () => [(await dbs.db.select().from(crmCompanies)).length, (await dbs.db.select().from(crmDeals)).length]; // sequential: one transaction
    expect(await dbs.runAsUser(outsider.user.id, peek)).toEqual([0, 0]);
    expect(await dbs.runAsUser(owner.user.id, peek)).toEqual([1, 1]);
    expect((await send(owner.agent, 'delete', api(`/crm/companies/${c.id}`))).status).toBe(204);
    expect((await owner.agent.get(api(`/crm/companies/${c.id}`))).status).toBe(404);
    // The deal survives without its company.
    expect((await owner.agent.get(api(`/crm/deals/${d.id}`))).body.deal.company).toBeNull();
  });
});
