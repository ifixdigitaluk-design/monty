import { Block, Inline, parseMarkdown } from '@monty/editor';
import { Fragment, ReactNode } from 'react';

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>;
      case 'strong':
        return <strong key={i}>{inline(n.c)}</strong>;
      case 'em':
        return <em key={i}>{inline(n.c)}</em>;
      case 'code':
        return <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.9em]">{n.v}</code>;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline">
            {inline(n.c)}
          </a>
        );
    }
  });
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'heading': {
      const cls = ['', 'text-2xl font-semibold mt-6 mb-2', 'text-xl font-semibold mt-5 mb-2', 'text-lg font-semibold mt-4 mb-1'][b.level];
      const H = (`h${b.level + 1}` as 'h2' | 'h3' | 'h4'); // page title is the h1
      return <H key={i} className={cls}>{inline(b.c)}</H>;
    }
    case 'paragraph':
      return <p key={i} className="my-2 leading-relaxed">{inline(b.c)}</p>;
    case 'quote':
      return <blockquote key={i} className="my-2 border-l-2 border-line pl-3 text-muted">{inline(b.c)}</blockquote>;
    case 'code':
      return <pre key={i} className="my-2 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[13px]"><code>{b.v}</code></pre>;
    case 'hr':
      return <hr key={i} className="my-4 border-line" />;
    case 'list': {
      const L = b.ordered ? 'ol' : 'ul';
      return (
        <L key={i} className={b.ordered ? 'my-2 list-decimal pl-6' : 'my-2 list-disc pl-6'}>
          {b.items.map((it, j) => (
            <li key={j} className={it.checked !== null ? 'list-none -ml-5' : undefined}>
              {it.checked !== null ? <input type="checkbox" checked={it.checked} readOnly disabled className="mr-2 align-middle" aria-label={it.checked ? 'done' : 'not done'} /> : null}
              {inline(it.c)}
            </li>
          ))}
        </L>
      );
    }
  }
}

/** Renders Markdown as React elements only (no dangerouslySetInnerHTML). */
export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return <p className="text-muted">This page is empty.</p>;
  return <div className="text-[15px]">{blocks.map(block)}</div>;
}
