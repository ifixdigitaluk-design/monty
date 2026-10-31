'use client';

import { applyView, canInWorkspace, type ViewConfig } from '@monty/domain';
import type { DatabaseDto, DatabaseFieldDto, DatabaseRowDto, DatabaseSummaryDto, DatabaseViewDto, WorkspaceMemberDto } from '@monty/validation';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Member } from '@/components/database/Cell';
import { ImportDialog } from '@/components/database/ImportDialog';
import { RowDrawer } from '@/components/database/RowDrawer';
import { FieldDialog, FieldsPanel, FilterPanel, SortPanel } from '@/components/database/Toolbar';
import { BoardView, TableView } from '@/components/database/Views';
import { Button, cx, EmptyState, ErrorBanner, Field, Input, Modal, PageLoading, Select, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useLiveEvents } from '@/lib/live';
import { useSession } from '@/lib/session';

export default function DatabasesPage() {
  return (
    <AppShell>
      <Databases />
    </AppShell>
  );
}

function Databases() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { organisations } = useSession();
  const workspaces = useMemo(
    () => organisations.flatMap((o) => o.workspaces.map((w) => ({ id: w.id, role: w.role, label: o.kind === 'PERSONAL' ? 'Personal' : `${o.name} · ${w.name}`, team: o.kind === 'TEAM' }))),
    [organisations],
  );
  const ws = params.get('ws') ?? workspaces.find((w) => w.team)?.id ?? workspaces[0]?.id ?? null;
  const workspace = workspaces.find((w) => w.id === ws);
  const dbId = params.get('id');
  const [list, setList] = useState<DatabaseSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);

  const loadList = useCallback(async () => {
    if (!ws) return;
    try {
      setList((await api.databases.list(ws)).databases);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [ws]);
  useEffect(() => {
    setList(null);
    void loadList();
  }, [loadList]);

  const open = (id: string | null, wsId = ws) => router.push(`/databases?${new URLSearchParams({ ...(wsId ? { ws: wsId } : {}), ...(id ? { id } : {}) }).toString()}`);

  if (!workspace) return <div className="p-8"><ErrorBanner message="Workspace not found." /></div>;
  const canCreate = canInWorkspace(workspace.role, 'task.create');

  return (
    <div className="flex min-h-[calc(100vh-3rem)] flex-col md:min-h-screen md:flex-row">
      <nav aria-label="Databases" className="border-b border-line p-3 md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <Select aria-label="Workspace" className="mb-3 w-full" value={ws ?? ''} onChange={(e) => open(null, e.target.value)}>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </Select>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[12px] font-medium uppercase tracking-wide text-muted">Databases</span>
          {canCreate ? (
            <Button variant="ghost" aria-label="New database" onClick={() => setDialog('new')}>
              +
            </Button>
          ) : null}
        </div>
        {error ? <ErrorBanner message={error} onRetry={loadList} /> : null}
        {list?.length === 0 ? <p className="px-2 text-[13px] text-muted">None yet.</p> : null}
        <ul>
          {list?.map((d) => (
            <li key={d.id}>
              <Link
                href={`/databases?ws=${ws}&id=${d.id}`}
                aria-current={d.id === dbId ? 'page' : undefined}
                className={cx('flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-surface-2', d.id === dbId && 'bg-surface-2 font-medium')}
              >
                <span className="truncate">{d.name}</span>
                <span className="text-[12px] text-muted">{d.rowCount}</span>
              </Link>
            </li>
          ))}
        </ul>
        {canCreate ? (
          <Button variant="ghost" className="mt-2 w-full justify-start" onClick={() => setDialog('import')}>
            Import CSV…
          </Button>
        ) : null}
      </nav>
      <div className="min-w-0 flex-1">
        {dbId ? (
          <DatabaseScreen key={dbId} id={dbId} workspaceId={ws!} onListChanged={loadList} onDeleted={() => { void loadList(); open(null); }} />
        ) : list === null ? (
          <PageLoading />
        ) : (
          <div className="p-8">
            <h1 className="sr-only">Databases</h1>
            <EmptyState
              title="Databases"
              body="Tables you shape yourself — a CRM, a content calendar, an asset list, a wiki of how-tos. Add typed fields, then filter, sort and group them into saved views."
              action={
                canCreate ? (
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => setDialog('new')}>New database</Button>
                    <Button onClick={() => setDialog('import')}>Import CSV…</Button>
                  </div>
                ) : undefined
              }
            />
          </div>
        )}
      </div>
      {dialog === 'new' && ws ? (
        <NewDatabase
          onClose={() => setDialog(null)}
          onCreate={async (name) => {
            try {
              const { database } = await api.databases.create(ws, { id: crypto.randomUUID(), name });
              setDialog(null);
              await loadList();
              open(database.id);
            } catch (err) {
              toast({ tone: 'error', message: errorMessage(err) });
            }
          }}
        />
      ) : null}
      {dialog === 'import' && ws ? (
        <ImportDialog
          workspaceId={ws}
          onClose={() => setDialog(null)}
          onImported={(db) => {
            setDialog(null);
            void loadList();
            open(db.id);
          }}
        />
      ) : null}
    </div>
  );
}

