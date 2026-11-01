import { describe, expect, it } from 'vitest';
import {
  applyView,
  cellFromText,
  FieldLike,
  groupRows,
  inferFieldType,
  normaliseCell,
  parseCsv,
  parseLooseDate,
  positionBetween,
  RowLike,
  TITLE_FIELD,
  toCsv,
} from '../src/databases';

const status: FieldLike = {
  id: 's',
  name: 'Status',
  type: 'select',
  options: { choices: [{ id: 'todo', label: 'To do', color: 'gray' }, { id: 'doing', label: 'Doing', color: 'blue' }, { id: 'done', label: 'Done', color: 'green' }] },
};
const tags: FieldLike = { id: 't', name: 'Tags', type: 'multi_select', options: { choices: [{ id: 'a', label: 'A', color: 'red' }, { id: 'b', label: 'B', color: 'blue' }] } };
const est: FieldLike = { id: 'n', name: 'Estimate', type: 'number', options: {} };
const due: FieldLike = { id: 'd', name: 'Due', type: 'date', options: {} };
const done: FieldLike = { id: 'c', name: 'Shipped', type: 'checkbox', options: {} };
const notes: FieldLike = { id: 'x', name: 'Notes', type: 'text', options: {} };
const fields = [status, tags, est, due, done, notes];

const row = (id: string, title: string, values: Record<string, unknown>, position: number): RowLike => ({ id, title, values, position });
const rows = [
  row('1', 'Homepage', { s: 'doing', n: 5, d: '2026-11-03', t: ['a'], x: 'hero image' }, 1),
  row('2', 'Pricing page', { s: 'todo', n: 2, d: '2026-11-01' }, 2),
  row('3', 'Blog', { s: 'done', n: 8, c: true, t: ['a', 'b'] }, 3),
  row('4', 'about us', {}, 4),
];
const ids = (rs: RowLike[]) => rs.map((r) => r.id);

describe('normaliseCell', () => {
  it('accepts valid values and normalises them', () => {
    expect(normaliseCell(est, '12.5')).toEqual({ ok: true, value: 12.5 });
    expect(normaliseCell(status, 'done')).toEqual({ ok: true, value: 'done' });
    expect(normaliseCell(tags, ['a', 'a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(normaliseCell(tags, [])).toEqual({ ok: true, value: null });
    expect(normaliseCell(done, false)).toEqual({ ok: true, value: null });
    expect(normaliseCell(due, '2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    expect(normaliseCell(notes, '')).toEqual({ ok: true, value: null });
    expect(normaliseCell({ id: 'u', name: 'Link', type: 'url', options: {} }, ' https://x.test/a ')).toEqual({ ok: true, value: 'https://x.test/a' });
  });

  it('rejects wrong types, unknown options, impossible dates, unsafe links and non-members', () => {
    expect(normaliseCell(est, 'ten').ok).toBe(false);
    expect(normaliseCell(est, Infinity).ok).toBe(false);
    expect(normaliseCell(status, 'nope').ok).toBe(false);
    expect(normaliseCell(tags, ['a', 'zzz']).ok).toBe(false);
    expect(normaliseCell(due, '2026-02-30').ok).toBe(false);
    expect(normaliseCell(due, '03/11/2026').ok).toBe(false);
    expect(normaliseCell({ id: 'u', name: 'Link', type: 'url', options: {} }, 'javascript:alert(1)').ok).toBe(false);
    expect(normaliseCell({ id: 'p', name: 'Owner', type: 'person', options: {} }, ['u1', 'u2'], (id) => id === 'u1').ok).toBe(false);
    expect(normaliseCell(notes, 42).ok).toBe(false);
    expect(normaliseCell({ id: 'q', name: 'Q', type: 'formula', options: {} }, 'x').ok).toBe(false);
  });
});

describe('applyView', () => {
  it('keeps manual order with no config', () => {
    expect(ids(applyView(rows, fields, {}))).toEqual(['1', '2', '3', '4']);
  });

  it('filters by each type and combines with all/any', () => {
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 's', op: 'is', value: 'todo' }] }))).toEqual(['2']);
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 'n', op: 'gt', value: 3 }] }))).toEqual(['1', '3']);
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 'd', op: 'before', value: '2026-11-02' }] }))).toEqual(['2']);
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 'c', op: 'checked' }] }))).toEqual(['3']);
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 't', op: 'has', value: 'b' }] }))).toEqual(['3']);
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: TITLE_FIELD, op: 'contains', value: 'PAGE' }] }))).toEqual(['1', '2']);
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 's', op: 'is_empty' }] }))).toEqual(['4']);
    const both = [{ fieldId: 's', op: 'is' as const, value: 'todo' }, { fieldId: 'c', op: 'checked' as const }];
    expect(ids(applyView(rows, fields, { filters: both }))).toEqual([]);
    expect(ids(applyView(rows, fields, { filters: both, match: 'any' }))).toEqual(['2', '3']);
  });

  it('ignores filters on deleted fields, mismatched operators and incomplete values', () => {
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 'gone', op: 'is', value: 'x' }] }))).toHaveLength(4);
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 'c', op: 'gt', value: 1 }] }))).toHaveLength(4);
    expect(ids(applyView(rows, fields, { filters: [{ fieldId: 'x', op: 'contains', value: '' }] }))).toHaveLength(4);
  });

  it('sorts by number, date, select option order and title; empties last in both directions', () => {
    expect(ids(applyView(rows, fields, { sorts: [{ fieldId: 'n', dir: 'desc' }] }))).toEqual(['3', '1', '2', '4']);
    expect(ids(applyView(rows, fields, { sorts: [{ fieldId: 'd', dir: 'asc' }] }))).toEqual(['2', '1', '3', '4']);
    expect(ids(applyView(rows, fields, { sorts: [{ fieldId: 's', dir: 'asc' }] }))).toEqual(['2', '1', '3', '4']);
    expect(ids(applyView(rows, fields, { sorts: [{ fieldId: TITLE_FIELD, dir: 'asc' }] }))).toEqual(['4', '3', '1', '2']);
  });

  it('quick search covers the title and text fields', () => {
    expect(ids(applyView(rows, fields, { search: 'hero' }))).toEqual(['1']);
    expect(ids(applyView(rows, fields, { search: 'blog' }))).toEqual(['3']);
  });
});

