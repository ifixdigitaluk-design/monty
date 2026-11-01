import type { INestApplication } from '@nestjs/common';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RealtimeService } from '../src/realtime/realtime.service';
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

interface Sse {
  events: { event: string; id?: string; data: Record<string, unknown> }[];
  status: number;
  waitFor: (pred: (e: Sse['events'][number]) => boolean, ms?: number) => Promise<Sse['events'][number]>;
  close: () => void;
  ended: Promise<void>;
}

/** Opens an SSE stream with the user's session cookie and parses events as they arrive. */
async function stream(cookie: string, path: string, lastEventId?: string): Promise<Sse> {
  const { port } = app.getHttpServer().address() as AddressInfo;
  return new Promise((resolve) => {
    const events: Sse['events'] = [];
    let endResolve: () => void;
    const ended = new Promise<void>((r) => (endResolve = r));
    const req = http.get({ port, host: '127.0.0.1', path, headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const e: Record<string, string> = {};
          for (const line of raw.split('\n')) {
            const m = /^(\w+): ?(.*)$/.exec(line);
            if (m) e[m[1]!] = m[2]!;
          }
          if (e.event) events.push({ event: e.event, id: e.id, data: JSON.parse(e.data ?? '{}') });
        }
      });
      res.on('end', () => endResolve());
      resolve({
        events,
        status: res.statusCode ?? 0,
        close: () => req.destroy(),
        ended,
        waitFor: async (pred, ms = 3000) => {
          const start = Date.now();
          while (Date.now() - start < ms) {
            const hit = events.find(pred);
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 25));
          }
          throw new Error(`timed out; saw ${JSON.stringify(events.map((x) => x.event))}`);
        },
      });
    });
  });
}

const cookieOf = async (agent: Awaited<ReturnType<typeof signUp>>['agent']) => {
  // supertest agents keep cookies in a jar; read it back for the raw http stream.
  const jar = (agent as unknown as { jar: { getCookies: (o: unknown) => { name: string; value: string }[] } }).jar;
  return jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false }).map((c) => `${c.name}=${c.value}`).join('; ');
};

