'use client';

import type { MilestoneDto } from '@monty/validation';
import { FormEvent, useState } from 'react';
import { api, errorMessage, formatDate } from '@/lib/api';
import { Button, Input, useToast } from '../ui';
import { DateInput } from './TaskControls';

export function Milestones({
  projectId,
  milestones,
  canEdit,
  onChanged,
}: {
  projectId: string;
  milestones: MilestoneDto[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [due, setDue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.milestones.create(projectId, { name: name.trim(), dueDate: due });
      setName('');
      setDue(null);
      onChanged();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      onChanged();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      onChanged();
    }
  }

  return (
    <section aria-labelledby="milestones-title" className="rounded-xl border border-line bg-surface p-4">
      <h2 id="milestones-title" className="mb-2 font-semibold">Milestones</h2>
      {milestones.length === 0 ? <p className="text-[13px] text-muted">No milestones yet.</p> : null}
      <ul className="space-y-2">
        {milestones.map((m) => {
          const pct = m.taskTotal ? Math.round((m.taskDone / m.taskTotal) * 100) : 0;
          return (
            <li key={m.id} data-milestone={m.name}>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  aria-label={`Mark milestone ${m.name} ${m.completedAt ? 'not complete' : 'complete'}`}
                  checked={!!m.completedAt}
                  disabled={!canEdit}
                  onChange={(e) => void act(() => api.milestones.update(m.id, { expectedVersion: m.version, completed: e.target.checked }))}
                />
                <span className={m.completedAt ? 'flex-1 text-muted line-through' : 'flex-1 font-medium'}>{m.name}</span>
                {canEdit ? (
                  <button className="text-[12px] text-muted hover:text-danger" aria-label={`Delete milestone ${m.name}`} onClick={() => void act(() => api.milestones.remove(m.id))}>
                    ✕
                  </button>
                ) : null}
              </div>
              <div className="ml-6 text-[12px] text-muted">
                {m.dueDate ? `Due ${formatDate(m.dueDate)} · ` : ''}
                {m.taskDone}/{m.taskTotal} tasks
              </div>
              <div className="ml-6 mt-1 h-1 rounded-full bg-surface-2">
                <div className="h-1 rounded-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      {canEdit ? (
        <form onSubmit={add} className="mt-3 space-y-2">
          <Input aria-label="New milestone name" placeholder="Add a milestone…" className="h-8" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex gap-2">
            <DateInput label="New milestone due date" value={due} onChange={setDue} />
            <Button type="submit" busy={busy} disabled={!name.trim()}>
              Add milestone
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
