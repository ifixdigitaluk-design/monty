'use client';

import { COMMON_CURRENCIES, DEAL_STAGES, formatMoney, parseMoney, STAGE_LABEL } from '@monty/domain';
import type { CompanyDto, ContactDto, CrmActivityDto, DealDto, QuoteDto } from '@monty/validation';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, Input, Select, Spinner, useToast } from '../ui';
import { EditableField, Member, MemberSelect, SidePanel, Timeline } from './shared';

interface Common {
  id: string;
  workspaceId: string;
  members: Member[];
  canEdit: boolean;
  meId: string;
  onClose: () => void;
  onChanged: () => void;
  open: (kind: 'company' | 'contact' | 'deal', id: string) => void;
}

function useDetail<T>(load: () => Promise<T>) {
  const toast = useToast();
  const [data, setData] = useState<T | null>(null);
  const reload = useCallback(() => {
    load().then(setData, (err) => toast({ tone: 'error', message: errorMessage(err) }));
  }, [load, toast]);
  useEffect(() => reload(), [reload]);
  return { data, reload, setData };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
      <span className="text-[13px] text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function useSaver(onChanged: () => void, reload: () => void) {
  const toast = useToast();
  return (p: Promise<unknown>) =>
    p.then(
      () => {
        reload();
        onChanged();
      },
      (err) => toast({ tone: 'error', message: errorMessage(err) }),
    );
}

export function CompanyPanel(p: Common) {
  const load = useCallback(() => api.crm.company(p.id), [p.id]);
  const { data, reload } = useDetail(load);
  const save = useSaver(p.onChanged, reload);
  if (!data) return <SidePanel label="Company" onClose={p.onClose}><Spinner /></SidePanel>;
  const c = data.company;
  const set = (patch: Parameters<typeof api.crm.updateCompany>[1]) => save(api.crm.updateCompany(c.id, patch));
  return (
    <SidePanel
      label={`Company: ${c.name}`}
      onClose={p.onClose}
      footer={p.canEdit ? <Button variant="danger" onClick={() => window.confirm(`Delete ${c.name}? Its contacts and deals stay, unlinked.`) && save(api.crm.removeCompany(c.id)).then(p.onClose)}>Delete company</Button> : undefined}
    >
      <EditableField label="Name" value={c.name} disabled={!p.canEdit} onSave={(v) => v.trim() && set({ name: v.trim() })} />
      <EditableField label="Website" type="url" value={c.website} disabled={!p.canEdit} placeholder="https://…" onSave={(v) => set({ website: v.trim() })} />
      <EditableField label="Industry" value={c.industry} disabled={!p.canEdit} onSave={(v) => set({ industry: v })} />
      <EditableField label="Phone" type="tel" value={c.phone} disabled={!p.canEdit} onSave={(v) => set({ phone: v })} />
      <EditableField label="Address" value={c.address} disabled={!p.canEdit} multiline onSave={(v) => set({ address: v })} />
      <Row label="Owner">
        <MemberSelect label="Company owner" value={c.owner?.id ?? null} members={p.members} disabled={!p.canEdit} onChange={(v) => set({ ownerId: v })} />
      </Row>
      <EditableField label="Notes" value={c.notes} disabled={!p.canEdit} multiline onSave={(v) => set({ notes: v })} />
      <RelatedList title="People" empty="No contacts yet." items={data.contacts.map((x) => ({ id: x.id, label: x.name, meta: x.jobTitle, kind: 'contact' as const }))} open={p.open} />
      <RelatedList title="Deals" empty="No deals yet." items={data.deals.map((d) => ({ id: d.id, label: d.title, meta: `${STAGE_LABEL[d.stage]} · ${formatMoney(d.value, d.currency)}`, kind: 'deal' as const }))} open={p.open} />
      <QuoteLinks quotes={data.quotes} workspaceId={p.workspaceId} />
      <Timeline workspaceId={p.workspaceId} link={{ companyId: c.id }} activities={data.activities} members={p.members} canEdit={p.canEdit} meId={p.meId} onChanged={reload} />
    </SidePanel>
  );
}

