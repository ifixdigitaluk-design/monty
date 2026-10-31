'use client';

import type { DependencyDto, MemberDto, MilestoneDto, TaskDto } from '@monty/validation';
import { CommentThread } from '../CommentThread';
import { Select } from '../ui';
import { FormEvent, useEffect, useState } from 'react';
import { Button, Field, Input, Textarea } from '../ui';
import { AssigneeSelect, DateInput, PrioritySelect, StatusSelect, TaskChanges } from './TaskControls';
import { TASK_STATUS_LABEL } from '@/lib/labels';

interface Props {
  task: TaskDto;
  subtasks: TaskDto[];
  members: MemberDto[];
  canEdit: boolean;
  onClose: () => void;
  onChange: (task: TaskDto, changes: TaskChanges) => Promise<void>;
  onDelete: (task: TaskDto) => Promise<void>;
  onAddSubtask: (parent: TaskDto, title: string) => Promise<void>;
  onOpen: (taskId: string) => void;
  milestones: MilestoneDto[];
  allTasks: TaskDto[];
  dependencies: DependencyDto[];
  onAddDependency: (task: TaskDto, dependsOnTaskId: string) => Promise<void>;
  onRemoveDependency: (task: TaskDto, dependencyId: string) => Promise<void>;
  canModerate: boolean;
}

