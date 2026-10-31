'use client';

import type { ReadinessReport } from '@monty/domain';
import { canInWorkspace } from '@monty/domain';
import type { ActivityDto, DependencyDto, MilestoneDto, ProjectDetailDto, ProjectLifecycle, TaskDto, UpdateProjectInput } from '@monty/validation';
import { CommentThread } from '@/components/CommentThread';
import { Milestones } from '@/components/project/Milestones';
import { AiPlanner } from '@/components/project/AiPlanner';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { ReadinessPanel } from '@/components/project/ReadinessPanel';
import { DateInput, TaskChanges } from '@/components/project/TaskControls';
import { TaskDrawer } from '@/components/project/TaskDrawer';
import { TaskBoard, TaskList } from '@/components/project/TaskViews';
import { Button, cx, EmptyState, ErrorBanner, Input, PageLoading, Select, Spinner, Textarea, useToast } from '@/components/ui';
import { api, ApiError, errorMessage, localToday } from '@/lib/api';
import { LIFECYCLE_LABEL } from '@/lib/labels';
import { useSerialWrites } from '@/lib/serial-writes';
import { useLiveEvents } from '@/lib/live';
import { useSession } from '@/lib/session';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function ProjectPage() {
  return (
    <AppShell>
      <ProjectView />
    </AppShell>
  );
}

