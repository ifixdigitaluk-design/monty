'use client';

import type { DatabaseFieldDto } from '@monty/validation';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui';

export interface Member {
  id: string;
  name: string;
}

export function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return <span className={`chip chip-${color}`}>{children}</span>;
}

/** Read-only rendering of a value (board cards, read-only tables). */
export function CellValue({ field, value, members }: { field: DatabaseFieldDto; value: unknown; members: Member[] }) {
  if (value === null || value === undefined || value === '') return null;
  const choices = field.options.choices ?? [];
  switch (field.type) {
    case 'select': {
      const c = choices.find((x) => x.id === value);
      return c ? <Chip color={c.color}>{c.label}</Chip> : null;
    }
    case 'multi_select':
      return (
        <span className="flex flex-wrap gap-1">
          {(value as string[]).map((id) => {
            const c = choices.find((x) => x.id === id);
            return c ? <Chip key={id} color={c.color}>{c.label}</Chip> : null;
          })}
        </span>
      );
    case 'person':
      return <span>{(value as string[]).map((id) => members.find((m) => m.id === id)?.name ?? 'Former member').join(', ')}</span>;
    case 'checkbox':
      return <span aria-label="Checked">☑</span>;
    case 'url':
      return (
        <a className="truncate text-accent hover:underline" href={String(value)} target="_blank" rel="noopener noreferrer nofollow">
          {String(value).replace(/^https?:\/\//, '')}
        </a>
      );
    case 'date':
      return <span>{new Date(`${String(value)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>;
    default:
      return <span className="truncate">{String(value)}</span>;
  }
}

/** A text-like input that keeps its draft while focused and saves on blur / Enter. Escape reverts. */
function DraftInput({ value, type, label, onSave, className }: { value: string; type: string; label: string; onSave: (v: string) => void; className?: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return (
    <input
      type={type}
      aria-label={label}
      value={draft}
      step={type === 'number' ? 'any' : undefined}
      className={cx('h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 hover:border-line focus:border-line focus:bg-surface', className)}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          focused.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** A small popover with checkboxes, for multi-select and person cells. Built on <details> so it works with the keyboard. */
function PickMany({
  label,
  options,
  selected,
  onChange,
  summary,
}: {
  label: string;
  options: { id: string; label: string; color?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  summary: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <details ref={ref} className="relative w-full">
      <summary aria-label={label} className="flex min-h-8 cursor-pointer list-none items-center rounded-md border border-transparent px-2 hover:border-line [&::-webkit-details-marker]:hidden">
        {summary ?? <span className="text-muted">—</span>}
      </summary>
      <fieldset className="absolute left-0 top-full z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-line bg-surface p-2 shadow-lg">
        <legend className="sr-only">{label}</legend>
        {options.length === 0 ? <p className="px-1 text-[13px] text-muted">No options yet. Add them from the field menu.</p> : null}
        {options.map((o) => (
          <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-surface-2">
            <input
              type="checkbox"
              checked={selected.includes(o.id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, o.id] : selected.filter((x) => x !== o.id))}
            />
            {o.color ? <Chip color={o.color}>{o.label}</Chip> : o.label}
          </label>
        ))}
      </fieldset>
    </details>
  );
}

/** Editable cell. `onSave(null)` clears it. */
export function Cell({
  field,
  value,
  rowTitle,
  members,
  canEdit,
  onSave,
}: {
  field: DatabaseFieldDto;
  value: unknown;
  rowTitle: string;
  members: Member[];
  canEdit: boolean;
  onSave: (value: unknown) => void;
}) {
  const label = `${field.name} of ${rowTitle || 'Untitled'}`;
  if (!canEdit) return <div className="px-2 py-1"><CellValue field={field} value={value} members={members} /></div>;
  const choices = field.options.choices ?? [];
  switch (field.type) {
    case 'checkbox':
      return (
        <div className="flex h-8 items-center px-2">
          <input type="checkbox" aria-label={label} checked={value === true} onChange={(e) => onSave(e.target.checked)} />
        </div>
      );
    case 'select':
      return (
        <select
          aria-label={label}
          className="h-8 w-full rounded-md border border-transparent bg-transparent px-1 hover:border-line"
          value={(value as string) ?? ''}
          onChange={(e) => onSave(e.target.value || null)}
        >
          <option value="">—</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      );
    case 'multi_select':
      return (
        <PickMany
          label={label}
          options={choices}
          selected={(value as string[]) ?? []}
          onChange={(v) => onSave(v.length ? v : null)}
          summary={value ? <CellValue field={field} value={value} members={members} /> : null}
        />
      );
    case 'person':
      return (
        <PickMany
          label={label}
          options={members.map((m) => ({ id: m.id, label: m.name }))}
          selected={(value as string[]) ?? []}
          onChange={(v) => onSave(v.length ? v : null)}
          summary={value ? <CellValue field={field} value={value} members={members} /> : null}
        />
      );
    case 'number':
      return <DraftInput type="number" label={label} value={value === null || value === undefined ? '' : String(value)} onSave={(v) => onSave(v.trim() === '' ? null : Number(v))} className="text-right" />;
    case 'date':
      return <DraftInput type="date" label={label} value={(value as string) ?? ''} onSave={(v) => onSave(v || null)} />;
    case 'url':
      return (
        <div className="flex items-center">
          <DraftInput type="url" label={label} value={(value as string) ?? ''} onSave={(v) => onSave(v.trim() || null)} />
          {value ? (
            <a className="shrink-0 px-1 text-accent" href={String(value)} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Open link in ${label}`}>
              ↗
            </a>
          ) : null}
        </div>
      );
    default:
      return <DraftInput type="text" label={label} value={(value as string) ?? ''} onSave={(v) => onSave(v || null)} />;
  }
}

export const FIELD_TYPE_LABEL: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  select: 'Select',
  multi_select: 'Multi-select',
  date: 'Date',
  checkbox: 'Checkbox',
  person: 'Person',
  url: 'Link',
};
