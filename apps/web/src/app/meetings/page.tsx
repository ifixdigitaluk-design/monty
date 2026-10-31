'use client';

import { canInWorkspace } from '@monty/domain';
import type { MeetingDto, WorkspaceMemberDto } from '@monty/validation';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { SidePanel } from '@/components/crm/shared';
import { Button, cx, EmptyState, ErrorBanner, Field, Input, Modal, PageLoading, Select, Spinner, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Member {
  id: string;
  name: string;
}
const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export default function MeetingsPage() {
  return (
    <AppShell>
      <Meetings />
    </AppShell>
  );
}

function Meetings() {
  const params = useSearchParams();
  const router = useRouter();
  const { organisations, user } = useSession();
  const workspaces = useMemo(
    () => organisations.flatMap((o) => o.workspaces.map((w) => ({ id: w.id, role: w.role, label: o.kind === 'PERSONAL' ? 'Personal' : `${o.name} · ${w.name}`, team: o.kind === 'TEAM' }))),
    [organisations],
  );
  const ws = params.get('ws') ?? workspaces.find((w) => w.team)?.id ?? workspaces[0]?.id ?? null;
  const workspace = workspaces.find((w) => w.id === ws);
  const openId = params.get('id');
  const [list, setList] = useState<MeetingDto[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showPast, setShowPast] = useState(false);

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      setList((await api.meetings.list(ws)).meetings);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [ws]);
  useEffect(() => {
    setList(null);
    void load();
    if (ws)
      api.members
        .workspace(ws)
        .then((r) => setMembers((r.members as WorkspaceMemberDto[]).filter((m) => m.effectiveRole).map((m) => ({ id: m.id, name: m.name }))))
        .catch(() => setMembers([]));
  }, [ws, load]);

  const go = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    if (ws) q.set('ws', ws);
    for (const [k, v] of Object.entries(patch)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    router.replace(`/meetings?${q.toString()}`);
  };

  if (!workspace) return <div className="p-8"><ErrorBanner message="Workspace not found." /></div>;
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  const canCreate = canInWorkspace(workspace.role, 'task.create');
  const now = Date.now();
  const upcoming = (list ?? []).filter((m) => Date.parse(m.endsAt) >= now);
  const past = (list ?? []).filter((m) => Date.parse(m.endsAt) < now).reverse();
  const shown = showPast ? past : upcoming;

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Meetings</h1>
        <Select aria-label="Workspace" value={ws ?? ''} onChange={(e) => router.replace(`/meetings?ws=${e.target.value}`)}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </Select>
        {canCreate ? <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>Schedule meeting</Button> : null}
      </header>
      <div role="tablist" aria-label="Meetings" className="mb-3 flex gap-1 border-b border-line">
        {[false, true].map((p) => (
          <button key={String(p)} role="tab" aria-selected={showPast === p} onClick={() => setShowPast(p)} className={cx('-mb-px border-b-2 px-3 py-1.5 text-[13px]', showPast === p ? 'border-accent font-medium' : 'border-transparent text-muted')}>
            {p ? `Past (${past.length})` : `Upcoming (${upcoming.length})`}
          </button>
        ))}
      </div>
      {!list ? (
        <PageLoading />
      ) : shown.length === 0 ? (
        <EmptyState title={showPast ? 'No past meetings' : 'No upcoming meetings'} body="Schedule a meeting for this workspace: everyone you invite gets a notification, a video link and a calendar file." />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {shown.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <button className={cx('font-medium hover:underline', m.cancelled && 'line-through opacity-70')} onClick={() => go({ id: m.id })}>
                  {m.title}
                </button>
                <p className="text-[13px] text-muted">
                  {fmt(m.startsAt)} · {m.durationMinutes} min · {m.attendees.length} {m.attendees.length === 1 ? 'person' : 'people'}
                  {m.cancelled ? ' · Cancelled' : ''}
                </p>
              </div>
              {!m.cancelled && !showPast ? (
                <a className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg" href={m.videoUrl} target="_blank" rel="noopener noreferrer">
                  Join
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {creating ? <NewMeeting ws={ws!} members={members.filter((m) => m.id !== user.id)} onClose={() => setCreating(false)} onCreated={(m) => { setCreating(false); void load(); go({ id: m.id }); }} /> : null}
      {openId ? <MeetingPanel key={openId} id={openId} members={members} onClose={() => go({ id: null })} onChanged={load} /> : null}
    </div>
  );
}

function PeoplePicker({ members, value, onChange }: { members: Member[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="max-h-40 overflow-y-auto rounded-lg border border-line p-2">
      <legend className="px-1 text-[13px]">Invite</legend>
      {members.length === 0 ? <p className="text-[13px] text-muted">Nobody else in this workspace yet.</p> : null}
      {members.map((m) => (
        <label key={m.id} className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={value.includes(m.id)} onChange={(e) => onChange(e.target.checked ? [...value, m.id] : value.filter((x) => x !== m.id))} /> {m.name}
        </label>
      ))}
    </fieldset>
  );
}

function NewMeeting({ ws, members, onClose, onCreated }: { ws: string; members: Member[]; onClose: () => void; onCreated: (m: MeetingDto) => void }) {
  const toast = useToast();
  const next = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000 + 3_600_000);
  const [f, setF] = useState({ title: '', start: localInput(next), duration: '30', link: '', location: '', agenda: '' });
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { meeting } = await api.meetings.create(ws, {
        id: crypto.randomUUID(),
        title: f.title.trim(),
        startsAt: new Date(f.start).toISOString(),
        durationMinutes: Number(f.duration),
        videoUrl: f.link.trim(),
        location: f.location.trim(),
        agenda: f.agenda,
        attendeeIds: people,
      });
      onCreated(meeting);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Schedule meeting">
      <form onSubmit={submit} className="max-h-[75vh] space-y-3 overflow-y-auto pr-1">
        <Field label="Title" htmlFor="mt-title">
          <Input id="mt-title" required value={f.title} maxLength={200} onChange={set('title')} placeholder="e.g. Sales weekly" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" htmlFor="mt-start">
            <Input id="mt-start" type="datetime-local" required value={f.start} onChange={set('start')} />
          </Field>
          <Field label="Length" htmlFor="mt-dur">
            <Select id="mt-dur" className="w-full" value={f.duration} onChange={set('duration')}>
              {[15, 30, 45, 60, 90, 120].map((n) => <option key={n} value={n}>{n} minutes</option>)}
            </Select>
          </Field>
        </div>
        <PeoplePicker members={members} value={people} onChange={setPeople} />
        <Field label="Video link (optional)" htmlFor="mt-link" hint="Leave empty for a free Jitsi link, or paste a Google Meet, Teams or Zoom link.">
          <Input id="mt-link" type="url" value={f.link} onChange={set('link')} placeholder="https://…" />
        </Field>
        <Field label="Room (optional)" htmlFor="mt-loc">
          <Input id="mt-loc" value={f.location} onChange={set('location')} placeholder="e.g. Meeting room 2" />
        </Field>
        <Field label="Agenda" htmlFor="mt-agenda">
          <Textarea id="mt-agenda" rows={4} value={f.agenda} onChange={set('agenda')} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!f.title.trim()}>Schedule and invite</Button>
        </div>
      </form>
    </Modal>
  );
}

function MeetingPanel({ id, members, onClose, onChanged }: { id: string; members: Member[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [m, setM] = useState<MeetingDto | null>(null);
  const [minutes, setMinutes] = useState('');
  const [newItem, setNewItem] = useState('');
  const [newWho, setNewWho] = useState('');
  useEffect(() => {
    api.meetings.get(id).then(
      (r) => {
        setM(r.meeting);
        setMinutes(r.meeting.minutes);
      },
      (err) => {
        toast({ tone: 'error', message: errorMessage(err) });
        onClose();
      },
    );
  }, [id, toast, onClose]);
  if (!m) return <SidePanel label="Meeting" onClose={onClose}><Spinner /></SidePanel>;
  const save = (patch: Parameters<typeof api.meetings.update>[1], done?: string) =>
    api.meetings.update(m.id, patch).then(
      (r) => {
        setM(r.meeting);
        onChanged();
        if (done) toast({ tone: 'success', message: done });
      },
      (err) => toast({ tone: 'error', message: errorMessage(err) }),
    );
  const items = m.actionItems;
  return (
    <SidePanel
      label={`Meeting: ${m.title}`}
      onClose={onClose}
      footer={
        m.canEdit ? (
          <>
            <Button onClick={() => save({ cancelled: !m.cancelled }, m.cancelled ? 'Meeting restored' : 'Meeting cancelled; attendees told')}>{m.cancelled ? 'Restore meeting' : 'Cancel meeting'}</Button>
            <Button variant="danger" onClick={() => window.confirm(`Delete “${m.title}” and its minutes?`) && api.meetings.remove(m.id).then(() => { onChanged(); onClose(); })}>Delete</Button>
          </>
        ) : undefined
      }
    >
      <div>
        <h2 className={cx('text-lg font-semibold', m.cancelled && 'line-through')}>{m.title}</h2>
        <p className="text-[13px] text-muted">
          {fmt(m.startsAt)} – {new Date(m.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · organised by {m.organizer.name}
          {m.location ? ` · ${m.location}` : ''}
        </p>
        {m.cancelled ? <p className="mt-1 text-[13px] text-danger">This meeting was cancelled.</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {!m.cancelled ? <a className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg" href={m.videoUrl} target="_blank" rel="noopener noreferrer">Join video call</a> : null}
        <a className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-surface-2" href={api.meetings.icsUrl(m.id)} download>Add to calendar (.ics)</a>
        <Button onClick={() => void navigator.clipboard?.writeText(m.videoUrl).then(() => toast({ tone: 'success', message: 'Link copied' }))}>Copy link</Button>
      </div>
      {m.canEdit ? (
        <Field label="Video link" htmlFor="mp-link" hint="Paste a Google Meet, Teams or Zoom link to replace it. Clear it for a new Jitsi link.">
          <Input id="mp-link" type="url" defaultValue={m.videoUrl} onBlur={(e) => e.target.value !== m.videoUrl && save({ videoUrl: e.target.value }, 'Link updated')} />
        </Field>
      ) : null}
      <section aria-labelledby="mp-people">
        <h2 id="mp-people" className="mb-1 font-medium">People ({m.attendees.length})</h2>
        {m.canEdit ? (
          <PeoplePicker members={members} value={m.attendees.map((a) => a.id)} onChange={(v) => save({ attendeeIds: v })} />
        ) : (
          <p className="text-[13px]">{m.attendees.map((a) => a.name).join(', ')}</p>
        )}
      </section>
      <section aria-labelledby="mp-agenda">
        <h2 id="mp-agenda" className="mb-1 font-medium">Agenda</h2>
        {m.canEdit ? (
          <Textarea aria-label="Agenda" rows={4} defaultValue={m.agenda} onBlur={(e) => e.target.value !== m.agenda && save({ agenda: e.target.value })} />
        ) : (
          <p className="whitespace-pre-wrap text-[13px]">{m.agenda || 'No agenda.'}</p>
        )}
      </section>
      <section aria-labelledby="mp-minutes">
        <h2 id="mp-minutes" className="mb-1 font-medium">Minutes</h2>
        <Textarea aria-label="Minutes" rows={6} placeholder="Decisions and notes — saved when you click away." value={minutes} onChange={(e) => setMinutes(e.target.value)} onBlur={() => minutes !== m.minutes && save({ minutes }, 'Minutes saved')} />
      </section>
      <section aria-labelledby="mp-actions">
        <h2 id="mp-actions" className="mb-1 font-medium">Action items</h2>
        {items.length === 0 ? <p className="text-[13px] text-muted">None yet.</p> : null}
        <ul className="space-y-1">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" aria-label={a.text} checked={a.done} onChange={(e) => save({ actionItems: items.map((x) => (x.id === a.id ? { ...x, done: e.target.checked } : x)) })} />
              <span className={cx('flex-1', a.done && 'line-through opacity-70')}>{a.text}</span>
              <span className="text-muted">{members.find((x) => x.id === a.assigneeId)?.name ?? ''}</span>
              <button className="text-muted hover:text-danger" aria-label={`Remove ${a.text}`} onClick={() => save({ actionItems: items.filter((x) => x.id !== a.id) })}>✕</button>
            </li>
          ))}
        </ul>
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newItem.trim()) return;
            void save({ actionItems: [...items, { id: crypto.randomUUID().slice(0, 8), text: newItem.trim(), assigneeId: newWho || null, done: false }] }).then(() => setNewItem(''));
          }}
        >
          <Input aria-label="New action item" className="h-8 min-w-48 flex-1" placeholder="Add an action…" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
          <Select aria-label="Action owner" value={newWho} onChange={(e) => setNewWho(e.target.value)}>
            <option value="">No owner</option>
            {members.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <Button type="submit" disabled={!newItem.trim()}>Add</Button>
        </form>
      </section>
    </SidePanel>
  );
}