describe('groupRows', () => {
  it('makes a column per option plus "No value"', () => {
    const g = groupRows(rows, status);
    expect(g.map((x) => [x.key, x.rows.map((r) => r.id)])).toEqual([[null, ['4']], ['todo', ['2']], ['doing', ['1']], ['done', ['3']]]);
    expect(g[0]!.label).toBe('No Status');
  });
});

describe('positionBetween', () => {
  it('places items between neighbours', () => {
    expect(positionBetween(null, null)).toBe(1024);
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(null, 10)).toBeLessThan(10);
    expect(positionBetween(10, null)).toBeGreaterThan(10);
  });
});

describe('CSV', () => {
  it('parses quotes, escaped quotes, newlines in cells, CRLF and a BOM', () => {
    const text = '﻿Name,Notes\r\n"Smith, J","said ""hi""\nthen left"\r\nPlain,\r\n\r\n';
    expect(parseCsv(text)).toEqual([['Name', 'Notes'], ['Smith, J', 'said "hi"\nthen left'], ['Plain', '']]);
  });

  it('round-trips and neutralises formulas', () => {
    const out = toCsv([['a,b', 'q"q'], ['=SUM(A1)', 'ok']]);
    expect(out).toBe('"a,b","q""q"\r\n\'=SUM(A1),ok\r\n');
    expect(parseCsv(out)).toEqual([['a,b', 'q"q'], ["'=SUM(A1)", 'ok']]);
  });

  it('infers field types from a column', () => {
    expect(inferFieldType(['1', '2.5', ''])).toEqual({ type: 'number' });
    expect(inferFieldType(['Yes', 'No'])).toEqual({ type: 'checkbox' });
    expect(inferFieldType(['2026-01-02', 'March 4, 2026'])).toEqual({ type: 'date' });
    expect(inferFieldType(['https://a.test', 'https://b.test'])).toEqual({ type: 'url' });
    expect(inferFieldType(['Done', 'To do', 'Done', 'Done'])).toEqual({ type: 'select', choices: ['Done', 'To do'] });
    expect(inferFieldType(['A, B', 'B', 'C, A'])).toEqual({ type: 'multi_select', choices: ['A', 'B', 'C'] });
    expect(inferFieldType(['one thing', 'another'])).toEqual({ type: 'text' });
  });

  it('reads Notion-style dates', () => {
    expect(parseLooseDate('November 3, 2026')).toBe('2026-11-03');
    expect(parseLooseDate('February 30, 2026')).toBeNull();
    expect(parseLooseDate('soon')).toBeNull();
  });
});

describe('cellFromText', () => {
  it('maps imported text onto each field type', () => {
    expect(cellFromText(est, '1,250.5')).toBe(1250.5);
    expect(cellFromText(done, 'Yes')).toBe(true);
    expect(cellFromText(due, 'November 3, 2026')).toBe('2026-11-03');
    expect(cellFromText(status, 'doing')).toBe('doing');
    expect(cellFromText(status, 'Unknown')).toBeNull();
    expect(cellFromText(tags, 'A, b, z')).toEqual(['a', 'b']);
    expect(cellFromText(notes, '  hi ')).toBe('hi');
    expect(cellFromText(notes, '')).toBeNull();
  });
});
