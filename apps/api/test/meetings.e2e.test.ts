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

describe('meetings', () => {
  it('schedule with a Jitsi link, invite, minutes and action items by attendees, own link, cancel, .ics, isolation', async () => {
    const owner = await signUp(app, 'Olga');
    const mia = await signUp(app, 'Mia');
    const vic = await signUp(app, 'Vic');
    const otto = await signUp(app, 'Otto');
    const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Acme' })).body.organisation;
    const ws = org.workspaces[0].id as string;
    for (const u of [mia, vic]) {
      await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, u.user.id]);
      await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'MEMBER')`, [ws, u.user.id]);
    }
    const startsAt = new Date(Date.now() + 86400_000).toISOString();
    const res = await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/meetings`, { title: 'Sales weekly', startsAt, durationMinutes: 45, agenda: '1. Pipeline', attendeeIds: [mia.user.id] });
    expect(res.status).toBe(201);
    const m = res.body.meeting;
    expect(m.videoUrl).toMatch(/^https:\/\/meet\.jit\.si\/Monty-[A-Za-z0-9_-]{16}$/);
    expect(m.attendees.map((a: { name: string }) => a.name).sort()).toEqual(['Mia', 'Olga']);
    expect(m.canEdit).toBe(true);
    expect((await mia.agent.get('/api/v1/me/notifications')).body.notifications[0]).toMatchObject({ type: 'meeting', entityType: 'meeting', entityId: m.id });
    expect((await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/meetings`, { title: 'X', startsAt, attendeeIds: [otto.user.id] })).status).toBe(400);

    // Attendee writes minutes and an action item for Vic; can't move the meeting.
    const item = { id: 'a1', text: 'Send forecast', assigneeId: vic.user.id, done: false };
    const upd = await send(mia.agent, 'patch', `/api/v1/meetings/${m.id}`, { minutes: 'Q4 looks good', actionItems: [item] });
    expect(upd.body.meeting).toMatchObject({ minutes: 'Q4 looks good', actionItems: [item], canEdit: false });
    expect((await vic.agent.get('/api/v1/me/notifications')).body.notifications[0]).toMatchObject({ type: 'assigned', entityType: 'meeting' });
    expect((await send(mia.agent, 'patch', `/api/v1/meetings/${m.id}`, { title: 'Hijack' })).status).toBe(403);

    // Organiser swaps in their own link, adds Vic, then cancels.
    const own = (await send(owner.agent, 'patch', `/api/v1/meetings/${m.id}`, { videoUrl: 'https://meet.google.com/abc-defg-hij', attendeeIds: [owner.user.id, mia.user.id, vic.user.id] })).body.meeting;
    expect(own.videoUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect((await send(owner.agent, 'patch', `/api/v1/meetings/${m.id}`, { videoUrl: 'javascript:alert(1)' })).status).toBe(400);
    const ics = await owner.agent.get(`/api/v1/meetings/${m.id}/ics`);
    expect(ics.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(ics.text).toContain('SUMMARY:Sales weekly');
    expect(ics.text).toContain('URL:https://meet.google.com/abc-defg-hij');
    expect(ics.text).toMatch(/DTEND:\d{8}T\d{6}Z/);
    expect((await send(owner.agent, 'patch', `/api/v1/meetings/${m.id}`, { cancelled: true })).body.meeting.cancelled).toBe(true);

    // Other organisations see nothing.
    expect((await otto.agent.get(`/api/v1/meetings/${m.id}`)).status).toBe(404);
    expect((await otto.agent.get(`/api/v1/workspaces/${ws}/meetings`)).status).toBe(404);
    expect((await mia.agent.get(`/api/v1/workspaces/${ws}/meetings`)).body.meetings).toHaveLength(1);
    expect((await send(mia.agent, 'delete', `/api/v1/meetings/${m.id}`)).status).toBe(403);
    expect((await send(owner.agent, 'delete', `/api/v1/meetings/${m.id}`)).status).toBe(204);
  });
});
