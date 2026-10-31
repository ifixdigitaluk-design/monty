'use client';

import type { AttachmentDto } from '@monty/validation';
import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, useToast } from './ui';

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A file chip: image thumbnail or file name, opening/downloading through the permission-checked API. */
export function AttachmentChip({ a, onRemove }: { a: AttachmentDto; onRemove?: () => void }) {
  const isImage = a.inline && a.contentType.startsWith('image/');
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1 text-[13px]">
      {isImage ? (
        <a href={`${a.url}?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={`Open image ${a.filename}`}>
          <img src={`${a.url}?inline=1`} alt={a.filename} className="h-16 max-w-40 rounded object-cover" loading="lazy" />
        </a>
      ) : null}
      <a className="truncate text-accent hover:underline" href={a.inline ? `${a.url}?inline=1` : a.url} {...(a.inline ? { target: '_blank', rel: 'noopener noreferrer' } : { download: a.filename })}>
        📎 {a.filename}
      </a>
      <span className="shrink-0 text-[12px] text-muted">{formatBytes(a.sizeBytes)}</span>
      {onRemove ? (
        <button type="button" className="shrink-0 text-muted hover:text-danger" aria-label={`Remove ${a.filename}`} onClick={onRemove}>✕</button>
      ) : null}
    </span>
  );
}

/** Files attached to a task or document: list, upload (button or drop), delete. */
export function Attachments({ targetType, targetId, canEdit, meId, isAdmin }: { targetType: 'task' | 'document'; targetId: string; canEdit: boolean; meId: string; isAdmin: boolean }) {
  const toast = useToast();
  const [items, setItems] = useState<AttachmentDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setItems((targetType === 'task' ? await api.files.forTask(targetId) : await api.files.forDocument(targetId)).attachments);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }, [targetType, targetId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  async function uploadFiles(files: FileList | File[]) {
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const a = await api.files.upload(targetType, targetId, f);
        setItems((all) => [...(all ?? []), a]);
      }
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  async function remove(a: AttachmentDto) {
    if (!window.confirm(`Delete ${a.filename}?`)) return;
    try {
      await api.files.remove(a.id);
      setItems((all) => all?.filter((x) => x.id !== a.id) ?? null);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  return (
    <section
      aria-labelledby={`files-${targetId}`}
      onDragOver={(e) => canEdit && e.preventDefault()}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
      }}
    >
      <div className="mb-1 flex items-center justify-between">
        <h3 id={`files-${targetId}`} className="font-medium">Files {items?.length ? `(${items.length})` : ''}</h3>
        {canEdit ? (
          <>
            <input ref={input} type="file" multiple className="sr-only" id={`file-input-${targetId}`} onChange={(e: ChangeEvent<HTMLInputElement>) => e.target.files && void uploadFiles(e.target.files)} />
            <Button busy={busy} onClick={() => input.current?.click()}>Attach files</Button>
          </>
        ) : null}
      </div>
      {items && items.length === 0 ? <p className="text-[13px] text-muted">{canEdit ? 'No files yet. Attach or drop files here.' : 'No files.'}</p> : null}
      <ul className="flex flex-wrap gap-2" aria-label="Attached files">
        {items?.map((a) => (
          <li key={a.id}>
            <AttachmentChip a={a} onRemove={canEdit && (a.uploaderId === meId || isAdmin) ? () => void remove(a) : undefined} />
          </li>
        ))}
      </ul>
    </section>
  );
}
