/**
 * CRM rules shared by the API and the web app. Money is always integer minor units (pence/cents) so totals never drift.
 */

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const OPEN_STAGES: DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation'];
export const STAGE_LABEL: Record<DealStage, string> = { lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
/** Default likelihood of closing, used for the weighted forecast. */
export const STAGE_PROBABILITY: Record<DealStage, number> = { lead: 0.1, qualified: 0.25, proposal: 0.5, negotiation: 0.75, won: 1, lost: 0 };

export const ACTIVITY_TYPES = ['note', 'call', 'meeting', 'email', 'task'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** ISO 4217 codes the UI offers; the API accepts any well-formed three-letter code. */
export const COMMON_CURRENCIES = ['GBP', 'EUR', 'USD', 'AUD', 'CAD', 'INR', 'AED', 'ZAR', 'NZD', 'CHF', 'SGD'];
export const isCurrencyCode = (c: string) => /^[A-Z]{3}$/.test(c);

export interface QuoteLine {
  description: string;
  /** May be fractional (e.g. 1.5 hours), up to 3 decimals. */
  quantity: number;
  /** Minor units per item. */
  unitPrice: number;
  /** Percent, e.g. 20 for 20% VAT. */
  taxRate: number;
}

/** Line totals are rounded half-up to the minor unit; tax is computed per line and rounded per line. */
export function quoteTotals(lines: QuoteLine[]): { lines: { net: number; tax: number }[]; subtotal: number; tax: number; total: number } {
  const out = lines.map((l) => {
    const net = Math.round(l.quantity * l.unitPrice);
    const tax = Math.round((net * l.taxRate) / 100);
    return { net, tax };
  });
  const subtotal = out.reduce((a, l) => a + l.net, 0);
  const tax = out.reduce((a, l) => a + l.tax, 0);
  return { lines: out, subtotal, tax, total: subtotal + tax };
}

export interface DealLike {
  stage: string;
  value: number;
  currency: string;
  closedAt?: string | null;
}

/** Pipeline per stage, per currency (values in different currencies are never added together). */
export function pipelineSummary(deals: DealLike[], now = new Date()) {
  const byCurrency = new Map<string, { stages: Record<DealStage, { count: number; value: number }>; openValue: number; weighted: number; wonThisMonth: number }>();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  for (const d of deals) {
    const stage = (DEAL_STAGES as readonly string[]).includes(d.stage) ? (d.stage as DealStage) : 'lead';
    let c = byCurrency.get(d.currency);
    if (!c) {
      c = { stages: Object.fromEntries(DEAL_STAGES.map((s) => [s, { count: 0, value: 0 }])) as Record<DealStage, { count: number; value: number }>, openValue: 0, weighted: 0, wonThisMonth: 0 };
      byCurrency.set(d.currency, c);
    }
    c.stages[stage].count++;
    c.stages[stage].value += d.value;
    if (OPEN_STAGES.includes(stage)) {
      c.openValue += d.value;
      c.weighted += Math.round(d.value * STAGE_PROBABILITY[stage]);
    }
    if (stage === 'won' && d.closedAt && d.closedAt >= monthStart) c.wonThisMonth += d.value;
  }
  return [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v })).sort((a, b) => b.openValue - a.openValue);
}

/** Win rate over closed deals (won / (won + lost)); null when nothing has closed. */
export function winRate(deals: DealLike[]): number | null {
  const won = deals.filter((d) => d.stage === 'won').length;
  const lost = deals.filter((d) => d.stage === 'lost').length;
  return won + lost === 0 ? null : won / (won + lost);
}

export type FollowUpState = 'overdue' | 'today' | 'upcoming' | 'done' | 'none';
export function followUpState(a: { dueAt: string | null; doneAt: string | null }, now = new Date()): FollowUpState {
  if (a.doneAt) return 'done';
  if (!a.dueAt) return 'none';
  const due = new Date(a.dueAt);
  if (due.getTime() < now.getTime() && due.toDateString() !== now.toDateString()) return 'overdue';
  if (due.toDateString() === now.toDateString()) return 'today';
  return 'upcoming';
}

/** Formats minor units for display, e.g. 123456 GBP → £1,234.56. */
export function formatMoney(minor: number, currency: string, locale?: string): string {
  try {
    const f = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(minor / 10 ** digits);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** Parses "1,234.50" into minor units (2 decimals). Returns null for invalid input. */
export function parseMoney(text: string): number | null {
  const t = text.replace(/[,\s£$€]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.replace('-', '').split('.');
  const v = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return t.startsWith('-') ? -v : v;
}

/** Next quote number after the highest existing one: Q-0001, Q-0002, … */
export function nextQuoteNumber(existing: string[]): string {
  const max = existing.reduce((m, n) => Math.max(m, Number(/^Q-(\d+)$/.exec(n)?.[1] ?? 0)), 0);
  return `Q-${String(max + 1).padStart(4, '0')}`;
}
