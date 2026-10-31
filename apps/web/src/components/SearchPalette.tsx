'use client';

import type { SearchResultDto } from '@monty/validation';
import { splitHighlights } from '@monty/domain';
import { useRouter } from 'next/navigation';
import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cx } from './ui';

/** ⌘K / Ctrl+K quick search across everything the user can access. */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResultDto[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api.insights
        .search(q)
        .then((r) => {
          if (cancelled) return;
          setResults(r.results);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  function go(r: SearchResultDto | undefined) {
    if (!r) return;
    onClose();
    setQ('');
    router.push(`/project?id=${r.projectId}${r.taskId ? `&task=${r.taskId}` : ''}`);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-label="Search" className="mx-auto mt-[12vh] w-[min(92vw,620px)] rounded-xl border border-line bg-surface p-0 text-fg backdrop:bg-black/40">
      <input
        autoFocus
        aria-label="Search projects, tasks and comments"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="search-results"
        placeholder="Search projects, tasks and comments…"
        className="h-12 w-full border-b border-line bg-transparent px-4 text-[15px] outline-none"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
      />
      <ul id="search-results" role="listbox" className="max-h-[50vh] overflow-y-auto p-1">
        {q.trim() && !loading && results.length === 0 ? <li className="px-3 py-4 text-muted">No results.</li> : null}
        {results.map((r, i) => (
          <li key={`${r.type}-${r.id}`} role="option" aria-selected={i === active}>
            <button
              className={cx('w-full rounded-lg px-3 py-2 text-left', i === active && 'bg-surface-2')}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
            >
              <span className="flex items-center gap-2">
                <span className="rounded bg-surface-2 px-1 text-[11px] uppercase text-muted">{r.type}</span>
                <span className="truncate font-medium">{r.title}</span>
                <span className="ml-auto shrink-0 text-[12px] text-muted">{r.projectName}</span>
              </span>
              <span className="block truncate text-[12px] text-muted">
                {splitHighlights(r.snippet).map((p, j) => (p.hit ? <mark key={j} className="bg-accent/20 text-fg">{p.text}</mark> : <span key={j}>{p.text}</span>))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-3 py-2 text-[11px] text-muted">↑↓ to move · Enter to open · Esc to close</p>
    </dialog>
  );
}
