import { addDays, IsoDate } from './dates';

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELLED';

export const TASK_STATUSES: readonly TaskStatus[] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'];

export function isOpenStatus(status: TaskStatus): boolean {
  return status !== 'DONE' && status !== 'CANCELLED';
}

export type MyTasksBucket = 'overdue' | 'today' | 'thisWeek' | 'later' | 'noDate';

export interface DatedTask {
  dueDate: IsoDate | null;
}

/** Groups tasks for the "My Tasks" view. "This week" means the next 6 days after today. */
export function bucketForTask(task: DatedTask, today: IsoDate): MyTasksBucket {
  if (!task.dueDate) return 'noDate';
  if (task.dueDate < today) return 'overdue';
  if (task.dueDate === today) return 'today';
  if (task.dueDate <= addDays(today, 6)) return 'thisWeek';
  return 'later';
}

export function groupMyTasks<T extends DatedTask>(tasks: readonly T[], today: IsoDate): Record<MyTasksBucket, T[]> {
  const groups: Record<MyTasksBucket, T[]> = { overdue: [], today: [], thisWeek: [], later: [], noDate: [] };
  for (const task of tasks) groups[bucketForTask(task, today)].push(task);
  const byDue = (a: T, b: T) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
  for (const key of Object.keys(groups) as MyTasksBucket[]) groups[key].sort(byDue);
  return groups;
}
