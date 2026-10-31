'use client';

import type { DatabaseFieldDto, DatabaseRowDto } from '@monty/validation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { Markdown } from '../Markdown';
import { Button, cx, Spinner, Textarea, useToast } from '../ui';
import { Cell, FIELD_TYPE_LABEL, Member } from './Cell';

type Save = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';

/** A row opened as a page: every property, plus a Markdown page that autosaves (with conflict protection). */
export function RowDrawer({
  rowId,
  fields,
  members,
  canEdit,
  onCell,
  onTitle,
  onDelete,
  onClose,
}: {
  rowId: string;
  fields: DatabaseFieldDto[];
  members: Member[];
  canEdit: boolean;
  onCell: (row: DatabaseRowDto, fieldId: string, value: unknown) => void;
  onTitle: (row: DatabaseRowDto, title: string) => void;
  onDelete: (row: DatabaseRowDto) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [row, setRow] = useState<DatabaseRowDto | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<'write' | 'preview'>('preview');
  const [save, setSave] = useState<Save>('idle');
  const version = useRef(0);
  const latest = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const { row: r } = await api.databases.getRow(rowId);
      setRow(r);
      setTitle(r.title);
      setBody(r.body ?? '');
      latest.current = r.body ?? '';
      version.current = r.bodyVersion;
      setMode(canEdit && !(r.body ?? '').trim() ? 'write' : 'preview');
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      onClose();
    }
  }, [rowId, canEdit, toast, onClose]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setSave('saving');
    try {
      const { row: r } = await api.databases.updateRow(rowId, { body: latest.current, expectedVersion: version.current });
      version.current = r.bodyVersion;
      setRow((prev) => (prev ? { ...prev, bodyVersion: r.bodyVersion, updatedAt: r.updatedAt, updatedBy: r.updatedBy } : r));
      setSave('saved');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setSave('conflict');
      else {
        setSave('error');
        toast({ tone: 'error', message: errorMessage(err) });
      }
    }
  }, [rowId, toast]);

  // Never lose typing when the drawer closes or the tab is left.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (timer.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      if (timer.current) void flush();
    };
  }, [flush]);

  function editBody(next: string) {
    latest.current = next;
    setBody(next);
    setSave('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 1000);
  }

  // Property edits go through the page so the table updates too. They don't affect the page body's version.
  function cell(fieldId: string, value: unknown) {
    if (!row) return;
    onCell(row, fieldId, value);
    setRow({ ...row, values: { ...row.values, [fieldId]: value } });
  }

  const label = { idle: '', dirty: 'Unsaved changes…', saving: 'Saving…', saved: 'All changes saved', error: 'Not saved — retrying on next edit', conflict: '' }[save];

  return (
    <div role="dialog" aria-label={`Row: ${row?.title || 'Untitled'}`} className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-xl">
      <div className="flex h-12 items-center justify-between border-b border-line px-4">
        <span aria-live="polite" className="flex items-center gap-1 text-[12px] text-muted" data-row-save={save}>
          {save === 'saving' ? <Spinner /> : null}
          {label}
        </span>
        <Button variant="ghost" aria-label="Close row" onClick={onClose}>
          ✕
        </Button>
      </div>
      {!row ? (
        <div className="p-6"><Spinner /></div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {save === 'conflict' ? (
            <div role="alert" className="rounded-lg border border-line bg-surface-2 p-3 text-[13px]">
              Someone else changed this page. Your text is still here — copy anything you need, then reload their version.
              <div className="mt-2 flex gap-2">
                <Button onClick={() => void navigator.clipboard?.writeText(latest.current)}>Copy my text</Button>
                <Button variant="primary" onClick={() => { setSave('idle'); void load(); }}>Load latest</Button>
              </div>
            </div>
          ) : null}
          <input
            aria-label="Row name"
            className="w-full bg-transparent text-2xl font-semibold outline-none"
            placeholder="Untitled"
            value={title}
            disabled={!canEdit}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title !== row.title) {
                onTitle(row, title);
                setRow({ ...row, title });
              }
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <dl className="grid grid-cols-[minmax(7rem,10rem)_1fr] items-center gap-x-3 gap-y-1">
            {fields.map((f) => (
              <div key={f.id} className="contents">
                <dt className="truncate text-[13px] text-muted" title={FIELD_TYPE_LABEL[f.type]}>{f.name}</dt>
                <dd className="min-w-0">
                  <Cell field={f} value={row.values[f.id] ?? null} rowTitle={row.title} members={members} canEdit={canEdit} onSave={(v) => cell(f.id, v)} />
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-[12px] text-muted">
            Created by {row.createdBy.name} · last edited by {row.updatedBy.name}, {new Date(row.updatedAt).toLocaleString()}
          </p>
          <hr className="border-line" />
          <div className="flex items-center gap-2">
            <div role="tablist" aria-label="Page mode" className="inline-flex rounded-lg border border-line p-0.5">
              {(['write', 'preview'] as const).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} disabled={m === 'write' && !canEdit} onClick={() => setMode(m)} className={cx('rounded-md px-3 py-1 text-[13px] capitalize', mode === m ? 'bg-surface-2 font-medium' : 'text-muted')}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          {mode === 'write' && canEdit ? (
            <Textarea
              aria-label="Row page (Markdown)"
              className="min-h-[35vh] font-mono text-[14px]"
              placeholder="Notes, meeting minutes, a brief… Markdown works."
              value={body}
              onChange={(e) => editBody(e.target.value)}
              onBlur={() => timer.current && void flush()}
            />
          ) : body.trim() ? (
            <div className="prose-sm"><Markdown source={body} /></div>
          ) : (
            <p className="text-[13px] text-muted">This page is empty.</p>
          )}
        </div>
      )}
      {canEdit && row ? (
        <div className="flex justify-end border-t border-line p-3">
          <Button
            variant="danger"
            onClick={() => {
              if (window.confirm(`Delete “${row.title || 'Untitled'}”?`)) onDelete(row);
            }}
          >
            Delete row
          </Button>
        </div>
      ) : null}
    </div>
  );
}
