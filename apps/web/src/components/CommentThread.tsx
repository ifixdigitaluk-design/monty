'use client';

import type { CommentDto, MemberDto } from '@monty/validation';
import { FormEvent, Fragment, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Select, Textarea, useToast } from './ui';

const TOKEN = /<@([0-9a-f-]{36})>/gi;

/** Renders mention tokens as @Name using React text nodes (never HTML). */
export function renderBody(body: string, members: MemberDto[]): ReactNode {
  const names = new Map(members.map((m) => [m.id, m.name]));
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    parts.push(body.slice(last, m.index));
    parts.push(
      <span key={m.index} className="rounded bg-surface-2 px-1 font-medium text-accent">
        @{names.get(m[1]!.toLowerCase()) ?? 'someone'}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  parts.push(body.slice(last));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

export function CommentThread({
  target,
  members,
  canPost,
  canModerate,
  label,
}: {
  target: { projectId: string } | { taskId: string };
  members: MemberDto[];
  canPost: boolean;
  canModerate: boolean;
  label: string;
}) {
  const { user } = useSession();
  const toast = useToast();
  const [comments, setComments] = useState<CommentDto[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const clientId = useRef(crypto.randomUUID());
  const key = 'taskId' in target ? target.taskId : target.projectId;

  const load = useCallback(async () => {
    try {
      setComments((await api.comments.list(target)).comments);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const { comment } = await api.comments.create(target, body.trim(), clientId.current);
      setComments((all) => [...(all ?? []), comment]);
      setBody('');
      clientId.current = crypto.randomUUID();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) }); // text is kept; retry reuses the same id (no duplicates)
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: CommentDto) {
    try {
      await api.comments.remove(c.id);
      setComments((all) => all?.filter((x) => x.id !== c.id) ?? null);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  return (
    <section aria-label={label} className="space-y-2">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      {comments === null ? null : comments.length === 0 ? (
        <p className="text-[13px] text-muted">No comments yet.</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-lg bg-surface-2 px-3 py-2" data-comment>
              <div className="flex items-center justify-between gap-2 text-[12px] text-muted">
                <span>
                  <span className="font-medium text-fg">{c.author.name}</span> · {new Date(c.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                </span>
                {c.author.id === user.id || canModerate ? (
                  <button className="hover:text-danger" aria-label="Delete comment" onClick={() => void remove(c)}>
                    Delete
                  </button>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap text-[13px]">{renderBody(c.body, members)}</p>
            </li>
          ))}
        </ul>
      )}
      {canPost ? (
        <form onSubmit={submit} className="space-y-2">
          <Textarea aria-label={`Write a comment (${label})`} rows={2} placeholder="Write a comment…" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex items-center justify-between gap-2">
            <Select
              aria-label="Mention someone"
              value=""
              onChange={(e) => {
                if (e.target.value) setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}<@${e.target.value}> `);
              }}
            >
              <option value="">@ Mention…</option>
              {members.filter((m) => m.id !== user.id).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="primary" busy={busy} disabled={!body.trim()}>
              Comment
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
