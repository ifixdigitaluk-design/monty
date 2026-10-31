import { describe, expect, it } from 'vitest';
import { addDays, isIsoDate } from '../src/dates';
import { groupMyTasks } from '../src/tasks';

describe('dates', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
  });
  it('adds days across month boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('groupMyTasks', () => {
  it('buckets by due date relative to today', () => {
    const today = '2026-10-31';
    const g = groupMyTasks(
      [
        { id: 'late', dueDate: '2026-10-30' },
        { id: 'now', dueDate: '2026-10-31' },
        { id: 'week', dueDate: '2026-11-06' },
        { id: 'later', dueDate: '2026-11-07' },
        { id: 'none', dueDate: null },
      ],
      today,
    );
    expect(g.overdue.map((t) => t.id)).toEqual(['late']);
    expect(g.today.map((t) => t.id)).toEqual(['now']);
    expect(g.thisWeek.map((t) => t.id)).toEqual(['week']);
    expect(g.later.map((t) => t.id)).toEqual(['later']);
    expect(g.noDate.map((t) => t.id)).toEqual(['none']);
  });
});