function NewDatabase({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    await onCreate(name.trim());
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title="New database">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name" htmlFor="db-name">
          <Input id="db-name" autoFocus value={name} maxLength={200} placeholder="e.g. Clients, Content calendar, Equipment" onChange={(e) => setName(e.target.value)} />
        </Field>
        <p className="text-[13px] text-muted">It starts with a Status field, a table and a board. Add your own fields next.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
            Create database
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DatabaseScreen({ id, workspaceId, onListChanged, onDeleted }: { id: string; workspaceId: string; onListChanged: () => void; onDeleted: () => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { user } = useSession();
  const [db, setDb] = useState<DatabaseDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, ViewConfig>>({});
  const [fieldDialog, setFieldDialog] = useState<DatabaseFieldDto | 'new' | null>(null);
  const [viewDialog, setViewDialog] = useState<DatabaseViewDto | null>(null);
  const viewId = params.get('view');
  const rowId = params.get('row');
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    try {
      setDb((await api.databases.get(id)).database);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);
  useEffect(() => {
    void load();
    api.members
      .workspace(workspaceId)
      .then((r) => setMembers((r.members as WorkspaceMemberDto[]).filter((m) => m.effectiveRole).map((m) => ({ id: m.id, name: m.name }))))
      .catch(() => setMembers([]));
  }, [load, workspaceId]);

  // Live: teammates' changes refresh this database (debounced). Our own changes are already on screen.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      void load();
      onListChanged();
    }, 300);
  }, [load, onListChanged]);
  useLiveEvents(workspaceId, null, {
    onChange: () => undefined,
    onReset: scheduleReload,
    onDatabase: (e) => {
      if (e.databaseId !== id) return onListChanged();
      if (e.kind === 'database.deleted') return onDeleted();
      if (e.actorId !== user.id) scheduleReload();
    },
  });

  const setParam = (key: 'view' | 'row', value: string | null) => {
    const q = new URLSearchParams(params.toString());
    if (value) q.set(key, value);
    else q.delete(key);
    router.replace(`/databases?${q.toString()}`);
  };

  const fail = (err: unknown) => {
    toast({ tone: 'error', message: errorMessage(err) });
    void load();
  };

  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!db) return <PageLoading />;

  const canEdit = canInWorkspace(db.role, 'task.update');
  const canStructure = canInWorkspace(db.role, 'task.create');
  const view = db.views.find((v) => v.id === viewId) ?? db.views[0]!;
  const config: ViewConfig = drafts[view.id] ?? view.config;
  const hidden = new Set(config.hiddenFieldIds ?? []);
  const visible = db.fields.filter((f) => !hidden.has(f.id));
  const shown = applyView(db.rows, db.fields, { ...config, search });
  const groupField = view.layout === 'board' ? db.fields.find((f) => f.id === config.groupBy && f.type === 'select') ?? null : null;

  function setConfig(next: ViewConfig) {
    setDrafts((d) => ({ ...d, [view.id]: next }));
    if (!canStructure) return; // viewers can explore, but views are saved by people who can edit the database
    clearTimeout(saveTimers.current[view.id]);
    const vid = view.id;
    saveTimers.current[vid] = setTimeout(() => {
      api.databases
        .updateView(vid, { config: next as never })
        .then(({ view: saved }) => setDb((cur) => (cur ? { ...cur, views: cur.views.map((v) => (v.id === vid ? saved : v)) } : cur)))
        .catch((err) => toast({ tone: 'error', message: errorMessage(err) }));
    }, 600);
  }

  const patchRow = (rowIdToPatch: string, patch: Partial<DatabaseRowDto>) =>
    setDb((cur) => (cur ? { ...cur, rows: cur.rows.map((r) => (r.id === rowIdToPatch ? { ...r, ...patch } : r)) } : cur));

  function onCell(row: DatabaseRowDto, fieldId: string, value: unknown) {
    const values = { ...row.values };
    if (value === null) delete values[fieldId];
    else values[fieldId] = value;
    patchRow(row.id, { values });
    api.databases.updateRow(row.id, { values: { [fieldId]: value } }).then(({ row: saved }) => patchRow(row.id, { values: saved.values, version: saved.version, updatedAt: saved.updatedAt }), fail);
  }
  function onTitle(row: DatabaseRowDto, title: string) {
    patchRow(row.id, { title });
    api.databases.updateRow(row.id, { title }).catch(fail);
  }
  async function addRow(values: Record<string, unknown> = {}) {
    // New rows inherit the view's simple "is" filters so they don't vanish from the view they were added in.
    const inherited: Record<string, unknown> = {};
    for (const f of config.filters ?? []) {
      const field = db!.fields.find((x) => x.id === f.fieldId);
      if (field && f.op === 'is' && f.value !== undefined && f.value !== '' && field.type === 'select') inherited[field.id] = f.value;
      if (field && f.op === 'checked') inherited[field.id] = true;
    }
    try {
      const { row } = await api.databases.createRow(db!.id, { id: crypto.randomUUID(), values: { ...inherited, ...values } });
      setDb((cur) => (cur ? { ...cur, rows: [...cur.rows, { ...row, body: undefined }] } : cur));
      onListChanged();
      // Focus the new row's name so typing starts right away.
      setTimeout(() => (document.querySelector(`tr[data-row=""]:last-of-type input`) as HTMLInputElement | null)?.focus(), 50);
      return row;
    } catch (err) {
      fail(err);
      return null;
    }
  }

  async function saveField(input: { name: string; type: string; choices: { id: string; label: string; color: string }[] }) {
    const isChoice = input.type === 'select' || input.type === 'multi_select';
    try {
      if (fieldDialog === 'new') {
        await api.databases.createField(db!.id, { name: input.name, type: input.type as DatabaseFieldDto['type'], ...(isChoice ? { options: { choices: input.choices as never } } : {}) });
      } else if (fieldDialog) {
        await api.databases.updateField(fieldDialog.id, { name: input.name, ...(isChoice ? { options: { choices: input.choices as never } } : {}) });
      }
      await load();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      throw err;
    }
  }

  async function addView(layout: 'table' | 'board') {
    try {
      const firstSelect = db!.fields.find((f) => f.type === 'select');
      if (layout === 'board' && !firstSelect) return toast({ tone: 'error', message: 'A board groups rows by a Select field. Add one first (Fields → New field).' });
      const { view: v } = await api.databases.createView(db!.id, { name: layout === 'board' ? 'Board' : 'Table', layout, config: layout === 'board' ? { groupBy: firstSelect!.id } : {} });
      setDb((cur) => (cur ? { ...cur, views: [...cur.views, v] } : cur));
      setParam('view', v.id);
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="p-4 md:p-6">
      <header className="relative mb-3 pr-36">
        <h1 className="sr-only">{db.name}</h1>
        <div className="absolute right-0 top-0">
          {canStructure ? (
              <Button
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  if (!window.confirm(`Delete the database “${db.name}” and all ${db.rows.length} rows? This can't be undone from the app.`)) return;
                  api.databases.remove(db.id).then(onDeleted, fail);
                }}
              >
                Delete database
              </Button>
            ) : null}
        </div>
        <input
          aria-label="Database name"
          className="w-full bg-transparent text-2xl font-semibold outline-none"
          defaultValue={db.name}
          key={`n-${db.name}`}
          disabled={!canStructure}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== db.name) api.databases.update(db.id, { name }).then(({ database }) => { setDb(database); onListChanged(); }, fail);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <input
          aria-label="Description"
          className="w-full bg-transparent text-muted outline-none"
          placeholder={canStructure ? 'Add a description…' : ''}
          defaultValue={db.description}
          key={`d-${db.description}`}
          disabled={!canStructure}
          onBlur={(e) => e.target.value !== db.description && api.databases.update(db.id, { description: e.target.value }).then(({ database }) => setDb(database), fail)}
        />
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-2">
        <div role="tablist" aria-label="Views" className="flex flex-wrap items-center gap-1">
          {db.views.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={v.id === view.id}
              onClick={() => setParam('view', v.id)}
              onDoubleClick={() => canStructure && setViewDialog(v)}
              className={cx('rounded-md px-2.5 py-1 text-[13px]', v.id === view.id ? 'bg-surface-2 font-medium' : 'text-muted hover:bg-surface-2')}
            >
              {v.layout === 'board' ? '▦ ' : '☰ '}
              {v.name}
            </button>
          ))}
        </div>
        {canStructure ? (
          <>
            <Button variant="ghost" onClick={() => void addView('table')}>+ Table</Button>
            <Button variant="ghost" onClick={() => void addView('board')}>+ Board</Button>
          </>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Input aria-label="Search rows" placeholder="Search…" className="h-8 w-40" value={search} onChange={(e) => setSearch(e.target.value)} />
          <FilterPanel fields={db.fields} members={members} config={config} onChange={setConfig} />
          <SortPanel fields={db.fields} config={config} onChange={setConfig} />
          <FieldsPanel fields={db.fields} config={config} onChange={setConfig} canStructure={canStructure} onAddField={() => setFieldDialog('new')} onEditField={(f) => setFieldDialog(f)} />
          {canStructure ? <Button variant="ghost" onClick={() => setViewDialog(view)}>View settings</Button> : null}
          <a className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-fg" href={api.databases.exportUrl(db.id)} download>
            Export CSV
          </a>
        </div>
      </div>

      {db.rows.length === 0 && !canEdit ? (
        <EmptyState title="No rows yet" body="People who can edit this workspace can add rows." />
      ) : view.layout === 'board' ? (
        <BoardView
          fields={db.fields}
          rows={shown}
          members={members}
          canEdit={canEdit}
          onCell={onCell}
          onTitle={onTitle}
          onOpen={(rid) => setParam('row', rid)}
          groupField={groupField}
          cardFields={visible.filter((f) => f.id !== groupField?.id).slice(0, 4)}
          onAddRow={(key) => void addRow(groupField && key ? { [groupField.id]: key } : {}).then((r) => r && setParam('row', r.id))}
        />
      ) : (
        <TableView
          fields={visible}
          rows={shown}
          total={db.rows.length}
          members={members}
          canEdit={canEdit}
          canStructure={canStructure}
          onCell={onCell}
          onTitle={onTitle}
          onOpen={(rid) => setParam('row', rid)}
          onAddRow={() => void addRow()}
          onDeleteRow={(row) => {
            if (!window.confirm(`Delete “${row.title || 'Untitled'}”?`)) return;
            setDb((cur) => (cur ? { ...cur, rows: cur.rows.filter((r) => r.id !== row.id) } : cur));
            api.databases.removeRow(row.id).then(onListChanged, fail);
          }}
          onEditField={(f) => setFieldDialog(f)}
          onAddField={() => setFieldDialog('new')}
        />
      )}

      {rowId ? (
        <RowDrawer
          key={rowId}
          rowId={rowId}
          fields={db.fields}
          members={members}
          canEdit={canEdit}
          onCell={onCell}
          onTitle={onTitle}
          onClose={() => {
            setParam('row', null);
            void load();
          }}
          onDelete={(row) => {
            api.databases.removeRow(row.id).then(() => {
              setParam('row', null);
              setDb((cur) => (cur ? { ...cur, rows: cur.rows.filter((r) => r.id !== row.id) } : cur));
              onListChanged();
            }, fail);
          }}
        />
      ) : null}

      {fieldDialog ? (
        <FieldDialog
          field={fieldDialog === 'new' ? null : fieldDialog}
          onClose={() => setFieldDialog(null)}
          onSubmit={saveField}
          onDelete={
            fieldDialog !== 'new'
              ? async () => {
                  await api.databases.removeField(fieldDialog.id).catch(fail);
                  await load();
                }
              : undefined
          }
        />
      ) : null}

      {viewDialog ? (
        <ViewSettings
          view={viewDialog}
          fields={db.fields}
          canDelete={db.views.length > 1}
          onClose={() => setViewDialog(null)}
          onSave={async (patch) => {
            try {
              const { view: saved } = await api.databases.updateView(viewDialog.id, patch as never);
              setDb((cur) => (cur ? { ...cur, views: cur.views.map((v) => (v.id === saved.id ? saved : v)) } : cur));
              setDrafts((d) => {
                const { [saved.id]: _drop, ...rest } = d;
                void _drop;
                return rest;
              });
              setViewDialog(null);
            } catch (err) {
              toast({ tone: 'error', message: errorMessage(err) });
            }
          }}
          onDelete={async () => {
            try {
              await api.databases.removeView(viewDialog.id);
              setViewDialog(null);
              setParam('view', null);
              await load();
            } catch (err) {
              toast({ tone: 'error', message: errorMessage(err) });
            }
          }}
          onDeleteDatabase={
            canStructure
              ? async () => {
                  if (!window.confirm(`Delete the database “${db.name}” and all ${db.rows.length} rows?`)) return;
                  await api.databases.remove(db.id).then(onDeleted, fail);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

function ViewSettings({
  view,
  fields,
  canDelete,
  onClose,
  onSave,
  onDelete,
  onDeleteDatabase,
}: {
  view: DatabaseViewDto;
  fields: DatabaseFieldDto[];
  canDelete: boolean;
  onClose: () => void;
  onSave: (patch: { name: string; layout: 'table' | 'board'; config: ViewConfig }) => Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteDatabase?: () => Promise<void>;
}) {
  const [name, setName] = useState(view.name);
  const [layout, setLayout] = useState(view.layout);
  const selects = fields.filter((f) => f.type === 'select');
  const [groupBy, setGroupBy] = useState(view.config.groupBy ?? selects[0]?.id ?? '');
  return (
    <Modal open onClose={onClose} title="View settings">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ name: name.trim() || view.name, layout, config: { ...view.config, groupBy: layout === 'board' ? groupBy || null : view.config.groupBy ?? null } });
        }}
      >
        <Field label="View name" htmlFor="view-name">
          <Input id="view-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Layout" htmlFor="view-layout">
          <Select id="view-layout" className="w-full" value={layout} onChange={(e) => setLayout(e.target.value as 'table' | 'board')}>
            <option value="table">Table</option>
            <option value="board">Board</option>
          </Select>
        </Field>
        {layout === 'board' ? (
          <Field label="Group by" htmlFor="view-group">
            <Select id="view-group" className="w-full" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {selects.length === 0 ? <option value="">No Select fields yet</option> : null}
              {selects.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          {onDeleteDatabase ? (
            <Button variant="danger" className="mr-auto" onClick={() => void onDeleteDatabase()}>
              Delete database…
            </Button>
          ) : null}
          {canDelete ? (
            <Button variant="danger" onClick={() => void onDelete()}>
              Delete view
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={layout === 'board' && !groupBy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
