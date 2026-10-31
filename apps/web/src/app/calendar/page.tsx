'use client';

import type { CalendarEntryDto } from '@monty/validation';
import { addDays } from '@monty/domain';
import Link from 'next/link';
import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
const parts = (d: string) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) - 1, d: Number(d.slice(8, 10)) });
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** Same day-of-month in another month, clamped (31 Jan + 1 month → 28/29 Feb). */
function addMonths(date: string, delta: number): string {
  const { y, m, d } = parts(date);
  const t = new Date(Date.UTC(y, m + delta, 1));
  return iso(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, daysIn(t.getUTCFullYear(), t.getUTCMonth())));
}
const WEEKDAYS = [
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
] as const;
const longDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const weekdayIndex = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;

/**
 * Month calendar following the WAI-ARIA date-grid pattern:
 * a table with column headers, one tab stop (the selected day), arrow keys to move by day/week,
 * Home/End for week start/end, PageUp/PageDown for months (Shift for years), Enter/Space to select.
 * The selected day's items are listed below the grid as ordinary links, so every item is reachable by keyboard
 * and announced in full without visiting each cell.
 */
function Calendar() {
  const today = localToday();
  const [selected, setSelected] = useState(today);
  const [mine, setMine] = useState(false);
  const [entries, setEntries] = useState<CalendarEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focusAfterRender = useRef(false);
  const gridRef = useRef<HTMLTableElement>(null);
  const month = { y: parts(selected).y, m: parts(selected).m };

  const weeks = useMemo(() => {
    const offset = weekdayIndex(iso(month.y, month.m, 1));
    const start = addDays(iso(month.y, month.m, 1), -offset);
    const cells = Math.ceil((offset + daysIn(month.y, month.m)) / 7) * 7;
    const days = Array.from({ length: cells }, (_, i) => addDays(start, i));
    return Array.from({ length: cells / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7));
  }, [month.y, month.m]);
  const first = weeks[0]![0]!;
  const last = weeks[weeks.length - 1]![6]!;

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries((await api.insights.calendar(first, last, mine)).entries);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [first, last, mine]);
  useEffect(() => {
    void load();
  }, [load]);

  // Keyboard navigation moves focus with the selection (including across months).
  useEffect(() => {
    if (!focusAfterRender.current) return;
    focusAfterRender.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-day="${selected}"]`)?.focus();
  }, [selected, weeks]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEntryDto[]>();
    for (const e of entries ?? []) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [entries]);

  function onKey(e: KeyboardEvent<HTMLButtonElement>, day: string) {
    const moves: Record<string, () => string> = {
      ArrowRight: () => addDays(day, 1),
      ArrowLeft: () => addDays(day, -1),
      ArrowDown: () => addDays(day, 7),
      ArrowUp: () => addDays(day, -7),
      Home: () => addDays(day, -weekdayIndex(day)),
      End: () => addDays(day, 6 - weekdayIndex(day)),
      PageDown: () => addMonths(day, e.shiftKey ? 12 : 1),
      PageUp: () => addMonths(day, e.shiftKey ? -12 : -1),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    focusAfterRender.current = true;
    setSelected(move());
  }

  const title = new Date(Date.UTC(month.y, month.m, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const selectedItems = byDate.get(selected) ?? [];

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Calendar</h1>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" className="accent-[var(--accent)]" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my tasks
          </label>
          <Button aria-label="Previous month" onClick={() => setSelected(addMonths(selected, -1))}>‹</Button>
          <h2 id="calendar-month" className="w-40 text-center font-medium" aria-live="polite">{title}</h2>
          <Button aria-label="Next month" onClick={() => setSelected(addMonths(selected, 1))}>›</Button>
          <Button onClick={() => setSelected(today)}>Today</Button>
        </div>
      </div>
      <p id="calendar-help" className="sr-only">
        Use arrow keys to move between days, Page Up and Page Down to change month, and Enter to show a day’s items below the calendar.
      </p>
      {error ? <ErrorBanner message={error} onRetry={load} /> : !entries ? <PageLoading /> : null}

      <table
        ref={gridRef}
        role="grid"
        aria-labelledby="calendar-month"
        aria-describedby="calendar-help"
        className="w-full table-fixed border-collapse overflow-hidden rounded-xl border border-line bg-surface text-[12px]"
      >
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th key={short} scope="col" abbr={long} className="border-b border-line px-2 py-1 text-left font-medium text-muted">
                <span aria-hidden="true">{short}</span>
                <span className="sr-only">{long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((d) => {
                const inMonth = parts(d).m === month.m;
                const items = byDate.get(d) ?? [];
                const isSelected = d === selected;
                const label = `${longDate(d)}${d === today ? ', today' : ''}, ${items.length === 0 ? 'no items' : `${items.length} item${items.length > 1 ? 's' : ''}`}`;
                return (
                  <td
                    key={d}
                    role="gridcell"
                    aria-selected={isSelected}
                    data-date={d}
                    className={cx('h-24 border-b border-r border-line p-1 align-top', !inMonth && 'bg-surface-2/50 text-muted', isSelected && 'bg-accent/5')}
                  >
                    <button
                      type="button"
                      data-day={d}
                      tabIndex={isSelected ? 0 : -1}
                      aria-label={label}
                      onClick={() => setSelected(d)}
                      onKeyDown={(e) => onKey(e, d)}
                      className={cx(
                        'mb-1 flex h-6 w-6 items-center justify-center rounded text-center outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
                        d === today && 'bg-accent text-accent-fg',
                        isSelected && d !== today && 'ring-1 ring-accent',
                      )}
                    >
                      {parts(d).d}
                    </button>
                    {/* Visual summary for pointer users; keyboard and screen-reader users get the full list below. */}
                    <ul className="space-y-0.5">
                      {items.slice(0, 3).map((e) => (
                        <li key={`${e.kind}-${e.id}`}>
                          <Link
                            href={`/project?id=${e.projectId}${e.kind === 'task' ? `&task=${e.id}` : ''}`}
                            tabIndex={-1}
                            aria-hidden="true"
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
                      {items.length > 3 ? <li className="px-1 text-muted" aria-hidden="true">+{items.length - 3} more</li> : null}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <section aria-labelledby="day-heading" className="mt-4 rounded-xl border border-line bg-surface p-4">
        <h2 id="day-heading" className="font-semibold" aria-live="polite">
          {longDate(selected)}
          {selected === today ? ' (today)' : ''}
        </h2>
        {selectedItems.length === 0 ? (
          <p className="mt-1 text-[13px] text-muted">Nothing due on this day.</p>
        ) : (
          <ul className="mt-2 space-y-1" aria-label={`Items on ${longDate(selected)}`}>
            {selectedItems.map((e) => (
              <li key={`${e.kind}-${e.id}`}>
                <Link
                  href={`/project?id=${e.projectId}${e.kind === 'task' ? `&task=${e.id}` : ''}`}
                  className="rounded hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {e.kind === 'milestone' ? 'Milestone: ' : 'Task: '}
                  {e.title}
                </Link>{' '}
                <span className="text-[12px] text-muted">
                  — {e.projectName}
                  {e.done ? ', done' : e.kind === 'task' && e.date < today ? ', overdue' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
