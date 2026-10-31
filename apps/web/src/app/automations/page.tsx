'use client';

import type {
  AutomationAction,
  AutomationConditions,
  AutomationRuleDto,
  AutomationRunDto,
  AutomationTrigger,
  Priority,
  ProjectListItemDto,
  TaskDto,
  WorkspaceMemberDto,
  WorkspaceSummaryDto,
} from '@monty/validation';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, Button, EmptyState, ErrorBanner, Field, Input, Modal, PageLoading, Select, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { PRIORITY_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';

export default function AutomationsPage() {
  return (
    <AppShell>
      <Automations />
    </AppShell>
  );
}

const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  'task.created': 'A task is created',
  'task.updated': 'A task is changed',
  'task.status_changed': 'A task changes status',
  'task.overdue': 'A task becomes overdue',
};
const STATUSES = Object.keys(TASK_STATUS_LABEL) as TaskDto['status'][];
const PRIORITIES = Object.keys(PRIORITY_LABEL) as Priority[];
const RUN_TONE: Record<AutomationRunDto['status'], 'success' | 'danger' | 'warning' | 'neutral'> = {
  SUCCEEDED: 'success',
  FAILED: 'danger',
  SKIPPED: 'warning',
  RUNNING: 'neutral',
};

interface Ctx {
  projects: ProjectListItemDto[];
  members: WorkspaceMemberDto[];
}

function describeAction(a: AutomationAction, ctx: Ctx): string {
  const who = (id: string) => (id === 'assignee' ? 'the assignee' : id === 'creator' ? 'the creator' : (ctx.members.find((m) => m.id === id)?.name ?? 'a former member'));
  switch (a.type) {
    case 'notify':
      return `Notify ${a.to.map(who).join(', ')}: “${a.message}”`;
    case 'set_status':
      return `Set status to ${TASK_STATUS_LABEL[a.status]}`;
    case 'set_priority':
      return `Set priority to ${PRIORITY_LABEL[a.priority]}`;
    case 'assign':
      return a.assigneeId ? `Assign to ${who(a.assigneeId)}` : 'Unassign';
    case 'webhook':
      return `Send webhook to ${new URL(a.url).host}`;
  }
}

function describeConditions(c: AutomationConditions, ctx: Ctx): string {
  const parts: string[] = [];
  if (c.projectId) parts.push(`in ${ctx.projects.find((p) => p.id === c.projectId)?.name ?? 'a deleted project'}`);
  if (c.toStatus) parts.push(`moved to ${TASK_STATUS_LABEL[c.toStatus]}`);
  if (c.status) parts.push(`status is ${TASK_STATUS_LABEL[c.status]}`);
  if (c.priority) parts.push(`priority is ${PRIORITY_LABEL[c.priority]}`);
  if (c.assigneeId !== undefined) parts.push(c.assigneeId ? `assigned to ${ctx.members.find((m) => m.id === c.assigneeId)?.name ?? 'someone'}` : 'unassigned');
  return parts.length ? parts.join(', ') : 'any task';
}

