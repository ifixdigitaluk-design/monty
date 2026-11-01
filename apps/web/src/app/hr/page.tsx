'use client';

import { LEAVE_LABEL, LEAVE_TYPES, workingDays, type LeaveType } from '@monty/domain';
import type { ChecklistDto, HrMeDto, HrPersonDto, HrProfileDto, LeaveDto, ReviewDto } from '@monty/validation';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { PersonPanel } from '@/components/hr/PersonPanel';
import { Button, cx, EmptyState, ErrorBanner, Field, Input, Modal, PageLoading, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

const TABS = ['people', 'leave', 'onboarding', 'reviews'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { people: 'People', leave: 'Leave', onboarding: 'Onboarding & leaving', reviews: 'Reviews' };
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const typeLabel = (t: LeaveDto['type']) => (t === 'away' ? 'Away' : LEAVE_LABEL[t]);

export default function HrPage() {
  return (
    <AppShell>
      <Hr />
    </AppShell>
  );
}

function Hr() {
  const params = useSearchParams();
  const router = useRouter();
  const { organisations, user } = useSession();
  const teams = organisations.filter((o) => o.kind === 'TEAM' && o.role !== 'GUEST');
  const org = params.get('org') ?? teams[0]?.id ?? null;
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'people';
  const person = params.get('person');
  const [me, setMe] = useState<HrMeDto | null>(null);
  const [people, setPeople] = useState<HrPersonDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    try {
      const [m, p] = await Promise.all([api.hr.me(org), api.hr.people(org)]);
      setMe(m);
      setPeople(p.people);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [org]);
  useEffect(() => {
    setMe(null);
    void load();
  }, [load]);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    if (org) next.set('org', org);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`/hr?${next.toString()}`);
  };

  if (!org) {
    return (
      <div className="p-8">
        <h1 className="sr-only">HR</h1>
        <EmptyState title="HR is for team organisations" body="Create a team organisation (or ask to be added to one) to use the staff directory, leave and onboarding." />
      </div>
    );
  }
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!me) return <PageLoading />;

  return (
    <div className="p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">HR</h1>
        {teams.length > 1 ? (
          <Select aria-label="Organisation" value={org} onChange={(e) => router.replace(`/hr?org=${e.target.value}`)}>
            {teams.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        ) : (
          <span className="text-muted">{teams[0]?.name}</span>
        )}
        {me.isHrAdmin ? <span className="rounded bg-surface-2 px-2 py-0.5 text-[12px]">You’re an HR admin</span> : null}
        <Button className="ml-auto" onClick={() => go({ person: user.id })}>My HR profile</Button>
      </header>
      <div role="tablist" aria-label="HR sections" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={t === tab} onClick={() => go({ tab: t })} className={cx('-mb-px border-b-2 px-3 py-1.5 text-[13px]', t === tab ? 'border-accent font-medium' : 'border-transparent text-muted hover:text-fg')}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {tab === 'people' ? (
        <People people={people} open={(id) => go({ person: id })} />
      ) : tab === 'leave' ? (
        <Leave org={org} me={me} people={people} userId={user.id} />
      ) : tab === 'onboarding' ? (
        <Onboarding org={org} me={me} people={people} />
      ) : (
        <Reviews org={org} me={me} people={people} />
      )}
      {person ? <PersonPanel key={person} org={org} userId={person} me={me} people={people} onClose={() => go({ person: null })} onChanged={load} /> : null}
    </div>
  );
}

// ---------- People ----------