async function team() {
  const owner = await signUp(app, 'Owner');
  const mia = await signUp(app, 'Mia');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Live' })).body.organisation;
  const wsId = org.workspaces[0].id as string;
  await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, mia.user.id]);
  await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'MEMBER')`, [wsId, mia.user.id]);
  const project = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'P' })).body.project;
  return { owner, mia, org, wsId, project };
}

describe('realtime (SSE)', () => {
  it('delivers committed changes to other members as pointers, with presence', async () => {
    const { owner, mia, wsId, project } = await team();
    const s = await stream(await cookieOf(mia.agent), `/api/v1/workspaces/${wsId}/events?projectId=${project.id}`);
    expect(s.status).toBe(200);
    await s.waitFor((e) => e.event === 'ready');
    const presence = await s.waitFor((e) => e.event === 'presence');
    expect(presence.data.viewers).toEqual([{ userId: mia.user.id, name: 'Mia' }]);

    const task = (await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'Secret-ish title' })).body.task;
    const created = await s.waitFor((e) => e.event === 'change' && e.data.topic === 'task.created');
    expect(created.data).toMatchObject({ entityId: task.id, projectId: project.id, version: 1, actorId: owner.user.id, workspaceId: wsId });
    expect(created.id).toBe(created.data.id);
    // Pointer only: no entity fields travel over the stream.
    expect(JSON.stringify(created.data)).not.toContain('Secret-ish');

    await send(owner.agent, 'patch', `/api/v1/tasks/${task.id}`, { expectedVersion: 1, status: 'DONE' });
    expect((await s.waitFor((e) => e.data.topic === 'task.updated')).data.version).toBe(2);
    s.close();
  });

  it('does not announce rolled-back changes', async () => {
    const { owner, mia, wsId, project } = await team();
    const s = await stream(await cookieOf(mia.agent), `/api/v1/workspaces/${wsId}/events`);
    await s.waitFor((e) => e.event === 'ready');
    const bad = await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'x', parentTaskId: crypto.randomUUID() });
    expect(bad.status).toBe(400);
    await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'ok' });
    await s.waitFor((e) => e.data.topic === 'task.created');
    expect(s.events.filter((e) => e.event === 'change')).toHaveLength(1);
    s.close();
  });

  it('replays missed events after reconnect (Last-Event-ID)', async () => {
    const { owner, mia, wsId, project } = await team();
    const s1 = await stream(await cookieOf(mia.agent), `/api/v1/workspaces/${wsId}/events`);
    await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'one' });
    const first = await s1.waitFor((e) => e.data.topic === 'task.created');
    s1.close();
    // Changes while disconnected.
    await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'two' });
    await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'three' });
    const s2 = await stream(await cookieOf(mia.agent), `/api/v1/workspaces/${wsId}/events`, first.id);
    await s2.waitFor(() => s2.events.filter((e) => e.event === 'change').length === 2);
    const ids = s2.events.filter((e) => e.event === 'change').map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(first.id); // no duplicate of what the client already had
    s2.close();

    const bogus = await stream(await cookieOf(mia.agent), `/api/v1/workspaces/${wsId}/events`, '00000000-0000-4000-8000-000000000000');
    expect((await bogus.waitFor((e) => e.event === 'reset')).data.reason).toBe('unknown_cursor');
    bogus.close();
  });

  it('refuses outsiders and disconnects members who lose access', async () => {
    const { owner, mia, org, wsId } = await team();
    const out = await signUp(app, 'Out');
    const denied = await stream(await cookieOf(out.agent), `/api/v1/workspaces/${wsId}/events`);
    expect(denied.status).toBe(404);
    const anon = await stream('', `/api/v1/workspaces/${wsId}/events`);
    expect(anon.status).toBe(401);

    const s = await stream(await cookieOf(mia.agent), `/api/v1/workspaces/${wsId}/events`);
    await s.waitFor((e) => e.event === 'ready');
    await send(owner.agent, 'delete', `/api/v1/organisations/${org.id}/members/${mia.user.id}`);
    await app.get(RealtimeService).recheckNow();
    expect((await s.waitFor((e) => e.event === 'revoked')).data.reason).toBe('access_changed');
    await s.ended;
  });
});

describe('chat live events', () => {
  it('public channel events reach the workspace; private channel events reach only its members', async () => {
    const { owner, mia, org, wsId } = await team();
    const vic = await signUp(app, 'Vic');
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, vic.user.id]);
    await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'MEMBER')`, [wsId, vic.user.id]);
    const pub = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/channels`, { name: 'general' })).body.channel;
    const priv = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/channels`, { name: 'leads', private: true, memberIds: [mia.user.id] })).body.channel;
    const sMia = await stream(await cookieOf(mia.agent), `/api/v1/workspaces/${wsId}/events`);
    const sVic = await stream(await cookieOf(vic.agent), `/api/v1/workspaces/${wsId}/events`);
    await sMia.waitFor((e) => e.event === 'ready');
    await sVic.waitFor((e) => e.event === 'ready');

    const secret = (await send(owner.agent, 'post', `/api/v1/channels/${priv.id}/messages`, { body: 'private news' })).body.message;
    const open = (await send(owner.agent, 'post', `/api/v1/channels/${pub.id}/messages`, { body: 'public news' })).body.message;
    const got = await sMia.waitFor((e) => e.event === 'chat' && e.data.messageId === secret.id);
    expect(got.data).toMatchObject({ kind: 'message.created', channelId: priv.id });
    expect(got.data).not.toHaveProperty('memberIds');
    expect(JSON.stringify(got.data)).not.toContain('private news'); // pointers only
    await sVic.waitFor((e) => e.event === 'chat' && e.data.messageId === open.id);
    expect(sVic.events.some((e) => e.event === 'chat' && e.data.channelId === priv.id)).toBe(false);
    sMia.close();
    sVic.close();
  });
});

describe('database live events', () => {
  it('row changes reach teammates in the workspace as pointers, and nobody else', async () => {
    const { owner, mia, wsId } = await team();
    const otto = await signUp(app, 'Otto');
    const ottoOrg = (await send(otto.agent, 'post', '/api/v1/organisations', { name: 'Other' })).body.organisation;
    const db = (await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/databases`, { name: 'CRM' })).body.database;
    const sMia = await stream(await cookieOf(mia.agent), `/api/v1/workspaces/${wsId}/events`);
    const sOtto = await stream(await cookieOf(otto.agent), `/api/v1/workspaces/${ottoOrg.workspaces[0].id}/events`);
    await sMia.waitFor((e) => e.event === 'ready');
    await sOtto.waitFor((e) => e.event === 'ready');
    const row = (await send(owner.agent, 'post', `/api/v1/databases/${db.id}/rows`, { title: 'Acme deal' })).body.row;
    const got = await sMia.waitFor((e) => e.event === 'database' && e.data.rowId === row.id);
    expect(got.data).toMatchObject({ kind: 'row.created', databaseId: db.id, workspaceId: wsId });
    expect(JSON.stringify(got.data)).not.toContain('Acme');
    await new Promise((r) => setTimeout(r, 200));
    expect(sOtto.events.some((e) => e.event === 'database')).toBe(false);
    sMia.close();
    sOtto.close();
  });
});
