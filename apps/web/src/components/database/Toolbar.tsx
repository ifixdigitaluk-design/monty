'use client';

import { CHOICE_COLORS, opsFor, TITLE_FIELD, type FilterOp, type ViewConfig, type ViewFilter } from '@monty/domain';
import type { DatabaseFieldDto } from '@monty/validation';
import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Modal, Select } from '../ui';
import { Chip, FIELD_TYPE_LABEL, Member } from './Cell';

const OP_LABEL: Record<FilterOp, string> = {
  contains: 'contains',
  not_contains: 'does not contain',
  is: 'is',
  is_not: 'is not',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  gt: 'is greater than',
  lt: 'is less than',
  before: 'is before',
  after: 'is after',
  checked: 'is checked',
  unchecked: 'is not checked',
  has: 'includes',
};
const NO_VALUE: FilterOp[] = ['is_empty', 'is_not_empty', 'checked', 'unchecked'];

/** Popover panel anchored to a toolbar button (keyboard-accessible <details>). */
function Panel({ label, badge, children }: { label: string; badge?: number; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <details ref={ref} className="relative">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1 rounded-lg px-3 text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-fg [&::-webkit-details-marker]:hidden">
        {label}
        {badge ? <span className="rounded bg-accent px-1 text-[11px] text-accent-fg">{badge}</span> : null}
      </summary>
      <div role="group" aria-label={label} className="absolute right-0 top-full z-30 mt-1 w-[min(92vw,30rem)] rounded-lg border border-line bg-surface p-3 shadow-lg">
        {children}
      </div>
    </details>
  );
}

const fieldOptions = (fields: DatabaseFieldDto[]) => [{ id: TITLE_FIELD, name: 'Name', type: 'text' }, ...fields];

