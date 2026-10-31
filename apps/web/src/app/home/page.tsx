'use client';

import type { HomeDto } from '@monty/validation';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, ErrorBanner, PageLoading } from '@/components/ui';
import { api, errorMessage, localToday } from '@/lib/api';
import { STATUS_LABEL, STATUS_TONE } from '@/lib/labels';
import { useSession } from '@/lib/session';
import type { ComputedProjectStatus } from '@monty/domain';

export default function HomePage() {
  return (
    <AppShell>
      <Home />
    </AppShell>
  );
}

function Stat({ label, value, href, tone }: { label: string; value: number; href: string; tone?: 'warning' }) {
  return (
    <Link href={href} className="rounded-xl border border-line bg-surface p-4 hover:bg-surface-2" data-stat={label}>
      <p className="text-[12px] text-muted">{label}</p>
      <p className={tone === 'warning' && value > 0 ? 'text-2xl font-semibold text-warning' : 'text-2xl font-semibold'}>{value}</p>
    </Link>
  );
}

function Home() {
  const { user } = useSession();
  const [data, setData] = useState<HomeDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.insights.home(localToday()));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!data) return <PageLoading />;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Home</h1>
        <p className="text-muted">
          {greeting}, {user.name.split(' ')[0]}. Here’s what needs you.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Overdue" value={data.counts.overdue} href="/tasks" tone="warning" />
        <Stat label="Due today" value={data.counts.today} href="/tasks" />
        <Stat label="Next 7 days" value={data.counts.thisWeek} href="/calendar" />
        <Stat label="Unread in inbox" value={data.counts.unreadNotifications} href="/inbox" />
      </div>

      <section aria-labelledby="attention-title" className="rounded-xl border border-line bg-surface p-4">
        <h2 id="attention-title" className="mb-2 font-semibold">Projects needing attention</h2>
        {data.attention.length === 0 ? (
          <p className="text-[13px] text-muted">Nothing is blocked, at risk or missing essentials.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.attention.map((a) => (
              <li key={a.projectId} className="py-2" data-attention={a.projectName}>
                <Link href={`/project?id=${a.projectId}`} className="flex items-start gap-3 hover:underline">
                  <Badge tone={STATUS_TONE[a.computedStatus as ComputedProjectStatus]}>{STATUS_LABEL[a.computedStatus as ComputedProjectStatus]}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{a.projectName}</span> <span className="text-[12px] text-muted">· {a.workspaceName}</span>
                    <span className="block text-[13px] text-muted">{a.reasons.join(' ')}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="recent-title" className="rounded-xl border border-line bg-surface p-4">
        <h2 id="recent-title" className="mb-2 font-semibold">Recent activity</h2>
        {data.recentActivity.length === 0 ? <p className="text-[13px] text-muted">No activity yet.</p> : null}
        <ul className="space-y-1 text-[13px]">
          {data.recentActivity.map((e) => (
            <li key={e.id} className="flex justify-between gap-3">
              <span>
                <span className="font-medium">{e.actor.name}</span> {e.action} {e.entityType} {String(e.data.title ?? e.data.name ?? '')}
              </span>
              <time className="shrink-0 text-muted" dateTime={e.createdAt}>
                {new Date(e.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
              </time>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
