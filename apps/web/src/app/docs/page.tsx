'use client';

import type { DocumentDto, DocumentSummaryDto, DocumentVersionDto } from '@monty/validation';
import { canInWorkspace } from '@monty/domain';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Markdown } from '@/components/Markdown';
import { Button, cx, EmptyState, ErrorBanner, PageLoading, Spinner, Textarea, useToast } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function DocsPage() {
  return (
    <AppShell>
      <Docs />
    </AppShell>
  );
}

function tree(docs: DocumentSummaryDto[], parent: string | null, depth = 0): { doc: DocumentSummaryDto; depth: number }[] {
  return docs
    .filter((d) => d.parentId === parent)
    .flatMap((d) => [{ doc: d, depth }, ...tree(docs, d.id, depth + 1)]);
}

function Docs() {
  const params = useSearchParams();
  const ws = params.get('ws') ?? '';
  const docId = params.get('id');
  const router = useRouter();
  const toast = useToast();
  const { organisations } = useSession();
  const workspace = organisations.flatMap((o) => o.workspaces).find((w) => w.id === ws);
  const [docs, setDocs] = useState<DocumentSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    if (!ws) return;
    try {
      setDocs((await api.documents.list(ws)).documents);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [ws]);
  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function newPage(parentId: string | null) {
    try {
      const { document } = await api.documents.create(ws, { id: crypto.randomUUID(), title: 'Untitled', parentId });
      await loadList();
      router.push(`/docs?ws=${ws}&id=${document.id}`);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  if (!workspace) return <div className="p-8"><ErrorBanner message="Workspace not found." /></div>;
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={loadList} /></div>;
  if (!docs) return <PageLoading />;
  const canEdit = canInWorkspace(workspace.role, 'task.update');

  return (
    <div className="flex min-h-[calc(100vh-3rem)] flex-col md:min-h-screen md:flex-row">
      <nav aria-label="Pages" className="border-b border-line p-3 md:w-64 md:border-b-0 md:border-r">
        <div className="mb-2 flex items-center justify-between">
          <Link href={`/workspace?id=${ws}`} className="text-[12px] font-medium uppercase tracking-wide text-muted hover:underline">{workspace.name} docs</Link>
          {canEdit ? <Button variant="ghost" aria-label="New page" onClick={() => void newPage(null)}>+</Button> : null}
        </div>
        {docs.length === 0 ? <p className="text-[13px] text-muted">No pages yet.</p> : null}
        <ul>
          {tree(docs, null).map(({ doc, depth }) => (
            <li key={doc.id}>
              <Link
                href={`/docs?ws=${ws}&id=${doc.id}`}
                aria-current={doc.id === docId ? 'page' : undefined}
                style={{ paddingLeft: 8 + depth * 14 }}
                className={cx('block truncate rounded-md py-1 pr-2 hover:bg-surface-2', doc.id === docId && 'bg-surface-2 font-medium')}
              >
                {doc.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        {docId ? (
          <Editor key={docId} id={docId} onChanged={loadList} onNewChild={() => void newPage(docId)} onDeleted={() => { void loadList(); router.push(`/docs?ws=${ws}`); }} />
        ) : (
          <div className="p-8">
            <EmptyState
              title="Documents"
              body="Write specs, notes and wikis next to your projects. Pages can be nested and every edit is kept in history."
              action={canEdit ? <Button variant="primary" onClick={() => void newPage(null)}>New page</Button> : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}

type Save = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

function Editor({ id, onChanged, onNewChild, onDeleted }: { id: string; onChanged: () => void; onNewChild: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [doc, setDoc] = useState<DocumentDto | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<'write' | 'preview'>('preview');
  const [save, setSave] = useState<Save>('idle');
  const [history, setHistory] = useState<DocumentVersionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ title: '', body: '' });

  useEffect(() => {
    api.documents
      .get(id)
      .then(({ document }) => {
        setDoc(document);
        setTitle(document.title);
        setBody(document.body);
        latest.current = { title: document.title, body: document.body };
        version.current = document.version;
        if (!document.body && canInWorkspace(document.role, 'task.update')) setMode('write');
      })
      .catch((err) => setError(errorMessage(err)));
  }, [id]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (saving.current) await saving.current; // one write at a time, always with the latest version
    const { title: t, body: b } = latest.current;
    saving.current = (async () => {
      setSave('saving');
      try {
        const { document } = await api.documents.update(id, { expectedVersion: version.current, title: t.trim() || 'Untitled', body: b });
        version.current = document.version;
        setDoc(document);
        setSave(latest.current.title === t && latest.current.body === b ? 'saved' : 'dirty');
        if (t !== doc?.title) onChanged();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
          setSave('conflict');
        } else {
          setSave('error');
          toast({ tone: 'error', message: errorMessage(err) });
        }
      } finally {
        saving.current = null;
      }
    })();
    await saving.current;
  }, [id, doc?.title, onChanged, toast]);

  function edit(next: { title?: string; body?: string }) {
    latest.current = { ...latest.current, ...next };
    if (next.title !== undefined) setTitle(next.title);
    if (next.body !== undefined) setBody(next.body);
    setSave('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 1200);
  }

  // Never lose typing when leaving the page.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (timer.current || saving.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  function insert(prefix: string) {
    edit({ body: `${latest.current.body}${latest.current.body && !latest.current.body.endsWith('\n') ? '\n' : ''}${prefix}` });
    setMode('write');
  }

  if (error) return <div className="p-8"><ErrorBanner message={error} /></div>;
  if (!doc) return <PageLoading />;
  const canEdit = canInWorkspace(doc.role, 'task.update');
  const label = { idle: '', dirty: 'Unsaved changes…', saving: 'Saving…', saved: 'All changes saved', error: 'Not saved — retrying on next edit', conflict: '' }[save];

  return (
    <article className="mx-auto max-w-3xl p-6">
      {save === 'conflict' ? (
        <div role="alert" className="mb-4 rounded-lg border border-line bg-surface p-3 text-[13px]">
          Someone else changed this page. Your text is still here — copy anything you need, then reload to see their version.
          <div className="mt-2 flex gap-2">
            <Button onClick={() => void navigator.clipboard?.writeText(latest.current.body)}>Copy my text</Button>
            <Button variant="primary" onClick={() => window.location.reload()}>Reload latest</Button>
          </div>
        </div>
      ) : null}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span>
          Last edited by {doc.updatedBy.name} · {new Date(doc.updatedAt).toLocaleString()}
        </span>
        <span aria-live="polite" data-doc-save={save} className="flex items-center gap-1">
          {save === 'saving' ? <Spinner /> : null}
          {label}
        </span>
      </div>
      <h1 className="sr-only">{title}</h1>
      <input
        aria-label="Page title"
        className="mb-3 w-full bg-transparent text-3xl font-semibold outline-none"
        value={title}
        disabled={!canEdit}
        onChange={(e) => edit({ title: e.target.value })}
      />
      <div className="mb-3 flex flex-wrap items-center gap-1">
        <div role="tablist" aria-label="Editor mode" className="inline-flex rounded-lg border border-line p-0.5">
          {(['write', 'preview'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} disabled={m === 'write' && !canEdit} onClick={() => setMode(m)} className={cx('rounded-md px-3 py-1 text-[13px] capitalize', mode === m ? 'bg-surface-2 font-medium' : 'text-muted')}>
              {m}
            </button>
          ))}
        </div>
        {canEdit ? (
          <>
            <Button variant="ghost" onClick={() => insert('## ')}>Heading</Button>
            <Button variant="ghost" onClick={() => insert('- ')}>List</Button>
            <Button variant="ghost" onClick={() => insert('- [ ] ')}>Checklist</Button>
            <Button variant="ghost" onClick={() => insert('```\n\n```\n')}>Code</Button>
            <Button variant="ghost" onClick={onNewChild}>+ Sub-page</Button>
          </>
        ) : null}
        <Button variant="ghost" onClick={() => void api.documents.versions(id).then((r) => setHistory(r.versions))}>History</Button>
        {canEdit ? (
          <Button
            variant="ghost"
            className="text-danger"
            onClick={async () => {
              if (!window.confirm('Delete this page and its sub-pages?')) return;
              await api.documents.remove(id).then(onDeleted, (err) => toast({ tone: 'error', message: errorMessage(err) }));
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>
      {mode === 'write' && canEdit ? (
        <Textarea
          aria-label="Page content (Markdown)"
          className="min-h-[50vh] font-mono text-[14px]"
          value={body}
          onChange={(e) => edit({ body: e.target.value })}
          onBlur={() => timer.current && void flush()}
          placeholder="Write in Markdown: # Heading, - list, - [ ] checklist, **bold**, [link](https://…)"
        />
      ) : (
        <div className="min-h-[30vh]" data-doc-preview>
          <Markdown source={body} />
        </div>
      )}
      {history ? (
        <section aria-labelledby="history-title" className="mt-6 rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="history-title" className="font-semibold">History</h2>
            <Button variant="ghost" onClick={() => setHistory(null)}>Close</Button>
          </div>
          <ul className="divide-y divide-line text-[13px]">
            {history.map((v, i) => (
              <li key={v.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  v{v.version} · {v.author.name} · {new Date(v.updatedAt).toLocaleString()} {i === 0 ? <span className="text-muted">(current)</span> : null}
                </span>
                {i > 0 && canEdit ? (
                  <Button
                    onClick={async () => {
                      if (timer.current || saving.current) await flush();
                      const { document } = await api.documents.restore(id, v.id);
                      version.current = document.version;
                      latest.current = { title: document.title, body: document.body };
                      setDoc(document);
                      setTitle(document.title);
                      setBody(document.body);
                      setHistory((await api.documents.versions(id)).versions);
                      toast({ tone: 'success', message: `Restored version ${v.version}.` });
                    }}
                  >
                    Restore
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