export function FilterPanel({ fields, members, config, onChange }: { fields: DatabaseFieldDto[]; members: Member[]; config: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const filters = config.filters ?? [];
  const all = fieldOptions(fields);
  const typeOf = (id: string) => (id === TITLE_FIELD ? TITLE_FIELD : fields.find((f) => f.id === id)?.type ?? 'text');
  const set = (next: ViewFilter[]) => onChange({ ...config, filters: next });
  const update = (i: number, patch: Partial<ViewFilter>) => set(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <Panel label="Filter" badge={filters.length}>
      {filters.length === 0 ? <p className="mb-2 text-[13px] text-muted">Show only rows that match.</p> : null}
      {filters.length > 1 ? (
        <Select aria-label="Match" className="mb-2" value={config.match ?? 'all'} onChange={(e) => onChange({ ...config, match: e.target.value as 'all' | 'any' })}>
          <option value="all">Match all filters</option>
          <option value="any">Match any filter</option>
        </Select>
      ) : null}
      <ul className="space-y-2">
        {filters.map((f, i) => {
          const type = typeOf(f.fieldId);
          const field = fields.find((x) => x.id === f.fieldId);
          return (
            <li key={i} className="flex flex-wrap items-center gap-1">
              <Select
                aria-label={`Filter ${i + 1} field`}
                value={f.fieldId}
                onChange={(e) => update(i, { fieldId: e.target.value, op: opsFor(typeOf(e.target.value))[0]!, value: undefined })}
              >
                {all.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
              <Select aria-label={`Filter ${i + 1} condition`} value={f.op} onChange={(e) => update(i, { op: e.target.value as FilterOp })}>
                {opsFor(type).map((op) => (
                  <option key={op} value={op}>
                    {OP_LABEL[op]}
                  </option>
                ))}
              </Select>
              {NO_VALUE.includes(f.op) ? null : field && (field.type === 'select' || field.type === 'multi_select') ? (
                <Select aria-label={`Filter ${i + 1} value`} value={(f.value as string) ?? ''} onChange={(e) => update(i, { value: e.target.value })}>
                  <option value="">Choose…</option>
                  {(field.options.choices ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              ) : field?.type === 'person' ? (
                <Select aria-label={`Filter ${i + 1} value`} value={(f.value as string) ?? ''} onChange={(e) => update(i, { value: e.target.value })}>
                  <option value="">Choose…</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  aria-label={`Filter ${i + 1} value`}
                  className="h-8 w-36"
                  type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
                  value={(f.value as string | number | undefined) ?? ''}
                  onChange={(e) => update(i, { value: type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })}
                />
              )}
              <Button variant="ghost" aria-label={`Remove filter ${i + 1}`} onClick={() => set(filters.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </li>
          );
        })}
      </ul>
      <Button className="mt-2" variant="ghost" disabled={filters.length >= 20} onClick={() => set([...filters, { fieldId: TITLE_FIELD, op: 'contains', value: '' }])}>
        + Add filter
      </Button>
    </Panel>
  );
}

export function SortPanel({ fields, config, onChange }: { fields: DatabaseFieldDto[]; config: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const sorts = config.sorts ?? [];
  const all = fieldOptions(fields);
  const set = (next: ViewConfig['sorts']) => onChange({ ...config, sorts: next });
  return (
    <Panel label="Sort" badge={sorts.length}>
      {sorts.length === 0 ? <p className="mb-2 text-[13px] text-muted">Rows are in manual order.</p> : null}
      <ul className="space-y-2">
        {sorts.map((s, i) => (
          <li key={i} className="flex items-center gap-1">
            <Select aria-label={`Sort ${i + 1} field`} value={s.fieldId} onChange={(e) => set(sorts.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)))}>
              {all.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
            <Select aria-label={`Sort ${i + 1} direction`} value={s.dir} onChange={(e) => set(sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)))}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </Select>
            <Button variant="ghost" aria-label={`Remove sort ${i + 1}`} onClick={() => set(sorts.filter((_, j) => j !== i))}>
              ✕
            </Button>
          </li>
        ))}
      </ul>
      <Button className="mt-2" variant="ghost" disabled={sorts.length >= 5} onClick={() => set([...sorts, { fieldId: TITLE_FIELD, dir: 'asc' }])}>
        + Add sort
      </Button>
    </Panel>
  );
}

export function FieldsPanel({
  fields,
  config,
  onChange,
  canStructure,
  onAddField,
  onEditField,
}: {
  fields: DatabaseFieldDto[];
  config: ViewConfig;
  onChange: (c: ViewConfig) => void;
  canStructure: boolean;
  onAddField: () => void;
  onEditField: (f: DatabaseFieldDto) => void;
}) {
  const hidden = config.hiddenFieldIds ?? [];
  return (
    <Panel label="Fields">
      <ul className="space-y-1">
        {fields.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!hidden.includes(f.id)}
                onChange={(e) => onChange({ ...config, hiddenFieldIds: e.target.checked ? hidden.filter((x) => x !== f.id) : [...hidden, f.id] })}
              />
              {f.name} <span className="text-[12px] text-muted">{FIELD_TYPE_LABEL[f.type]}</span>
            </label>
            {canStructure ? (
              <Button variant="ghost" aria-label={`Edit field ${f.name}`} onClick={() => onEditField(f)}>
                Edit
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canStructure ? (
        <Button className="mt-2" variant="ghost" onClick={onAddField}>
          + New field
        </Button>
      ) : null}
    </Panel>
  );
}

type ChoiceDraft = { id: string; label: string; color: string };
const newChoiceId = () => Math.random().toString(36).slice(2, 10);

/** Create or edit a field (name, type on create, options for selects). */
export function FieldDialog({
  field,
  onClose,
  onSubmit,
  onDelete,
}: {
  field: DatabaseFieldDto | null;
  onClose: () => void;
  onSubmit: (input: { name: string; type: string; choices: ChoiceDraft[] }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(field?.name ?? '');
  const [type, setType] = useState<string>(field?.type ?? 'text');
  const [choices, setChoices] = useState<ChoiceDraft[]>(field?.options.choices ?? []);
  const [newChoice, setNewChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isChoice = type === 'select' || type === 'multi_select';

  function addChoice() {
    const label = newChoice.trim();
    if (!label || choices.some((c) => c.label.toLowerCase() === label.toLowerCase())) return;
    setChoices([...choices, { id: newChoiceId(), label, color: CHOICE_COLORS[(choices.length + 1) % CHOICE_COLORS.length]! }]);
    setNewChoice('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), type, choices });
      onClose();
    } catch {
      // The page shows the error; keep the dialog open.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={field ? `Edit field ${field.name}` : 'New field'}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Field name" htmlFor="field-name">
          <Input id="field-name" autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        {field ? (
          <p className="text-[13px] text-muted">Type: {FIELD_TYPE_LABEL[field.type]}</p>
        ) : (
          <Field label="Type" htmlFor="field-type">
            <Select id="field-type" className="w-full" value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(FIELD_TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {isChoice ? (
          <div>
            <p className="mb-1 text-[12px] font-medium text-muted">Options</p>
            <ul className="space-y-1">
              {choices.map((c, i) => (
                <li key={c.id} className="flex items-center gap-2">
                  <Chip color={c.color}>{c.label}</Chip>
                  <Input aria-label={`Option ${i + 1} name`} className="h-7 flex-1" value={c.label} onChange={(e) => setChoices(choices.map((x) => (x.id === c.id ? { ...x, label: e.target.value } : x)))} />
                  <Select aria-label={`Option ${i + 1} colour`} value={c.color} onChange={(e) => setChoices(choices.map((x) => (x.id === c.id ? { ...x, color: e.target.value } : x)))}>
                    {CHOICE_COLORS.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </Select>
                  <Button variant="ghost" aria-label={`Remove option ${c.label}`} onClick={() => setChoices(choices.filter((x) => x.id !== c.id))}>
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Input
                aria-label="New option"
                placeholder="Add an option…"
                className="h-8"
                value={newChoice}
                onChange={(e) => setNewChoice(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addChoice();
                  }
                }}
              />
              <Button onClick={addChoice} disabled={!newChoice.trim()}>
                Add
              </Button>
            </div>
            {field && (field.options.choices ?? []).some((c) => !choices.some((x) => x.id === c.id)) ? (
              <p className="mt-2 text-[12px] text-warning">Removed options will be cleared from every row.</p>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-2">
          {onDelete ? (
            confirmDelete ? (
              <>
                <span className="mr-auto text-[13px] text-danger">Delete this field and its values in every row?</span>
                <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
                <Button variant="danger" onClick={() => void onDelete().then(onClose)}>
                  Delete field
                </Button>
              </>
            ) : (
              <Button variant="danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>
                Delete…
              </Button>
            )
          ) : null}
          {confirmDelete ? null : (
            <>
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
                {field ? 'Save' : 'Create field'}
              </Button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
