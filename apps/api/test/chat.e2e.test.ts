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
  const mia = await signUp(app, 'Mia');
  const vic = await signUp(app, 'Vic');
  const outsider = await signUp(app, 'Otto');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Team' })).body.organisation;
  const ws = org.workspaces[0].id as string;
  for (const [u, role] of [[mia, 'MEMBER'], [vic, 'VIEWER']] as const) {
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, u.user.id]);
    await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, $3)`, [ws, u.user.id, role]);
  }
  return { owner, mia, vic, outsider, org, ws };
}
const channels = async (u: Awaited<ReturnType<typeof signUp>>, ws: string) => (await u.agent.get(`/api/v1/workspaces/${ws}/channels`)).body.channels as { id: string; name: string; kind: string; isMember: boolean; unread: number; mentions: number }[];

describe('channels', () => {
  it('public channels: create, list, join, post, unread counts, read, leave', async () => {
    const { owner, mia, vic, outsider, ws } = await team();
    const res = await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name: '#General Chat', topic: 'Everything' });
    expect(res.status).toBe(201);
    const ch = res.body.channel;
    expect(ch).toMatchObject({ name: 'general-chat', kind: 'public', isMember: true, role: 'admin' });
    expect((await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name: 'general-chat' })).status).toBe(409);
    expect((await send(vic.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name: 'viewer-made' })).status).toBe(403);
    expect((await outsider.agent.get(`/api/v1/workspaces/${ws}/channels`)).status).toBe(404);

    expect((await channels(mia, ws))[0]).toMatchObject({ name: 'general-chat', isMember: false });
    expect((await send(mia.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { body: 'hi' })).status).toBe(403); // join first
    await send(mia.agent, 'post', `/api/v1/channels/${ch.id}/join`);
    const msg = await send(owner.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { body: 'Welcome <@' + mia.user.id + '>!' });
    expect(msg.status).toBe(201);
    await send(owner.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { body: 'Second' });
    expect((await channels(mia, ws))[0]).toMatchObject({ unread: 2, mentions: 1 });
    expect((await mia.agent.get('/api/v1/me/chat/unread')).body.workspaces).toEqual([{ workspaceId: ws, unread: 2, mentions: 1 }]);
    const inbox = (await mia.agent.get('/api/v1/me/notifications')).body.notifications;
    expect(inbox[0]).toMatchObject({ type: 'mention', entityType: 'message', data: { channelName: '#general-chat' } });

    await send(mia.agent, 'post', `/api/v1/channels/${ch.id}/read`);
    expect((await channels(mia, ws))[0]).toMatchObject({ unread: 0, mentions: 0 });
    const history = (await vic.agent.get(`/api/v1/channels/${ch.id}/messages`)).body; // viewers can read public channels
    expect(history.messages.map((m: { body: string }) => m.body)).toEqual(['Welcome <@' + mia.user.id + '>!', 'Second']);
    expect((await outsider.agent.get(`/api/v1/channels/${ch.id}/messages`)).status).toBe(404);
    expect((await send(mia.agent, 'post', `/api/v1/channels/${ch.id}/leave`)).status).toBe(204);
  });

  it('private channels and DMs are invisible to non-members, even to a query that skips the API checks (RLS)', async () => {
    const { owner, mia, vic, ws } = await team();
    const priv = (await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name: 'leads', private: true, memberIds: [mia.user.id] })).body.channel;
    await send(owner.agent, 'post', `/api/v1/channels/${priv.id}/messages`, { body: 'secret plan' });
    const dm = (await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/dms`, { userIds: [mia.user.id] })).body.channel;
    expect(dm).toMatchObject({ kind: 'dm', name: 'Mia' });
    // Opening the same DM again (from either side) returns the same conversation.
    expect((await send(mia.agent, 'post', `/api/v1/workspaces/${ws}/dms`, { userIds: [owner.user.id] })).body.channel.id).toBe(dm.id);
    await send(mia.agent, 'post', `/api/v1/channels/${dm.id}/messages`, { body: 'just between us' });

    expect((await channels(vic, ws)).map((c) => c.name)).toEqual([]);
    expect((await vic.agent.get(`/api/v1/channels/${priv.id}/messages`)).status).toBe(404);
    expect((await vic.agent.get(`/api/v1/channels/${dm.id}/messages`)).status).toBe(404);
    expect((await send(vic.agent, 'post', `/api/v1/channels/${priv.id}/join`)).status).toBe(404);
    // Search never surfaces them either.
    expect((await vic.agent.get('/api/v1/search?q=secret')).body.results).toEqual([]);
    expect((await mia.agent.get('/api/v1/search?q=secret')).body.results.map((r: { type: string }) => r.type)).toContain('message');

    // Row-level security: as Vic, a raw query sees no private messages.
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [vic.user.id]);
      expect((await c.query(`select body from messages`)).rows).toEqual([]);
      expect((await c.query(`select id from channels`)).rows).toEqual([]);
      await c.query('rollback');
    } finally {
      c.release();
      await pool.end();
    }

    // Adding Vic to the private channel makes it visible; removal hides it again.
    expect((await send(mia.agent, 'post', `/api/v1/channels/${priv.id}/members`, { userIds: [vic.user.id] })).status).toBe(200);
    expect((await vic.agent.get(`/api/v1/channels/${priv.id}/messages`)).body.messages[0].body).toBe('secret plan');
    expect((await send(mia.agent, 'delete', `/api/v1/channels/${priv.id}/members/${vic.user.id}`)).status).toBe(403); // only the channel admin
    expect((await send(owner.agent, 'delete', `/api/v1/channels/${priv.id}/members/${vic.user.id}`)).status).toBe(204);
    expect((await vic.agent.get(`/api/v1/channels/${priv.id}/messages`)).status).toBe(404);
  });

  it('losing workspace access hides the workspace’s private channels and DMs', async () => {
    const { owner, mia, ws } = await team();
    const dm = (await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/dms`, { userIds: [mia.user.id] })).body.channel;
    await send(owner.agent, 'post', `/api/v1/channels/${dm.id}/messages`, { body: 'before removal' });
    await query(`delete from workspace_memberships where workspace_id = $1 and user_id = $2`, [ws, mia.user.id]);
    expect((await mia.agent.get(`/api/v1/channels/${dm.id}/messages`)).status).toBe(404);
    expect((await mia.agent.get('/api/v1/me/chat/unread')).body.workspaces).toEqual([]);
  });
});

describe('messages', () => {
  it('threads, edits, deletes, reactions, paging and idempotent posting', async () => {
    const { owner, mia, ws } = await team();
    const ch = (await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name: 'dev' })).body.channel;
    await send(mia.agent, 'post', `/api/v1/channels/${ch.id}/join`);
    const id = crypto.randomUUID();
    const root = (await send(owner.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { id, body: 'Release today?' }));
    expect(root.status).toBe(201);
    expect((await send(owner.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { id, body: 'Release today?' })).status).toBe(200); // retry
    const r1 = (await send(mia.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { body: 'Yes after QA', parentId: id })).body.message;
    // A reply to a reply attaches to the thread root.
    await send(owner.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { body: 'Great', parentId: r1.id });
    const thread = (await mia.agent.get(`/api/v1/messages/${id}/thread`)).body;
    expect(thread.root).toMatchObject({ replyCount: 2 });
    expect(thread.replies.map((m: { body: string }) => m.body)).toEqual(['Yes after QA', 'Great']);
    // Replies are not top-level history.
    expect((await mia.agent.get(`/api/v1/channels/${ch.id}/messages`)).body.messages).toHaveLength(1);

    expect((await send(mia.agent, 'patch', `/api/v1/messages/${id}`, { body: 'hacked' })).status).toBe(403);
    expect((await send(owner.agent, 'patch', `/api/v1/messages/${id}`, { body: 'Release tomorrow?' })).body.message).toMatchObject({ body: 'Release tomorrow?' });
    const reacted = (await send(mia.agent, 'post', `/api/v1/messages/${id}/reactions`, { emoji: '👍' })).body.message;
    expect(reacted.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    expect((await send(mia.agent, 'post', `/api/v1/messages/${id}/reactions`, { emoji: '👍' })).body.message.reactions).toEqual([]); // toggle
    expect((await send(mia.agent, 'post', `/api/v1/messages/${id}/reactions`, { emoji: '💩' })).status).toBe(400);

    expect((await send(mia.agent, 'delete', `/api/v1/messages/${r1.id}`)).status).toBe(204);
    const after = (await mia.agent.get(`/api/v1/messages/${id}/thread`)).body.replies[0];
    expect(after).toMatchObject({ deleted: true, body: '' });

    for (let i = 0; i < 55; i++) await send(owner.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { body: `m${i}` });
    const page1 = (await mia.agent.get(`/api/v1/channels/${ch.id}/messages`)).body;
    expect(page1.messages).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    expect(page1.messages[49].body).toBe('m54');
    const page2 = (await mia.agent.get(`/api/v1/channels/${ch.id}/messages?before=${page1.messages[0].id}`)).body;
    expect(page2.messages.map((m: { body: string }) => m.body)).toEqual(['Release tomorrow?', 'm0', 'm1', 'm2', 'm3', 'm4']);
    expect(page2.hasMore).toBe(false);
  });

  it('archived channels are read-only; only the channel admin or a workspace admin can archive', async () => {
    const { owner, mia, ws } = await team();
    const ch = (await send(mia.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name: 'temp' })).body.channel;
    await send(owner.agent, 'post', `/api/v1/channels/${ch.id}/join`);
    expect((await send(owner.agent, 'patch', `/api/v1/channels/${ch.id}`, { archived: true })).status).toBe(200); // workspace admin
    expect((await send(mia.agent, 'post', `/api/v1/channels/${ch.id}/messages`, { body: 'x' })).status).toBe(409);
    expect((await send(mia.agent, 'patch', `/api/v1/channels/${ch.id}`, { archived: false, topic: 'back' })).body.channel).toMatchObject({ archived: false, topic: 'back' });
  });
});