function ProjectView() {
  const params = useSearchParams();
  const id = params.get('id');
  const router = useRouter();
  const toast = useToast();
  const [project, setProject] = useState<ProjectDetailDto | null>(null);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [activity, setActivity] = useState<ActivityDto[]>([]);
  const [milestones, setMilestones] = useState<MilestoneDto[]>([]);
  const [dependencies, setDependencies] = useState<DependencyDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'board'>('list');
  const [openTaskId, setOpenTaskId] = useState<string | null>(() => params.get('task'));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [aiOpen, setAiOpen] = useState(false);
  const pending = useRef(0);
  // Latest server version per record, read at send time (not render time) so queued edits never use a stale version.
  const versions = useRef(new Map<string, number>());
  const serial = useSerialWrites();
  const today = localToday();

  const rememberTask = useCallback((t: TaskDto) => {
    versions.current.set(t.id, t.version);
    setTasks((all) => all.map((x) => (x.id === t.id ? t : x)));
  }, []);

  const refreshDerived = useCallback(async () => {
    if (!id) return;
    const [r, a, m, d] = await Promise.all([
      api.projects.readiness(id, localToday()),
      api.projects.activity(id),
      api.milestones.list(id),
      api.dependencies.list(id),
    ]);
    setReadiness(r.readiness);
    setActivity(a.activity);
    setMilestones(m.milestones);
    setDependencies(d.dependencies);
  }, [id]);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [p, t] = await Promise.all([api.projects.get(id), api.tasks.list(id)]);
      versions.current.set(p.project.id, p.project.version);
      for (const x of t.tasks) versions.current.set(x.id, x.version);
      setProject(p.project);
      setTasks(t.tasks);
      await refreshDerived();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id, refreshDerived]);

  useEffect(() => {
    setProject(null);
    void load();
  }, [load]);

  // Live updates from teammates: refetch through the normal API (debounced), never trust stream payloads.
  const { user } = useSession();
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchLive = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(async () => {
      if (!id) return;
      try {
        const [p, t] = await Promise.all([api.projects.get(id), api.tasks.list(id)]);
        for (const x of t.tasks) versions.current.set(x.id, Math.max(versions.current.get(x.id) ?? 0, x.version));
        versions.current.set(p.project.id, Math.max(versions.current.get(p.project.id) ?? 0, p.project.version));
        setProject(p.project);
        setTasks(t.tasks);
        await refreshDerived();
      } catch {
        /* the next event or a manual reload will recover */
      }
    }, 300);
  }, [id, refreshDerived]);
  const live = useLiveEvents(project?.workspaceId ?? null, id, {
    onChange: (e) => {
      if (e.projectId !== id || e.actorId === user.id) return; // own changes are already applied
      const known = versions.current.get(e.entityId);
      if (e.version !== null && known !== undefined && e.version <= known && !e.topic.endsWith('.deleted')) return;
      refetchLive();
    },
    onReset: refetchLive,
  });

  /** Wraps every write: "Saved" is shown only after the server has committed. */
  const track = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      pending.current += 1;
      setSaveState('saving');
      try {
        const result = await fn();
        pending.current -= 1;
        if (pending.current === 0) setSaveState('saved');
        void refreshDerived().catch(() => undefined);
        return result;
      } catch (err) {
        pending.current -= 1;
        setSaveState('error');
        throw err;
      }
    },
    [refreshDerived],
  );

  const updateTask = useCallback(
    async (task: TaskDto, changes: TaskChanges): Promise<void> => {
      try {
        await track(() =>
          serial(task.id, async () => {
            const expectedVersion = versions.current.get(task.id) ?? task.version;
            const { task: saved } = await api.tasks.update(task.id, { expectedVersion, ...changes });
            rememberTask(saved);
          }),
        );
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
          const current = (err.details as { current: TaskDto | null } | undefined)?.current;
          if (current) rememberTask(current);
          toast({
            tone: 'error',
            message: 'Someone else changed this task. We loaded their version — your change was not saved.',
            action: current ? { label: 'Re-apply mine', run: () => void updateTask(current, changes) } : undefined,
          });
        } else {
          toast({ tone: 'error', message: errorMessage(err), action: { label: 'Retry', run: () => void updateTask(task, changes) } });
        }
      }
    },
    [track, serial, rememberTask, toast],
  );

  const updateProject = useCallback(
    async (changes: Omit<UpdateProjectInput, 'expectedVersion'>) => {
      if (!project) return;
      const projectId = project.id;
      try {
        await track(() =>
          serial(projectId, async () => {
            const expectedVersion = versions.current.get(projectId) ?? project.version;
            const { project: saved } = await api.projects.update(projectId, { expectedVersion, ...changes });
            versions.current.set(projectId, saved.version);
            setProject((p) => (p ? { ...p, ...saved } : p));
          }),
        );
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
          toast({
            tone: 'error',
            message: 'This project was changed by someone else. We loaded the latest version — your change was not saved.',
            action: { label: 'Re-apply mine', run: () => void load().then(() => updateProject(changes)) },
          });
          void load();
        } else {
          toast({ tone: 'error', message: errorMessage(err), action: { label: 'Retry', run: () => void updateProject(changes) } });
        }
      }
    },
    [project, track, serial, toast, load],
  );

  const createTask = useCallback(
    async (title: string, parentTaskId: string | null = null, clientId: string = crypto.randomUUID()) => {
      if (!id) return;
      try {
        await track(async () => {
          const { task } = await api.tasks.create(id, { id: clientId, title, parentTaskId });
          versions.current.set(task.id, task.version);
          setTasks((all) => (all.some((t) => t.id === task.id) ? all : [...all, task]));
        });
      } catch (err) {
        // Retrying with the same id is safe: the server returns the original task instead of duplicating it.
        toast({ tone: 'error', message: errorMessage(err), action: { label: 'Retry', run: () => void createTask(title, parentTaskId, clientId) } });
        throw err;
      }
    },
    [id, track, toast],
  );

  const deleteTask = useCallback(
    async (task: TaskDto) => {
      try {
        await track(() => serial(task.id, () => api.tasks.remove(task.id)));
        setTasks((all) => all.filter((t) => t.id !== task.id && t.parentTaskId !== task.id));
        setOpenTaskId(null);
      } catch (err) {
        toast({ tone: 'error', message: errorMessage(err) });
      }
    },
    [track, serial, toast],
  );

  if (!id) return <div className="p-8"><ErrorBanner message="No project selected." /></div>;
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!project) return <PageLoading />;

  const canEdit = canInWorkspace(project.role, 'task.update');
  const canEditProject = canInWorkspace(project.role, 'project.update');
  const canDelete = canInWorkspace(project.role, 'project.delete');
  const openTask = tasks.find((t) => t.id === openTaskId) ?? null;

  return (
    <div className="mx-auto max-w-7xl p-6">
      <nav aria-label="Breadcrumb" className="mb-2 text-[13px] text-muted">
        <Link className="hover:underline" href={`/workspace?id=${project.workspaceId}`}>
          {project.workspaceName}
        </Link>{' '}
        / Project
      </nav>

      <div className="mb-1 flex items-center justify-end gap-2 text-[12px] text-muted" aria-live="polite">
        {live.viewers.filter((v) => v.userId !== user.id).length > 0 ? (
          <span data-presence>
            Also here: {live.viewers.filter((v) => v.userId !== user.id).map((v) => v.name).join(', ')}
          </span>
        ) : null}
        <span data-live={live.status} className={live.status === 'live' ? 'text-success' : live.status === 'revoked' ? 'text-danger' : ''}>
          {live.status === 'live' ? '● Live' : live.status === 'revoked' ? 'Access changed — reload' : '○ Reconnecting…'}
        </span>
      </div>
      <ProjectHeader project={project} canEdit={canEditProject} saveState={saveState} onChange={updateProject} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="View" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
              {(['list', 'board'] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cx('rounded-md px-3 py-1 text-[13px] capitalize', view === v ? 'bg-surface-2 font-medium' : 'text-muted')}
                >
                  {v}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canEdit ? <Button onClick={() => setAiOpen(true)}>✦ Plan with AI</Button> : null}
              {canEdit ? <QuickAdd onAdd={(title) => createTask(title)} /> : null}
            </div>
          </div>

          {tasks.length === 0 ? (
            <EmptyState title="No tasks yet" body="Break the objective into tasks. Press C to add one." />
          ) : view === 'list' ? (
            <TaskList tasks={tasks} members={project.members} canEdit={canEdit} today={today} onChange={updateTask} onOpen={setOpenTaskId} />
          ) : (
            <TaskBoard tasks={tasks} members={project.members} canEdit={canEdit} today={today} onChange={updateTask} onOpen={setOpenTaskId} />
          )}

          <section className="rounded-xl border border-line bg-surface p-4">
            <CommentThread
              target={{ projectId: project.id }}
              members={project.members}
              canPost={canEdit}
              canModerate={canInWorkspace(project.role, 'workspace.manage')}
              label="Project discussion"
            />
          </section>
          <ActivityList activity={activity} />
        </div>

        <div className="space-y-4">
          {readiness ? <ReadinessPanel
              report={readiness}
              onOpenTask={setOpenTaskId}
              taskTitle={(taskId) => tasks.find((t) => t.id === taskId)?.title ?? 'Open task'}
            /> : <PageLoading />}
          <ProjectDocs workspaceId={project.workspaceId} projectId={project.id} canEdit={canEdit} />
          <Milestones projectId={project.id} milestones={milestones} canEdit={canEditProject} onChanged={() => void refreshDerived()} />
          {canDelete ? (
            <DeleteProject
              onDelete={async () => {
                await api.projects.remove(project.id);
                router.replace(`/workspace?id=${project.workspaceId}`);
              }}
            />
          ) : null}
        </div>
      </div>

      {aiOpen ? <AiPlanner projectId={project.id} open={aiOpen} onClose={() => setAiOpen(false)} onApplied={() => void load()} /> : null}
      {openTask ? (
        <TaskDrawer
          key={openTask.id}
          task={openTask}
          subtasks={tasks.filter((t) => t.parentTaskId === openTask.id)}
          members={project.members}
          canEdit={canEdit}
          onClose={() => setOpenTaskId(null)}
          onChange={updateTask}
          onDelete={deleteTask}
          onAddSubtask={(parent, title) => createTask(title, parent.id)}
          onOpen={setOpenTaskId}
          milestones={milestones}
          allTasks={tasks}
          dependencies={dependencies}
          canModerate={canInWorkspace(project.role, 'workspace.manage')}
          onAddDependency={async (t, dependsOnTaskId) => {
            try {
              await track(() => api.dependencies.add(t.id, dependsOnTaskId));
            } catch (err) {
              toast({ tone: 'error', message: errorMessage(err) });
            }
          }}
          onRemoveDependency={async (t, depId) => {
            try {
              await track(() => api.dependencies.remove(t.id, depId));
            } catch (err) {
              toast({ tone: 'error', message: errorMessage(err) });
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ProjectHeader({
  project,
  canEdit,
  saveState,
  onChange,
}: {
  project: ProjectDetailDto;
  canEdit: boolean;
  saveState: SaveState;
  onChange: (c: Omit<UpdateProjectInput, 'expectedVersion'>) => Promise<void>;
}) {
  const [name, setName] = useState(project.name);
  const [objective, setObjective] = useState(project.objective);
  useEffect(() => {
    setName(project.name);
    setObjective(project.objective);
  }, [project.version, project.name, project.objective]);

  return (
    <header className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <input
          aria-label="Project name"
          className="w-full bg-transparent text-2xl font-semibold outline-none focus:underline disabled:opacity-100"
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== project.name && void onChange({ name: name.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <SaveIndicator state={saveState} />
      </div>
      <Textarea
        aria-label="Project objective"
        rows={2}
        placeholder={canEdit ? 'Objective: what must this project achieve?' : 'No objective yet'}
        value={objective}
        disabled={!canEdit}
        onChange={(e) => setObjective(e.target.value)}
        onBlur={() => objective !== project.objective && void onChange({ objective })}
      />
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Stage</span>
          <Select
            aria-label="Project stage"
            value={project.lifecycle}
            disabled={!canEdit}
            onChange={(e) => void onChange({ lifecycle: e.target.value as ProjectLifecycle })}
          >
            {Object.entries(LIFECYCLE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Owner</span>
          <Select
            aria-label="Project owner"
            value={project.ownerId ?? ''}
            disabled={!canEdit}
            onChange={(e) => void onChange({ ownerId: e.target.value || null })}
          >
            <option value="">No owner</option>
            {project.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Start</span>
          <DateInput label="Project start date" value={project.startDate} disabled={!canEdit} onChange={(v) => void onChange({ startDate: v })} />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Target</span>
          <DateInput label="Project target date" value={project.targetDate} disabled={!canEdit} onChange={(v) => void onChange({ targetDate: v })} />
        </label>
      </div>
    </header>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const text = { idle: '', saving: 'Saving…', saved: 'All changes saved', error: 'Not saved' }[state];
  return (
    <span aria-live="polite" data-save-state={state} className={cx('flex shrink-0 items-center gap-1.5 pt-2 text-[12px]', state === 'error' ? 'text-danger' : 'text-muted')}>
      {state === 'saving' ? <Spinner /> : null}
      {text}
    </span>
  );
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onAdd(title.trim());
      setTitle('');
    } catch {
      // Toast already shown; keep the text so nothing typed is lost.
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full gap-2 sm:w-auto">
      <Input
        ref={ref}
        aria-label="New task title"
        placeholder="Add a task…  (C)"
        className="h-8 sm:w-72"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Button type="submit" variant="primary" busy={busy} disabled={!title.trim()}>
        Add task
      </Button>
    </form>
  );
}

const FIELD_LABEL: Record<string, string> = {
  ownerId: 'owner',
  assigneeId: 'assignee',
  targetDate: 'target date',
  startDate: 'start date',
  dueDate: 'due date',
  blockedReason: 'blocker',
  estimateMinutes: 'estimate',
  lifecycle: 'stage',
};

function ActivityList({ activity }: { activity: ActivityDto[] }) {
  if (activity.length === 0) return null;
  const describe = (a: ActivityDto) => {
    const name = String(a.data.title ?? a.data.name ?? '');
    if (a.action === 'created') return `created ${a.entityType} “${name}”`;
    if (a.action === 'deleted') return `deleted ${a.entityType} “${name}”`;
    const changes = Object.keys((a.data.changes as Record<string, unknown>) ?? {}).map((k) => FIELD_LABEL[k] ?? k);
    return `updated ${a.entityType}${name ? ` “${name}”` : ''}${changes.length ? ` (${changes.join(', ')})` : ''}`;
  };
  return (
    <section aria-labelledby="activity-title" className="rounded-xl border border-line bg-surface p-4">
      <h2 id="activity-title" className="mb-2 font-semibold">Activity</h2>
      <ul className="space-y-1 text-[13px]">
        {activity.slice(0, 15).map((a) => (
          <li key={a.id} className="flex justify-between gap-3">
            <span><span className="font-medium">{a.actor.name}</span> {describe(a)}</span>
            <time className="shrink-0 text-muted" dateTime={a.createdAt}>
              {new Date(a.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeleteProject({ onDelete }: { onDelete: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!confirm) {
    return (
      <Button variant="danger" className="w-full" onClick={() => setConfirm(true)}>
        Delete project
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
      <p className="text-[13px]">Delete this project and all its tasks?</p>
      <div className="flex gap-2">
        <Button onClick={() => setConfirm(false)}>Keep</Button>
        <Button
          variant="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onDelete();
            } catch (err) {
              toast({ tone: 'error', message: errorMessage(err) });
              setBusy(false);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function ProjectDocs({ workspaceId, projectId, canEdit }: { workspaceId: string; projectId: string; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [docs, setDocs] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    api.documents
      .list(workspaceId, projectId)
      .then((r) => setDocs(r.documents))
      .catch(() => setDocs([]));
  }, [workspaceId, projectId]);
  return (
    <section aria-labelledby="project-docs-title" className="rounded-xl border border-line bg-surface p-4">
      <h2 id="project-docs-title" className="mb-2 font-semibold">Documents</h2>
      {docs && docs.length === 0 ? <p className="text-[13px] text-muted">No project documents yet.</p> : null}
      <ul className="space-y-1 text-[13px]">
        {docs?.map((d) => (
          <li key={d.id}>
            <Link className="hover:underline" href={`/docs?ws=${workspaceId}&id=${d.id}`}>
              {d.title}
            </Link>
          </li>
        ))}
      </ul>
      {canEdit ? (
        <Button
          className="mt-2"
          onClick={async () => {
            try {
              const { document } = await api.documents.create(workspaceId, { id: crypto.randomUUID(), title: 'Untitled', projectId });
              router.push(`/docs?ws=${workspaceId}&id=${document.id}`);
            } catch (err) {
              toast({ tone: 'error', message: errorMessage(err) });
            }
          }}
        >
          New project doc
        </Button>
      ) : null}
    </section>
  );
}
