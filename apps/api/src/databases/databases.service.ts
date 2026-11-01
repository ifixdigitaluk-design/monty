import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { aliasedTable, and, asc, count, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import {
  DatabaseTable,
  DatabaseField,
  DatabaseRow,
  DatabaseView,
  databaseFields,
  databaseRows,
  databases,
  databaseViews,
  isUniqueViolation,
  users,
} from '@monty/database';
import { CHOICE_COLORS, cellFromText, FieldLike, normaliseCell, TITLE_FIELD } from '@monty/domain';
import type {
  CreateDatabaseInput,
  CreateFieldInput,
  CreateRowInput,
  CreateViewInput,
  DatabaseDto,
  DatabaseFieldDto,
  DatabaseRowDto,
  DatabaseSummaryDto,
  DatabaseViewDto,
  ImportRowsInput,
  UpdateDatabaseInput,
  UpdateFieldInput,
  UpdateRowInput,
  UpdateViewInput,
} from '@monty/validation';
import { badRequest, conflict, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';

/** Keeps every database comfortably fast to load and evaluate in the browser. */
export const MAX_ROWS = 10_000;
export const MAX_FIELDS = 50;
const MAX_VIEWS = 30;

type Role = 'ADMIN' | 'MEMBER' | 'VIEWER';
type DbEventKind = 'database.updated' | 'database.deleted' | 'row.created' | 'row.updated' | 'row.deleted' | 'rows.imported';

const DEFAULT_STATUS_CHOICES = [
  { id: 'todo', label: 'Not started', color: 'gray' },
  { id: 'doing', label: 'In progress', color: 'blue' },
  { id: 'done', label: 'Done', color: 'green' },
];

/**
 * Notion-style databases. Reads need workspace access; editing rows needs `task.update`; changing structure
 * (fields, views, the database itself) needs `task.create`. VIEWERs can only read.
 */
@Injectable()
export class DatabasesService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
  ) {}

  // ---------- loading & permissions ----------

  private async load(userId: string, id: string, action: 'workspace.read' | 'task.update' | 'task.create') {
    const d = await this.dbs.db.query.databases.findFirst({ where: and(eq(databases.id, id), isNull(databases.deletedAt)) });
    if (!d) throw notFound('Database');
    const a = await this.access.workspaceAccess(userId, d.workspaceId);
    if (!a) throw notFound('Database');
    if (action !== 'workspace.read') await this.access.requireWorkspace(userId, d.workspaceId, action);
    return { d, role: a.role as Role, organisationId: a.workspace.organisationId };
  }

  private async fieldsOf(databaseId: string) {
    return this.dbs.db.select().from(databaseFields).where(eq(databaseFields.databaseId, databaseId)).orderBy(asc(databaseFields.position), asc(databaseFields.createdAt));
  }

  private async loadField(userId: string, fieldId: string) {
    const f = await this.dbs.db.query.databaseFields.findFirst({ where: eq(databaseFields.id, fieldId) });
    if (!f) throw notFound('Field');
    const { d } = await this.load(userId, f.databaseId, 'task.create').catch((e) => {
      throw is404(e) ? notFound('Field') : e;
    });
    return { f, d };
  }

  private async loadRow(userId: string, rowId: string, action: 'workspace.read' | 'task.update') {
    const r = await this.dbs.db.query.databaseRows.findFirst({ where: and(eq(databaseRows.id, rowId), isNull(databaseRows.deletedAt)) });
    if (!r) throw notFound('Row');
    const { d, role } = await this.load(userId, r.databaseId, action).catch((e) => {
      throw is404(e) ? notFound('Row') : e;
    });
    return { r, d, role };
  }

  private async loadView(userId: string, viewId: string) {
    const v = await this.dbs.db.query.databaseViews.findFirst({ where: eq(databaseViews.id, viewId) });
    if (!v) throw notFound('View');
    const { d } = await this.load(userId, v.databaseId, 'task.create').catch((e) => {
      throw is404(e) ? notFound('View') : e;
    });
    return { v, d };
  }

  /** Live pointer event to everyone watching the workspace; clients refetch through this permission-checked API. */
  private async emit(d: DatabaseTable, kind: DbEventKind, actorId: string, rowId: string | null = null) {
    const payload = { workspaceId: d.workspaceId, databaseId: d.id, kind, rowId, actorId, at: new Date().toISOString() };
    await this.dbs.db.execute(sql`select pg_notify('monty_db', ${JSON.stringify(payload)})`);
  }

  private async touch(d: DatabaseTable) {
    await this.dbs.db.update(databases).set({ updatedAt: new Date() }).where(eq(databases.id, d.id));
  }

  // ---------- databases ----------

  async list(userId: string, workspaceId: string): Promise<DatabaseSummaryDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const rows = await this.dbs.db
      .select({ id: databases.id, name: databases.name, description: databases.description, updatedAt: databases.updatedAt, rowCount: count(databaseRows.id) })
      .from(databases)
      .leftJoin(databaseRows, and(eq(databaseRows.databaseId, databases.id), isNull(databaseRows.deletedAt)))
      .where(and(eq(databases.workspaceId, workspaceId), isNull(databases.deletedAt)))
      .groupBy(databases.id)
      .orderBy(asc(databases.name))
      .limit(500);
    return rows.map((r) => ({ ...r, rowCount: Number(r.rowCount), updatedAt: r.updatedAt.toISOString() }));
  }

  async create(userId: string, workspaceId: string, input: CreateDatabaseInput): Promise<{ database: DatabaseDto; created: boolean }> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'task.create');
    if (input.id) {
      const existing = await this.dbs.db.query.databases.findFirst({ where: eq(databases.id, input.id) });
      if (existing) {
        if (existing.createdById !== userId || existing.workspaceId !== workspaceId) throw conflict('CONFLICT', 'This id is already in use');
        return { database: await this.get(userId, existing.id), created: false };
      }
    }
    const base = { organisationId: workspace.organisationId, workspaceId };
    let d: DatabaseTable;
    try {
      [d] = (await this.dbs.db.insert(databases).values({ id: input.id, ...base, name: input.name, description: input.description ?? '', createdById: userId }).returning()) as [DatabaseTable];
    } catch (err) {
      if (input.id && isUniqueViolation(err)) return this.create(userId, workspaceId, input);
      throw err;
    }

    if (input.import) {
      const fieldRows = input.import.fields.map((f, i) => ({
        ...base,
        databaseId: d.id,
        name: f.name,
        type: f.type,
        options: f.type === 'select' || f.type === 'multi_select' ? { choices: this.choicesFrom(f.choices ?? []) } : {},
        position: (i + 1) * 1024,
      }));
      if (fieldRows.length) await this.dbs.db.insert(databaseFields).values(fieldRows);
      await this.view(d, 'All', 'table', {});
      if (input.import.rows.length) await this.importInto(userId, d, input.import.rows);
    } else {
      // A useful starting point, like a new Notion database: a Status select, a board grouped by it, and a table.
      const [status] = await this.dbs.db
        .insert(databaseFields)
        .values({ ...base, databaseId: d.id, name: 'Status', type: 'select', options: { choices: DEFAULT_STATUS_CHOICES }, position: 1024 })
        .returning();
      await this.view(d, 'Table', 'table', {});
      await this.view(d, 'Board', 'board', { groupBy: status!.id }, 2048);
    }
    return { database: await this.get(userId, d.id), created: true };
  }

  private choicesFrom(labels: string[]) {
    const unique = [...new Map(labels.map((l) => [l.toLowerCase(), l])).values()].slice(0, 100);
    return unique.map((label, i) => ({ id: randomUUID().slice(0, 8), label, color: CHOICE_COLORS[(i + 1) % CHOICE_COLORS.length]! }));
  }

  private async view(d: DatabaseTable, name: string, layout: 'table' | 'board', config: Record<string, unknown>, position = 1024) {
    await this.dbs.db.insert(databaseViews).values({ organisationId: d.organisationId, workspaceId: d.workspaceId, databaseId: d.id, name, layout, config, position });
  }

  async get(userId: string, id: string): Promise<DatabaseDto> {
    const { d, role } = await this.load(userId, id, 'workspace.read');
    // Sequential on purpose: inside a request transaction these share one database connection.
    const fields = await this.fieldsOf(id);
    const views = await this.dbs.db.select().from(databaseViews).where(eq(databaseViews.databaseId, id)).orderBy(asc(databaseViews.position), asc(databaseViews.createdAt));
    const rows = await this.rowsWithNames(and(eq(databaseRows.databaseId, id), isNull(databaseRows.deletedAt))!);
    return {
      id: d.id,
      workspaceId: d.workspaceId,
      name: d.name,
      description: d.description,
      role,
      fields: fields.map(fieldDto),
      views: views.map(viewDto),
      rows: rows.map((r) => rowDto(r, false)),
    };
  }

  async update(userId: string, id: string, input: UpdateDatabaseInput): Promise<DatabaseDto> {
    const { d } = await this.load(userId, id, 'task.create');
    await this.dbs.db.update(databases).set(input).where(eq(databases.id, id));
    await this.emit(d, 'database.updated', userId);
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const { d } = await this.load(userId, id, 'task.create');
    await this.dbs.db.update(databases).set({ deletedAt: new Date() }).where(eq(databases.id, id));
    await this.emit(d, 'database.deleted', userId);
  }

  /** CSV of the whole database (all fields, readable values), for backups or moving data out. */
  async exportRows(userId: string, id: string): Promise<{ name: string; header: string[]; rows: string[][] }> {
    const { d } = await this.load(userId, id, 'workspace.read');
    const fields = await this.fieldsOf(id);
    const rows = await this.dbs.db.select().from(databaseRows).where(and(eq(databaseRows.databaseId, id), isNull(databaseRows.deletedAt))).orderBy(asc(databaseRows.position));
    const personIds = [...new Set(rows.flatMap((r) => fields.filter((f) => f.type === 'person').flatMap((f) => (r.values[f.id] as string[] | undefined) ?? [])))];
    const names = personIds.length ? new Map((await this.dbs.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, personIds))).map((u) => [u.id, u.name])) : new Map<string, string>();
    const text = (f: DatabaseField, v: unknown): string => {
      if (f.type === 'checkbox') return v === true ? 'Yes' : 'No';
      if (v === null || v === undefined) return '';
      const label = (cid: unknown) => f.options.choices?.find((c) => c.id === cid)?.label ?? '';
      if (f.type === 'select') return label(v);
      if (f.type === 'multi_select') return (v as string[]).map(label).filter(Boolean).join(', ');
      if (f.type === 'person') return (v as string[]).map((u) => names.get(u) ?? '').filter(Boolean).join(', ');
      return String(v);
    };
    return { name: d.name, header: ['Name', ...fields.map((f) => f.name)], rows: rows.map((r) => [r.title, ...fields.map((f) => text(f, r.values[f.id]))]) };
  }

  // ---------- fields ----------

  async createField(userId: string, databaseId: string, input: CreateFieldInput): Promise<DatabaseFieldDto> {
    const { d } = await this.load(userId, databaseId, 'task.create');
    const existing = await this.fieldsOf(databaseId);
    if (input.id) {
      const same = existing.find((f) => f.id === input.id);
      if (same) return fieldDto(same);
    }
    if (existing.length >= MAX_FIELDS) throw badRequest(`A database can have at most ${MAX_FIELDS} fields`);
    const isChoice = input.type === 'select' || input.type === 'multi_select';
    const options = isChoice ? { choices: dedupeChoices(input.options?.choices ?? []) } : {};
    const position = Math.max(0, ...existing.map((f) => f.position)) + 1024;
    const [f] = await this.dbs.db
      .insert(databaseFields)
      .values({ id: input.id, organisationId: d.organisationId, workspaceId: d.workspaceId, databaseId, name: input.name, type: input.type, options, position })
      .returning();
    await this.touch(d);
    await this.emit(d, 'database.updated', userId);
    return fieldDto(f!);
  }

  async updateField(userId: string, fieldId: string, input: UpdateFieldInput): Promise<DatabaseFieldDto> {
    const { f, d } = await this.loadField(userId, fieldId);
    const set: Partial<DatabaseField> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.position !== undefined) set.position = input.position;
    if (input.options !== undefined) {
      if (f.type !== 'select' && f.type !== 'multi_select') throw badRequest('Only select fields have options');
      const choices = dedupeChoices(input.options.choices ?? []);
      set.options = { choices };
      // Removing an option clears it from every row, so no cell points at an option that no longer exists.
      const kept = new Set(choices.map((c) => c.id));
      const removed = (f.options.choices ?? []).map((c) => c.id).filter((cid) => !kept.has(cid));
      if (removed.length) await this.clearChoices(f, removed);
    }
    const [u] = await this.dbs.db.update(databaseFields).set(set).where(eq(databaseFields.id, fieldId)).returning();
    await this.touch(d);
    await this.emit(d, 'database.updated', userId);
    return fieldDto(u!);
  }

  private async clearChoices(f: DatabaseField, removed: string[]) {
    const key = f.id;
    const list = sql`array[${sql.join(removed.map((r) => sql`${r}`), sql`, `)}]::text[]`;
    if (f.type === 'select') {
      await this.dbs.db.execute(sql`
        update database_rows set values = values - ${key}, version = version + 1
        where database_id = ${f.databaseId} and values ->> ${key} = any(${list})`);
      return;
    }
    await this.dbs.db.execute(sql`
      with kept as (
        select r.id, coalesce((select jsonb_agg(e) from jsonb_array_elements(r.values -> ${key}) e where not (e #>> '{}' = any(${list}))), '[]'::jsonb) as arr
        from database_rows r
        where r.database_id = ${f.databaseId} and jsonb_typeof(r.values -> ${key}) = 'array'
          and exists (select 1 from jsonb_array_elements_text(r.values -> ${key}) x where x = any(${list}))
      )
      update database_rows d
      set values = case when jsonb_array_length(kept.arr) = 0 then d.values - ${key} else jsonb_set(d.values, array[${key}], kept.arr) end,
          version = d.version + 1
      from kept where kept.id = d.id`);
  }

  async removeField(userId: string, fieldId: string): Promise<void> {
    const { f, d } = await this.loadField(userId, fieldId);
    await this.dbs.db.delete(databaseFields).where(eq(databaseFields.id, fieldId));
    // Drop the cells and any view settings that referred to the field.
    await this.dbs.db.execute(sql`update database_rows set values = values - ${f.id} where database_id = ${d.id} and values ? ${f.id}`);
    const views = await this.dbs.db.select().from(databaseViews).where(eq(databaseViews.databaseId, d.id));
    for (const v of views) {
      const c = v.config as { filters?: { fieldId: string }[]; sorts?: { fieldId: string }[]; groupBy?: string | null; hiddenFieldIds?: string[] };
      const next = {
        ...c,
        filters: c.filters?.filter((x) => x.fieldId !== f.id),
        sorts: c.sorts?.filter((x) => x.fieldId !== f.id),
        groupBy: c.groupBy === f.id ? null : c.groupBy,
        hiddenFieldIds: c.hiddenFieldIds?.filter((x) => x !== f.id),
      };
      if (JSON.stringify(next) !== JSON.stringify(c)) await this.dbs.db.update(databaseViews).set({ config: next }).where(eq(databaseViews.id, v.id));
    }
    await this.touch(d);
    await this.emit(d, 'database.updated', userId);
  }

  // ---------- views ----------

  async createView(userId: string, databaseId: string, input: CreateViewInput): Promise<DatabaseViewDto> {
    const { d } = await this.load(userId, databaseId, 'task.create');
    const [{ n, top }] = (await this.dbs.db.select({ n: count(), top: max(databaseViews.position) }).from(databaseViews).where(eq(databaseViews.databaseId, databaseId))) as [{ n: number; top: number | null }];
    if (Number(n) >= MAX_VIEWS) throw badRequest(`A database can have at most ${MAX_VIEWS} views`);
    const config = await this.checkConfig(databaseId, input.config ?? {}, input.layout);
    const [v] = await this.dbs.db
      .insert(databaseViews)
      .values({ organisationId: d.organisationId, workspaceId: d.workspaceId, databaseId, name: input.name, layout: input.layout, config, position: (top ?? 0) + 1024 })
      .returning();
    await this.emit(d, 'database.updated', userId);
    return viewDto(v!);
  }

  async updateView(userId: string, viewId: string, input: UpdateViewInput): Promise<DatabaseViewDto> {
    const { v, d } = await this.loadView(userId, viewId);
    const layout = input.layout ?? (v.layout as 'table' | 'board');
    const set: Partial<DatabaseView> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.position !== undefined) set.position = input.position;
    if (input.layout !== undefined) set.layout = input.layout;
    if (input.config !== undefined || input.layout !== undefined) set.config = await this.checkConfig(d.id, input.config ?? (v.config as Record<string, unknown>), layout);
    const [u] = await this.dbs.db.update(databaseViews).set(set).where(eq(databaseViews.id, viewId)).returning();
    await this.emit(d, 'database.updated', userId);
    return viewDto(u!);
  }

  async removeView(userId: string, viewId: string): Promise<void> {
    const { d } = await this.loadView(userId, viewId);
    const [{ n }] = (await this.dbs.db.select({ n: count() }).from(databaseViews).where(eq(databaseViews.databaseId, d.id))) as [{ n: number }];
    if (Number(n) <= 1) throw badRequest('A database needs at least one view');
    await this.dbs.db.delete(databaseViews).where(eq(databaseViews.id, viewId));
    await this.emit(d, 'database.updated', userId);
  }

  /** Field references in a view must belong to this database; a board must group by a select field. */
  private async checkConfig(databaseId: string, config: Record<string, unknown>, layout: 'table' | 'board') {
    const fields = await this.fieldsOf(databaseId);
    const ids = new Set(fields.map((f) => f.id));
    const c = config as { filters?: { fieldId: string }[]; sorts?: { fieldId: string }[]; groupBy?: string | null; hiddenFieldIds?: string[] };
    const bad = [...(c.filters ?? []), ...(c.sorts ?? [])].find((x) => x.fieldId !== TITLE_FIELD && !ids.has(x.fieldId)) ?? (c.hiddenFieldIds ?? []).find((x) => !ids.has(x));
    if (bad) throw badRequest('The view refers to a field that is not in this database');
    if (layout === 'board') {
      const group = c.groupBy ? fields.find((f) => f.id === c.groupBy) : fields.find((f) => f.type === 'select');
      if (!group || group.type !== 'select') throw badRequest('A board needs a select field to group by. Add one first.', [{ path: 'groupBy', message: 'Choose a select field' }]);
      return { ...c, groupBy: group.id };
    }
    return c;
  }

  // ---------- rows ----------

  private async rowsWithNames(where: ReturnType<typeof and>) {
    const creator = aliasedTable(users, 'creator');
    const editor = aliasedTable(users, 'editor');
    return this.dbs.db
      .select({ r: databaseRows, createdBy: creator.name, updatedBy: editor.name })
      .from(databaseRows)
      .innerJoin(creator, eq(creator.id, databaseRows.createdById))
      .innerJoin(editor, eq(editor.id, databaseRows.updatedById))
      .where(where)
      .orderBy(asc(databaseRows.position), asc(databaseRows.createdAt))
      .limit(MAX_ROWS);
  }

  private async rowDtoById(id: string, withBody: boolean): Promise<DatabaseRowDto> {
    const [r] = await this.rowsWithNames(eq(databaseRows.id, id));
    return rowDto(r!, withBody);
  }

  /** Validates a set of cell changes against the database's fields. Unknown field ids are rejected. */
  private async checkValues(d: DatabaseTable, values: Record<string, unknown>) {
    const fields = await this.fieldsOf(d.id);
    const byId = new Map(fields.map((f) => [f.id, f]));
    const hasPerson = Object.keys(values).some((k) => byId.get(k)?.type === 'person');
    const members = hasPerson ? new Set((await this.access.workspaceMembers(d.workspaceId, d.organisationId)).map((m) => m.id)) : new Set<string>();
    const out: Record<string, unknown> = {};
    const errors: { path: string; message: string }[] = [];
    for (const [key, raw] of Object.entries(values)) {
      const f = byId.get(key);
      if (!f) {
        errors.push({ path: `values.${key}`, message: 'No such field in this database' });
        continue;
      }
      const res = normaliseCell(f as FieldLike, raw, (u) => members.has(u));
      if (res.ok) out[key] = res.value;
      else errors.push({ path: `values.${key}`, message: `${f.name}: ${res.message}` });
    }
    if (errors.length) throw badRequest(errors[0]!.message, errors);
    return out;
  }

  private async rowCount(databaseId: string) {
    const [{ n }] = (await this.dbs.db.select({ n: count() }).from(databaseRows).where(and(eq(databaseRows.databaseId, databaseId), isNull(databaseRows.deletedAt)))) as [{ n: number }];
    return Number(n);
  }

  async createRow(userId: string, databaseId: string, input: CreateRowInput): Promise<{ row: DatabaseRowDto; created: boolean }> {
    const { d } = await this.load(userId, databaseId, 'task.update');
    if (input.id) {
      const existing = await this.dbs.db.query.databaseRows.findFirst({ where: eq(databaseRows.id, input.id) });
      if (existing) {
        if (existing.createdById !== userId || existing.databaseId !== databaseId) throw conflict('CONFLICT', 'This id is already in use');
        return { row: await this.rowDtoById(existing.id, true), created: false };
      }
    }
    if ((await this.rowCount(databaseId)) >= MAX_ROWS) throw badRequest(`A database can have at most ${MAX_ROWS.toLocaleString('en')} rows`);
    const values = stripNulls(await this.checkValues(d, input.values ?? {}));
    let position = input.position;
    if (position === undefined) {
      const [{ top }] = (await this.dbs.db.select({ top: max(databaseRows.position) }).from(databaseRows).where(eq(databaseRows.databaseId, databaseId))) as [{ top: number | null }];
      position = (top ?? 0) + 1024;
    }
    const id = input.id ?? randomUUID();
    try {
      await this.dbs.db.insert(databaseRows).values({
        id,
        organisationId: d.organisationId,
        workspaceId: d.workspaceId,
        databaseId,
        title: input.title ?? '',
        values,
        body: input.body ?? '',
        position,
        createdById: userId,
        updatedById: userId,
      });
    } catch (err) {
      if (input.id && isUniqueViolation(err)) return this.createRow(userId, databaseId, input);
      throw err;
    }
    await this.touch(d);
    await this.emit(d, 'row.created', userId, id);
    return { row: await this.rowDtoById(id, true), created: true };
  }

  async getRow(userId: string, rowId: string): Promise<DatabaseRowDto> {
    await this.loadRow(userId, rowId, 'workspace.read');
    return this.rowDtoById(rowId, true);
  }

  async updateRow(userId: string, rowId: string, input: UpdateRowInput): Promise<DatabaseRowDto> {
    const { r, d } = await this.loadRow(userId, rowId, 'task.update');
    if (input.body !== undefined && input.expectedVersion === undefined) throw badRequest('expectedVersion is required when changing the page', [{ path: 'expectedVersion', message: 'Required' }]);
    const values = input.values ? await this.checkValues(d, input.values) : null;
    const set: Record<string, unknown> = { updatedById: userId, version: sql`${databaseRows.version} + 1`, updatedAt: new Date() };
    if (input.title !== undefined) set.title = input.title;
    if (input.body !== undefined) {
      set.body = input.body;
      set.bodyVersion = sql`${databaseRows.bodyVersion} + 1`;
    }
    if (input.position !== undefined) set.position = input.position;
    // Merge only the cells sent; null removes a cell. Other people's concurrent edits to other cells are kept.
    if (values) set.values = sql`jsonb_strip_nulls(${databaseRows.values} || ${JSON.stringify(values)}::jsonb)`;
    const [u] = await this.dbs.db
      .update(databaseRows)
      .set(set)
      .where(and(eq(databaseRows.id, rowId), isNull(databaseRows.deletedAt), input.body !== undefined ? eq(databaseRows.bodyVersion, input.expectedVersion!) : undefined))
      .returning({ id: databaseRows.id });
    if (!u) {
      throw conflict('VERSION_CONFLICT', 'This page was changed by someone else. Reload to see the latest version.', { current: await this.rowDtoById(r.id, true) });
    }
    await this.touch(d);
    await this.emit(d, 'row.updated', userId, rowId);
    return this.rowDtoById(rowId, true);
  }

  async removeRow(userId: string, rowId: string): Promise<void> {
    const { d } = await this.loadRow(userId, rowId, 'task.update');
    await this.dbs.db.update(databaseRows).set({ deletedAt: new Date() }).where(eq(databaseRows.id, rowId));
    await this.touch(d);
    await this.emit(d, 'row.deleted', userId, rowId);
  }

  async importRows(userId: string, databaseId: string, input: ImportRowsInput): Promise<{ imported: number }> {
    const { d } = await this.load(userId, databaseId, 'task.update');
    const imported = await this.importInto(userId, d, input.rows);
    await this.emit(d, 'rows.imported', userId);
    return { imported };
  }

  /** Imported text is converted per field type; text that doesn't fit a field (e.g. an unknown option) is left empty. */
  private async importInto(userId: string, d: DatabaseTable, rows: { title: string; cells: string[] }[]) {
    if ((await this.rowCount(d.id)) + rows.length > MAX_ROWS) throw badRequest(`A database can have at most ${MAX_ROWS.toLocaleString('en')} rows`);
    const fields = await this.fieldsOf(d.id);
    const [{ top }] = (await this.dbs.db.select({ top: max(databaseRows.position) }).from(databaseRows).where(eq(databaseRows.databaseId, d.id))) as [{ top: number | null }];
    const values = rows.map((row, i) => {
      const v: Record<string, unknown> = {};
      fields.forEach((f, idx) => {
        const res = normaliseCell(f as FieldLike, cellFromText(f as FieldLike, row.cells[idx] ?? ''));
        if (res.ok && res.value !== null) v[f.id] = res.value;
      });
      return {
        organisationId: d.organisationId,
        workspaceId: d.workspaceId,
        databaseId: d.id,
        title: row.title.slice(0, 500),
        values: v,
        position: (top ?? 0) + (i + 1) * 1024,
        createdById: userId,
        updatedById: userId,
      };
    });
    for (let i = 0; i < values.length; i += 500) await this.dbs.db.insert(databaseRows).values(values.slice(i, i + 500));
    await this.touch(d);
    return values.length;
  }
}

const is404 = (e: unknown) => e instanceof HttpException && e.getStatus() === 404;

function dedupeChoices(choices: { id: string; label: string; color: string }[]) {
  const seen = new Set<string>();
  return choices.filter((c) => !seen.has(c.id) && (seen.add(c.id), true));
}

const stripNulls = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null));

const fieldDto = (f: DatabaseField): DatabaseFieldDto => ({ id: f.id, name: f.name, type: f.type as DatabaseFieldDto['type'], options: f.options, position: f.position });
const viewDto = (v: DatabaseView): DatabaseViewDto => ({ id: v.id, name: v.name, layout: v.layout as 'table' | 'board', config: v.config, position: v.position });
function rowDto({ r, createdBy, updatedBy }: { r: DatabaseRow; createdBy: string; updatedBy: string }, withBody: boolean): DatabaseRowDto {
  return {
    id: r.id,
    title: r.title,
    values: r.values,
    hasBody: r.body.trim().length > 0,
    ...(withBody ? { body: r.body } : {}),
    position: r.position,
    version: r.version,
    bodyVersion: r.bodyVersion,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    createdBy: { id: r.createdById, name: createdBy },
    updatedBy: { id: r.updatedById, name: updatedBy },
  };
}
