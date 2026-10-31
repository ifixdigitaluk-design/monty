import { describe, expect, it } from 'vitest';
import { followUpState, formatMoney, nextQuoteNumber, parseMoney, pipelineSummary, quoteTotals, winRate } from '../src/crm';

describe('quoteTotals', () => {
  it('rounds per line and adds tax per line', () => {
    const t = quoteTotals([
      { description: 'Design', quantity: 1.5, unitPrice: 8333, taxRate: 20 }, // 12499.5 → 12500 net; tax 2500
      { description: 'Hosting', quantity: 12, unitPrice: 999, taxRate: 0 },
      { description: 'Discount', quantity: 1, unitPrice: -1000, taxRate: 20 },
    ]);
    expect(t.lines).toEqual([{ net: 12500, tax: 2500 }, { net: 11988, tax: 0 }, { net: -1000, tax: -200 }]);
    expect(t).toMatchObject({ subtotal: 23488, tax: 2300, total: 25788 });
    expect(quoteTotals([])).toMatchObject({ subtotal: 0, tax: 0, total: 0 });
  });
});

describe('pipelineSummary', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  it('sums per stage and currency, weights open deals and counts this month\'s wins', () => {
    const s = pipelineSummary(
      [
        { stage: 'lead', value: 10000, currency: 'GBP' },
        { stage: 'proposal', value: 20000, currency: 'GBP' },
        { stage: 'won', value: 5000, currency: 'GBP', closedAt: '2026-10-02T09:00:00Z' },
        { stage: 'won', value: 7000, currency: 'GBP', closedAt: '2026-09-30T09:00:00Z' },
        { stage: 'lost', value: 999, currency: 'GBP' },
        { stage: 'negotiation', value: 4000, currency: 'USD' },
      ],
      now,
    );
    expect(s.map((x) => x.currency)).toEqual(['GBP', 'USD']);
    expect(s[0]).toMatchObject({ openValue: 30000, weighted: 1000 + 10000, wonThisMonth: 5000 });
    expect(s[0]!.stages.won).toEqual({ count: 2, value: 12000 });
    expect(s[1]).toMatchObject({ openValue: 4000, weighted: 3000 });
  });
  it('win rate', () => {
    expect(winRate([{ stage: 'won', value: 1, currency: 'GBP' }, { stage: 'lost', value: 1, currency: 'GBP' }, { stage: 'won', value: 1, currency: 'GBP' }])).toBeCloseTo(2 / 3);
    expect(winRate([{ stage: 'lead', value: 1, currency: 'GBP' }])).toBeNull();
  });
});

describe('money and numbering', () => {
  it('formats and parses minor units', () => {
    expect(formatMoney(123456, 'GBP', 'en-GB')).toBe('£1,234.56');
    expect(formatMoney(5000, 'JPY', 'en-GB')).toBe('JP¥5,000');
    expect(parseMoney('1,234.5')).toBe(123450);
    expect(parseMoney('£12')).toBe(1200);
    expect(parseMoney('-3.05')).toBe(-305);
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
  it('numbers quotes sequentially', () => {
    expect(nextQuoteNumber([])).toBe('Q-0001');
    expect(nextQuoteNumber(['Q-0009', 'Q-0002', 'junk'])).toBe('Q-0010');
  });
  it('classifies follow-ups', () => {
    const now = new Date('2026-10-20T12:00:00');
    expect(followUpState({ dueAt: '2026-10-19T09:00:00', doneAt: null }, now)).toBe('overdue');
    expect(followUpState({ dueAt: '2026-10-20T08:00:00', doneAt: null }, now)).toBe('today');
    expect(followUpState({ dueAt: '2026-10-22T08:00:00', doneAt: null }, now)).toBe('upcoming');
    expect(followUpState({ dueAt: '2026-10-19T09:00:00', doneAt: '2026-10-19T10:00:00' }, now)).toBe('done');
    expect(followUpState({ dueAt: null, doneAt: null }, now)).toBe('none');
  });
});
