'use client';

import { groupMyTasks, MyTasksBucket } from '@monty/domain';
import type { MyTaskDto } from '@monty/validation';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, EmptyState, ErrorBanner, PageLoading, useToast } from '@/components/ui';
import { api, ApiError, errorMessage, formatDate, localToday } from '@/lib/api';
import { PRIORITY_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';

const SECTIONS: { key: MyTasksBucket; title: string }[] = [
  { key: 'overdue', title: 'Overdue' },
  { key: 'today', title: 'Today' },
  { key: 'thisWeek', title: 'Next 7 days' },
  { key: 'later', title: 'Later' },
  { key: 'noDate', title: 'No due date' },
];

export default function MyTasksPage() {
  return (
    <AppShell>
      <MyTasks />
    </AppShell>
  );
}

function MyTasks() {
  const [tasks, setTasks] = useState<MyTaskDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setTasks((await api.tasks.mine()).tasks);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function complete(task: MyTaskDto) {
    try {
      await api.tasks.update(task.id, { expectedVersion: task.version, status: 'DONE' });
      setTasks((all) => all?.filter((t) => t.id !== task.id) ?? null);
      toast({ tone: 'success', message: `Completed “${task.title}”` });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        toast({ tone: 'error', message: 'That task changed elsewhere. Refreshed your list.' });
        void load();
      } else {
        toast({ tone: 'error', message: errorMessage(err) });
      }
    }
  }

  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!tasks) return <PageLoading />;

  const groups = groupMyTasks(tasks, localToday());

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">My Tasks</h1>
      <p className="mb-6 text-muted">Open work assigned to you, across all your workspaces.</p>
      {tasks.length === 0 ? (
        <EmptyState title="Nothing assigned to you" body="Tasks assigned to you in any project show up here." />
      ) : (
        <div className="space-y-6">
          {SECTIONS.filter((s) => groups[s.key].length > 0).map((s) => (
            <section key={s.key} aria-labelledby={`sec-${s.key}`}>
              <h2 id={`sec-${s.key}`} className={`mb-2 text-[13px] font-semibold ${s.key === 'overdue' ? 'text-warning' : 'text-muted'}`}>
                {s.title} · {groups[s.key].length}
              </h2>
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {groups[s.key].map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      aria-label={`Complete ${t.title}`}
                      onChange={() => void complete(t)}
                    />
                    <div className="min-w-0 flex-1">
                      <Link href={`/project?id=${t.projectId}`} className="block truncate hover:underline">
                        {t.title}
                      </Link>
                      <p className="truncate text-[12px] text-muted">
                        {t.projectName} · {TASK_STATUS_LABEL[t.status]}
                        {t.priority !== 'NONE' ? ` · ${PRIORITY_LABEL[t.priority]}` : ''}
                      </p>
                    </div>
                    {t.blockedReason ? <Badge tone="danger">Blocked</Badge> : null}
                    {t.dueDate ? <span className="shrink-0 text-[12px] text-muted">{formatDate(t.dueDate)}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
