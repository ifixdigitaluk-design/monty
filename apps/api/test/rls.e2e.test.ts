import type { INestApplication } from '@nestjs/common';
import { projects, tasks } from '@monty/database';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

/**
 * Row-level security (B-03): verifies that Postgres itself isolates tenants for the API's runtime role,
 * independently of the API's permission checks.
 */
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

/** Runs SQL as the API's restricted role with an optional RLS context, in one transaction. */
async function asApp<T = Record<string, unknown>>(ctx: { userId?: string; system?: boolean }, sql: string, params: unknown[] = []) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    if (ctx.userId) await client.query(`select set_config('app.user_id', $1, true)`, [ctx.userId]);
    if (ctx.system) await client.query(`select set_config('app.system', 'on', true)`);
    const res = await client.query(sql, params);
    await client.query('commit');
    return { rows: res.rows as T[], count: res.rowCount ?? 0 };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

async function setup() {
  const alice = await signUp(app, 'Alice');
  const bob = await signUp(app, 'Bob');
  const project = (await send(alice.agent, 'post', `/api/v1/workspaces/${alice.workspaceId}/projects`, { name: 'Secret' })).body.project;
  const task = (await send(alice.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'Secret task' })).body.task;
  return { alice, bob, project, task };
}

describe('row-level security for the runtime role', () => {
  it('the API role is restricted (not owner, no BYPASSRLS) and RLS is enabled on tenant tables', async () => {
    const [role] = (await asApp<{ owner: boolean; bypass: boolean }>({},
      `select (select pg_get_userbyid(relowner) = current_user from pg_class where relname = 'projects') as owner,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypass`)).rows;
    expect(role).toEqual({ owner: false, bypass: false });
    // Guard for future migrations: every table carrying tenant data must have RLS enabled.
    // Membership tables are the exception by design (they are the source of truth for the policies).
    const unprotected = await query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
         join pg_class p on p.relname = c.table_name and p.relkind = 'r'
        where c.table_schema = 'public' and c.column_name in ('organisation_id', 'workspace_id') and not p.relrowsecurity
        group by c.table_name order by c.table_name`,
    );
    expect(unprotected.map((t) => t.table_name)).toEqual(['organisation_memberships', 'workspace_memberships']);
  });

  it('without a user context nothing tenant-scoped is visible', async () => {
    await setup();
    for (const t of ['projects', 'tasks', 'workspaces', 'activity_events', 'outbox_events']) {
      expect((await asApp({}, `select 1 from ${t}`)).count, t).toBe(0);
    }
  });

  it("another user cannot read, change, delete or insert into someone else's data", async () => {
    const { alice, bob, project, task } = await setup();
    const asBob = { userId: bob.user.id };
    expect((await asApp(asBob, 'select * from projects where id = $1', [project.id])).count).toBe(0);
    expect((await asApp(asBob, 'select * from tasks where id = $1', [task.id])).count).toBe(0);
    expect((await asApp(asBob, `update tasks set title = 'pwned' where id = $1`, [task.id])).count).toBe(0);
    expect((await asApp(asBob, 'delete from projects where id = $1', [project.id])).count).toBe(0);
    await expect(
      asApp(asBob, `insert into tasks (organisation_id, workspace_id, project_id, title, creator_id) values ($1, $2, $3, 'evil', $4)`, [
        project.organisationId, project.workspaceId, project.id, bob.user.id,
      ]),
    ).rejects.toThrow(/row-level security/);
    // Alice still sees her untouched data; the system context sees everything.
    const own = await asApp<{ title: string }>({ userId: alice.user.id }, 'select title from tasks where id = $1', [task.id]);
    expect(own.rows).toEqual([{ title: 'Secret task' }]);
    expect((await asApp({ system: true }, 'select 1 from projects')).count).toBe(1);
  });

  it('a user cannot move a row into another tenant (WITH CHECK)', async () => {
    const { alice, bob, project } = await setup();
    const bobWs = await query<{ organisation_id: string }>('select organisation_id from workspaces where id = $1', [bob.workspaceId]);
    await expect(
      asApp({ userId: alice.user.id }, 'update projects set workspace_id = $1, organisation_id = $2 where id = $3', [
        bob.workspaceId, bobWs[0]!.organisation_id, project.id,
      ]),
    ).rejects.toThrow(/row-level security|violates/);
  });

  it('workspace-level access follows roles: org members need explicit workspace membership', async () => {
    const owner = await signUp(app, 'Owner');
    const member = await signUp(app, 'Member');
    const org = (await send(owner.agent, 'post', '/api/v1/organisations', { name: 'Team' })).body.organisation;
    const wsId = org.workspaces[0].id;
    await send(owner.agent, 'post', `/api/v1/workspaces/${wsId}/projects`, { name: 'Team project' });
    await query(`insert into organisation_memberships (organisation_id, user_id, role) values ($1, $2, 'MEMBER')`, [org.id, member.user.id]);

    const visible = () => asApp({ userId: member.user.id }, `select 1 from projects where workspace_id = $1`, [wsId]);
    expect((await visible()).count).toBe(0);
    await query(`insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'VIEWER')`, [wsId, member.user.id]);
    expect((await visible()).count).toBe(1);
    // Losing organisation membership removes access immediately, even if a stale workspace membership remains.
    await query('delete from organisation_memberships where organisation_id = $1 and user_id = $2', [org.id, member.user.id]);
    expect((await visible()).count).toBe(0);
  });

  it('account-level audit entries are visible only to their own user', async () => {
    const { alice, bob } = await setup();
    const mine = await asApp<{ action: string }>({ userId: alice.user.id }, `select action from audit_logs where organisation_id is null`);
    expect(mine.rows.map((r) => r.action)).toEqual(['auth.registered']);
    const theirs = await asApp({ userId: bob.user.id }, `select 1 from audit_logs where actor_id = $1`, [alice.user.id]);
    expect(theirs.count).toBe(0);
  });
});

describe('RLS behind the API', () => {
  it('a query that skips the permission layer still only sees the caller’s rows (simulated missing check)', async () => {
    const { alice, bob } = await setup();
    const dbs = app.get(DbService);
    // Deliberately unfiltered queries, as a buggy service method might write them.
    const asBob = await dbs.runAsUser(bob.user.id, async () => ({
      projects: await dbs.db.select().from(projects),
      tasks: await dbs.db.select().from(tasks),
    }));
    expect(asBob).toEqual({ projects: [], tasks: [] });
    const asAlice = await dbs.runAsUser(alice.user.id, () => dbs.db.select().from(projects));
    expect(asAlice.map((p) => p.name)).toEqual(['Secret']);
  });

  it('a failed request rolls back everything it wrote (request = transaction)', async () => {
    const { alice, project } = await setup();
    // Parent from another project → 400 after the access checks; nothing may be persisted.
    const before = await query('select count(*)::int as n from activity_events');
    const res = await send(alice.agent, 'post', `/api/v1/projects/${project.id}/tasks`, { title: 'x', parentTaskId: crypto.randomUUID() });
    expect(res.status).toBe(400);
    expect(await query('select count(*)::int as n from activity_events')).toEqual(before);
  });

  it('refuses to start when RLS would not apply (owner connection) if RLS is required', async () => {
    await expect(createTestApp({ databaseUrl: process.env.TEST_DATABASE_URL!, requireRls: true })).rejects.toThrow(
      /Row-level security is NOT effective: .*owns the tables/,
    );
    const lenient = await createTestApp({ databaseUrl: process.env.TEST_DATABASE_URL!, requireRls: false });
    await lenient.close();
  });
});
