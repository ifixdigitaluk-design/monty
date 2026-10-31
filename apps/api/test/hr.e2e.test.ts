import type { INestApplication } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FilesService } from '../src/files/files.service';
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
 * Org "People Co": owner Olga (HR admin by default), Carl (CTO, reports to Olga), Lee (lead, reports to Carl),
 * Dev (reports to Lee), Pat (peer of Lee, reports to Carl). Otto is in another organisation.
 */
async function company() {
  const olga = await signUp(app, 'Olga');
  const [carl, lee, dev, pat, otto] = await Promise.all(['Carl', 'Lee', 'Dev', 'Pat', 'Otto'].map((n) => signUp(app, n)));
  const org = (await send(olga.agent, 'post', '/api/v1/organisations', { name: 'People Co' })).body.organisation;
  for (const u of [carl, lee, dev, pat]) await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, u!.user.id]);
  const hr = (p: string) => `/api/v1/organisations/${org.id}/hr${p}`;
  const setManager = async (u: { user: { id: string } }, m: { user: { id: string } }) => expect((await send(olga.agent, 'patch', hr(`/people/${u.user.id}`), { managerId: m.user.id })).status).toBe(200);
  await setManager(carl!, olga);
  await setManager(lee!, carl!);
  await setManager(dev!, lee!);
  await setManager(pat!, carl!);
  return { org, hr, olga, carl: carl!, lee: lee!, dev: dev!, pat: pat!, otto: otto! };
}

describe('HR: directory and private details', () => {
  it('everyone sees the directory; private details only for the person, HR and their management chain; pay only for the person and HR', async () => {
    const { hr, olga, carl, lee, dev, pat, otto } = await company();
    expect((await send(olga.agent, 'patch', hr(`/people/${dev.user.id}`), { jobTitle: 'Developer', department: 'Engineering', startDate: '2026-01-05', private: { homeAddress: '1 Secret St', salary: 4_500_000, salaryCurrency: 'GBP', notes: 'Probation passed' } })).status).toBe(200);

    const dir = (await pat.agent.get(hr('/people'))).body.people;
    expect(dir.find((p: { userId: string }) => p.userId === dev.user.id)).toMatchObject({ jobTitle: 'Developer', manager: { name: 'Lee' } });
    expect(JSON.stringify(dir)).not.toContain('Secret St');

    const view = async (who: typeof dev) => (await who.agent.get(hr(`/people/${dev.user.id}`))).body.profile;
    expect((await view(dev)).private).toMatchObject({ homeAddress: '1 Secret St', salary: 4_500_000 });
    expect((await view(dev)).private).not.toHaveProperty('notes'); // HR's notes stay with HR
    expect((await view(olga)).private).toMatchObject({ salary: 4_500_000, notes: 'Probation passed' });
    expect((await view(lee)).private).toEqual({ homeAddress: '1 Secret St' }); // manager: personal details, no pay
    expect((await view(carl)).private).toEqual({ homeAddress: '1 Secret St' }); // manager's manager too
    expect((await view(pat)).private).toBeNull(); // a peer
    expect((await dev.agent.get(hr(`/people/${lee.user.id}`))).body.profile.private).toBeNull(); // not upwards
    expect((await otto.agent.get(hr(`/people/${dev.user.id}`))).status).toBe(404);

    // Encrypted at rest.
    const [row] = await query<{ private_data: string }>(`select private_data from hr_profiles where user_id = $1`, [dev.user.id]);
    expect(row!.private_data).toMatch(/^v1\./);
    expect(row!.private_data).not.toContain('Secret');
  });

  it('who can edit what; reporting loops refused; owners choose HR admins', async () => {
    const { hr, olga, carl, lee, dev } = await company();
    expect((await send(dev.agent, 'patch', hr(`/people/${dev.user.id}`), { private: { personalPhone: '07700 900000' } })).status).toBe(200);
    expect((await send(dev.agent, 'patch', hr(`/people/${dev.user.id}`), { private: { salary: 9_999_999 } })).status).toBe(403);
    expect((await send(dev.agent, 'patch', hr(`/people/${dev.user.id}`), { jobTitle: 'CEO' })).status).toBe(403);
    expect((await send(lee.agent, 'patch', hr(`/people/${dev.user.id}`), { private: { homeAddress: 'x' } })).status).toBe(403);
    const loop = await send(olga.agent, 'patch', hr(`/people/${carl.user.id}`), { managerId: dev.user.id });
    expect(loop.status).toBe(400);
    expect(loop.body.error.message).toMatch(/loop/);

    expect((await send(carl.agent, 'put', hr('/admins'), { userId: lee.user.id, hrAdmin: true })).status).toBe(403);
    expect((await send(olga.agent, 'put', hr('/admins'), { userId: lee.user.id, hrAdmin: true })).status).toBe(204);
    expect((await lee.agent.get(hr('/me'))).body.isHrAdmin).toBe(true);
    expect((await lee.agent.get(hr(`/people/${carl.user.id}`))).body.profile.canEdit).toEqual({ profile: true, personal: true, salary: true });
    const audit = await query<{ action: string; data: Record<string, unknown> }>(`select action, data from audit_logs where action like 'hr.%' order by created_at`);
    expect(audit.map((a) => a.action)).toContain('hr.admin_granted');
    expect(JSON.stringify(audit)).not.toContain('07700'); // field names only, never values
  });

  it('personal organisations have no HR', async () => {
    const solo = await signUp(app, 'Solo');
    expect((await solo.agent.get(`/api/v1/organisations/${solo.personalOrgId}/hr/me`)).status).toBe(400);
  });
});

