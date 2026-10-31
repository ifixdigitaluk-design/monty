import { describe, expect, it } from 'vitest';
import { headings, parseInline, parseMarkdown } from '../src';

describe('parseMarkdown', () => {
  it('parses headings, paragraphs, lists, checklists, quotes, code and rules', () => {
    const doc = parseMarkdown(
      ['# Title', '', 'Some **bold** and *em* text', 'continues here.', '', '- one', '- [x] done', '- [ ] todo', '', '1. first', '2. second', '', '> quoted', '', '```ts', 'const a = 1 < 2;', '```', '---'].join('\n'),
    );
    expect(doc.map((b) => b.t)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'hr']);
    expect(doc[1]).toEqual({
      t: 'paragraph',
      c: [{ t: 'text', v: 'Some ' }, { t: 'strong', c: [{ t: 'text', v: 'bold' }] }, { t: 'text', v: ' and ' }, { t: 'em', c: [{ t: 'text', v: 'em' }] }, { t: 'text', v: ' text continues here.' }],
    });
    expect(doc[2]).toMatchObject({ ordered: false, items: [{ checked: null }, { checked: true }, { checked: false }] });
    expect(doc[3]).toMatchObject({ ordered: true });
    expect(doc[5]).toEqual({ t: 'code', lang: 'ts', v: 'const a = 1 < 2;' });
    expect(headings(doc)).toEqual([{ level: 1, text: 'Title' }]);
  });

  it('never produces unsafe links and keeps raw HTML as text', () => {
    expect(JSON.stringify(parseInline('[x](javascript:alert(1))'))).not.toContain('link');
    expect(JSON.stringify(parseInline('[x](JavaScript:alert`1`)'))).not.toContain('link');
    expect(parseInline('[x](data:text/html,hi)')).toEqual([{ t: 'text', v: 'x' }]);
    expect(parseInline('[site](https://example.com)')).toEqual([{ t: 'link', href: 'https://example.com', c: [{ t: 'text', v: 'site' }] }]);
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([{ t: 'paragraph', c: [{ t: 'text', v: '<script>alert(1)</script>' }] }]);
  });
});
