/**
 * Minimal, safe Markdown parser for Monty documents.
 * Produces a small AST that the UI renders with React elements — no HTML strings, so document
 * content can never inject markup or scripts. Links are limited to http(s) and mailto.
 */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: { checked: boolean | null; c: Inline[] }[] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'hr' };

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push({ t: 'code', v: m[1]! });
    } else if ((m = rest.match(/^\*\*(.+?)\*\*/))) {
      flush();
      out.push({ t: 'strong', c: parseInline(m[1]!) });
    } else if ((m = rest.match(/^\*(?!\s)(.+?)\*/)) || (m = rest.match(/^_(?!\s)(.+?)_/))) {
      flush();
      out.push({ t: 'em', c: parseInline(m[1]!) });
    } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush();
      if (SAFE_URL.test(m[2]!)) out.push({ t: 'link', href: m[2]!, c: parseInline(m[1]!) });
      else out.push({ t: 'text', v: m[1]! }); // unsafe scheme (javascript:, data:, …): keep the text, drop the link
    } else {
      buf += src[i];
      i += 1;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'paragraph', c: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^```\s*([\w-]*)\s*$/))) {
      endPara();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      blocks.push({ t: 'code', lang: m[1] ?? '', v: code.join('\n') });
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      endPara();
      blocks.push({ t: 'heading', level: m[1]!.length as 1 | 2 | 3, c: parseInline(m[2]!.trim()) });
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      endPara();
      blocks.push({ t: 'hr' });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      endPara();
      const q = [m[1]!];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]!)) q.push(lines[++i]!.replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseInline(q.join(' ')) });
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      endPara();
      const ordered = /^\s*\d+\./.test(line);
      const items: { checked: boolean | null; c: Inline[] }[] = [];
      let j = i;
      while (j < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[j]!)) {
        const text = lines[j]!.replace(/^\s*([-*]|\d+\.)\s+/, '');
        const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
        items.push(task ? { checked: task[1] !== ' ', c: parseInline(task[2]!) } : { checked: null, c: parseInline(text) });
        j += 1;
      }
      i = j - 1;
      blocks.push({ t: 'list', ordered, items });
    } else if (line.trim() === '') {
      endPara();
    } else {
      para.push(line.trim());
    }
  }
  endPara();
  return blocks;
}

/** Plain-text outline of headings (for a table of contents). */
export function headings(blocks: Block[]): { level: number; text: string }[] {
  const text = (c: Inline[]): string => c.map((n) => ('v' in n ? n.v : text(n.c))).join('');
  return blocks.filter((b): b is Extract<Block, { t: 'heading' }> => b.t === 'heading').map((b) => ({ level: b.level, text: text(b.c) }));
}