// A Monday–Friday week in the current year (balances are per calendar year).
const Y = new Date().getUTCFullYear();
const mon = (() => {
  const d = new Date(Date.UTC(Y, 5, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
})();
const at = (n: number) => new Date(mon.getTime() + n * 86400_000).toISOString().slice(0, 10);

describe('HR: leave', () => {
  it('request → manager notified → approve; balance; overlap refused; sickness hidden from colleagues', async () => {
    const { hr, olga, lee, dev, pat } = await company();
    const req = await send(dev.agent, 'post', hr('/leave'), { type: 'annual', startDate: at(0), endDate: at(4), reason: 'Family trip' });
    expect(req.status).toBe(201);
    expect(req.body.leave).toMatchObject({ days: 5, status: 'pending', canDecide: false });
    expect((await send(dev.agent, 'post', hr('/leave'), { type: 'annual', startDate: at(4), endDate: at(7) })).status).toBe(409);
    expect((await send(dev.agent, 'post', hr('/leave'), { type: 'annual', startDate: at(5), endDate: at(6) })).status).toBe(400); // weekend
    expect((await send(dev.agent, 'post', hr('/leave'), { type: 'annual', startDate: at(8), endDate: at(9), halfDay: true })).status).toBe(400);

    const inbox = (await lee.agent.get('/api/v1/me/notifications')).body.notifications;
    expect(inbox[0]).toMatchObject({ type: 'leave_request', entityType: 'hr_leave', entityId: req.body.leave.id });
    expect((await lee.agent.get(hr('/inbox'))).body.leaveToDecide).toHaveLength(1);

    expect((await send(dev.agent, 'post', hr(`/leave/${req.body.leave.id}/decision`), { decision: 'approved' })).status).toBe(403); // own
    expect((await send(pat.agent, 'post', hr(`/leave/${req.body.leave.id}/decision`), { decision: 'approved' })).status).toBe(403); // peer
    const ok = await send(lee.agent, 'post', hr(`/leave/${req.body.leave.id}/decision`), { decision: 'approved', note: 'Enjoy!' });
    expect(ok.body.leave).toMatchObject({ status: 'approved', decidedBy: { name: 'Lee' } });
    expect((await send(olga.agent, 'post', hr(`/leave/${req.body.leave.id}/decision`), { decision: 'declined' })).status).toBe(409);
    expect((await dev.agent.get('/api/v1/me/notifications')).body.notifications[0]).toMatchObject({ type: 'leave_approved' });

    const profile = (await dev.agent.get(hr(`/people/${dev.user.id}`))).body.profile;
    expect(profile.balance).toMatchObject({ year: Y, allowance: 25, taken: 5, remaining: 20 });

    // HR records a sick day for Dev: approved straight away; colleagues just see "away", without the reason.
    const sick = await send(olga.agent, 'post', hr('/leave'), { type: 'sick', startDate: at(14), endDate: at(14), reason: 'Migraine', userId: dev.user.id });
    expect(sick.body.leave.status).toBe('approved');
    const asPat = (await pat.agent.get(hr(`/leave?from=${at(0)}&to=${at(20)}`))).body.leave;
    expect(asPat.map((l: { type: string }) => l.type).sort()).toEqual(['annual', 'away']);
    expect(asPat.every((l: { reason: string | null }) => l.reason === null)).toBe(true);
    expect(JSON.stringify(asPat)).not.toContain('Migraine');
    const asLee = (await lee.agent.get(hr(`/leave?from=${at(0)}&to=${at(20)}`))).body.leave;
    expect(asLee.find((l: { type: string }) => l.type === 'sick')).toMatchObject({ reason: 'Migraine' });
    // Only HR records leave for others.
    expect((await send(lee.agent, 'post', hr('/leave'), { type: 'sick', startDate: at(15), endDate: at(15), userId: dev.user.id })).status).toBe(403);
  });

  it('cancel: own pending or future approved leave; declined leave is only visible to those involved', async () => {
    const { hr, lee, dev, pat } = await company();
    const future = new Date(Date.now() + 30 * 86400_000);
    while ([0, 6].includes(future.getUTCDay())) future.setUTCDate(future.getUTCDate() + 1);
    const d = future.toISOString().slice(0, 10);
    const r = (await send(dev.agent, 'post', hr('/leave'), { type: 'annual', startDate: d, endDate: d })).body.leave;
    expect((await send(pat.agent, 'post', hr(`/leave/${r.id}/cancel`))).status).toBe(403);
    expect((await send(dev.agent, 'post', hr(`/leave/${r.id}/cancel`))).body.leave.status).toBe('cancelled');
    const r2 = (await send(dev.agent, 'post', hr('/leave'), { type: 'annual', startDate: d, endDate: d })).body.leave;
    await send(lee.agent, 'post', hr(`/leave/${r2.id}/decision`), { decision: 'declined', note: 'Release week' });
    expect((await pat.agent.get(hr('/leave'))).body.leave).toEqual([]);
    expect((await dev.agent.get(hr('/leave'))).body.leave.map((l: { status: string }) => l.status).sort()).toEqual(['cancelled', 'declined']);
  });
});

describe('HR: onboarding, documents and reviews', () => {
  it('onboarding checklist from the template: assignees notified, only they (or HR) tick their steps', async () => {
    const { hr, olga, lee, dev, pat } = await company();
    const cl = (await send(olga.agent, 'post', hr('/checklists'), { kind: 'onboarding', subjectName: 'Nina New', dueDate: '2026-12-01', assignees: { manager: lee.user.id, it: pat.user.id } })).body.checklist;
    expect(cl).toMatchObject({ title: 'Onboarding: Nina New', total: 7, done: 0 });
    expect(cl.items[0]).toMatchObject({ title: 'Send contract and collect signed copy', assignee: { name: 'Olga' }, dueDate: '2026-11-17' });
    const itStep = cl.items.find((i: { assignee: { name: string } | null }) => i.assignee?.name === 'Pat');
    const mgrStep = cl.items.find((i: { assignee: { name: string } | null }) => i.assignee?.name === 'Lee');
    expect((await pat.agent.get('/api/v1/me/notifications')).body.notifications[0]).toMatchObject({ type: 'checklist_assigned', entityType: 'hr_checklist' });
    expect((await send(pat.agent, 'patch', hr(`/checklist-items/${itStep.id}`), { done: true })).body.checklist.done).toBe(1);
    expect((await send(pat.agent, 'patch', hr(`/checklist-items/${mgrStep.id}`), { done: true })).status).toBe(403);
    expect((await send(pat.agent, 'patch', hr(`/checklist-items/${itStep.id}`), { title: 'renamed' })).status).toBe(403);
    expect((await dev.agent.get(hr('/checklists'))).body.checklists).toEqual([]); // not involved
    expect((await send(lee.agent, 'post', hr('/checklists'), { kind: 'offboarding', subjectName: 'X' })).status).toBe(403);
  });

  it('documents: HR uploads; encrypted on disk; the person, HR and managers download; peers and outsiders cannot', async () => {
    const { hr, olga, lee, dev, pat, otto } = await company();
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('signed contract body')]);
    const up = (who: typeof olga) =>
      who.agent.post(hr(`/people/${dev.user.id}/documents?category=contract`)).set('X-Monty-Client', 'web').set('Content-Type', 'application/octet-stream').set('X-Filename', encodeURIComponent('Contract Dev.pdf')).send(pdf);
    expect((await up(lee)).status).toBe(403);
    const doc = (await up(olga)).body.document;
    expect(doc).toMatchObject({ category: 'contract', filename: 'Contract Dev.pdf', contentType: 'application/pdf', sizeBytes: pdf.length });
    const [row] = await query<{ storage_key: string }>(`select storage_key from hr_documents where id = $1`, [doc.id]);
    const onDisk = await readFile(app.get(FilesService).pathOf(row!.storage_key), 'utf8');
    expect(onDisk.startsWith('v1.')).toBe(true);
    expect(onDisk).not.toContain('signed contract');

    const get = (who: typeof olga) => who.agent.get(doc.url).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    for (const who of [dev, olga, lee]) {
      const r = await get(who);
      expect(r.status).toBe(200);
      expect(Buffer.compare(r.body as Buffer, pdf)).toBe(0);
      expect(r.headers['cache-control']).toBe('private, no-store');
    }
    expect((await get(pat)).status).toBe(404);
    expect((await get(otto)).status).toBe(404);
    expect((await pat.agent.get(hr(`/people/${dev.user.id}/documents`))).status).toBe(404);
    expect((await dev.agent.get(hr(`/people/${dev.user.id}/documents`))).body.documents).toHaveLength(1);
  });

  it('reviews: manager writes a draft (hidden from the person), shares it; private notes never reach the person', async () => {
    const { hr, olga, lee, dev, pat } = await company();
    expect((await send(pat.agent, 'post', hr('/reviews'), { subjectUserId: dev.user.id, period: 'H2 2026' })).status).toBe(403);
    expect((await send(dev.agent, 'post', hr('/reviews'), { subjectUserId: dev.user.id, period: 'H2 2026' })).status).toBe(403);
    const r = (await send(lee.agent, 'post', hr('/reviews'), { subjectUserId: dev.user.id, period: 'H2 2026', rating: 4, strengths: 'Ships reliably', goals: 'Lead a project', notes: 'Consider for promotion' })).body.review;
    expect((await dev.agent.get(hr('/reviews'))).body.reviews).toEqual([]);
    expect((await olga.agent.get(hr(`/reviews?userId=${dev.user.id}`))).body.reviews).toHaveLength(1);
    expect((await pat.agent.get(hr('/reviews'))).body.reviews).toEqual([]);
    const [row] = await query<{ content: string }>(`select content from hr_reviews where id = $1`, [r.id]);
    expect(row!.content).not.toContain('Ships');

    await send(lee.agent, 'patch', hr(`/reviews/${r.id}`), { share: true });
    const mine = (await dev.agent.get(hr('/reviews'))).body.reviews;
    expect(mine[0]).toMatchObject({ status: 'shared', strengths: 'Ships reliably', notes: '', rating: 4 });
    expect((await dev.agent.get('/api/v1/me/notifications')).body.notifications[0]).toMatchObject({ type: 'review_shared' });
    expect((await send(lee.agent, 'patch', hr(`/reviews/${r.id}`), { strengths: 'edited' })).status).toBe(400);
  });

  it('personal data export includes my HR profile (decrypted) and leave', async () => {
    const { hr, olga, dev } = await company();
    await send(olga.agent, 'patch', hr(`/people/${dev.user.id}`), { jobTitle: 'Developer', private: { homeAddress: '1 Secret St' } });
    await send(dev.agent, 'post', hr('/leave'), { type: 'annual', startDate: '2026-11-02', endDate: '2026-11-02' });
    const created = await send(dev.agent, 'post', '/api/v1/me/exports');
    const file = await dev.agent.get(created.body.export.downloadPath).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const data = JSON.parse((file.body as Buffer).toString());
    expect(data.hrProfiles[0]).toMatchObject({ job_title: 'Developer', personal: { homeAddress: '1 Secret St' } });
    expect(data.leaveRequests).toHaveLength(1);
  });
});