function People({ people, open }: { people: HrPersonDto[]; open: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [view, setView] = useState<'list' | 'chart'>('list');
  const shown = people.filter((p) => !q.trim() || `${p.name} ${p.jobTitle} ${p.department} ${p.email}`.toLowerCase().includes(q.trim().toLowerCase()));
  const tree = (managerId: string | null, depth: number, seen: Set<string>): React.ReactNode => {
    const kids = people.filter((p) => (p.manager?.id ?? null) === managerId && !seen.has(p.userId));
    if (!kids.length) return null;
    return (
      <ul className={cx(depth > 0 && 'ml-5 border-l border-line pl-3')}>
        {kids.map((p) => {
          const next = new Set(seen).add(p.userId);
          return (
            <li key={p.userId} className="py-0.5">
              <button className="hover:underline" onClick={() => open(p.userId)}>
                <span className="font-medium">{p.name}</span>
                {p.jobTitle ? <span className="text-muted"> — {p.jobTitle}</span> : null}
              </button>
              {tree(p.userId, depth + 1, next)}
            </li>
          );
        })}
      </ul>
    );
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Search people" placeholder="Search people…" className="h-8 w-64" value={q} onChange={(e) => setQ(e.target.value)} />
        <div role="tablist" aria-label="People view" className="inline-flex rounded-lg border border-line p-0.5">
          {(['list', 'chart'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cx('rounded-md px-3 py-1 text-[13px]', view === v ? 'bg-surface-2 font-medium' : 'text-muted')}>
              {v === 'list' ? 'Directory' : 'Org chart'}
            </button>
          ))}
        </div>
      </div>
      {view === 'chart' ? (
        <div className="rounded-lg border border-line bg-surface p-4">{tree(null, 0, new Set())}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-max text-[13px]">
            <caption className="sr-only">Staff directory</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted">
                {['Name', 'Job title', 'Department', 'Manager', 'Location', 'Email'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.userId} className="border-b border-line last:border-b-0 hover:bg-surface-2">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <button className="hover:underline" onClick={() => open(p.userId)}>{p.name}</button>
                  </th>
                  <td className="px-3 py-2">{p.jobTitle}</td>
                  <td className="px-3 py-2">{p.department}</td>
                  <td className="px-3 py-2">{p.manager?.name ?? ''}</td>
                  <td className="px-3 py-2">{p.location}</td>
                  <td className="px-3 py-2">{p.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Leave ----------

function Leave({ org, me, people, userId }: { org: string; me: HrMeDto; people: HrPersonDto[]; userId: string }) {
  const toast = useToast();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [team, setTeam] = useState<LeaveDto[]>([]);
  const [mine, setMine] = useState<LeaveDto[]>([]);
  const [toDecide, setToDecide] = useState<LeaveDto[]>([]);
  const [profile, setProfile] = useState<HrProfileDto | null>(null);
  const [requesting, setRequesting] = useState(false);
  const range = useMemo(() => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
  }, [month]);

  const load = useCallback(async () => {
    try {
      const [t, my, inbox, p] = await Promise.all([api.hr.leave(org, range), api.hr.leave(org, { userId }), api.hr.inbox(org), api.hr.profile(org, userId)]);
      setTeam(t.leave.filter((l) => l.status === 'approved' || l.status === 'pending'));
      setMine(my.leave.slice().reverse());
      setToDecide(inbox.leaveToDecide);
      setProfile(p.profile);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }, [org, range, userId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = (p: Promise<unknown>) => p.then(load, (err) => toast({ tone: 'error', message: errorMessage(err) }));
  const shift = (n: number) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    setMonth(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7));
  };
  const b = profile?.balance;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="my-leave-h">
        <h2 id="my-leave-h" className="mb-2 font-medium">My leave</h2>
        {b ? (
          <p className="mb-3">
            <span className="text-2xl font-semibold">{b.remaining}</span> <span className="text-muted">of {b.allowance} days left in {b.year}</span>
            {b.pending ? <span className="block text-[13px] text-muted">{b.pending} days waiting for approval</span> : null}
          </p>
        ) : null}
        <Button variant="primary" onClick={() => setRequesting(true)}>Request leave</Button>
        <ul className="mt-3 space-y-1 text-[13px]">
          {mine.slice(0, 8).map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2">
              <span>
                {typeLabel(l.type)} · {fmt(l.startDate)}
                {l.endDate !== l.startDate ? ` – ${fmt(l.endDate)}` : ''} · {l.days}d
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge s={l.status} />
                {l.canCancel ? <Button variant="ghost" onClick={() => window.confirm('Cancel this leave?') && act(api.hr.cancelLeave(org, l.id))}>Cancel</Button> : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4 lg:col-span-2" aria-labelledby="decide-h">
        <h2 id="decide-h" className="mb-2 font-medium">Waiting for your decision</h2>
        {toDecide.length === 0 ? <p className="text-[13px] text-muted">Nothing to approve.</p> : null}
        <ul className="space-y-2">
          {toDecide.map((l) => (
            <li key={l.id} className="rounded-lg border border-line p-2.5">
              <p>
                <span className="font-medium">{l.user.name}</span> — {typeLabel(l.type)}, {fmt(l.startDate)}
                {l.endDate !== l.startDate ? ` to ${fmt(l.endDate)}` : ''} ({l.days} {l.days === 1 ? 'day' : 'days'})
              </p>
              {l.reason ? <p className="text-[13px] text-muted">“{l.reason}”</p> : null}
              <div className="mt-2 flex gap-2">
                <Button variant="primary" aria-label={`Approve ${l.user.name}'s leave`} onClick={() => act(api.hr.decideLeave(org, l.id, { decision: 'approved' }))}>Approve</Button>
                <Button
                  aria-label={`Decline ${l.user.name}'s leave`}
                  onClick={() => {
                    const note = window.prompt('Reason for declining (shown to them):') ?? undefined;
                    if (note !== undefined) void act(api.hr.decideLeave(org, l.id, { decision: 'declined', note }));
                  }}
                >
                  Decline
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4 lg:col-span-3" aria-labelledby="away-h">
        <div className="mb-2 flex items-center gap-2">
          <h2 id="away-h" className="font-medium">
            Who’s away — {new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </h2>
          <Button variant="ghost" aria-label="Previous month" onClick={() => shift(-1)}>←</Button>
          <Button variant="ghost" aria-label="Next month" onClick={() => shift(1)}>→</Button>
        </div>
        {team.length === 0 ? <p className="text-[13px] text-muted">Nobody is away this month.</p> : null}
        <table className="w-full text-[13px]">
          <caption className="sr-only">Leave this month</caption>
          <tbody>
            {team.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-b-0">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">{l.user.name}</th>
                <td className="py-1.5 pr-3">{fmt(l.startDate)}{l.endDate !== l.startDate ? ` – ${fmt(l.endDate)}` : l.halfDay ? ' (half day)' : ''}</td>
                <td className="py-1.5 pr-3">{typeLabel(l.type)}</td>
                <td className="py-1.5"><StatusBadge s={l.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {requesting ? <RequestLeave org={org} me={me} people={people} onClose={() => setRequesting(false)} onDone={() => { setRequesting(false); void load(); }} /> : null}
    </div>
  );
}

function StatusBadge({ s }: { s: LeaveDto['status'] }) {
  const tone = { pending: 'text-warning', approved: 'text-success', declined: 'text-danger', cancelled: 'text-muted' }[s];
  return <span className={cx('text-[12px] font-medium capitalize', tone)}>{s}</span>;
}

function RequestLeave({ org, me, people, onClose, onDone }: { org: string; me: HrMeDto; people: HrPersonDto[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<LeaveType>('annual');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [half, setHalf] = useState(false);
  const [reason, setReason] = useState('');
  const [forUser, setForUser] = useState('');
  const [busy, setBusy] = useState(false);
  const days = start && (end || start) >= start ? workingDays(start, end || start, half) : 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.hr.requestLeave(org, { id: crypto.randomUUID(), type, startDate: start, endDate: end || start, halfDay: half && (!end || end === start), reason, ...(forUser ? { userId: forUser } : {}) });
      toast({ tone: 'success', message: forUser ? 'Leave recorded' : 'Request sent for approval' });
      onDone();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Request leave">
      <form onSubmit={submit} className="space-y-3">
        {me.isHrAdmin ? (
          <Field label="For" htmlFor="lv-for" hint="HR can record leave for someone else, e.g. sickness reported by phone.">
            <Select id="lv-for" className="w-full" value={forUser} onChange={(e) => setForUser(e.target.value)}>
              <option value="">Me</option>
              {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label="Type" htmlFor="lv-type">
          <Select id="lv-type" className="w-full" value={type} onChange={(e) => setType(e.target.value as LeaveType)}>
            {LEAVE_TYPES.map((t) => <option key={t} value={t}>{LEAVE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First day" htmlFor="lv-start">
            <Input id="lv-start" type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Last day" htmlFor="lv-end">
            <Input id="lv-end" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        {!end || end === start ? (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} /> Half day
          </label>
        ) : null}
        <Field label="Note (optional)" htmlFor="lv-reason" hint="Only you, your managers and HR see this.">
          <Textarea id="lv-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="text-[13px] text-muted" aria-live="polite">{start ? `${days} working ${days === 1 ? 'day' : 'days'} (weekends aren’t counted)` : ''}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!start || days === 0}>{forUser ? 'Record leave' : 'Send request'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Onboarding / offboarding ----------

function Onboarding({ org, me, people }: { org: string; me: HrMeDto; people: HrPersonDto[] }) {
  const toast = useToast();
  const [lists, setLists] = useState<ChecklistDto[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.hr.checklists(org).then((r) => setLists(r.checklists), (err) => toast({ tone: 'error', message: errorMessage(err) })), [org, toast]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!lists) return <PageLoading />;
  const replace = (c: ChecklistDto) => setLists((all) => all?.map((x) => (x.id === c.id ? c : x)) ?? null);
  return (
    <div className="max-w-4xl space-y-4">
      {me.isHrAdmin ? <Button variant="primary" onClick={() => setCreating(true)}>Start onboarding or leaving checklist</Button> : null}
      {lists.length === 0 ? <EmptyState title="No checklists" body={me.isHrAdmin ? 'Start one when someone joins or leaves: each step goes to HR, their manager or IT.' : 'Steps assigned to you for new joiners or leavers appear here.'} /> : null}
      {lists.map((c) => (
        <section key={c.id} className="rounded-lg border border-line bg-surface p-4" aria-label={c.title}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-medium">{c.title}</h2>
            <span className="text-[13px] text-muted">
              {c.done} of {c.total} done{c.dueDate ? ` · ${c.kind === 'onboarding' ? 'starts' : 'leaves'} ${fmt(c.dueDate)}` : ''}
            </span>
          </div>
          <div className="mb-3 h-1.5 overflow-hidden rounded bg-surface-2" aria-hidden="true">
            <div className="h-full bg-accent" style={{ width: `${c.total ? (100 * c.done) / c.total : 0}%` }} />
          </div>
          <ul className="space-y-1">
            {c.items.map((i) => (
              <li key={i.id} className="flex items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  aria-label={i.title}
                  checked={!!i.doneAt}
                  disabled={!i.canTick}
                  onChange={(e) => {
                    const done = e.target.checked;
                    // Show the tick straight away; the server's answer (or an error) settles it.
                    replace({ ...c, done: c.done + (done ? 1 : -1), items: c.items.map((x) => (x.id === i.id ? { ...x, doneAt: done ? new Date().toISOString() : null } : x)) });
                    api.hr.updateChecklistItem(org, i.id, { done }).then(
                      (r) => replace(r.checklist),
                      (err) => {
                        replace(c);
                        toast({ tone: 'error', message: errorMessage(err) });
                      },
                    );
                  }}
                />
                <span className={cx('flex-1', i.doneAt && 'line-through opacity-70')}>{i.title}</span>
                <span className="shrink-0 text-muted">
                  {i.assignee?.name ?? 'Unassigned'}
                  {i.dueDate ? ` · ${fmt(i.dueDate)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {me.isHrAdmin ? (
            <div className="mt-3 flex gap-2">
              <AddStep org={org} checklistId={c.id} people={people} onAdded={replace} />
              <Button variant="ghost" className="ml-auto text-danger" onClick={() => window.confirm(`Delete “${c.title}”?`) && api.hr.removeChecklist(org, c.id).then(load)}>Delete</Button>
            </div>
          ) : null}
        </section>
      ))}
      {creating ? <NewChecklist org={org} people={people} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} /> : null}
    </div>
  );
}

function AddStep({ org, checklistId, people, onAdded }: { org: string; checklistId: string; people: HrPersonDto[]; onAdded: (c: ChecklistDto) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [who, setWho] = useState('');
  return (
    <form
      className="flex flex-1 flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        api.hr.addChecklistItem(org, checklistId, { title: title.trim(), assigneeId: who || null }).then((r) => { onAdded(r.checklist); setTitle(''); }, (err) => toast({ tone: 'error', message: errorMessage(err) }));
      }}
    >
      <Input aria-label="New step" placeholder="Add a step…" className="h-8 min-w-48 flex-1" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Select aria-label="New step assignee" value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">Unassigned</option>
        {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
      </Select>
      <Button type="submit" disabled={!title.trim()}>Add</Button>
    </form>
  );
}

function NewChecklist({ org, people, onClose, onCreated }: { org: string; people: HrPersonDto[]; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<'onboarding' | 'offboarding'>('onboarding');
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [due, setDue] = useState('');
  const [hr, setHr] = useState('');
  const [manager, setManager] = useState('');
  const [it, setIt] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = (id: string, label: string, v: string, set: (v: string) => void, none = 'Unassigned') => (
    <Field label={label} htmlFor={id}>
      <Select id={id} className="w-full" value={v} onChange={(e) => set(e.target.value)}>
        <option value="">{none}</option>
        {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
      </Select>
    </Field>
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    const subjectName = name.trim() || people.find((p) => p.userId === subject)?.name || '';
    if (!subjectName) return;
    setBusy(true);
    try {
      await api.hr.createChecklist(org, { id: crypto.randomUUID(), kind, subjectName, subjectUserId: subject || null, dueDate: due || null, assignees: { hr: hr || null, manager: manager || null, it: it || null } });
      onCreated();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="New checklist">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Type" htmlFor="cl-kind">
          <Select id="cl-kind" className="w-full" value={kind} onChange={(e) => setKind(e.target.value as 'onboarding' | 'offboarding')}>
            <option value="onboarding">Onboarding (someone joining)</option>
            <option value="offboarding">Leaving (someone going)</option>
          </Select>
        </Field>
        {kind === 'onboarding' ? (
          <Field label="New joiner’s name" htmlFor="cl-name" hint="They don’t need a Monty account yet.">
            <Input id="cl-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : null}
        {pick('cl-subject', kind === 'onboarding' ? 'Their Monty account (if they have one)' : 'Who is leaving', subject, setSubject, 'None')}
        <Field label={kind === 'onboarding' ? 'Start date' : 'Last day'} htmlFor="cl-due" hint="Steps are scheduled around this date.">
          <Input id="cl-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        {pick('cl-hr', 'HR steps', hr, setHr, 'Me')}
        {pick('cl-manager', 'Manager steps', manager, setManager, 'Their manager (if known)')}
        {pick('cl-it', 'IT steps', it, setIt)}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!(name.trim() || subject)}>Create checklist</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Reviews ----------

function Reviews({ org, me, people }: { org: string; me: HrMeDto; people: HrPersonDto[] }) {
  const toast = useToast();
  const [reviews, setReviews] = useState<ReviewDto[] | null>(null);
  const [editing, setEditing] = useState<ReviewDto | 'new' | null>(null);
  const load = useCallback(() => api.hr.reviews(org).then((r) => setReviews(r.reviews), (err) => toast({ tone: 'error', message: errorMessage(err) })), [org, toast]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!reviews) return <PageLoading />;
  const reviewable = people.filter((p) => me.reportIds.includes(p.userId));
  return (
    <div className="max-w-4xl space-y-3">
      {reviewable.length ? <Button variant="primary" onClick={() => setEditing('new')}>Write a review</Button> : null}
      {reviews.length === 0 ? <EmptyState title="No reviews" body="Managers and HR write reviews here. You see yours once your reviewer shares it." /> : null}
      <ul className="space-y-2">
        {reviews.map((r) => (
          <li key={r.id} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <button className="font-medium hover:underline" onClick={() => setEditing(r)}>
                {r.subject.name} · {r.period}
              </button>
              <span className="text-[13px] text-muted">
                by {r.reviewer.name} · {r.status === 'shared' ? `shared ${new Date(r.sharedAt!).toLocaleDateString()}` : 'draft (not visible to them yet)'}
                {r.rating ? ` · ${r.rating}/5` : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {editing ? <ReviewEditor org={org} review={editing === 'new' ? null : editing} people={reviewable} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} /> : null}
    </div>
  );
}

function ReviewEditor({ org, review, people, onClose, onSaved }: { org: string; review: ReviewDto | null; people: HrPersonDto[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [subject, setSubject] = useState(review?.subject.id ?? people[0]?.userId ?? '');
  const [f, setF] = useState({ period: review?.period ?? `H${new Date().getMonth() < 6 ? 1 : 2} ${new Date().getFullYear()}`, rating: review?.rating ? String(review.rating) : '', strengths: review?.strengths ?? '', improvements: review?.improvements ?? '', goals: review?.goals ?? '', notes: review?.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const readOnly = review !== null && !review.canEdit;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save(share: boolean) {
    if (share && !window.confirm('Share this review? They’ll be able to read it (not your private notes) and it can no longer be changed.')) return;
    setBusy(true);
    const body = { period: f.period.trim(), rating: f.rating ? Number(f.rating) : null, strengths: f.strengths, improvements: f.improvements, goals: f.goals, notes: f.notes };
    try {
      const saved = review ? (await api.hr.updateReview(org, review.id, body)).review : (await api.hr.createReview(org, { subjectUserId: subject, ...body })).review;
      if (share) await api.hr.updateReview(org, saved.id, { share: true });
      onSaved();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      setBusy(false);
    }
  }
  const area = (k: 'strengths' | 'improvements' | 'goals' | 'notes', label: string, hint?: string) => (
    <Field label={label} htmlFor={`rv-${k}`} hint={hint}>
      <Textarea id={`rv-${k}`} rows={3} value={f[k]} disabled={readOnly} onChange={set(k)} />
    </Field>
  );
  return (
    <Modal open onClose={onClose} title={review ? `Review: ${review.subject.name}` : 'Write a review'}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        {review ? null : (
          <Field label="Person" htmlFor="rv-subject">
            <Select id="rv-subject" className="w-full" value={subject} onChange={(e) => setSubject(e.target.value)}>
              {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Period" htmlFor="rv-period">
            <Input id="rv-period" value={f.period} disabled={readOnly} onChange={set('period')} />
          </Field>
          <Field label="Overall rating" htmlFor="rv-rating">
            <Select id="rv-rating" className="w-full" value={f.rating} disabled={readOnly} onChange={set('rating')}>
              <option value="">No rating</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} / 5</option>)}
            </Select>
          </Field>
        </div>
        {area('strengths', 'What went well')}
        {area('improvements', 'What to improve')}
        {area('goals', 'Goals for next period')}
        {review?.notes !== '' || !review || review.canEdit ? area('notes', 'Private notes', 'Never shown to the person reviewed.') : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {readOnly ? null : (
            <>
              <Button busy={busy} disabled={!f.period.trim() || !subject} onClick={() => void save(false)}>Save draft</Button>
              <Button variant="primary" busy={busy} disabled={!f.period.trim() || !subject} onClick={() => void save(true)}>Share with them</Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
