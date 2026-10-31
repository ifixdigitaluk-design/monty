import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseFields, databaseRows, databases, databaseViews } from '@monty/database';
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
  const owner = await signUp(app, 'Fay');
  const mia = await signUp(app, 'Mia');
  const vic = await signUp(app, 'Vic');
  const outsider = await signUp(app, 'Otto');
  const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Data' })).body.organisation;
  const ws = org.workspaces[0].id as string;
  for (const [u, role] of [[mia, 'MEMBER'], [vic, 'VIEWER']] as const) {
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, u.user.id]);
    await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, $3)`, [ws, u.user.id, role]);
  }
  return { owner, mia, vic, outsider, ws };
}

const api = (path: string) => `/api/v1${path}`;

describe('databases', () => {
  it('creates a database with a Status field, table and board views; idempotent by id', async () => {
    const { owner, ws } = await team();
    const id = crypto.randomUUID();
    const res = await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { id, name: 'Content calendar' });
    expect(res.status).toBe(201);
    const db = res.body.database;
    expect(db).toMatchObject({ id, name: 'Content calendar', role: 'ADMIN', rows: [] });
    expect(db.fields).toEqual([expect.objectContaining({ name: 'Status', type: 'select' })]);
    expect(db.fields[0].options.choices.map((c: { label: string }) => c.label)).toEqual(['Not started', 'In progress', 'Done']);
    expect(db.views.map((v: { name: string; layout: string }) => [v.name, v.layout])).toEqual([['Table', 'table'], ['Board', 'board']]);
    expect(db.views[1].config.groupBy).toBe(db.fields[0].id);
    const again = await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { id, name: 'Content calendar' });
    expect(again.status).toBe(200);
    expect((await owner.agent.get(api(`/workspaces/${ws}/databases`))).body.databases).toEqual([expect.objectContaining({ id, rowCount: 0 })]);
  });

  it('typed fields: values are validated, merged per cell and cleared with null', async () => {
    const { owner, mia, ws } = await team();
    const db = (await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { name: 'Deals' })).body.database;
    const status = db.fields[0];
    const field = async (name: string, type: string, options?: unknown) =>
      (await send(owner.agent, 'post', api(`/databases/${db.id}/fields`), { name, type, ...(options ? { options } : {}) })).body.field;
    const value = await field('Value', 'number');
    const close = await field('Close date', 'date');
    const owners = await field('Owner', 'person');
    const tags = await field('Tags', 'multi_select', { choices: [{ id: 'hot', label: 'Hot', color: 'red' }, { id: 'new', label: 'New', color: 'blue' }] });
    const site = await field('Website', 'url');

    const created = await send(mia.agent, 'post', api(`/databases/${db.id}/rows`), {
      title: 'Acme',
      values: { [value.id]: 1200, [status.id]: 'doing', [owners.id]: [mia.user.id], [tags.id]: ['hot'] },
    });
    expect(created.status).toBe(201);
    const row = created.body.row;
    expect(row.values).toEqual({ [value.id]: 1200, [status.id]: 'doing', [owners.id]: [mia.user.id], [tags.id]: ['hot'] });
    expect(row.createdBy).toEqual({ id: mia.user.id, name: 'Mia' });

    // Bad values are rejected with the field name.
    const bad = async (values: Record<string, unknown>) => send(mia.agent, 'patch', api(`/database-rows/${row.id}`), { values });
    expect((await bad({ [value.id]: 'lots' })).body.error.message).toBe('Value: Must be a number');
    expect((await bad({ [status.id]: 'nope' })).status).toBe(400);
    expect((await bad({ [close.id]: '2026-02-30' })).status).toBe(400);
    expect((await bad({ [site.id]: 'javascript:alert(1)' })).status).toBe(400);
    const otto = await signUp(app, 'Otto');
    expect((await bad({ [owners.id]: [otto.user.id] })).body.error.message).toMatch(/member of this workspace/);
    expect((await bad({ [crypto.randomUUID()]: 'x' })).status).toBe(400);

    // Two people edit different cells at the same time: both changes are kept (cells merge).
    await Promise.all([
      send(owner.agent, 'patch', api(`/database-rows/${row.id}`), { values: { [close.id]: '2026-12-01' } }),
      send(mia.agent, 'patch', api(`/database-rows/${row.id}`), { values: { [value.id]: 1500 } }),
    ]);
    const after = (await owner.agent.get(api(`/database-rows/${row.id}`))).body.row;
    expect(after.values).toMatchObject({ [close.id]: '2026-12-01', [value.id]: 1500, [status.id]: 'doing' });
    // null clears a cell.
    const cleared = (await send(owner.agent, 'patch', api(`/database-rows/${row.id}`), { values: { [tags.id]: null } })).body.row;
    expect(cleared.values).not.toHaveProperty(tags.id);
  });

  it('the row page needs expectedVersion and refuses stale edits', async () => {
    const { owner, mia, ws } = await team();
    const db = (await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { name: 'Wiki' })).body.database;
    const row = (await send(owner.agent, 'post', api(`/databases/${db.id}/rows`), { title: 'Onboarding' })).body.row;
    expect((await send(owner.agent, 'patch', api(`/database-rows/${row.id}`), { body: 'x' })).status).toBe(400);
    // A teammate editing a property meanwhile does not make the page edit conflict.
    await send(mia.agent, 'patch', api(`/database-rows/${row.id}`), { title: 'Onboarding guide' });
    const v2 = await send(owner.agent, 'patch', api(`/database-rows/${row.id}`), { body: '# Day one', expectedVersion: row.bodyVersion });
    expect(v2.status).toBe(200);
    expect(v2.body.row).toMatchObject({ body: '# Day one', hasBody: true, title: 'Onboarding guide', bodyVersion: row.bodyVersion + 1 });
    const stale = await send(mia.agent, 'patch', api(`/database-rows/${row.id}`), { body: 'mine', expectedVersion: row.bodyVersion });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.current.body).toBe('# Day one');
    // Lists don't carry page bodies (kept small); the flag says whether there is one.
    const listed = (await owner.agent.get(api(`/databases/${db.id}`))).body.database.rows[0];
    expect(listed).toMatchObject({ hasBody: true });
    expect(listed).not.toHaveProperty('body');
  });

  it('permissions: viewers read only, members edit rows and structure, outsiders get 404', async () => {
    const { owner, mia, vic, outsider, ws } = await team();
    const db = (await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { name: 'Roadmap' })).body.database;
    const row = (await send(owner.agent, 'post', api(`/databases/${db.id}/rows`), { title: 'Q1' })).body.row;

    expect((await vic.agent.get(api(`/databases/${db.id}`))).status).toBe(200);
    expect((await send(vic.agent, 'post', api(`/databases/${db.id}/rows`), { title: 'x' })).status).toBe(403);
    expect((await send(vic.agent, 'patch', api(`/database-rows/${row.id}`), { title: 'x' })).status).toBe(403);

    expect((await send(mia.agent, 'patch', api(`/database-rows/${row.id}`), { title: 'Q1 plan' })).status).toBe(200);
    // Members create structure too (same rule as projects/docs: task.create); viewers don't.
    expect((await send(vic.agent, 'post', api(`/databases/${db.id}/fields`), { name: 'F', type: 'text' })).status).toBe(403);
    expect((await send(vic.agent, 'post', api(`/databases/${db.id}/views`), { name: 'Mine', layout: 'table' })).status).toBe(403);
    expect((await send(vic.agent, 'delete', api(`/databases/${db.id}`))).status).toBe(403);

    for (const r of [
      await outsider.agent.get(api(`/databases/${db.id}`)),
      await outsider.agent.get(api(`/database-rows/${row.id}`)),
      await outsider.agent.get(api(`/databases/${db.id}/export.csv`)),
      await send(outsider.agent, 'patch', api(`/database-rows/${row.id}`), { title: 'x' }),
      await send(outsider.agent, 'post', api(`/databases/${db.id}/rows`), { title: 'x' }),
      await send(outsider.agent, 'patch', api(`/database-fields/${db.fields[0].id}`), { name: 'x' }),
      await send(outsider.agent, 'patch', api(`/database-views/${db.views[0].id}`), { name: 'x' }),
      await outsider.agent.get(api(`/workspaces/${ws}/databases`)),
    ]) {
      expect(r.status).toBe(404);
    }
  });

  it('views: saved filters/sorts; boards need a select field; deleting a field cleans cells and views; removing an option clears it', async () => {
    const { owner, ws } = await team();
    const db = (await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { name: 'Bugs' })).body.database;
    const status = db.fields[0];
    const sev = (await send(owner.agent, 'post', api(`/databases/${db.id}/fields`), { name: 'Severity', type: 'number' })).body.field;
    const labels = (
      await send(owner.agent, 'post', api(`/databases/${db.id}/fields`), {
        name: 'Labels',
        type: 'multi_select',
        options: { choices: [{ id: 'ui', label: 'UI', color: 'blue' }, { id: 'api', label: 'API', color: 'green' }] },
      })
    ).body.field;
    const row = (await send(owner.agent, 'post', api(`/databases/${db.id}/rows`), { title: 'Crash', values: { [sev.id]: 1, [status.id]: 'todo', [labels.id]: ['ui', 'api'] } })).body.row;

    const view = await send(owner.agent, 'post', api(`/databases/${db.id}/views`), {
      name: 'Urgent',
      layout: 'table',
      config: { filters: [{ fieldId: sev.id, op: 'lt', value: 2 }], sorts: [{ fieldId: '__title', dir: 'asc' }], hiddenFieldIds: [labels.id] },
    });
    expect(view.status).toBe(201);
    expect((await send(owner.agent, 'post', api(`/databases/${db.id}/views`), { name: 'X', layout: 'table', config: { filters: [{ fieldId: crypto.randomUUID(), op: 'is', value: 1 }] } })).status).toBe(400);
    expect((await send(owner.agent, 'patch', api(`/database-views/${view.body.view.id}`), { layout: 'board', config: { groupBy: sev.id } })).status).toBe(400);

    // Removing the "ui" option strips it from rows; the row keeps "api".
    await send(owner.agent, 'patch', api(`/database-fields/${labels.id}`), { options: { choices: [{ id: 'api', label: 'API', color: 'green' }] } });
    expect((await owner.agent.get(api(`/database-rows/${row.id}`))).body.row.values[labels.id]).toEqual(['api']);
    // Removing the status option the row uses clears the cell.
    await send(owner.agent, 'patch', api(`/database-fields/${status.id}`), { options: { choices: status.options.choices.filter((c: { id: string }) => c.id !== 'todo') } });
    expect((await owner.agent.get(api(`/database-rows/${row.id}`))).body.row.values).not.toHaveProperty(status.id);

    // Deleting a field removes its cells and every view reference to it.
    expect((await send(owner.agent, 'delete', api(`/database-fields/${sev.id}`))).status).toBe(204);
    const now = (await owner.agent.get(api(`/databases/${db.id}`))).body.database;
    expect(now.rows[0].values).not.toHaveProperty(sev.id);
    const urgent = now.views.find((v: { name: string }) => v.name === 'Urgent');
    expect(urgent.config.filters).toEqual([]);
    expect(urgent.config.sorts).toEqual([{ fieldId: '__title', dir: 'asc' }]);
    // Deleting the group-by field of a board leaves no select to group by: the board keeps working with groupBy null.
    expect((await send(owner.agent, 'delete', api(`/database-fields/${status.id}`))).status).toBe(204);
    expect((await owner.agent.get(api(`/databases/${db.id}`))).body.database.views.find((v: { layout: string }) => v.layout === 'board').config.groupBy).toBeNull();

    // A database always keeps one view.
    const views = (await owner.agent.get(api(`/databases/${db.id}`))).body.database.views as { id: string }[];
    for (const v of views.slice(1)) expect((await send(owner.agent, 'delete', api(`/database-views/${v.id}`))).status).toBe(204);
    expect((await send(owner.agent, 'delete', api(`/database-views/${views[0]!.id}`))).status).toBe(400);
  });

  it('imports a CSV-style table (types converted, batches) and exports CSV safely', async () => {
    const { owner, ws } = await team();
    const created = await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), {
      name: 'Imported',
      import: {
        fields: [
          { name: 'Stage', type: 'select', choices: ['Lead', 'Won'] },
          { name: 'Amount', type: 'number' },
          { name: 'Closed', type: 'date' },
          { name: 'Signed', type: 'checkbox' },
          { name: 'Notes', type: 'text' },
        ],
        rows: [
          { title: 'Acme', cells: ['Won', '1,200', 'March 4, 2026', 'Yes', '=HYPERLINK("http://evil")'] },
          { title: 'Globex', cells: ['Unknown stage', 'n/a', 'someday', 'No', 'call back, maybe'] },
        ],
      },
    });
    expect(created.status).toBe(201);
    const db = created.body.database;
    const [stage, amount, closed, signed, notes] = db.fields;
    expect(db.views).toEqual([expect.objectContaining({ name: 'All', layout: 'table' })]);
    const acme = db.rows.find((r: { title: string }) => r.title === 'Acme');
    const won = stage.options.choices.find((c: { label: string }) => c.label === 'Won').id;
    expect(acme.values).toEqual({ [stage.id]: won, [amount.id]: 1200, [closed.id]: '2026-03-04', [signed.id]: true, [notes.id]: '=HYPERLINK("http://evil")' });
    // Text that doesn't fit the field is left empty rather than failing the import.
    const globex = db.rows.find((r: { title: string }) => r.title === 'Globex');
    expect(globex.values).toEqual({ [notes.id]: 'call back, maybe' });

    const more = await send(owner.agent, 'post', api(`/databases/${db.id}/import`), { rows: [{ title: 'Initech', cells: ['Lead', '50'] }] });
    expect(more.body).toEqual({ imported: 1 });

    const csv = await owner.agent.get(api(`/databases/${db.id}/export.csv`));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="Imported.csv"/);
    const lines = csv.text.replace(/^\ufeff/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Name,Stage,Amount,Closed,Signed,Notes');
    // Formula-looking text is neutralised so it can't run when opened in a spreadsheet.
    expect(lines[1]).toBe(`Acme,Won,1200,2026-03-04,Yes,"'=HYPERLINK(""http://evil"")"`);
    expect(lines[2]).toBe('Globex,,,,No,"call back, maybe"');
    expect(lines[3]).toBe('Initech,Lead,50,,No,');
  });

  it('row-level security hides other tenants\' databases even from an unfiltered query', async () => {
    const { owner, outsider, ws } = await team();
    const db = (await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { name: 'Secret CRM' })).body.database;
    await send(owner.agent, 'post', api(`/databases/${db.id}/rows`), { title: 'Big client' });
    const dbs = app.get(DbService);
    const unfiltered = () =>
      Promise.all([dbs.db.select().from(databases), dbs.db.select().from(databaseFields), dbs.db.select().from(databaseRows), dbs.db.select().from(databaseViews)]).then((r) => r.map((x) => x.length));
    expect(await dbs.runAsUser(outsider.user.id, unfiltered)).toEqual([0, 0, 0, 0]);
    expect(await dbs.runAsUser(owner.user.id, unfiltered)).toEqual([1, 1, 1, 2]);
  });

  it('deleting a database hides it and its rows', async () => {
    const { owner, ws } = await team();
    const db = (await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { name: 'Temp' })).body.database;
    const row = (await send(owner.agent, 'post', api(`/databases/${db.id}/rows`), { title: 'r' })).body.row;
    expect((await send(owner.agent, 'delete', api(`/databases/${db.id}`))).status).toBe(204);
    expect((await owner.agent.get(api(`/databases/${db.id}`))).status).toBe(404);
    expect((await owner.agent.get(api(`/database-rows/${row.id}`))).status).toBe(404);
    expect((await owner.agent.get(api(`/workspaces/${ws}/databases`))).body.databases).toEqual([]);
  });
});

describe('database search', () => {
  it('finds rows by title and page text, only in the caller’s workspaces', async () => {
    const { owner, outsider, ws } = await team();
    const db = (await send(owner.agent, 'post', api(`/workspaces/${ws}/databases`), { name: 'Clients' })).body.database;
    const row = (await send(owner.agent, 'post', api(`/databases/${db.id}/rows`), { title: 'Globex renewal' })).body.row;
    await send(owner.agent, 'patch', api(`/database-rows/${row.id}`), { body: 'Discussed the zeppelin budget', expectedVersion: row.bodyVersion });
    const hit = (await owner.agent.get(api('/search?q=zeppelin'))).body.results;
    expect(hit).toEqual([expect.objectContaining({ type: 'database_row', id: row.id, title: 'Globex renewal', databaseId: db.id, projectName: 'Clients', workspaceId: ws })]);
    expect((await owner.agent.get(api('/search?q=globex'))).body.results.map((r: { id: string }) => r.id)).toContain(row.id);
    expect((await outsider.agent.get(api('/search?q=zeppelin'))).body.results).toEqual([]);
  });
});
