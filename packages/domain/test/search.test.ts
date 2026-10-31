import { describe, expect, it } from 'vitest';
import { splitHighlights, toPrefixTsQuery } from '../src/search';

describe('toPrefixTsQuery', () => {
  it('builds prefix terms and strips operators', () => {
    expect(toPrefixTsQuery('Design home')).toBe('design:* & home:*');
    expect(toPrefixTsQuery("a' | b & !c:*")).toBe('a:* & b:* & c:*');
    expect(toPrefixTsQuery('Café 2030')).toBe('café:* & 2030:*');
    expect(toPrefixTsQuery('  !!  ')).toBeNull();
  });
});

describe('splitHighlights', () => {
  it('splits marked snippets', () => {
    expect(splitHighlights('the [[design]] doc')).toEqual([
      { text: 'the ', hit: false },
      { text: 'design', hit: true },
      { text: ' doc', hit: false },
    ]);
  });
});
