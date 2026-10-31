'use client';

import { groupRows } from '@monty/domain';
import type { DatabaseFieldDto, DatabaseRowDto } from '@monty/validation';
import { useState } from 'react';
import { Button, cx } from '../ui';
import { Cell, CellValue, Chip, FIELD_TYPE_LABEL, Member } from './Cell';

interface Common {
  fields: DatabaseFieldDto[];
  rows: DatabaseRowDto[];
  members: Member[];
  canEdit: boolean;
  onCell: (row: DatabaseRowDto, fieldId: string, value: unknown) => void;
  onTitle: (row: DatabaseRowDto, title: string) => void;
  onOpen: (rowId: string) => void;
}

function TitleInput({ row, canEdit, onTitle }: { row: DatabaseRowDto; canEdit: boolean; onTitle: (row: DatabaseRowDto, title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (!canEdit) return <span className="truncate px-2">{row.title || 'Untitled'}</span>;
  return (
    <input
      aria-label={`Name of ${row.title || 'Untitled'}`}
      className="h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 font-medium hover:border-line focus:border-line focus:bg-surface"
      placeholder="Untitled"
      value={draft ?? row.title}
      onFocus={() => setDraft(row.title)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== row.title) onTitle(row, draft);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function TableView({
  fields,
  rows,
  members,
  canEdit,
  canStructure,
  onCell,
  onTitle,
  onOpen,
  onAddRow,
  onEditField,
  onAddField,
  total,
}: Common & { canStructure: boolean; onAddRow: () => void; onEditField: (f: DatabaseFieldDto) => void; onAddField: () => void; total: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th scope="col" className="sticky left-0 z-10 w-64 min-w-48 bg-surface px-2 py-1.5 font-medium">Name</th>
            {fields.map((f) => (
              <th key={f.id} scope="col" className="min-w-40 px-2 py-1.5 font-medium">
                {canStructure ? (
                  <button className="w-full truncate text-left hover:text-fg" title={`${FIELD_TYPE_LABEL[f.type]} — edit field`} onClick={() => onEditField(f)}>
                    {f.name}
                  </button>
                ) : (
                  f.name
                )}
              </th>
            ))}
            {canStructure ? (
              <th scope="col" className="w-10 px-1">
                <Button variant="ghost" aria-label="Add a field" onClick={onAddField}>
                  +
                </Button>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="group border-b border-line last:border-b-0 hover:bg-surface-2/50" data-row={r.title}>
              <th scope="row" className="sticky left-0 z-10 bg-surface p-0 text-left font-normal group-hover:bg-surface-2">
                <div className="flex items-center">
                  <TitleInput row={r} canEdit={canEdit} onTitle={onTitle} />
                  <button
                    className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-surface hover:text-fg"
                    aria-label={`Open ${r.title || 'Untitled'}`}
                    onClick={() => onOpen(r.id)}
                  >
                    {r.hasBody ? '📄' : 'Open'}
                  </button>
                </div>
              </th>
              {fields.map((f) => (
                <td key={f.id} className="max-w-72 p-0 align-middle">
                  <Cell field={f} value={r.values[f.id] ?? null} rowTitle={r.title} members={members} canEdit={canEdit} onSave={(v) => onCell(r, f.id, v)} />
                </td>
              ))}
              {canStructure ? <td /> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between border-t border-line px-2 py-1.5 text-[12px] text-muted">
        {canEdit ? (
          <Button variant="ghost" onClick={onAddRow}>
            + New row
          </Button>
        ) : (
          <span />
        )}
        <span aria-live="polite">{rows.length === total ? `${total} rows` : `${rows.length} of ${total} rows`}</span>
      </div>
    </div>
  );
}

export function BoardView({
  rows,
  members,
  canEdit,
  onCell,
  onOpen,
  groupField,
  cardFields,
  onAddRow,
}: Common & { groupField: DatabaseFieldDto | null; cardFields: DatabaseFieldDto[]; onAddRow: (groupValue: string | null) => void }) {
  const [over, setOver] = useState<string | null>(null);
  if (!groupField) {
    return <p className="rounded-lg border border-line bg-surface p-4 text-muted">A board groups rows by a Select field. Add a Select field, then choose it in this view’s settings.</p>;
  }
  const groups = groupRows(rows, groupField);
  return (
    <ul className="flex gap-3 overflow-x-auto pb-2" aria-label={`Board grouped by ${groupField.name}`}>
      {groups.map((g) => {
        const key = g.key ?? '__none';
        return (
          <li key={key} className="shrink-0">
          <section
            aria-label={`${g.label}, ${g.rows.length} rows`}
            data-column={key}
            className={cx('flex h-full w-72 flex-col rounded-lg bg-surface-2 p-2', over === key && 'ring-2 ring-accent')}
            onDragOver={(e) => {
              if (!canEdit) return;
              e.preventDefault();
              setOver(key);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null);
              const id = e.dataTransfer.getData('text/monty-row');
              const row = rows.find((r) => r.id === id);
              if (row && (row.values[groupField.id] ?? null) !== g.key) onCell(row, groupField.id, g.key);
            }}
          >
            <h2 className="mb-2 flex items-center justify-between px-1 text-[14px] font-normal">
              <Chip color={g.color}>{g.label}</Chip>
              <span className="text-[12px] text-muted">{g.rows.length}</span>
            </h2>
            <ul className="space-y-2">
              {g.rows.map((r) => (
                <li
                  key={r.id}
                  draggable={canEdit}
                  onDragStart={(e) => e.dataTransfer.setData('text/monty-row', r.id)}
                  className="rounded-lg border border-line bg-surface p-2 shadow-sm"
                >
                  <button className="block w-full truncate text-left font-medium hover:underline" onClick={() => onOpen(r.id)}>
                    {r.title || 'Untitled'}
                  </button>
                  {cardFields.length ? (
                    <div className="mt-1 space-y-1 text-[12px]">
                      {cardFields.map((f) =>
                        r.values[f.id] !== undefined ? (
                          <div key={f.id} className="flex min-w-0 items-center gap-1">
                            <span className="sr-only">{f.name}:</span>
                            <CellValue field={f} value={r.values[f.id]} members={members} />
                          </div>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {canEdit ? (
              <Button variant="ghost" className="mt-2 justify-start" onClick={() => onAddRow(g.key)} aria-label={`New row in ${g.label}`}>
                + New
              </Button>
            ) : null}
          </section>
          </li>
        );
      })}
    </ul>
  );
}
