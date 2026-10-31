'use client';

import type { ProjectListItemDto, WorkspaceSummaryDto } from '@monty/validation';
import { canInWorkspace } from '@monty/domain';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, Button, EmptyState, ErrorBanner, Field, Input, Modal, PageLoading, Textarea } from '@/components/ui';
import { api, errorMessage, formatDate } from '@/lib/api';
import { LIFECYCLE_LABEL } from '@/lib/labels';

export default function WorkspacePage() {
  return (
    <AppShell>
      <WorkspaceView />
    </AppShell>
  );
}

function WorkspaceView() {
  const id = useSearchParams().get('id');
  const router = useRouter();
  const [data, setData] = useState<{ projects: ProjectListItemDto[]; workspace: WorkspaceSummaryDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      setData(await api.projects.list(id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  if (!id) return <div className="p-8"><ErrorBanner message="No workspace selected." /></div>;
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!data) return <PageLoading />;

  const canCreate = canInWorkspace(data.workspace.role, 'project.create');

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{data.workspace.name}</h1>
          <p className="text-muted">Projects in this workspace</p>
        </div>
        {canCreate ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New project
          </Button>
        ) : null}
      </header>

      {data.projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Start with an idea. You can add the objective, owner and tasks next."
          action={canCreate ? <Button variant="primary" onClick={() => setCreating(true)}>Create a project</Button> : undefined}
        />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {data.projects.map((p) => {
            const pct = p.taskTotal ? Math.round((p.taskDone / p.taskTotal) * 100) : 0;
            return (
              <li key={p.id}>
                <Link href={`/project?id=${p.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.name}</p>
                    <p className="truncate text-[13px] text-muted">{p.objective || 'No objective yet'}</p>
                  </div>
                  <Badge>{LIFECYCLE_LABEL[p.lifecycle]}</Badge>
                  <span className="hidden w-28 text-right text-[13px] text-muted sm:block">
                    {p.targetDate ? formatDate(p.targetDate) : '—'}
                  </span>
                  <div className="hidden w-32 items-center gap-2 sm:flex" aria-label={`${p.taskDone} of ${p.taskTotal} tasks done`}>
                    <div className="h-1.5 flex-1 rounded-full bg-surface-2">
                      <div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-10 text-right text-[12px] text-muted">
                      {p.taskDone}/{p.taskTotal}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <CreateProjectModal
        open={creating}
        onClose={() => setCreating(false)}
        workspaceId={id}
        onCreated={(projectId) => router.push(`/project?id=${projectId}`)}
      />
    </div>
  );
}

function CreateProjectModal(props: { open: boolean; onClose: () => void; workspaceId: string; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Client-generated id makes a retried submit idempotent (no duplicate project on double-click or network retry).
  const [clientId, setClientId] = useState(() => crypto.randomUUID());

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.projects.create(props.workspaceId, { id: clientId, name: name.trim(), objective });
      setName('');
      setObjective('');
      setClientId(crypto.randomUUID());
      props.onCreated(project.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.open} onClose={props.onClose} title="New project">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Project name" htmlFor="project-name">
          <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Objective" htmlFor="project-objective" hint="What must this project achieve? Required before it is ready to start.">
          <Textarea id="project-objective" rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Create project</Button>
        </div>
      </form>
    </Modal>
  );
}
