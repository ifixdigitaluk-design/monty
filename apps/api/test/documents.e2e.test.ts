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

describe('documents', () => {
  it('create, nest, edit with optimistic concurrency, history, restore, delete subtree', async () => {
    const a = await signUp(app, 'Doc');
    const url = `/api/v1/workspaces/${a.workspaceId}/documents`;
    const root = (await send(a.agent, 'post', url, { title: 'Handbook', body: '# Welcome' })).body.document;
    expect(root).toMatchObject({ title: 'Handbook', body: '# Welcome', version: 1, role: 'ADMIN', createdBy: { name: 'Doc' } });
    const child = (await send(a.agent, 'post', url, { title: 'Onboarding', parentId: root.id })).body.document;

    const e1 = await send(a.agent, 'patch', `/api/v1/documents/${root.id}`, { expectedVersion: 1, body: '# Welcome\n\nFirst draft' });
    expect(e1.body.document.version).toBe(2);
    const stale = await send(a.agent, 'patch', `/api/v1/documents/${root.id}`, { expectedVersion: 1, body: 'lost' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.current.body).toContain('First draft');

    // Rapid saves by the same author coalesce into one history entry.
    await send(a.agent, 'patch', `/api/v1/documents/${root.id}`, { expectedVersion: 2, body: '# Welcome\n\nSecond draft' });
    let versions = (await a.agent.get(`/api/v1/documents/${root.id}/versions`)).body.versions;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([3, 1]);

    // Restore v1 creates a new version; history is kept.
    const restored = await send(a.agent, 'post', `/api/v1/documents/${root.id}/versions/${versions[1].id}/restore`);
    expect(restored.body.document).toMatchObject({ body: '# Welcome', version: 4 });
    versions = (await a.agent.get(`/api/v1/documents/${root.id}/versions`)).body.versions;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([4, 3, 1]);

    // Cannot move a page inside its own child.
    expect((await send(a.agent, 'patch', `/api/v1/documents/${root.id}`, { expectedVersion: 4, parentId: child.id })).status).toBe(400);

    const list = (await a.agent.get(url)).body.documents;
    expect(list.map((d: { title: string; parentId: string | null }) => `${d.title}:${d.parentId === root.id}`)).toEqual(['Handbook:false', 'Onboarding:true']);

    expect((await send(a.agent, 'delete', `/api/v1/documents/${root.id}`)).status).toBe(204);
    expect((await a.agent.get(url)).body.documents).toEqual([]);
    expect((await a.agent.get(`/api/v1/documents/${child.id}`)).status).toBe(404);
  });

  it('links to a project in the same workspace only; appears in search; isolated per tenant', async () => {
    const a = await signUp(app, 'Alice');
    const b = await signUp(app, 'Bob');
    const p = (await send(a.agent, 'post', `/api/v1/workspaces/${a.workspaceId}/projects`, { name: 'Launch' })).body.project;
    const bp = (await send(b.agent, 'post', `/api/v1/workspaces/${b.workspaceId}/projects`, { name: 'Bob P' })).body.project;
    const url = `/api/v1/workspaces/${a.workspaceId}/documents`;
    expect((await send(a.agent, 'post', url, { title: 'X', projectId: bp.id })).status).toBe(400);
    const spec = (await send(a.agent, 'post', url, { title: 'Launch spec', projectId: p.id, body: 'Pricing assumptions and risks' })).body.document;

    expect((await a.agent.get(`${url}?projectId=${p.id}`)).body.documents.map((d: { id: string }) => d.id)).toEqual([spec.id]);
    const hits = (await a.agent.get('/api/v1/search?q=pricing')).body.results;
    expect(hits[0]).toMatchObject({ type: 'document', id: spec.id, projectId: p.id, projectName: 'Launch' });

    expect((await b.agent.get(`/api/v1/documents/${spec.id}`)).status).toBe(404);
    expect((await send(b.agent, 'patch', `/api/v1/documents/${spec.id}`, { expectedVersion: 1, body: 'pwned' })).status).toBe(404);
    expect((await b.agent.get('/api/v1/search?q=pricing')).body.results).toEqual([]);
    expect((await b.agent.get(url)).status).toBe(404);
  });

  it('viewers can read but not edit', async () => {
    const owner = await signUp(app, 'Owner');
    const viewer = await signUp(app, 'Viewer');
    const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'T' })).body.organisation;
    const ws = org.workspaces[0].id;
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, viewer.user.id]);
    await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'VIEWER')`, [ws, viewer.user.id]);
    const d = (await send(owner.agent, 'post', `/api/v1/workspaces/${ws}/documents`, { title: 'Policy' })).body.document;
    expect((await viewer.agent.get(`/api/v1/documents/${d.id}`)).body.document.role).toBe('VIEWER');
    expect((await send(viewer.agent, 'patch', `/api/v1/documents/${d.id}`, { expectedVersion: 1, body: 'x' })).status).toBe(403);
    expect((await send(viewer.agent, 'post', `/api/v1/workspaces/${ws}/documents`, { title: 'No' })).status).toBe(403);
  });
});