/** Side panel with every task field. Text fields save on blur; selects save on change. */
export function TaskDrawer({
  task,
  subtasks,
  members,
  canEdit,
  onClose,
  onChange,
  onDelete,
  onAddSubtask,
  onOpen,
  milestones,
  allTasks,
  dependencies,
  onAddDependency,
  onRemoveDependency,
  canModerate,
}: Props) {
  const waitingOn = dependencies.filter((d) => d.taskId === task.id);
  const blocking = dependencies.filter((d) => d.dependsOnTaskId === task.id);
  const titleOf = (id: string) => allTasks.find((t) => t.id === id);
  const candidates = allTasks.filter((t) => t.id !== task.id && !waitingOn.some((d) => d.dependsOnTaskId === t.id));
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [blocked, setBlocked] = useState(task.blockedReason ?? '');
  const [estimate, setEstimate] = useState(task.estimateMinutes?.toString() ?? '');
  const [subtaskTitle, setSubtaskTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Keep local drafts in sync when the server version changes (save, conflict reload).
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
    setBlocked(task.blockedReason ?? '');
    setEstimate(task.estimateMinutes?.toString() ?? '');
  }, [task.id, task.version, task.title, task.description, task.blockedReason, task.estimateMinutes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = (changes: TaskChanges) => void onChange(task, changes);

  async function addSubtask(e: FormEvent) {
    e.preventDefault();
    if (!subtaskTitle.trim()) return;
    try {
      await onAddSubtask(task, subtaskTitle.trim());
      setSubtaskTitle('');
    } catch {
      // Error toast already shown by the page; keep the typed title.
    }
  }

  return (
    <aside
      role="dialog"
      aria-label={`Task: ${task.title}`}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-line bg-surface shadow-xl"
    >
      <div className="flex h-12 items-center justify-between border-b border-line px-4">
        <span className="text-[13px] text-muted">Task · v{task.version}</span>
        <Button variant="ghost" aria-label="Close task" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <Field label="Title" htmlFor="task-title">
          <Input
            id="task-title"
            value={title}
            disabled={!canEdit}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== task.title && save({ title: title.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status" htmlFor="task-status">
            <StatusSelect task={task} disabled={!canEdit} onChange={save} />
          </Field>
          <Field label="Priority" htmlFor="task-priority">
            <PrioritySelect task={task} disabled={!canEdit} onChange={save} />
          </Field>
          <Field label="Assignee" htmlFor="task-assignee">
            <AssigneeSelect task={task} members={members} disabled={!canEdit} onChange={save} />
          </Field>
          <Field label="Estimate (minutes)" htmlFor="task-estimate">
            <Input
              id="task-estimate"
              type="number"
              min={0}
              className="h-8"
              value={estimate}
              disabled={!canEdit}
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => {
                const v = estimate === '' ? null : Math.max(0, Math.round(Number(estimate)));
                if (v !== task.estimateMinutes && !Number.isNaN(v)) save({ estimateMinutes: v });
              }}
            />
          </Field>
          <Field label="Start" htmlFor="task-start">
            <DateInput label="Start date" value={task.startDate} disabled={!canEdit} onChange={(v) => save({ startDate: v })} />
          </Field>
          <Field label="Due" htmlFor="task-due">
            <DateInput label="Due date" value={task.dueDate} disabled={!canEdit} onChange={(v) => save({ dueDate: v })} />
          </Field>
        </div>
        <Field label="Milestone" htmlFor="task-milestone">
          <Select
            id="task-milestone"
            aria-label={`Milestone of ${task.title}`}
            className="h-9 w-full"
            value={task.milestoneId ?? ''}
            disabled={!canEdit}
            onChange={(e) => save({ milestoneId: e.target.value || null })}
          >
            <option value="">No milestone</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <p className="mb-1 text-[12px] font-medium text-muted">Waiting on</p>
          {waitingOn.length === 0 ? <p className="text-[13px] text-muted">Nothing — can start any time.</p> : null}
          <ul className="space-y-1">
            {waitingOn.map((d) => {
              const dep = titleOf(d.dependsOnTaskId);
              return (
                <li key={d.id} className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2 py-1 text-[13px]">
                  <button className="truncate text-left hover:underline" onClick={() => onOpen(d.dependsOnTaskId)}>
                    {dep?.title ?? 'Task'} {dep?.status === 'DONE' ? '✓' : ''}
                  </button>
                  {canEdit ? (
                    <button className="text-muted hover:text-danger" aria-label={`Remove dependency on ${dep?.title ?? 'task'}`} onClick={() => void onRemoveDependency(task, d.id)}>
                      ✕
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canEdit && candidates.length > 0 ? (
            <Select
              aria-label="Add dependency"
              className="mt-1 w-full"
              value=""
              onChange={(e) => e.target.value && void onAddDependency(task, e.target.value)}
            >
              <option value="">+ Waits for another task…</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          ) : null}
          {blocking.length > 0 ? (
            <p className="mt-1 text-[12px] text-muted">Blocks: {blocking.map((d) => titleOf(d.taskId)?.title ?? 'task').join(', ')}</p>
          ) : null}
        </div>
        <Field label="Blocked by" htmlFor="task-blocked" hint="Describe what is blocking this task. Clear it when resolved.">
          <Input
            id="task-blocked"
            value={blocked}
            disabled={!canEdit}
            placeholder="Nothing — not blocked"
            onChange={(e) => setBlocked(e.target.value)}
            onBlur={() => (blocked.trim() || null) !== task.blockedReason && save({ blockedReason: blocked.trim() || null })}
          />
        </Field>
        <Field label="Description" htmlFor="task-description">
          <Textarea
            id="task-description"
            rows={6}
            value={description}
            disabled={!canEdit}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== task.description && save({ description })}
          />
        </Field>

        <CommentThread target={{ taskId: task.id }} members={members} canPost={canEdit} canModerate={canModerate} label="Comments" />
        {task.parentTaskId === null ? (
          <div>
            <p className="mb-2 text-[12px] font-medium text-muted">Subtasks</p>
            <ul className="space-y-1">
              {subtasks.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2 py-1">
                  <button className="truncate text-left hover:underline" onClick={() => onOpen(s.id)}>
                    {s.title}
                  </button>
                  <span className="text-[12px] text-muted">{TASK_STATUS_LABEL[s.status]}</span>
                </li>
              ))}
            </ul>
            {canEdit ? (
              <form onSubmit={addSubtask} className="mt-2 flex gap-2">
                <Input
                  aria-label="New subtask title"
                  placeholder="Add a subtask…"
                  className="h-8"
                  value={subtaskTitle}
                  onChange={(e) => setSubtaskTitle(e.target.value)}
                />
                <Button type="submit" disabled={!subtaskTitle.trim()}>
                  Add
                </Button>
              </form>
            ) : null}
          </div>
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex justify-end gap-2 border-t border-line p-3">
          {confirmDelete ? (
            <>
              <span className="mr-auto self-center text-[13px] text-muted">Delete this task{subtasks.length ? ' and its subtasks' : ''}?</span>
              <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
              <Button variant="danger" onClick={() => void onDelete(task)}>
                Delete
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete task
            </Button>
          )}
        </div>
      ) : null}
    </aside>
  );
}
