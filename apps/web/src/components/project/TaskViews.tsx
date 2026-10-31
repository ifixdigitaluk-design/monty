'use client';

import type { MemberDto, TaskDto } from '@monty/validation';
import { DragEvent, useState } from 'react';
import { Badge, cx } from '../ui';
import { AssigneeSelect, DateInput, PrioritySelect, StatusSelect, TaskChanges } from './TaskControls';
import { BOARD_COLUMNS, PRIORITY_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import { formatDate } from '@/lib/api';

interface ViewProps {
  tasks: TaskDto[];
  members: MemberDto[];
  canEdit: boolean;
  today: string;
  onChange: (task: TaskDto, changes: TaskChanges) => Promise<void>;
  onOpen: (taskId: string) => void;
}

/** Orders tasks so each subtask follows its parent. Both views use the same records. */
export function withSubtasks(tasks: TaskDto[]): { task: TaskDto; depth: number }[] {
  const children = new Map<string, TaskDto[]>();
  for (const t of tasks) if (t.parentTaskId) children.set(t.parentTaskId, [...(children.get(t.parentTaskId) ?? []), t]);
  const ids = new Set(tasks.map((t) => t.id));
  const out: { task: TaskDto; depth: number }[] = [];
  for (const t of tasks) {
    if (t.parentTaskId && ids.has(t.parentTaskId)) continue;
    out.push({ task: t, depth: 0 });
    for (const c of children.get(t.id) ?? []) out.push({ task: c, depth: 1 });
  }
  return out;
}

export function TaskList({ tasks, members, canEdit, today, onChange, onOpen }: ViewProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[720px] text-left">
        <thead className="border-b border-line text-[12px] text-muted">
          <tr>
            <th className="w-10 px-3 py-2 font-medium"><span className="sr-only">Done</span></th>
            <th className="px-2 py-2 font-medium">Task</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Assignee</th>
            <th className="px-2 py-2 font-medium">Due</th>
            <th className="px-2 py-2 font-medium">Priority</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {withSubtasks(tasks).map(({ task, depth }) => {
            const overdue = task.dueDate && task.dueDate < today && task.status !== 'DONE' && task.status !== 'CANCELLED';
            return (
              <tr key={task.id} data-task-id={task.id} className="hover:bg-surface-2/60">
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    aria-label={`Mark ${task.title} ${task.status === 'DONE' ? 'not done' : 'done'}`}
                    checked={task.status === 'DONE'}
                    disabled={!canEdit}
                    onChange={(e) => void onChange(task, { status: e.target.checked ? 'DONE' : 'TODO' })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <button
                    className={cx('text-left hover:underline', depth > 0 && 'pl-5 text-[13px]', task.status === 'DONE' && 'text-muted line-through')}
                    onClick={() => onOpen(task.id)}
                  >
                    {depth ? '↳ ' : ''}
                    {task.title}
                  </button>
                  {task.blockedReason ? <span className="ml-2"><Badge tone="danger">Blocked</Badge></span> : null}
                  {overdue ? <span className="ml-2"><Badge tone="warning">Overdue</Badge></span> : null}
                </td>
                <td className="px-2 py-1.5"><StatusSelect task={task} disabled={!canEdit} onChange={(c) => void onChange(task, c)} /></td>
                <td className="px-2 py-1.5"><AssigneeSelect task={task} members={members} disabled={!canEdit} onChange={(c) => void onChange(task, c)} /></td>
                <td className="px-2 py-1.5">
                  <DateInput label={`Due date of ${task.title}`} value={task.dueDate} disabled={!canEdit} onChange={(v) => void onChange(task, { dueDate: v })} />
                </td>
                <td className="px-2 py-1.5"><PrioritySelect task={task} disabled={!canEdit} onChange={(c) => void onChange(task, c)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TaskBoard({ tasks, members, canEdit, today, onChange, onOpen }: ViewProps) {
  const [dragOver, setDragOver] = useState<TaskDto['status'] | null>(null);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memberName = new Map(members.map((m) => [m.id, m.name]));

  function drop(e: DragEvent, status: TaskDto['status']) {
    e.preventDefault();
    setDragOver(null);
    const task = byId.get(e.dataTransfer.getData('text/task-id'));
    if (task && task.status !== status) void onChange(task, { status });
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {BOARD_COLUMNS.map((status) => {
        const column = tasks.filter((t) => t.status === status);
        return (
          <section
            key={status}
            aria-label={TASK_STATUS_LABEL[status]}
            data-column={status}
            onDragOver={(e) => {
              if (!canEdit) return;
              e.preventDefault();
              setDragOver(status);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => drop(e, status)}
            className={cx('min-h-40 rounded-xl border border-line bg-surface-2/50 p-2', dragOver === status && 'border-accent')}
          >
            <h3 className="mb-2 flex items-center justify-between px-1 text-[13px] font-medium">
              {TASK_STATUS_LABEL[status]} <span className="text-muted">{column.length}</span>
            </h3>
            <ul className="space-y-2">
              {column.map((task) => (
                <li
                  key={task.id}
                  data-task-id={task.id}
                  draggable={canEdit}
                  onDragStart={(e) => e.dataTransfer.setData('text/task-id', task.id)}
                  className="rounded-lg border border-line bg-surface p-2 shadow-sm"
                >
                  <button className="w-full text-left font-medium hover:underline" onClick={() => onOpen(task.id)}>
                    {task.parentTaskId ? '↳ ' : ''}
                    {task.title}
                  </button>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[12px] text-muted">
                    {task.assigneeId ? <span>{memberName.get(task.assigneeId) ?? 'Member'}</span> : <span>Unassigned</span>}
                    {task.dueDate ? (
                      <span className={task.dueDate < today && status !== 'DONE' ? 'text-warning' : ''}>· {formatDate(task.dueDate)}</span>
                    ) : null}
                    {task.priority !== 'NONE' ? <span>· {PRIORITY_LABEL[task.priority]}</span> : null}
                    {task.blockedReason ? <Badge tone="danger">Blocked</Badge> : null}
                  </div>
                  {/* Keyboard / touch alternative to drag-and-drop. */}
                  <div className="mt-2">
                    <StatusSelect task={task} disabled={!canEdit} onChange={(c) => void onChange(task, c)} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
