import type { INestApplication } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanFilename, FilesService } from '../src/files/files.service';
import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp({ files: { dir: process.env.FILES_DIR!, maxBytes: 1024 * 1024 } });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
});

type U = Awaited<ReturnType<typeof signUp>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const upload = (u: U, targetType: string, targetId: string, bytes: Buffer, name = 'file.bin') =>
  u.agent
    .post(`/api/v1/attachments?targetType=${targetType}&targetId=${targetId}`)
    .set('X-Monty-Client', 'web')
    .set('Content-Type', 'application/octet-stream')
    .set('X-Filename', encodeURIComponent(name))
    .send(bytes);

async function team() {
  const owner = await signUp(app, 'Fay');
  const mia = await signUp(app, 'Mia');
  const vic = await signUp(app, 'Vic');
  const outsider = await signUp(app, 'Otto');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Files' })).body.organisation;
  const ws = org.workspaces[0].id as string;
  for (const [u, role] of [[mia, 'MEMBER'], [vic, 'VIEWER']] as const) {
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, u.user.id]);
    await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, $3)`, [ws, u.user.id, role]);
  }
  const project = (await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/projects`, { name: 'P' })).body.project;
  const task = (await send(owner.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'T' })).body.task;
  return { owner, mia, vic, outsider, ws, task };
}

describe('attachments', () => {
  it('task files: upload, list, download (sniffed type), permissions and isolation', async () => {
    const { owner, mia, vic, outsider, task } = await team();
    const img = await upload(mia, 'task', task.id, PNG, 'screen shot.png');
    expect(img.status).toBe(201);
    expect(img.body.attachment).toMatchObject({ filename: 'screen shot.png', contentType: 'image/png', inline: true, sizeBytes: PNG.length });
    // A file claiming to be HTML is stored as an opaque download, never rendered.
    const html = await upload(mia, 'task', task.id, Buffer.from('<script>alert(1)</script>'), 'evil.html');
    expect(html.body.attachment).toMatchObject({ contentType: 'application/octet-stream', inline: false });
    expect((await upload(vic, 'task', task.id, PNG)).status).toBe(403); // viewers read, don't upload
    expect((await upload(outsider, 'task', task.id, PNG)).status).toBe(404);

    const list = (await vic.agent.get(`/api/v1/tasks/${task.id}/attachments`)).body.attachments;
    expect(list.map((a: { filename: string }) => a.filename)).toEqual(['screen shot.png', 'evil.html']);
    const dl = await vic.agent.get(`${img.body.attachment.url}?inline=1`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.headers['content-disposition']).toMatch(/^inline; filename="screen shot.png"/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(dl.body as Buffer, PNG)).toBe(0);
    const evil = await vic.agent.get(`${html.body.attachment.url}?inline=1`);
    expect(evil.headers['content-type']).toBe('application/octet-stream');
    expect(evil.headers['content-disposition']).toMatch(/^attachment;/);
    expect(evil.headers['content-security-policy']).toContain('sandbox');
    expect((await outsider.agent.get(img.body.attachment.url)).status).toBe(404);

    expect((await send(vic.agent, 'delete', img.body.attachment.url)).status).toBe(403);
    expect((await send(owner.agent, 'delete', img.body.attachment.url)).status).toBe(204); // workspace admin
    expect((await vic.agent.get(img.body.attachment.url)).status).toBe(404);
  });

  it('enforces the size limit, rejects empty files and wrong content types, and cleans names', async () => {
    const { mia, task } = await team();
    expect((await upload(mia, 'task', task.id, Buffer.alloc(1024 * 1024 + 1, 7))).status).toBe(413);
    expect((await upload(mia, 'task', task.id, Buffer.alloc(0))).status).toBe(400);
    const json = await mia.agent.post(`/api/v1/attachments?targetType=task&targetId=${task.id}`).set('X-Monty-Client', 'web').send({ a: 1 });
    expect(json.status).toBe(400);
    expect(cleanFilename(encodeURIComponent('../../etc/passwd'))).toBe('passwd');
    expect(cleanFilename('a"b<c>.txt')).toBe('abc.txt');
    expect(cleanFilename(undefined)).toBe('file');
    // No temp files left behind by the rejected upload.
    const tmp = await readdir(path.join(process.env.FILES_DIR!, 'tmp'));
    expect(tmp).toEqual([]);
  });

  it('chat files: pending until posted, visible only to people who can see the channel', async () => {
    const { owner, mia, vic, ws } = await team();
    const priv = (await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name: 'secret', private: true, memberIds: [mia.user.id] })).body.channel;
    const up = (await upload(mia, 'channel', priv.id, PNG, 'plan.png')).body.attachment;
    expect((await upload(vic, 'channel', priv.id, PNG)).status).toBe(404);
    const msg = await send(mia.agent, 'post', `/api/v1/channels/${priv.id}/messages`, { body: '', attachmentIds: [up.id] });
    expect(msg.status).toBe(201);
    expect(msg.body.message.attachments).toMatchObject([{ id: up.id, filename: 'plan.png' }]);
    // Someone else's upload can't be attached; nor can the same file twice.
    const other = (await upload(owner, 'channel', priv.id, PNG)).body.attachment;
    expect((await send(mia.agent, 'post', `/api/v1/channels/${priv.id}/messages`, { body: 'x', attachmentIds: [other.id] })).status).toBe(400);
    expect((await send(mia.agent, 'post', `/api/v1/channels/${priv.id}/messages`, { body: 'x', attachmentIds: [up.id] })).status).toBe(400);

    expect((await owner.agent.get(up.url)).status).toBe(200);
    expect((await vic.agent.get(up.url)).status).toBe(404); // not in the private channel
    // Deleting the message hides its files.
    await send(mia.agent, 'delete', `/api/v1/messages/${msg.body.message.id}`);
    expect((await owner.agent.get(up.url)).status).toBe(404);
  });

  it('maintenance erases deleted, never-posted and orphaned files from disk', async () => {
    const { mia, ws, task } = await team();
    const ch = (await send(mia.agent, 'post', `/api/v1/workspaces/${ws}/channels`, { name: 'files' })).body.channel;
    const pending = (await upload(mia, 'channel', ch.id, PNG)).body.attachment;
    const gone = (await upload(mia, 'task', task.id, PNG)).body.attachment;
    const kept = (await upload(mia, 'task', task.id, PNG)).body.attachment;
    await send(mia.agent, 'delete', gone.url);
    await query(`update attachments set created_at = now() - interval '2 days' where id = $1`, [pending.id]);
    await query(`update attachments set deleted_at = now() - interval '2 days' where id = $1`, [gone.id]);
    const result = await app.get(FilesService).purge();
    expect(result.deleted).toBe(2);
    expect((await mia.agent.get(kept.url)).status).toBe(200);
    const rows = await query<{ id: string }>(`select id from attachments`);
    expect(rows.map((r) => r.id)).toEqual([kept.id]);
    expect((await app.get(MaintenanceService).runNow()).files).toBe(0);
  });
});