export function ContactPanel(p: Common & { companies: CompanyDto[] }) {
  const load = useCallback(() => api.crm.contact(p.id), [p.id]);
  const { data, reload } = useDetail(load);
  const save = useSaver(p.onChanged, reload);
  if (!data) return <SidePanel label="Contact" onClose={p.onClose}><Spinner /></SidePanel>;
  const c: ContactDto = data.contact;
  const set = (patch: Parameters<typeof api.crm.updateContact>[1]) => save(api.crm.updateContact(c.id, patch));
  return (
    <SidePanel
      label={`Contact: ${c.name}`}
      onClose={p.onClose}
      footer={p.canEdit ? <Button variant="danger" onClick={() => window.confirm(`Delete ${c.name}?`) && save(api.crm.removeContact(c.id)).then(p.onClose)}>Delete contact</Button> : undefined}
    >
      <EditableField label="Name" value={c.name} disabled={!p.canEdit} onSave={(v) => v.trim() && set({ name: v.trim() })} />
      <EditableField label="Job title" value={c.jobTitle} disabled={!p.canEdit} onSave={(v) => set({ jobTitle: v })} />
      <EditableField label="Email" type="email" value={c.email} disabled={!p.canEdit} onSave={(v) => set({ email: v.trim() })} />
      <EditableField label="Phone" type="tel" value={c.phone} disabled={!p.canEdit} onSave={(v) => set({ phone: v })} />
      <Row label="Company">
        <div className="flex items-center gap-2">
          <Select aria-label="Contact's company" className="h-8 flex-1" value={c.company?.id ?? ''} disabled={!p.canEdit} onChange={(e) => set({ companyId: e.target.value || null })}>
            <option value="">No company</option>
            {p.companies.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
          {c.company ? <Button variant="ghost" onClick={() => p.open('company', c.company!.id)}>Open</Button> : null}
        </div>
      </Row>
      <Row label="Owner">
        <MemberSelect label="Contact owner" value={c.owner?.id ?? null} members={p.members} disabled={!p.canEdit} onChange={(v) => set({ ownerId: v })} />
      </Row>
      <EditableField label="Notes" value={c.notes} disabled={!p.canEdit} multiline onSave={(v) => set({ notes: v })} />
      {c.email ? (
        <p className="text-[13px]">
          <a className="text-accent underline" href={`mailto:${c.email}`}>Email {c.name}</a>
        </p>
      ) : null}
      <RelatedList title="Deals" empty="No deals yet." items={data.deals.map((d) => ({ id: d.id, label: d.title, meta: `${STAGE_LABEL[d.stage]} · ${formatMoney(d.value, d.currency)}`, kind: 'deal' as const }))} open={p.open} />
      <Timeline workspaceId={p.workspaceId} link={{ contactId: c.id, ...(c.company ? { companyId: c.company.id } : {}) }} activities={data.activities} members={p.members} canEdit={p.canEdit} meId={p.meId} onChanged={reload} />
    </SidePanel>
  );
}

export function DealPanel(p: Common & { companies: CompanyDto[]; contacts: ContactDto[] }) {
  const load = useCallback(() => api.crm.deal(p.id), [p.id]);
  const { data, reload } = useDetail(load);
  const save = useSaver(p.onChanged, reload);
  const [valueText, setValueText] = useState<string | null>(null);
  if (!data) return <SidePanel label="Deal" onClose={p.onClose}><Spinner /></SidePanel>;
  const d: DealDto = data.deal;
  const set = (patch: Parameters<typeof api.crm.updateDeal>[1]) => save(api.crm.updateDeal(d.id, patch));
  const people = p.contacts.filter((c) => !d.company || c.company?.id === d.company.id);
  return (
    <SidePanel
      label={`Deal: ${d.title}`}
      onClose={p.onClose}
      footer={p.canEdit ? <Button variant="danger" onClick={() => window.confirm(`Delete the deal “${d.title}”?`) && save(api.crm.removeDeal(d.id)).then(p.onClose)}>Delete deal</Button> : undefined}
    >
      <EditableField label="Title" value={d.title} disabled={!p.canEdit} onSave={(v) => v.trim() && set({ title: v.trim() })} />
      <Row label="Stage">
        <Select aria-label="Deal stage" className="h-8 w-full" value={d.stage} disabled={!p.canEdit} onChange={(e) => set({ stage: e.target.value as DealDto['stage'] })}>
          {DEAL_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </Select>
      </Row>
      {d.stage === 'lost' ? <EditableField label="Why lost" value={d.lostReason} disabled={!p.canEdit} onSave={(v) => set({ lostReason: v })} /> : null}
      <Row label="Value">
        <div className="flex gap-2">
          <Input
            aria-label="Deal value"
            className="h-8 flex-1"
            inputMode="decimal"
            disabled={!p.canEdit}
            value={valueText ?? (d.value / 100).toFixed(2)}
            onChange={(e) => setValueText(e.target.value)}
            onBlur={() => {
              if (valueText === null) return;
              const v = parseMoney(valueText);
              setValueText(null);
              if (v !== null && v >= 0 && v !== d.value) set({ value: v });
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <Select aria-label="Deal currency" className="h-8" value={d.currency} disabled={!p.canEdit} onChange={(e) => set({ currency: e.target.value })}>
            {[...new Set([d.currency, ...COMMON_CURRENCIES])].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </div>
      </Row>
      <EditableField label="Expected close" type="date" value={d.expectedClose ?? ''} disabled={!p.canEdit} onSave={(v) => set({ expectedClose: v || null })} />
      <Row label="Company">
        <div className="flex items-center gap-2">
          <Select aria-label="Deal company" className="h-8 flex-1" value={d.company?.id ?? ''} disabled={!p.canEdit} onChange={(e) => set({ companyId: e.target.value || null, contactId: null })}>
            <option value="">No company</option>
            {p.companies.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
          {d.company ? <Button variant="ghost" onClick={() => p.open('company', d.company!.id)}>Open</Button> : null}
        </div>
      </Row>
      <Row label="Contact">
        <Select aria-label="Deal contact" className="h-8 w-full" value={d.contact?.id ?? ''} disabled={!p.canEdit} onChange={(e) => set({ contactId: e.target.value || null })}>
          <option value="">No contact</option>
          {people.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Owner">
        <MemberSelect label="Deal owner" value={d.owner?.id ?? null} members={p.members} disabled={!p.canEdit} onChange={(v) => set({ ownerId: v })} />
      </Row>
      <EditableField label="Notes" value={d.notes} disabled={!p.canEdit} multiline onSave={(v) => set({ notes: v })} />
      <QuoteLinks quotes={data.quotes} workspaceId={p.workspaceId} newFor={p.canEdit ? d : undefined} />
      <Timeline
        workspaceId={p.workspaceId}
        link={{ dealId: d.id, ...(d.company ? { companyId: d.company.id } : {}), ...(d.contact ? { contactId: d.contact.id } : {}) }}
        activities={data.activities as CrmActivityDto[]}
        members={p.members}
        canEdit={p.canEdit}
        meId={p.meId}
        onChanged={reload}
      />
    </SidePanel>
  );
}

function RelatedList({ title, empty, items, open }: { title: string; empty: string; items: { id: string; label: string; meta: string; kind: 'contact' | 'deal' }[]; open: Common['open'] }) {
  return (
    <section>
      <h2 className="mb-1 font-medium">{title}</h2>
      {items.length === 0 ? <p className="text-[13px] text-muted">{empty}</p> : null}
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.id}>
            <button className="flex w-full items-center justify-between gap-2 rounded-md bg-surface-2 px-2 py-1 text-left hover:underline" onClick={() => open(i.kind, i.id)}>
              <span className="truncate">{i.label}</span>
              <span className="shrink-0 text-[12px] text-muted">{i.meta}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuoteLinks({ quotes, workspaceId, newFor }: { quotes: QuoteDto[]; workspaceId: string; newFor?: DealDto }) {
  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-medium">Quotes</h2>
        {newFor ? (
          <Link className="text-[13px] text-accent underline" href={`/crm/quote?ws=${workspaceId}&deal=${newFor.id}`}>
            New quote
          </Link>
        ) : null}
      </div>
      {quotes.length === 0 ? <p className="text-[13px] text-muted">No quotes.</p> : null}
      <ul className="space-y-1">
        {quotes.map((q) => (
          <li key={q.id}>
            <Link className="flex justify-between rounded-md bg-surface-2 px-2 py-1 hover:underline" href={`/crm/quote?ws=${workspaceId}&id=${q.id}`}>
              <span>
                {q.number} · {q.title}
              </span>
              <span className="text-[12px] text-muted">{formatMoney(q.total, q.currency)} · {q.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
