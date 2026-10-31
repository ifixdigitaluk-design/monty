'use client';

import { COMMON_CURRENCIES, EMPLOYMENT_LABEL, EMPLOYMENT_TYPES, formatMoney, HR_DOC_CATEGORIES, parseMoney } from '@monty/domain';
import type { HrDocumentDto, HrMeDto, HrPersonDto, HrProfileDto, UpdateHrProfileInput } from '@monty/validation';
import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '../Attachments';
import { Button, Input, Select, Spinner, useToast } from '../ui';
import { EditableField, SidePanel } from '../crm/shared';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
      <span className="text-[13px] text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function PersonPanel({ org, userId, me, people, onClose, onChanged }: { org: string; userId: string; me: HrMeDto; people: HrPersonDto[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<HrProfileDto | null>(null);
  const [docs, setDocs] = useState<HrDocumentDto[] | null>(null);
  const [salaryText, setSalaryText] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('contract');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { profile } = await api.hr.profile(org, userId);
      setP(profile);
      setDocs(profile.private ? (await api.hr.documents(org, userId)).documents : null);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      onClose();
    }
  }, [org, userId, toast, onClose]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!p) return <SidePanel label="Person" onClose={onClose}><Spinner /></SidePanel>;

  const save = (patch: UpdateHrProfileInput) =>
    api.hr.updateProfile(org, userId, patch).then(
      ({ profile }) => {
        setP(profile);
        onChanged();
      },
      (err) => toast({ tone: 'error', message: errorMessage(err) }),
    );
  const savePrivate = (patch: NonNullable<UpdateHrProfileInput['private']>) => save({ private: patch });
  const job = !p.canEdit.profile;
  const priv = p.private;

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    try {
      await api.hr.uploadDocument(org, userId, category, f);
      setDocs((await api.hr.documents(org, userId)).documents);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <SidePanel label={`Person: ${p.name}`} onClose={onClose}>
      <div>
        <h2 className="text-lg font-semibold">{p.name}</h2>
        <p className="text-[13px] text-muted">
          {p.email}
          {p.isHrAdmin ? ' · HR admin' : ''}
        </p>
      </div>

      <section className="space-y-2" aria-labelledby="job-h">
        <h2 id="job-h" className="font-medium">Job</h2>
        <EditableField label="Job title" value={p.jobTitle} disabled={job} onSave={(v) => save({ jobTitle: v })} />
        <EditableField label="Department" value={p.department} disabled={job} onSave={(v) => save({ department: v })} />
        <Row label="Manager">
          <Select aria-label="Manager" className="h-8 w-full" value={p.manager?.id ?? ''} disabled={job} onChange={(e) => save({ managerId: e.target.value || null })}>
            <option value="">No manager</option>
            {people.filter((x) => x.userId !== userId).map((x) => (
              <option key={x.userId} value={x.userId}>{x.name}</option>
            ))}
          </Select>
        </Row>
        <Row label="Employment">
          <Select aria-label="Employment type" className="h-8 w-full" value={p.employmentType} disabled={job} onChange={(e) => save({ employmentType: e.target.value as HrProfileDto['employmentType'] })}>
            {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_LABEL[t]}</option>)}
          </Select>
        </Row>
        <EditableField label="Start date" type="date" value={p.startDate ?? ''} disabled={job} onSave={(v) => save({ startDate: v || null })} />
        <EditableField label="Leaving date" type="date" value={p.endDate ?? ''} disabled={job} onSave={(v) => save({ endDate: v || null })} />
        <EditableField label="Location" value={p.location} disabled={job} onSave={(v) => save({ location: v })} />
        <EditableField label="Work phone" type="tel" value={p.workPhone} disabled={job} onSave={(v) => save({ workPhone: v })} />
        <EditableField label="Leave allowance (days/year)" type="number" value={String(p.annualLeaveDays)} disabled={job} onSave={(v) => v !== '' && save({ annualLeaveDays: Number(v) })} />
      </section>

      {p.balance ? (
        <section aria-labelledby="bal-h">
          <h2 id="bal-h" className="mb-1 font-medium">Annual leave {p.balance.year}</h2>
          <p className="text-[13px]">
            <strong>{p.balance.remaining}</strong> of {p.balance.allowance} days left · {p.balance.taken} taken
            {p.balance.pending ? ` · ${p.balance.pending} waiting for approval` : ''}
          </p>
        </section>
      ) : null}

      {priv ? (
        <section className="space-y-2" aria-labelledby="priv-h">
          <h2 id="priv-h" className="font-medium">
            Personal details <span className="text-[12px] font-normal text-muted">— only {p.name.split(' ')[0]}, HR and their managers can see this</span>
          </h2>
          <EditableField label="Personal email" type="email" value={priv.personalEmail ?? ''} disabled={!p.canEdit.personal} onSave={(v) => savePrivate({ personalEmail: v.trim() })} />
          <EditableField label="Personal phone" type="tel" value={priv.personalPhone ?? ''} disabled={!p.canEdit.personal} onSave={(v) => savePrivate({ personalPhone: v })} />
          <EditableField label="Home address" value={priv.homeAddress ?? ''} multiline disabled={!p.canEdit.personal} onSave={(v) => savePrivate({ homeAddress: v })} />
          <EditableField label="Date of birth" type="date" value={priv.dateOfBirth ?? ''} disabled={!p.canEdit.personal} onSave={(v) => savePrivate({ dateOfBirth: v })} />
          <EditableField label="Emergency contact" value={priv.emergencyContact ?? ''} disabled={!p.canEdit.personal} placeholder="Name, relationship, phone" onSave={(v) => savePrivate({ emergencyContact: v })} />
          {p.canEdit.salary || priv.salary !== undefined ? (
            <Row label="Salary (per year)">
              {p.canEdit.salary ? (
                <div className="flex gap-2">
                  <Input
                    aria-label="Salary"
                    className="h-8 flex-1"
                    inputMode="decimal"
                    value={salaryText ?? (priv.salary != null ? (priv.salary / 100).toFixed(2) : '')}
                    onChange={(e) => setSalaryText(e.target.value)}
                    onBlur={() => {
                      if (salaryText === null) return;
                      const v = salaryText.trim() === '' ? null : parseMoney(salaryText);
                      setSalaryText(null);
                      if (v === null && salaryText.trim() !== '') return toast({ tone: 'error', message: 'Enter the salary as a number, e.g. 42,000' });
                      void savePrivate({ salary: v });
                    }}
                  />
                  <Select aria-label="Salary currency" className="h-8" value={priv.salaryCurrency ?? 'GBP'} onChange={(e) => savePrivate({ salaryCurrency: e.target.value })}>
                    {COMMON_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                  </Select>
                </div>
              ) : (
                <span>{priv.salary != null ? formatMoney(priv.salary, priv.salaryCurrency ?? 'GBP') : '—'}</span>
              )}
            </Row>
          ) : null}
          {me.isHrAdmin ? <EditableField label="HR notes" value={priv.notes ?? ''} multiline onSave={(v) => savePrivate({ notes: v })} /> : null}
        </section>
      ) : (
        <p className="text-[13px] text-muted">Personal details are private to {p.name.split(' ')[0]}, HR and their managers.</p>
      )}

      {docs ? (
        <section aria-labelledby="docs-h">
          <h2 id="docs-h" className="mb-1 font-medium">Documents</h2>
          {docs.length === 0 ? <p className="text-[13px] text-muted">No documents.</p> : null}
          <ul className="space-y-1">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2 py-1 text-[13px]">
                <a className="truncate text-accent hover:underline" href={d.url} download={d.filename}>
                  📄 {d.filename}
                </a>
                <span className="shrink-0 text-muted">
                  {d.category} · {formatBytes(d.sizeBytes)}
                  {me.isHrAdmin ? (
                    <button
                      className="ml-2 hover:text-danger"
                      aria-label={`Delete ${d.filename}`}
                      onClick={() => window.confirm(`Delete ${d.filename}?`) && api.hr.removeDocument(org, d.id).then(load, (err) => toast({ tone: 'error', message: errorMessage(err) }))}
                    >
                      ✕
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {me.isHrAdmin ? (
            <div className="mt-2 flex items-center gap-2">
              <Select aria-label="Document type" value={category} onChange={(e) => setCategory(e.target.value)}>
                {HR_DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}
              </Select>
              <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void upload(e)} />
              <Button busy={uploading} onClick={() => fileInput.current?.click()}>Upload document</Button>
              <span className="text-[12px] text-muted">Up to 10 MB, stored encrypted.</span>
            </div>
          ) : null}
        </section>
      ) : null}

      {me.isOwner ? (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={p.isHrAdmin} onChange={(e) => api.hr.setAdmin(org, userId, e.target.checked).then(() => { void load(); onChanged(); }, (err) => toast({ tone: 'error', message: errorMessage(err) }))} />
          HR admin (sees everyone’s personal details, pay and documents)
        </label>
      ) : null}
    </SidePanel>
  );
}