function Automations() {
  const ws = useSearchParams().get('ws');
  const toast = useToast();
  const [workspace, setWorkspace] = useState<WorkspaceSummaryDto | null>(null);
  const [rules, setRules] = useState<AutomationRuleDto[] | null>(null);
  const [ctx, setCtx] = useState<Ctx>({ projects: [], members: [] });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AutomationRuleDto | 'new' | null>(null);
  const [runsFor, setRunsFor] = useState<AutomationRuleDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ws) return;
    setError(null);
    try {
      const [{ automations }, { projects, workspace }, members] = await Promise.all([
        api.automations.list(ws),
        api.projects.list(ws),
        api.members.workspace(ws).then((r) => r.members).catch(() => [] as WorkspaceMemberDto[]),
      ]);
      setRules(automations);
      setWorkspace(workspace);
      setCtx({ projects, members: members.filter((m) => m.effectiveRole) });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [ws]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(rule: AutomationRuleDto) {
    setBusyId(rule.id);
    try {
      const { automation } = await api.automations.update(rule.id, { expectedVersion: rule.version, enabled: !rule.enabled });
      setRules((rs) => rs?.map((r) => (r.id === rule.id ? automation : r)) ?? null);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      void load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(rule: AutomationRuleDto) {
    if (!window.confirm(`Delete the automation “${rule.name}”? It will stop running immediately.`)) return;
    setBusyId(rule.id);
    try {
      await api.automations.remove(rule.id);
      setRules((rs) => rs?.filter((r) => r.id !== rule.id) ?? null);
      toast({ tone: 'success', message: 'Automation deleted' });
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusyId(null);
    }
  }

  if (!ws) return <div className="p-8"><ErrorBanner message="No workspace selected." /></div>;
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!rules || !workspace) return <PageLoading />;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <p className="text-[13px] text-muted">
            <Link href={`/workspace?id=${ws}`} className="hover:underline">{workspace.name}</Link>
          </p>
          <h1 className="text-xl font-semibold">Automations</h1>
          <p className="text-muted">When something happens to a task, do something automatically. Rules run with the permissions of the admin who last saved them.</p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>New automation</Button>
      </header>

      {rules.length === 0 ? (
        <EmptyState
          title="No automations yet"
          body="For example: when a task moves to In review, notify its creator."
          action={<Button variant="primary" onClick={() => setEditing('new')}>Create an automation</Button>}
        />
      ) : (
        <ul className="space-y-3" aria-label="Automations">
          {rules.map((r) => (
            <li key={r.id} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium">
                    {r.name} {r.enabled ? null : <Badge>Off</Badge>}
                  </p>
                  <p className="text-[13px] text-muted">
                    When {TRIGGER_LABEL[r.trigger].toLowerCase()} — {describeConditions(r.conditions, ctx)}
                  </p>
                  <ul className="mt-2 list-disc pl-5 text-[13px]">
                    {r.actions.map((a, i) => (
                      <li key={i}>{describeAction(a, ctx)}</li>
                    ))}
                  </ul>
                  {r.webhookSecret ? (
                    <details className="mt-2 text-[12px] text-muted">
                      <summary className="cursor-pointer">Webhook signing secret</summary>
                      <code className="break-all">{r.webhookSecret}</code>
                      <p>Each request carries <code>X-Monty-Signature: t=&lt;unix time&gt;,v1=&lt;HMAC-SHA256 of &quot;t.body&quot;&gt;</code>.</p>
                    </details>
                  ) : null}
                  <p className="mt-2 text-[12px] text-muted">
                    Last run:{' '}
                    {r.lastRun ? (
                      <>
                        <Badge tone={RUN_TONE[r.lastRun.status]}>{r.lastRun.status.toLowerCase()}</Badge> {new Date(r.lastRun.createdAt).toLocaleString()}
                      </>
                    ) : (
                      'never'
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <Button onClick={() => toggle(r)} busy={busyId === r.id} aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} ${r.name}`}>
                    {r.enabled ? 'Turn off' : 'Turn on'}
                  </Button>
                  <Button onClick={() => setRunsFor(r)}>History</Button>
                  <Button onClick={() => setEditing(r)}>Edit</Button>
                  <Button variant="danger" onClick={() => remove(r)} disabled={busyId === r.id}>Delete</Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <RuleEditor
          workspaceId={ws}
          rule={editing === 'new' ? null : editing}
          ctx={ctx}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setRules((rs) => {
              const list = rs ?? [];
              return list.some((r) => r.id === saved.id) ? list.map((r) => (r.id === saved.id ? saved : r)) : [...list, saved];
            });
            setEditing(null);
            toast({ tone: 'success', message: 'Automation saved' });
          }}
        />
      ) : null}
      {runsFor ? <RunHistory rule={runsFor} onClose={() => setRunsFor(null)} /> : null}
    </div>
  );
}

function RunHistory({ rule, onClose }: { rule: AutomationRuleDto; onClose: () => void }) {
  const [runs, setRuns] = useState<AutomationRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns((await api.automations.runs(rule.id)).runs);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [rule.id]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Modal open onClose={onClose} title={`History — ${rule.name}`}>
      {error ? <ErrorBanner message={error} onRetry={load} /> : !runs ? <PageLoading /> : runs.length === 0 ? (
        <p className="text-muted">This automation hasn’t run yet.</p>
      ) : (
        <ul className="max-h-96 divide-y divide-line overflow-auto text-[13px]">
          {runs.map((r) => (
            <li key={r.id} className="py-2">
              <Badge tone={RUN_TONE[r.status]}>{r.status.toLowerCase()}</Badge> {new Date(r.createdAt).toLocaleString()}
              {r.attempts > 1 ? <span className="text-muted"> · {r.attempts} attempts</span> : null}
              {r.error ? <p className="text-danger">{r.error}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

type DraftAction =
  | { type: 'notify'; to: string[]; message: string }
  | { type: 'set_status'; status: TaskDto['status'] }
  | { type: 'set_priority'; priority: Priority }
  | { type: 'assign'; assigneeId: string | null }
  | { type: 'webhook'; url: string };

const NEW_ACTION: Record<DraftAction['type'], DraftAction> = {
  notify: { type: 'notify', to: ['assignee'], message: '' },
  set_status: { type: 'set_status', status: 'IN_PROGRESS' },
  set_priority: { type: 'set_priority', priority: 'HIGH' },
  assign: { type: 'assign', assigneeId: null },
  webhook: { type: 'webhook', url: 'https://' },
};
const ACTION_LABEL: Record<DraftAction['type'], string> = {
  notify: 'Send a notification',
  set_status: 'Change status',
  set_priority: 'Change priority',
  assign: 'Assign',
  webhook: 'Call a webhook (HTTPS)',
};

function RuleEditor(props: { workspaceId: string; rule: AutomationRuleDto | null; ctx: Ctx; onClose: () => void; onSaved: (r: AutomationRuleDto) => void }) {
  const { rule, ctx } = props;
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<AutomationTrigger>(rule?.trigger ?? 'task.status_changed');
  const [conditions, setConditions] = useState<AutomationConditions>(rule?.conditions ?? {});
  const [actions, setActions] = useState<DraftAction[]>((rule?.actions as DraftAction[]) ?? [NEW_ACTION.notify]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId] = useState(() => crypto.randomUUID());

  const setCond = <K extends keyof AutomationConditions>(k: K, v: AutomationConditions[K] | '') =>
    setConditions((c) => {
      const next = { ...c };
      if (v === '') delete next[k];
      else next[k] = v as AutomationConditions[K];
      return next;
    });
  const setAction = (i: number, a: DraftAction) => setActions((as) => as.map((x, j) => (j === i ? a : x)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const cleanConditions = trigger === 'task.status_changed' ? conditions : (({ toStatus: _t, ...rest }) => rest)(conditions);
    try {
      const saved = rule
        ? await api.automations.update(rule.id, { expectedVersion: rule.version, name: name.trim(), trigger, conditions: cleanConditions, actions: actions as AutomationAction[] })
        : await api.automations.create(props.workspaceId, { id: clientId, name: name.trim(), enabled: true, trigger, conditions: cleanConditions, actions: actions as AutomationAction[] });
      props.onSaved(saved.automation);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const memberOptions = ctx.members.map((m) => (
    <option key={m.id} value={m.id}>{m.name}</option>
  ));

  return (
    <Modal open onClose={props.onClose} title={rule ? 'Edit automation' : 'New automation'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="auto-name">
          <Input id="auto-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="When" htmlFor="auto-trigger">
          <Select id="auto-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
            {(Object.keys(TRIGGER_LABEL) as AutomationTrigger[]).map((t) => (
              <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>
            ))}
          </Select>
        </Field>

        <fieldset className="space-y-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-[13px] font-medium">Only if (optional)</legend>
          {trigger === 'task.status_changed' ? (
            <Field label="Moved to status" htmlFor="auto-to-status">
              <Select id="auto-to-status" value={conditions.toStatus ?? ''} onChange={(e) => setCond('toStatus', e.target.value as TaskDto['status'] | '')}>
                <option value="">Any status</option>
                {STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label="Project" htmlFor="auto-project">
            <Select id="auto-project" value={conditions.projectId ?? ''} onChange={(e) => setCond('projectId', e.target.value)}>
              <option value="">Any project</option>
              {ctx.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Priority is" htmlFor="auto-priority">
            <Select id="auto-priority" value={conditions.priority ?? ''} onChange={(e) => setCond('priority', e.target.value as Priority | '')}>
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </Select>
          </Field>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-[13px] font-medium">Then</legend>
          {actions.map((a, i) => (
            <div key={i} className="space-y-2 rounded-md bg-surface-2 p-2">
              <div className="flex gap-2">
                <Select aria-label={`Action ${i + 1} type`} value={a.type} onChange={(e) => setAction(i, NEW_ACTION[e.target.value as DraftAction['type']])}>
                  {(Object.keys(ACTION_LABEL) as DraftAction['type'][]).map((t) => <option key={t} value={t}>{ACTION_LABEL[t]}</option>)}
                </Select>
                {actions.length > 1 ? (
                  <Button type="button" variant="ghost" onClick={() => setActions((as) => as.filter((_, j) => j !== i))} aria-label={`Remove action ${i + 1}`}>Remove</Button>
                ) : null}
              </div>
              {a.type === 'notify' ? (
                <>
                  <Select aria-label={`Action ${i + 1} recipient`} value={a.to[0] ?? 'assignee'} onChange={(e) => setAction(i, { ...a, to: [e.target.value] })}>
                    <option value="assignee">The assignee</option>
                    <option value="creator">The task creator</option>
                    {memberOptions}
                  </Select>
                  <Input aria-label={`Action ${i + 1} message`} placeholder="Message" value={a.message} onChange={(e) => setAction(i, { ...a, message: e.target.value })} required maxLength={500} />
                </>
              ) : a.type === 'set_status' ? (
                <Select aria-label={`Action ${i + 1} status`} value={a.status} onChange={(e) => setAction(i, { ...a, status: e.target.value as TaskDto['status'] })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
                </Select>
              ) : a.type === 'set_priority' ? (
                <Select aria-label={`Action ${i + 1} priority`} value={a.priority} onChange={(e) => setAction(i, { ...a, priority: e.target.value as Priority })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </Select>
              ) : a.type === 'assign' ? (
                <Select aria-label={`Action ${i + 1} assignee`} value={a.assigneeId ?? ''} onChange={(e) => setAction(i, { ...a, assigneeId: e.target.value || null })}>
                  <option value="">Nobody (unassign)</option>
                  {memberOptions}
                </Select>
              ) : (
                <Input aria-label={`Action ${i + 1} URL`} type="url" value={a.url} onChange={(e) => setAction(i, { ...a, url: e.target.value })} required pattern="https://.+" />
              )}
            </div>
          ))}
          {actions.length < 10 ? (
            <Button type="button" onClick={() => setActions((as) => [...as, NEW_ACTION.set_priority])}>Add action</Button>
          ) : null}
        </fieldset>

        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Save automation</Button>
        </div>
      </form>
    </Modal>
  );
}
