'use client';

import type { NotificationDto } from '@monty/validation';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Button, cx, EmptyState, ErrorBanner, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function InboxPage() {
  return (
    <AppShell>
      <Inbox />
    </AppShell>
  );
}

function describe(n: NotificationDto): string {
  const who = n.actor?.name ?? 'Someone';
  const task = (n.data.taskTitle as string | null) ?? null;
  const project = (n.data.projectName as string | null) ?? null;
  if (n.type === 'automation') {
    return `Automation “${(n.data.ruleName as string) ?? 'rule'}”: ${(n.data.message as string) ?? ''}${n.data.title ? ` — “${n.data.title as string}”` : ''}`;
  }
  if (n.type === 'assigned') return `${who} assigned you “${task ?? 'a task'}”${project ? ` in ${project}` : ''}`;
  if (n.type === 'mention' && n.entityType === 'message') {
    return `${who} mentioned you in ${(n.data.channelName as string) ?? 'chat'}: “${(n.data.preview as string) ?? ''}”`;
  }
  if (n.type === 'mention') return `${who} mentioned you${task ? ` on “${task}”` : project ? ` in ${project}` : ''}`;
  return `${who} commented on “${task ?? 'a task'}”`;
}

function Inbox() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.notifications.list()).notifications);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(n: NotificationDto) {
    if (!n.readAt) await api.notifications.markRead([n.id]).catch(() => undefined);
    const taskId = n.entityType === 'task' ? n.entityId : ((n.data.taskId as string | null) ?? null);
    if (n.entityType === 'message') {
      const d = n.data as { workspaceId?: string; channelId?: string; threadId?: string | null };
      router.push(`/chat?${d.workspaceId ? `ws=${d.workspaceId}&` : ''}c=${d.channelId}${d.threadId ? `&t=${d.threadId}` : ''}`);
      return;
    }
    if (n.projectId) router.push(`/project?id=${n.projectId}${taskId ? `&task=${taskId}` : ''}`);
  }

  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!items) return <PageLoading />;
  const unread = items.filter((n) => !n.readAt).length;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-muted">Mentions, assignments and comments on your tasks.</p>
        </div>
        {unread > 0 ? (
          <Button onClick={() => void api.notifications.markRead().then(load)}>Mark all read</Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <EmptyState title="You’re all caught up" body="When someone mentions you or assigns you work, it shows up here." />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {items.map((n) => (
            <li key={n.id}>
              <button className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2" onClick={() => void open(n)} data-notification={n.type}>
                <span aria-hidden className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-accent')} />
                <span className="min-w-0 flex-1">
                  <span className={cx('block', !n.readAt && 'font-medium')}>
                    {describe(n)}
                    {!n.readAt ? <span className="sr-only"> (unread)</span> : null}
                  </span>
                  {n.data.excerpt ? <span className="block truncate text-[13px] text-muted">{String(n.data.excerpt).replace(/<@[0-9a-f-]{36}>/gi, '@…')}</span> : null}
                </span>
                <time className="shrink-0 text-[12px] text-muted" dateTime={n.createdAt}>
                  {new Date(n.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
