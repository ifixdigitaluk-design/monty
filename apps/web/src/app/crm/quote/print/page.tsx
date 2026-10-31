'use client';

import { formatMoney, quoteTotals } from '@monty/domain';
import type { QuoteDto } from '@monty/validation';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/** A plain, printable quote (Print → Save as PDF to send it). Signed-in users only; same permissions as the quote. */
export default function PrintQuotePage() {
  return (
    <Suspense>
      <PrintQuote />
    </Suspense>
  );
}

function PrintQuote() {
  const id = useSearchParams().get('id') ?? '';
  const [q, setQ] = useState<QuoteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.crm.quote(id).then((r) => setQ(r.quote), (err) => setError(errorMessage(err)));
  }, [id]);
  if (error) return <main className="p-8"><p role="alert">{error}</p></main>;
  if (!q) return <main className="p-8"><p>Loading…</p></main>;
  const t = quoteTotals(q.lines);
  const m = (n: number) => formatMoney(n, q.currency);
  const d = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <main className="mx-auto max-w-3xl bg-white p-10 text-[14px] text-black print:p-0">
      <div className="mb-6 flex justify-end gap-2 print:hidden">
        <button className="rounded-lg border border-gray-300 px-3 py-1.5" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
      <header className="mb-8 flex justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Quote {q.number}</h1>
          <p>{q.title}</p>
        </div>
        <dl className="text-right">
          <div><dt className="inline text-gray-600">Date: </dt><dd className="inline">{d(q.issueDate)}</dd></div>
          {q.validUntil ? <div><dt className="inline text-gray-600">Valid until: </dt><dd className="inline">{d(q.validUntil)}</dd></div> : null}
        </dl>
      </header>
      {q.company || q.contact ? (
        <section className="mb-6">
          <h2 className="text-[12px] uppercase tracking-wide text-gray-600">Prepared for</h2>
          {q.contact ? <p>{q.contact.name}</p> : null}
          {q.company ? <p className="font-medium">{q.company.name}</p> : null}
          {q.company?.address ? <p className="whitespace-pre-line">{q.company.address}</p> : null}
        </section>
      ) : null}
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b-2 border-black text-left">
            <th scope="col" className="py-2">Description</th>
            <th scope="col" className="py-2 text-right">Qty</th>
            <th scope="col" className="py-2 text-right">Unit price</th>
            <th scope="col" className="py-2 text-right">Tax</th>
            <th scope="col" className="py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {q.lines.map((l, i) => (
            <tr key={i} className="border-b border-gray-300">
              <td className="py-2">{l.description}</td>
              <td className="py-2 text-right">{l.quantity}</td>
              <td className="py-2 text-right">{m(l.unitPrice)}</td>
              <td className="py-2 text-right">{l.taxRate}%</td>
              <td className="py-2 text-right">{m(t.lines[i]!.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="ml-auto mt-4 w-64 space-y-1">
        <div className="flex justify-between"><dt>Subtotal</dt><dd>{m(q.subtotal)}</dd></div>
        <div className="flex justify-between"><dt>Tax</dt><dd>{m(q.tax)}</dd></div>
        <div className="flex justify-between border-t-2 border-black pt-1 text-lg font-semibold"><dt>Total</dt><dd>{m(q.total)}</dd></div>
      </dl>
      {q.notes ? <section className="mt-8 whitespace-pre-wrap"><h2 className="mb-1 font-medium">Notes and terms</h2>{q.notes}</section> : null}
    </main>
  );
}
