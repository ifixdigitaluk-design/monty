'use client';

import { canInWorkspace, DEAL_STAGES, formatMoney, OPEN_STAGES, parseMoney, STAGE_LABEL, type DealStage } from '@monty/domain';
import type { CompanyDto, ContactDto, CrmActivityDto, CrmSummaryDto, DealDto, QuoteDto, WorkspaceMemberDto } from '@monty/validation';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { CompanyPanel, ContactPanel, DealPanel } from '@/components/crm/panels';
import { FollowUpBadge, Member } from '@/components/crm/shared';
import { Button, cx, EmptyState, ErrorBanner, Field, Input, Modal, PageLoading, Select, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

const TABS = ['overview', 'pipeline', 'companies', 'contacts', 'followups', 'quotes'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', pipeline: 'Pipeline', companies: 'Companies', contacts: 'Contacts', followups: 'My follow-ups', quotes: 'Quotes' };

export default function CrmPage() {
  return (
    <AppShell>
      <Crm />
    </AppShell>
  );
}

function Crm() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { organisations, user } = useSession();
  const workspaces = useMemo(
    () => organisations.flatMap((o) => o.workspaces.map((w) => ({ id: w.id, role: w.role, label: o.kind === 'PERSONAL' ? 'Personal' : `${o.name} · ${w.name}`, team: o.kind === 'TEAM' }))),
    [organisations],
  );
  const ws = params.get('ws') ?? workspaces.find((w) => w.team)?.id ?? workspaces[0]?.id ?? null;
  const workspace = workspaces.find((w) => w.id === ws);
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const panel = (['company', 'contact', 'deal'] as const).map((k) => ({ kind: k, id: params.get(k) })).find((x) => x.id);

  const [summary, setSummary] = useState<CrmSummaryDto | null>(null);
  const [companies, setCompanies] = useState<CompanyDto[]>([]);
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [deals, setDeals] = useState<DealDto[]>([]);
  const [quotes, setQuotes] = useState<QuoteDto[]>([]);
  const [followUps, setFollowUps] = useState<CrmActivityDto[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState<'company' | 'contact' | 'deal' | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const [s, c, p, d, qu, f] = await Promise.all([api.crm.summary(ws), api.crm.companies(ws), api.crm.contacts(ws), api.crm.deals(ws), api.crm.quotes(ws), api.crm.followUps(ws)]);
      setSummary(s);
      setCompanies(c.companies);
      setContacts(p.contacts);
      setDeals(d.deals);
      setQuotes(qu.quotes);
      setFollowUps(f.activities);
      setError(null);
      setLoaded(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [ws]);
  useEffect(() => {
    setLoaded(false);
    void load();
    if (ws)
      api.members
        .workspace(ws)
        .then((r) => setMembers((r.members as WorkspaceMemberDto[]).filter((m) => m.effectiveRole).map((m) => ({ id: m.id, name: m.name }))))
        .catch(() => setMembers([]));
  }, [ws, load]);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    if (ws) next.set('ws', ws);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`/crm?${next.toString()}`);
  };
  const open = (kind: 'company' | 'contact' | 'deal', id: string) => go({ company: null, contact: null, deal: null, [kind]: id });

  if (!workspace) return <div className="p-8"><ErrorBanner message="Workspace not found." /></div>;
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  const canEdit = canInWorkspace(workspace.role, 'task.update');
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());

  async function moveDeal(d: DealDto, stage: DealStage) {
    setDeals((all) => all.map((x) => (x.id === d.id ? { ...x, stage } : x)));
    try {
      await api.crm.updateDeal(d.id, { stage });
      void load();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      void load();
    }
  }

  return (
    <div className="p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">CRM</h1>
        <Select aria-label="Workspace" value={ws ?? ''} onChange={(e) => router.replace(`/crm?ws=${e.target.value}`)}>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </Select>
        {canEdit ? (
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setCreating('company')}>New company</Button>
            <Button onClick={() => setCreating('contact')}>New contact</Button>
            <Button variant="primary" onClick={() => setCreating('deal')}>New deal</Button>
          </div>
        ) : null}
      </header>
      <div role="tablist" aria-label="CRM sections" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={t === tab}
            onClick={() => go({ tab: t })}
            className={cx('-mb-px border-b-2 px-3 py-1.5 text-[13px]', t === tab ? 'border-accent font-medium' : 'border-transparent text-muted hover:text-fg')}
          >
            {TAB_LABEL[t]}
            {t === 'followups' && followUps.length ? ` (${followUps.length})` : ''}
          </button>
        ))}
      </div>

      {!loaded ? (
        <PageLoading />
      ) : tab === 'overview' ? (
        <Overview summary={summary!} deals={deals} followUps={followUps} open={open} go={go} />
      ) : tab === 'pipeline' ? (
        <Pipeline deals={deals} canEdit={canEdit} onMove={moveDeal} open={open} />
      ) : tab === 'followups' ? (
        <FollowUps items={followUps} onDone={(a) => api.crm.updateActivity(a.id, { done: true }).then(load, (err) => toast({ tone: 'error', message: errorMessage(err) }))} open={open} />
      ) : tab === 'quotes' ? (
        <Quotes quotes={quotes} ws={ws!} canEdit={canEdit} />
      ) : (
        <>
          <Input aria-label={`Search ${tab}`} placeholder="Search…" className="mb-3 h-8 w-64" value={q} onChange={(e) => setQ(e.target.value)} />
          {tab === 'companies' ? (
            <Table
              caption="Companies"
              empty="No companies yet."
              head={['Name', 'Industry', 'People', 'Open deals', 'Owner']}
              rows={companies.filter((c) => match(`${c.name} ${c.industry} ${c.website}`)).map((c) => ({
                id: c.id,
                label: c.name,
                cells: [c.industry, String(c.contactCount), c.openDeals.length ? c.openDeals.map((o) => formatMoney(o.value, o.currency)).join(' + ') : '—', c.owner?.name ?? '—'],
                onOpen: () => open('company', c.id),
              }))}
            />
          ) : (
            <Table
              caption="Contacts"
              empty="No contacts yet."
              head={['Name', 'Company', 'Job title', 'Email', 'Phone']}
              rows={contacts.filter((c) => match(`${c.name} ${c.email} ${c.jobTitle} ${c.company?.name ?? ''}`)).map((c) => ({
                id: c.id,
                label: c.name,
                cells: [c.company?.name ?? '—', c.jobTitle, c.email, c.phone],
                onOpen: () => open('contact', c.id),
              }))}
            />
          )}
        </>
      )}

      {panel?.kind === 'company' ? (
        <CompanyPanel key={panel.id} id={panel.id!} workspaceId={ws!} members={members} canEdit={canEdit} meId={user.id} onClose={() => go({ company: null })} onChanged={load} open={open} />
      ) : panel?.kind === 'contact' ? (
        <ContactPanel key={panel.id} id={panel.id!} workspaceId={ws!} members={members} canEdit={canEdit} meId={user.id} onClose={() => go({ contact: null })} onChanged={load} open={open} companies={companies} />
      ) : panel?.kind === 'deal' ? (
        <DealPanel key={panel.id} id={panel.id!} workspaceId={ws!} members={members} canEdit={canEdit} meId={user.id} onClose={() => go({ deal: null })} onChanged={load} open={open} companies={companies} contacts={contacts} />
      ) : null}

      {creating ? (
        <NewRecord
          kind={creating}
          ws={ws!}
          companies={companies}
          contacts={contacts}
          onClose={() => setCreating(null)}
          onCreated={(kind, id) => {
            setCreating(null);
            void load();
            open(kind, id);
          }}
        />
      ) : null}
    </div>
  );
}

