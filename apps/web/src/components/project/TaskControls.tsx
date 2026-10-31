'use client';

import type { MemberDto, Priority, TaskDto } from '@monty/validation';
import { Select } from '../ui';
import { PRIORITY_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';

export type TaskChanges = Partial<
  Pick<TaskDto, 'title' | 'description' | 'status' | 'priority' | 'assigneeId' | 'startDate' | 'dueDate' | 'estimateMinutes' | 'blockedReason' | 'sortOrder' | 'milestoneId'>
>;

export function StatusSelect({ task, disabled, onChange }: { task: TaskDto; disabled?: boolean; onChange: (c: TaskChanges) => void }) {
  return (
    <Select
      aria-label={`Status of ${task.title}`}
      value={task.status}
      disabled={disabled}
      onChange={(e) => onChange({ status: e.target.value as TaskDto['status'] })}
    >
      {Object.entries(TASK_STATUS_LABEL).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </Select>
  );
}

export function AssigneeSelect({
  task,
  members,
  disabled,
  onChange,
}: {
  task: TaskDto;
  members: MemberDto[];
  disabled?: boolean;
  onChange: (c: TaskChanges) => void;
}) {
  return (
    <Select
      aria-label={`Assignee of ${task.title}`}
      value={task.assigneeId ?? ''}
      disabled={disabled}
      onChange={(e) => onChange({ assigneeId: e.target.value || null })}
    >
      <option value="">Unassigned</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </Select>
  );
}

export function PrioritySelect({ task, disabled, onChange }: { task: TaskDto; disabled?: boolean; onChange: (c: TaskChanges) => void }) {
  return (
    <Select
      aria-label={`Priority of ${task.title}`}
      value={task.priority}
      disabled={disabled}
      onChange={(e) => onChange({ priority: e.target.value as Priority })}
    >
      {Object.entries(PRIORITY_LABEL).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </Select>
  );
}

export function DateInput({
  value,
  label,
  disabled,
  onChange,
}: {
  value: string | null;
  label: string;
  disabled?: boolean;
  onChange: (v: string | null) => void;
}) {
  return (
    <input
      type="date"
      aria-label={label}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px] outline-none focus:border-accent disabled:opacity-60"
    />
  );
}
