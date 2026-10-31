'use client';

import { canInWorkspace, COMMON_CURRENCIES, formatMoney, parseMoney, QUOTE_STATUSES, quoteTotals } from '@monty/domain';
import type { CompanyDto, ContactDto, DealDto, QuoteDto } from '@monty/validation';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Button, ErrorBanner, Field, Input, PageLoading, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function QuotePage() {
  return (
    <AppShell>
      <QuoteEditor />
    </AppShell>
  );
}

interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}
const toDraft = (l: QuoteDto['lines'][number]): LineDraft => ({ key: crypto.randomUUID(), description: l.description, quantity: String(l.quantity), unitPrice: (l.unitPrice / 100).toFixed(2), taxRate: String(l.taxRate) });
const blank = (): LineDraft => ({ key: crypto.randomUUID(), description: '', quantity: '1', unitPrice: '', taxRate: '20' });

function QuoteEditor() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { organisations } = useSession();
  const ws = params.get('ws') ?? '';
  const id = params.get('id');
  const role = organisations.flatMap((o) => o.workspaces).find((w) => w.id === ws)?.role;
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [companies, setCompanies] = useState<CompanyDto[]>([]);
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [deals, setDeals] = useState<DealDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', companyId: '', contactId: '', dealId: '', status: 'draft', currency: 'GBP', issueDate: new Date().toISOString().slice(0, 10), validUntil: '', notes: '' });
  const [lines, setLines] = useState<LineDraft[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ws) return;
    (async () => {
      try {
        const [c, p, d] = await Promise.all([api.crm.companies(ws), api.crm.contacts(ws), api.crm.deals(ws)]);
        setCompanies(c.companies);
        setContacts(p.contacts);
        setDeals(d.deals);
        if (id) {
          const { quote: q } = await api.crm.quote(id);
          setQuote(q);
          setForm({ title: q.title, companyId: q.company?.id ?? '', contactId: q.contact?.id ?? '', dealId: q.deal?.id ?? '', status: q.status, currency: q.currency, issueDate: q.issueDate, validUntil: q.validUntil ?? '', notes: q.notes });
          setLines(q.lines.length ? q.lines.map(toDraft) : [blank()]);
        } else {
          const deal = d.deals.find((x) => x.id === params.get('deal'));
          const in30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
          setForm((f) => ({ ...f, validUntil: in30, ...(deal ? { title: deal.title, dealId: deal.id, companyId: deal.company?.id ?? '', contactId: deal.contact?.id ?? '', currency: deal.currency } : {}) }));
        }
        setReady(true);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [ws, id, params]);

  if (error) return <div className="p-8"><ErrorBanner message={error} /></div>;
  if (!ready || !role) return <PageLoading />;
  const canEdit = canInWorkspace(role, 'task.update');
  const locked = quote?.status === 'accepted';

  const parsed = lines.map((l) => ({
    description: l.description.trim(),
    quantity: Number(l.quantity),
    unitPrice: parseMoney(l.unitPrice || '0'),
    taxRate: Number(l.taxRate || '0'),
  }));
  const invalid = parsed.findIndex((l) => !l.description || !Number.isFinite(l.quantity) || l.quantity < 0 || l.unitPrice === null || !Number.isFinite(l.taxRate) || l.taxRate < 0 || l.taxRate > 100);
  const valid = parsed.map((l) => ({ ...l, unitPrice: l.unitPrice ?? 0 }));
  const totals = quoteTotals(valid);
  const money = (n: number) => formatMoney(n, form.currency);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    if (!form.title.trim()) return toast({ tone: 'error', message: 'Give the quote a title.' });
    if (invalid >= 0) return toast({ tone: 'error', message: `Line ${invalid + 1}: add a description, a quantity, a price like 120.00 and a tax rate between 0 and 100.` });
    setBusy(true);
    const body = {
      title: form.title.trim(),
      companyId: form.companyId || null,
      contactId: form.contactId || null,
      dealId: form.dealId || null,
      status: form.status as QuoteDto['status'],
      currency: form.currency,
      issueDate: form.issueDate,
      validUntil: form.validUntil || null,
      notes: form.notes,
      ...(locked ? {} : { lines: valid }),
    };
    try {
      if (quote) {
        const { quote: q } = await api.crm.updateQuote(quote.id, locked ? (({ currency: _c, ...rest }) => rest)(body) : body);
        setQuote(q);
        toast({ tone: 'success', message: 'Quote saved' });
      } else {
        const { quote: q } = await api.crm.createQuote(ws, { id: crypto.randomUUID(), ...body });
        router.replace(`/crm/quote?ws=${ws}&id=${q.id}`);
      }
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const people = contacts.filter((c) => !form.companyId || c.company?.id === form.companyId);
  const disabled = !canEdit;
  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <Link className="text-[13px] text-muted hover:underline" href={`/crm?ws=${ws}&tab=quotes`}>← Quotes</Link>
        <h1 className="text-xl font-semibold">{quote ? `${quote.number} · ${quote.title}` : 'New quote'}</h1>
        <div className="ml-auto flex gap-2">
          {quote ? (
            <Link className="inline-flex h-8 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-surface-2" href={`/crm/quote/print?id=${quote.id}`} target="_blank">
              Print / PDF
            </Link>
          ) : null}
          {canEdit ? (
            <Button variant="primary" busy={busy} onClick={() => void save()}>
              {quote ? 'Save' : 'Create quote'}
            </Button>
          ) : null}
        </div>
      </header>
      {locked ? <p role="status" className="mb-3 rounded-lg bg-surface-2 p-2 text-[13px]">This quote was accepted, so its lines and currency are locked. Create a new quote for changes.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" htmlFor="q-title">
          <Input id="q-title" value={form.title} disabled={disabled} maxLength={200} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Status" htmlFor="q-status">
          <Select id="q-status" className="w-full" value={form.status} disabled={disabled} onChange={(e) => set('status', e.target.value)}>
            {QUOTE_STATUSES.map((s) => (
              <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>
            ))}
          </Select>
        </Field>
        <Field label="Company" htmlFor="q-company">
          <Select id="q-company" className="w-full" value={form.companyId} disabled={disabled} onChange={(e) => setForm((f) => ({ ...f, companyId: e.target.value, contactId: '' }))}>
            <option value="">None</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Contact" htmlFor="q-contact">
          <Select id="q-contact" className="w-full" value={form.contactId} disabled={disabled} onChange={(e) => set('contactId', e.target.value)}>
            <option value="">None</option>
            {people.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Deal" htmlFor="q-deal">
          <Select id="q-deal" className="w-full" value={form.dealId} disabled={disabled} onChange={(e) => set('dealId', e.target.value)}>
            <option value="">None</option>
            {deals.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </Field>
        <Field label="Currency" htmlFor="q-currency">
          <Select id="q-currency" className="w-full" value={form.currency} disabled={disabled || locked} onChange={(e) => set('currency', e.target.value)}>
            {[...new Set([form.currency, ...COMMON_CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Issue date" htmlFor="q-issue">
          <Input id="q-issue" type="date" value={form.issueDate} disabled={disabled} onChange={(e) => set('issueDate', e.target.value)} />
        </Field>
        <Field label="Valid until" htmlFor="q-valid">
          <Input id="q-valid" type="date" value={form.validUntil} disabled={disabled} onChange={(e) => set('validUntil', e.target.value)} />
        </Field>
      </div>

      <div className="mt-5 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[40rem] text-[13px]">
          <caption className="sr-only">Quote lines</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className="px-2 py-2 font-medium">Description</th>
              <th scope="col" className="w-20 px-2 py-2 font-medium">Qty</th>
              <th scope="col" className="w-28 px-2 py-2 font-medium">Unit price</th>
              <th scope="col" className="w-20 px-2 py-2 font-medium">Tax %</th>
              <th scope="col" className="w-28 px-2 py-2 text-right font-medium">Amount</th>
              <th scope="col" className="w-10"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const upd = (k: keyof LineDraft, v: string) => setLines((all) => all.map((x) => (x.key === l.key ? { ...x, [k]: v } : x)));
              const n = i + 1;
              return (
                <tr key={l.key} className="border-b border-line last:border-b-0">
                  <td className="p-1"><Input aria-label={`Line ${n} description`} className="h-8" value={l.description} disabled={disabled || locked} onChange={(e) => upd('description', e.target.value)} /></td>
                  <td className="p-1"><Input aria-label={`Line ${n} quantity`} className="h-8" inputMode="decimal" value={l.quantity} disabled={disabled || locked} onChange={(e) => upd('quantity', e.target.value)} /></td>
                  <td className="p-1"><Input aria-label={`Line ${n} unit price`} className="h-8" inputMode="decimal" placeholder="0.00" value={l.unitPrice} disabled={disabled || locked} onChange={(e) => upd('unitPrice', e.target.value)} /></td>
                  <td className="p-1"><Input aria-label={`Line ${n} tax rate`} className="h-8" inputMode="decimal" value={l.taxRate} disabled={disabled || locked} onChange={(e) => upd('taxRate', e.target.value)} /></td>
                  <td className="px-2 text-right tabular-nums">{money(totals.lines[i]?.net ?? 0)}</td>
                  <td className="p-1">
                    {canEdit && !locked ? (
                      <Button variant="ghost" aria-label={`Remove line ${n}`} disabled={lines.length === 1} onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>✕</Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {canEdit && !locked ? (
          <div className="border-t border-line p-2">
            <Button variant="ghost" disabled={lines.length >= 200} onClick={() => setLines((all) => [...all, blank()])}>+ Add line</Button>
          </div>
        ) : null}
      </div>
      <dl className="ml-auto mt-3 w-64 space-y-1 text-[14px]" aria-label="Totals">
        <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular-nums">{money(totals.subtotal)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd className="tabular-nums">{money(totals.tax)}</dd></div>
        <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>Total</dt><dd className="tabular-nums" data-testid="quote-total">{money(totals.total)}</dd></div>
      </dl>
      <Field label="Notes and terms (shown on the quote)" htmlFor="q-notes">
        <Textarea id="q-notes" rows={4} value={form.notes} disabled={disabled} onChange={(e) => set('notes', e.target.value)} />
      </Field>
      {quote && canEdit ? (
        <div className="mt-4 flex justify-end">
          <Button variant="danger" onClick={() => window.confirm(`Delete ${quote.number}?`) && api.crm.removeQuote(quote.id).then(() => router.replace(`/crm?ws=${ws}&tab=quotes`), (err) => toast({ tone: 'error', message: errorMessage(err) }))}>
            Delete quote
          </Button>
        </div>
      ) : null}
    </div>
  );
}
