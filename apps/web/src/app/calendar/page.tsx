'use client';

import type { CalendarEntryDto } from '@monty/validation';
import { addDays } from '@monty/domain';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Button, cx, ErrorBanner, PageLoading } from '@/components/ui';
import { api, errorMessage, localToday } from '@/lib/api';

export default function CalendarPage() {
  return (
    <AppShell>
      <Calendar />
    </AppShell>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

function Calendar() {
  const today = localToday();
  const [month, setMonth] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [mine, setMine] = useState(false);
  const [entries, setEntries] = useState<CalendarEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Grid: Monday-first weeks covering the month.
  const days = useMemo(() => {
    const first = new Date(Date.UTC(month.y, month.m, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    const start = addDays(iso(month.y, month.m, 1), -offset);
    const last = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate();
    const cells = Math.ceil((offset + last) / 7) * 7;
    return Array.from({ length: cells }, (_, i) => addDays(start, i));
  }, [month]);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries((await api.insights.calendar(days[0]!, days[days.length - 1]!, mine)).entries);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [days, mine]);
  useEffect(() => {
    void load();
  }, [load]);

  const shift = (delta: number) => setMonth(({ y, m }) => ({ y: m + delta < 0 ? y - 1 : m + delta > 11 ? y + 1 : y, m: (m + delta + 12) % 12 }));
  const title = new Date(Date.UTC(month.y, month.m, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Calendar</h1>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" className="accent-[var(--accent)]" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my tasks
          </label>
          <Button aria-label="Previous month" onClick={() => shift(-1)}>‹</Button>
          <span className="w-40 text-center font-medium" aria-live="polite">{title}</span>
          <Button aria-label="Next month" onClick={() => shift(1)}>›</Button>
          <Button onClick={() => setMonth({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 })}>Today</Button>
        </div>
      </div>
      {error ? <ErrorBanner message={error} onRetry={load} /> : !entries ? <PageLoading /> : null}
      <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-line bg-surface text-[12px]" role="grid" aria-label={title}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} role="columnheader" className="border-b border-line px-2 py-1 font-medium text-muted">{d}</div>
        ))}
        {days.map((d) => {
          const inMonth = Number(d.slice(5, 7)) - 1 === month.m;
          const items = entries?.filter((e) => e.date === d) ?? [];
          return (
            <div key={d} role="gridcell" data-date={d} className={cx('min-h-24 border-b border-r border-line p-1', !inMonth && 'bg-surface-2/50 text-muted')}>
              <div className={cx('mb-1 w-6 rounded text-center', d === today && 'bg-accent text-accent-fg')}>{Number(d.slice(8))}</div>
              <ul className="space-y-0.5">
                {items.slice(0, 4).map((e) => (
                  <li key={`${e.kind}-${e.id}`}>
                    <Link
                      href={`/project?id=${e.projectId}${e.kind === 'task' ? `&task=${e.id}` : ''}`}
                      title={`${e.title} — ${e.projectName}`}
                      className={cx(
                        'block truncate rounded px-1 hover:underline',
                        e.kind === 'milestone' ? 'bg-accent/15 font-medium' : 'bg-surface-2',
                        e.done && 'text-muted line-through',
                        e.kind === 'task' && !e.done && d < today && 'text-warning',
                      )}
                    >
                      {e.kind === 'milestone' ? '◆ ' : ''}
                      {e.title}
                    </Link>
                  </li>
                ))}
                {items.length > 4 ? <li className="px-1 text-muted">+{items.length - 4} more</li> : null}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