function Overview({ summary, deals, followUps, open, go }: { summary: CrmSummaryDto; deals: DealDto[]; followUps: CrmActivityDto[]; open: (k: 'deal' | 'company' | 'contact', id: string) => void; go: (p: Record<string, string | null>) => void }) {
  const closing = deals
    .filter((d) => (OPEN_STAGES as string[]).includes(d.stage) && d.expectedClose)
    .sort((a, b) => a.expectedClose!.localeCompare(b.expectedClose!))
    .slice(0, 6);
  if (!summary.counts.companies && !summary.counts.contacts && !deals.length) {
    return <EmptyState title="Your CRM is empty" body="Add the companies you work with, the people there, and the deals you’re chasing. Log calls and set follow-ups so nothing slips." />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="rounded-lg border border-line bg-surface p-4 lg:col-span-2" aria-labelledby="pipe-h">
        <h2 id="pipe-h" className="mb-3 font-medium">Pipeline</h2>
        {summary.pipeline.length === 0 ? <p className="text-muted">No deals yet.</p> : null}
        {summary.pipeline.map((p) => (
          <dl key={p.currency} className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={`Open (${p.currency})`} value={formatMoney(p.openValue, p.currency)} />
            <Stat label="Weighted forecast" value={formatMoney(p.weighted, p.currency)} />
            <Stat label="Won this month" value={formatMoney(p.wonThisMonth, p.currency)} />
            <Stat label="Win rate" value={summary.winRate === null ? '—' : `${Math.round(summary.winRate * 100)}%`} />
          </dl>
        ))}
        <p className="text-[12px] text-muted">
          {summary.counts.openDeals} open deals · {summary.counts.companies} companies · {summary.counts.contacts} contacts. Forecast weights: Lead 10%, Qualified 25%, Proposal 50%, Negotiation 75%.
        </p>
      </section>
      <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="fu-h">
        <h2 id="fu-h" className="mb-2 font-medium">My follow-ups</h2>
        {followUps.length === 0 ? <p className="text-[13px] text-muted">Nothing due. 🎉</p> : null}
        <ul className="space-y-1">
          {followUps.slice(0, 6).map((a) => (
            <li key={a.id} className="text-[13px]">
              <span className="font-medium">{a.subject}</span> <FollowUpBadge a={a} />
            </li>
          ))}
        </ul>
        {followUps.length > 6 ? <Button variant="ghost" onClick={() => go({ tab: 'followups' })}>See all</Button> : null}
      </section>
      <section className="rounded-lg border border-line bg-surface p-4 lg:col-span-3" aria-labelledby="close-h">
        <h2 id="close-h" className="mb-2 font-medium">Closing soon</h2>
        {closing.length === 0 ? <p className="text-[13px] text-muted">No open deals with an expected close date.</p> : null}
        <ul className="divide-y divide-line">
          {closing.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
              <button className="truncate text-left hover:underline" onClick={() => open('deal', d.id)}>{d.title}</button>
              <span className="shrink-0 text-[13px] text-muted">
                {d.company?.name ? `${d.company.name} · ` : ''}
                {STAGE_LABEL[d.stage]} · {formatMoney(d.value, d.currency)} · {new Date(`${d.expectedClose}T00:00:00`).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}

function Pipeline({ deals, canEdit, onMove, open }: { deals: DealDto[]; canEdit: boolean; onMove: (d: DealDto, s: DealStage) => void; open: (k: 'deal', id: string) => void }) {
  const [over, setOver] = useState<string | null>(null);
  if (!deals.length) return <EmptyState title="No deals yet" body="Create a deal to see it move through your pipeline." />;
  return (
    <ul className="flex gap-3 overflow-x-auto pb-2" aria-label="Deals by stage">
      {DEAL_STAGES.map((s) => {
        const col = deals.filter((d) => d.stage === s);
        const totals = [...new Set(col.map((d) => d.currency))].map((c) => formatMoney(col.filter((d) => d.currency === c).reduce((a, d) => a + d.value, 0), c)).join(' + ');
        return (
          <li key={s} className="w-64 shrink-0">
            <section
              aria-label={`${STAGE_LABEL[s]}, ${col.length} deals`}
              data-stage={s}
              className={cx('flex h-full flex-col rounded-lg bg-surface-2 p-2', over === s && 'ring-2 ring-accent')}
              onDragOver={(e) => {
                if (!canEdit) return;
                e.preventDefault();
                setOver(s);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                setOver(null);
                const d = deals.find((x) => x.id === e.dataTransfer.getData('text/monty-deal'));
                if (d && d.stage !== s) onMove(d, s);
              }}
            >
              <h2 className="mb-2 flex items-baseline justify-between px-1 text-[14px] font-medium">
                {STAGE_LABEL[s]} <span className="text-[12px] font-normal text-muted">{col.length ? totals : '0'}</span>
              </h2>
              <ul className="space-y-2">
                {col.map((d) => (
                  <li key={d.id} draggable={canEdit} onDragStart={(e) => e.dataTransfer.setData('text/monty-deal', d.id)} className="rounded-lg border border-line bg-surface p-2 shadow-sm">
                    <button className="block w-full truncate text-left font-medium hover:underline" onClick={() => open('deal', d.id)}>{d.title}</button>
                    <p className="text-[12px] text-muted">
                      {formatMoney(d.value, d.currency)}
                      {d.company ? ` · ${d.company.name}` : ''}
                    </p>
                    {canEdit ? (
                      <Select aria-label={`Stage of ${d.title}`} className="mt-1 h-7 w-full text-[12px]" value={d.stage} onChange={(e) => onMove(d, e.target.value as DealStage)}>
                        {DEAL_STAGES.map((x) => (
                          <option key={x} value={x}>
                            {STAGE_LABEL[x]}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          </li>
        );
      })}
    </ul>
  );
}

function FollowUps({ items, onDone, open }: { items: CrmActivityDto[]; onDone: (a: CrmActivityDto) => void; open: (k: 'company' | 'contact' | 'deal', id: string) => void }) {
  if (!items.length) return <EmptyState title="No open follow-ups" body="Follow-ups you schedule on a company, contact or deal — or that colleagues give you — appear here." />;
  return (
    <ul className="max-w-3xl divide-y divide-line rounded-lg border border-line bg-surface">
      {items.map((a) => {
        const target = a.deal ? (['deal', a.deal.id, a.deal.title] as const) : a.contact ? (['contact', a.contact.id, a.contact.name] as const) : a.company ? (['company', a.company.id, a.company.name] as const) : null;
        return (
          <li key={a.id} className="flex items-start gap-3 p-3">
            <input type="checkbox" className="mt-1" aria-label={`Mark “${a.subject}” done`} onChange={() => onDone(a)} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{a.subject}</p>
              <p className="flex flex-wrap gap-x-2 text-[12px] text-muted">
                <FollowUpBadge a={a} />
                {target ? (
                  <button className="underline" onClick={() => open(target[0], target[1])}>
                    {target[2]}
                  </button>
                ) : null}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Quotes({ quotes, ws, canEdit }: { quotes: QuoteDto[]; ws: string; canEdit: boolean }) {
  return (
    <div>
      {canEdit ? (
        <Link className="mb-3 inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg" href={`/crm/quote?ws=${ws}`}>
          New quote
        </Link>
      ) : null}
      <Table
        caption="Quotes"
        empty="No quotes yet."
        head={['Quote', 'Customer', 'Status', 'Issued', 'Total']}
        rows={quotes.map((q) => ({
          id: q.id,
          label: `${q.number} · ${q.title}`,
          href: `/crm/quote?ws=${ws}&id=${q.id}`,
          cells: [q.company?.name ?? '—', q.status, new Date(`${q.issueDate}T00:00:00`).toLocaleDateString(), formatMoney(q.total, q.currency)],
        }))}
      />
    </div>
  );
}

function Table({ caption, head, rows, empty }: { caption: string; head: string[]; empty: string; rows: { id: string; label: string; cells: string[]; onOpen?: () => void; href?: string }[] }) {
  if (!rows.length) return <p className="text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-max text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-muted">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-surface-2">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {r.href ? (
                  <Link className="hover:underline" href={r.href}>{r.label}</Link>
                ) : (
                  <button className="text-left hover:underline" onClick={r.onOpen}>{r.label}</button>
                )}
              </th>
              {r.cells.map((c, i) => (
                <td key={i} className="px-3 py-2">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewRecord({
  kind,
  ws,
  companies,
  contacts,
  onClose,
  onCreated,
}: {
  kind: 'company' | 'contact' | 'deal';
  ws: string;
  companies: CompanyDto[];
  contacts: ContactDto[];
  onClose: () => void;
  onCreated: (kind: 'company' | 'contact' | 'deal', id: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [contactId, setContactId] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const title = { company: 'New company', contact: 'New contact', deal: 'New deal' }[kind];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      if (kind === 'company') await api.crm.createCompany(ws, { id, name: name.trim() });
      if (kind === 'contact') await api.crm.createContact(ws, { id, name: name.trim(), email: email.trim(), companyId: companyId || null });
      if (kind === 'deal') {
        const v = value.trim() ? parseMoney(value) : 0;
        if (v === null || v < 0) throw new Error('Enter the value as a number, e.g. 12,500.00');
        await api.crm.createDeal(ws, { id, title: name.trim(), value: v, companyId: companyId || null, contactId: contactId || null });
      }
      onCreated(kind, id);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={kind === 'deal' ? 'Deal title' : 'Name'} htmlFor="crm-name">
          <Input id="crm-name" autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        {kind === 'contact' ? (
          <Field label="Email" htmlFor="crm-email">
            <Input id="crm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        ) : null}
        {kind !== 'company' ? (
          <Field label="Company" htmlFor="crm-company">
            <Select id="crm-company" className="w-full" value={companyId} onChange={(e) => { setCompanyId(e.target.value); setContactId(''); }}>
              <option value="">None</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
        ) : null}
        {kind === 'deal' ? (
          <>
            <Field label="Contact" htmlFor="crm-contact">
              <Select id="crm-contact" className="w-full" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">None</option>
                {contacts.filter((c) => !companyId || c.company?.id === companyId).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Value (GBP)" htmlFor="crm-value" hint="You can change the currency on the deal.">
              <Input id="crm-value" inputMode="decimal" placeholder="0.00" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}
