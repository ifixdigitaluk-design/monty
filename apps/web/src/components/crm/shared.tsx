'use client';

import { ACTIVITY_TYPES, followUpState, type ActivityType } from '@monty/domain';
import type { CrmActivityDto } from '@monty/validation';
import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, cx, Input, Select, Textarea, useToast } from '../ui';

export interface Member {
  id: string;
  name: string;
}

export const ACTIVITY_LABEL: Record<ActivityType, string> = { note: 'Note', call: 'Call', meeting: 'Meeting', email: 'Email', task: 'To-do' };
const ACTIVITY_ICON: Record<ActivityType, string> = { note: '📝', call: '📞', meeting: '👥', email: '✉️', task: '☑️' };

/** Right-hand panel used for company, contact and deal details. */
export function SidePanel({ label, onClose, children, footer }: { label: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={label} className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-xl">
      <div className="flex h-12 items-center justify-between border-b border-line px-4">
        <span className="text-[13px] text-muted">{label.split(':')[0]}</span>
        <Button variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-5">{children}</div>
      {footer ? <div className="flex justify-end gap-2 border-t border-line p-3">{footer}</div> : null}
    </div>
  );
}

/** Label + value that saves on blur (Enter for single-line). Disabled for read-only users. */
export function EditableField({
  label,
  value,
  onSave,
  disabled,
  multiline,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
  multiline?: boolean;
  type?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const common = {
    'aria-label': label,
    value: draft,
    disabled,
    placeholder: disabled ? '' : (placeholder ?? '—'),
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      if (draft !== value) onSave(draft);
    },
  };
  return (
    <label className="grid grid-cols-[8rem_1fr] items-start gap-3">
      <span className="pt-1.5 text-[13px] text-muted">{label}</span>
      {multiline ? (
        <Textarea {...common} rows={3} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <Input {...common} type={type} className="h-8" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
    </label>
  );
}

export function MemberSelect({ label, value, members, onChange, disabled, allowNone = true }: { label: string; value: string | null; members: Member[]; onChange: (id: string | null) => void; disabled?: boolean; allowNone?: boolean }) {
  return (
    <Select aria-label={label} className="h-8 w-full" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone ? <option value="">Nobody</option> : null}
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </Select>
  );
}

export function FollowUpBadge({ a }: { a: { dueAt: string | null; doneAt: string | null } }) {
  const s = followUpState(a);
  if (s === 'none') return null;
  const style = { overdue: 'text-danger', today: 'text-warning', upcoming: 'text-muted', done: 'text-success' }[s];
  const text = s === 'done' ? 'Done' : s === 'overdue' ? 'Overdue' : s === 'today' ? 'Today' : 'Due';
  return (
    <span className={cx('text-[12px] font-medium', style)}>
      {text}
      {a.dueAt && s !== 'done' ? ` · ${new Date(a.dueAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
    </span>
  );
}

/** Activity history for a company, contact or deal, with a form to log a call/note or schedule a follow-up. */
export function Timeline({
  workspaceId,
  link,
  activities,
  members,
  canEdit,
  meId,
  onChanged,
}: {
  workspaceId: string;
  link: { companyId?: string; contactId?: string; dealId?: string };
  activities: CrmActivityDto[];
  members: Member[];
  canEdit: boolean;
  meId: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [type, setType] = useState<ActivityType>('note');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState<string | null>(meId);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!subject.trim()) return;
    setBusy(true);
    try {
      await api.crm.createActivity(workspaceId, {
        id: crypto.randomUUID(),
        type,
        subject: subject.trim(),
        body,
        ...link,
        ...(due ? { dueAt: new Date(due).toISOString(), assigneeId: assignee } : {}),
      });
      setSubject('');
      setBody('');
      setDue('');
      onChanged();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(a: CrmActivityDto) {
    await api.crm.updateActivity(a.id, { done: !a.doneAt }).then(onChanged, (err) => toast({ tone: 'error', message: errorMessage(err) }));
  }

  return (
    <section aria-labelledby="timeline-h">
      <h2 id="timeline-h" className="mb-2 font-medium">Activity</h2>
      {canEdit ? (
        <form onSubmit={submit} className="mb-3 space-y-2 rounded-lg border border-line p-3">
          <div className="flex gap-2">
            <Select aria-label="Activity type" value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
              {ACTIVITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACTIVITY_LABEL[t]}
                </option>
              ))}
            </Select>
            <Input aria-label="Activity summary" className="h-8 flex-1" placeholder="What happened, or what needs doing?" value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <Textarea aria-label="Activity details" rows={2} placeholder="Details (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <label className="flex items-center gap-1 text-muted">
              Follow up
              <Input aria-label="Follow-up date and time" type="datetime-local" className="h-8 w-52" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            {due ? <MemberSelect label="Follow-up assignee" value={assignee} members={members} onChange={setAssignee} allowNone={false} /> : null}
            <Button type="submit" variant="primary" className="ml-auto" busy={busy} disabled={!subject.trim()}>
              {due ? 'Schedule' : 'Log'}
            </Button>
          </div>
        </form>
      ) : null}
      {activities.length === 0 ? <p className="text-[13px] text-muted">Nothing logged yet.</p> : null}
      <ol className="space-y-2">
        {activities.map((a) => (
          <li key={a.id} className="rounded-lg border border-line p-2.5">
            <div className="flex items-start gap-2">
              {a.dueAt && canEdit ? (
                <input type="checkbox" className="mt-1" aria-label={`Mark “${a.subject}” done`} checked={!!a.doneAt} onChange={() => void toggle(a)} />
              ) : (
                <span aria-hidden="true">{ACTIVITY_ICON[a.type]}</span>
              )}
              <div className="min-w-0 flex-1">
                <p className={cx('font-medium', a.doneAt && a.dueAt && 'line-through opacity-70')}>
                  <span className="sr-only">{ACTIVITY_LABEL[a.type]}: </span>
                  {a.subject}
                </p>
                {a.body ? <p className="whitespace-pre-wrap text-[13px]">{a.body}</p> : null}
                <p className="mt-1 flex flex-wrap gap-x-2 text-[12px] text-muted">
                  <span>
                    {ACTIVITY_LABEL[a.type]} · {a.createdBy.name} · {new Date(a.createdAt).toLocaleDateString()}
                  </span>
                  {a.assignee ? <span>for {a.assignee.name}</span> : null}
                  <FollowUpBadge a={a} />
                </p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
