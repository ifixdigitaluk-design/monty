'use client';

import { canInOrg, PLAN_LIMITS } from '@monty/domain';
import type { AuditEntryDto, InvitationDto, OrgMemberDto, OrgRoleValue, WorkspaceRoleValue } from '@monty/validation';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, Button, cx, ErrorBanner, Field, Input, PageLoading, Select, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ORG_ROLE_LABEL, WS_ROLE_LABEL } from '@/lib/labels';
import { useSession } from '@/lib/session';

export default function OrganisationPage() {
  return (
    <AppShell>
      <OrganisationView />
    </AppShell>
  );
}

type Tab = 'members' | 'invitations' | 'audit' | 'plan' | 'settings';

function OrganisationView() {
  const id = useSearchParams().get('id');
  const { organisations, user, refreshOrganisations } = useSession();
  const router = useRouter();
  const toast = useToast();
  const org = organisations.find((o) => o.id === id);
  const [tab, setTab] = useState<Tab>('members');
  const [members, setMembers] = useState<OrgMemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = org ? canInOrg(org.role, 'org.manage') : false;

  const loadMembers = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      setMembers((await api.members.list(id)).members);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  if (!id || !org) return <div className="p-8"><ErrorBanner message="Organisation not found." /></div>;
  if (org.kind === 'PERSONAL') {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Personal space</h1>
        <p className="mt-2 text-muted">Your personal space is private to you. To work with others, create a team organisation from the sidebar.</p>
      </div>
    );
  }
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={loadMembers} /></div>;
  if (!members) return <PageLoading />;

  async function changeRole(m: OrgMemberDto, role: OrgRoleValue) {
    try {
      await api.members.changeRole(id!, m.id, role);
      toast({ tone: 'success', message: `${m.name} is now ${ORG_ROLE_LABEL[role].toLowerCase()}.` });
      await Promise.all([loadMembers(), refreshOrganisations()]);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
      void loadMembers();
    }
  }

  async function remove(m: OrgMemberDto) {
    const self = m.id === user.id;
    if (!window.confirm(self ? `Leave ${org!.name}?` : `Remove ${m.name} from ${org!.name}? They lose access to all its workspaces.`)) return;
    try {
      await api.members.remove(id!, m.id);
      if (self) {
        await refreshOrganisations();
        router.replace('/tasks');
        return;
      }
      toast({ tone: 'success', message: `${m.name} was removed.` });
      void loadMembers();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'members', label: `Members (${members.length})`, show: true },
    { key: 'invitations', label: 'Invitations', show: canManage },
    { key: 'audit', label: 'Audit log', show: canManage },
    { key: 'plan', label: 'Plan & usage', show: true },
    { key: 'settings', label: 'Settings', show: canManage },
  ];

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-xl font-semibold">{org.name}</h1>
      <p className="mb-4 text-muted">Your role: {ORG_ROLE_LABEL[org.role]}</p>

      <div role="tablist" aria-label="Organisation settings" className="mb-4 flex gap-1 border-b border-line">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cx('-mb-px border-b-2 px-3 py-2 text-[13px]', tab === t.key ? 'border-accent font-medium' : 'border-transparent text-muted')}
            >
              {t.label}
            </button>
          ))}
      </div>

      {tab === 'members' ? (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface" aria-label="Members">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-member={m.email}>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {m.name} {m.id === user.id ? <span className="text-muted">(you)</span> : null}
                </p>
                <p className="truncate text-[12px] text-muted">
                  {m.email}
                  {m.workspaces.length ? ` · ${m.workspaces.map((w) => `${w.name} (${WS_ROLE_LABEL[w.role]})`).join(', ')}` : ''}
                </p>
              </div>
              {canManage && (org.role === 'OWNER' || m.role !== 'OWNER') ? (
                <Select aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => void changeRole(m, e.target.value as OrgRoleValue)}>
                  {(org.role === 'OWNER' ? (['OWNER', 'ADMIN', 'MEMBER', 'GUEST'] as const) : (['ADMIN', 'MEMBER', 'GUEST'] as const)).map((r) => (
                    <option key={r} value={r}>
                      {ORG_ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              ) : (
                <Badge>{ORG_ROLE_LABEL[m.role]}</Badge>
              )}
              {m.id === user.id ? (
                <Button variant="ghost" onClick={() => void remove(m)}>
                  Leave
                </Button>
              ) : canManage && (org.role === 'OWNER' || m.role !== 'OWNER') ? (
                <Button variant="danger" aria-label={`Remove ${m.name}`} onClick={() => void remove(m)}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {tab === 'invitations' && canManage ? <Invitations orgId={id} workspaces={org.workspaces} /> : null}
      {tab === 'audit' && canManage ? <AuditLog orgId={id} /> : null}
      {tab === 'plan' ? <PlanUsage orgId={id} isOwner={org.role === 'OWNER'} /> : null}
      {tab === 'settings' && canManage ? (
        <OrganisationSettings
          orgId={id}
          name={org.name}
          isOwner={org.role === 'OWNER'}
          onRenamed={() => void refreshOrganisations()}
          onDeleted={async () => {
            await refreshOrganisations();
            router.replace('/settings/account');
          }}
        />
      ) : null}
    </div>
  );
}

function Invitations({ orgId, workspaces }: { orgId: string; workspaces: { id: string; name: string }[] }) {
  const toast = useToast();
  const [list, setList] = useState<InvitationDto[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'MEMBER' | 'GUEST'>('MEMBER');
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRoleValue>('MEMBER');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string; emailSent: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList((await api.invitations.list(orgId)).invitations);
  }, [orgId]);

  useEffect(() => {
    void load().catch((err) => setError(errorMessage(err)));
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { invitation } = await api.invitations.create(orgId, {
        email: email.trim(),
        role,
        workspaceId: workspaceId || null,
        workspaceRole: workspaceId ? workspaceRole : null,
      });
      setLink({ email: invitation.email, url: `${window.location.origin}${invitation.invitePath}`, emailSent: invitation.emailSent });
      setEmail('');
      void load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inv: InvitationDto) {
    try {
      await api.invitations.revoke(orgId, inv.id);
      toast({ tone: 'success', message: `Invitation to ${inv.email} revoked.` });
      void load();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-3 rounded-xl border border-line bg-surface p-4" aria-label="Invite someone">
        <h2 className="font-semibold">Invite someone</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" htmlFor="invite-email">
            <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Organisation role" htmlFor="invite-role">
            <Select id="invite-role" className="h-9 w-full" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="ADMIN">Admin — manages members and every workspace</option>
              <option value="MEMBER">Member — works in workspaces they are added to</option>
              <option value="GUEST">Guest — limited access, e.g. clients</option>
            </Select>
          </Field>
          <Field label="Add to workspace" htmlFor="invite-ws">
            <Select id="invite-ws" className="h-9 w-full" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              <option value="">No workspace yet</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          {workspaceId ? (
            <Field label="Workspace role" htmlFor="invite-ws-role">
              <Select id="invite-ws-role" className="h-9 w-full" value={workspaceRole} onChange={(e) => setWorkspaceRole(e.target.value as WorkspaceRoleValue)}>
                <option value="ADMIN">Admin</option>
                <option value="MEMBER">Member</option>
                <option value="VIEWER">Viewer (read-only)</option>
              </Select>
            </Field>
          ) : null}
        </div>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        <Button type="submit" variant="primary" busy={busy} disabled={!email.trim()}>
          Create invitation
        </Button>
        {link ? (
          <div className="rounded-lg bg-surface-2 p-3" data-invite-link>
            <p className="text-[13px]">
              {link.emailSent ? (
                <>An invitation email to <strong>{link.email}</strong> is on its way (we retry automatically if delivery is delayed). You can also share this link directly. </>
              ) : (
                <>An email for this invitation was already queued. You can also send this link to <strong>{link.email}</strong> yourself. </>
              )}
              It works once, only for that email address, and expires in 7 days. It won’t be shown again.
            </p>
            <div className="mt-2 flex gap-2">
              <Input readOnly aria-label="Invitation link" value={link.url} onFocus={(e) => e.target.select()} className="h-8 font-mono text-[12px]" />
              <Button
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(link.url)
                    .then(() => toast({ tone: 'success', message: 'Link copied.' }))
                    .catch(() => toast({ tone: 'error', message: 'Copy failed — select the link and copy it manually.' }))
                }
              >
                Copy
              </Button>
            </div>
          </div>
        ) : null}
      </form>

      <section aria-labelledby="pending-title">
        <h2 id="pending-title" className="mb-2 font-semibold">Pending invitations</h2>
        {!list ? (
          <PageLoading />
        ) : list.length === 0 ? (
          <p className="text-muted">No pending invitations.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {list.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{inv.email}</p>
                  <p className="text-[12px] text-muted">
                    {ORG_ROLE_LABEL[inv.role]}
                    {inv.workspaceName && inv.workspaceRole ? ` · ${inv.workspaceName} (${WS_ROLE_LABEL[inv.workspaceRole]})` : ''} · invited by {inv.invitedBy.name} ·{' '}
                    {inv.status === 'expired' ? 'expired' : `expires ${new Date(inv.expiresAt).toLocaleDateString()}`}
                  </p>
                </div>
                {inv.status === 'expired' ? <Badge tone="warning">Expired</Badge> : null}
                <Button variant="danger" aria-label={`Revoke invitation to ${inv.email}`} onClick={() => void revoke(inv)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const AUDIT_LABEL: Record<string, string> = {
  'organisation.created': 'created the organisation',
  'workspace.created': 'created a workspace',
  'invitation.created': 'invited someone',
  'invitation.revoked': 'revoked an invitation',
  'invitation.accepted': 'accepted an invitation',
  'member.role_changed': 'changed a member’s role',
  'member.removed': 'removed a member',
  'member.left': 'left the organisation',
  'workspace_member.set': 'changed workspace access',
  'workspace_member.removed': 'removed workspace access',
};

function AuditLog({ orgId }: { orgId: string }) {
  const [entries, setEntries] = useState<AuditEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.members
      .audit(orgId)
      .then((r) => setEntries(r.entries))
      .catch((err) => setError(errorMessage(err)));
  }, [orgId]);
  if (error) return <ErrorBanner message={error} />;
  if (!entries) return <PageLoading />;
  const detail = (e: AuditEntryDto) => {
    const d = e.data;
    if (d.email) return String(d.email);
    if (d.from && d.to) return `${d.from} → ${d.to}`;
    if (d.workspaceName) return `${d.workspaceName}${d.role ? ` (${d.role})` : ''}`;
    if (d.name) return String(d.name);
    return '';
  };
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-2 py-2 font-medium">Who</th>
            <th className="px-2 py-2 font-medium">What</th>
            <th className="px-2 py-2 font-medium">Detail</th>
            <th className="px-2 py-2 font-medium">IP</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {entries.map((e) => (
            <tr key={e.id} data-audit={e.action}>
              <td className="whitespace-nowrap px-4 py-2 text-muted">{new Date(e.createdAt).toLocaleString()}</td>
              <td className="px-2 py-2">{e.actor?.name ?? 'System'}</td>
              <td className="px-2 py-2">{AUDIT_LABEL[e.action] ?? e.action}</td>
              <td className="px-2 py-2 text-muted">{detail(e)}</td>
              <td className="px-2 py-2 text-muted">{e.ip ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const USAGE_LABEL: Record<string, string> = {
  projects: 'Projects',
  members: 'Members and pending invitations',
  aiRequestsPerMonth: 'AI requests this month',
  automationRules: 'Automation rules',
};

const PLANS = ['FREE', 'PRO', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as const;
const planName = (p: string) => p.charAt(0) + p.slice(1).toLowerCase();

function PlanUsage({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const toast = useToast();
  const [choice, setChoice] = useState<(typeof PLANS)[number] | ''>('');
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<{ plan: string; limits: Record<string, number | null>; usage: Record<string, number> } | null>(null);
  useEffect(() => {
    api.usage(orgId).then(setData).catch(() => undefined);
  }, [orgId]);
  if (!data) return <PageLoading />;
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4" data-plan={data.plan}>
      <p>
        Current plan: <strong>{data.plan.charAt(0) + data.plan.slice(1).toLowerCase()}</strong>
      </p>
      <ul className="space-y-2">
        {Object.entries(data.usage).map(([k, used]) => {
          const limit = data.limits[k];
          const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
          return (
            <li key={k}>
              <div className="flex justify-between text-[13px]">
                <span>{USAGE_LABEL[k] ?? k}</span>
                <span className="text-muted">{used} / {limit ?? 'unlimited'}</span>
              </div>
              {limit ? <div className="mt-1 h-1.5 rounded-full bg-surface-2"><div className={pct >= 100 ? 'h-1.5 rounded-full bg-warning' : 'h-1.5 rounded-full bg-accent'} style={{ width: `${pct}%` }} /></div> : null}
            </li>
          );
        })}
      </ul>
      {isOwner ? (
        <div className="border-t border-line pt-3">
          <h3 className="mb-1 font-medium">Change plan</h3>
          <p className="mb-2 text-[13px] text-muted">
            Monty runs on your own server, so there’s no payment: pick the plan whose limits suit you. <strong>Enterprise</strong> has no limits. Lowering a plan never deletes anything; it only stops new additions above the limit.
          </p>
          <div className="overflow-x-auto">
            <table className="mb-3 w-full text-[13px]">
              <caption className="sr-only">Plan limits</caption>
              <thead>
                <tr className="text-left text-muted">
                  <th scope="col" className="py-1 pr-3 font-medium">Plan</th>
                  {Object.keys(data.limits).map((k) => <th key={k} scope="col" className="py-1 pr-3 font-medium">{USAGE_LABEL[k] ?? k}</th>)}
                </tr>
              </thead>
              <tbody>
                {PLANS.map((p) => (
                  <tr key={p} className={p === data.plan ? 'font-semibold' : ''}>
                    <th scope="row" className="py-1 pr-3 text-left">{planName(p)}{p === data.plan ? ' (current)' : ''}</th>
                    {Object.keys(data.limits).map((k) => <td key={k} className="py-1 pr-3">{PLAN_LIMITS[p][k as keyof (typeof PLAN_LIMITS)['FREE']] ?? 'Unlimited'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2">
            <Select aria-label="Plan" value={choice || data.plan} onChange={(e) => setChoice(e.target.value as (typeof PLANS)[number])}>
              {PLANS.map((p) => <option key={p} value={p}>{planName(p)}</option>)}
            </Select>
            <Button
              variant="primary"
              busy={saving}
              disabled={!choice || choice === data.plan}
              onClick={async () => {
                if (!choice) return;
                setSaving(true);
                try {
                  setData(await api.setPlan(orgId, choice));
                  setChoice('');
                  toast({ tone: 'success', message: `Plan changed to ${planName(choice)}` });
                } catch (err) {
                  toast({ tone: 'error', message: errorMessage(err) });
                } finally {
                  setSaving(false);
                }
              }}
            >
              Change plan
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-muted">Only the organisation owner can change the plan.</p>
      )}
    </div>
  );
}

function OrganisationSettings(props: { orgId: string; name: string; isOwner: boolean; onRenamed: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(props.name);
  const [renaming, setRenaming] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename(e: FormEvent) {
    e.preventDefault();
    setRenaming(true);
    try {
      await api.organisations.rename(props.orgId, name.trim());
      toast({ tone: 'success', message: 'Organisation renamed.' });
      props.onRenamed();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setRenaming(false);
    }
  }

  async function remove(e: FormEvent) {
    e.preventDefault();
    setDeleting(true);
    setError(null);
    try {
      const { organisation } = await api.organisations.scheduleDeletion(props.orgId, confirmName, password);
      toast({ tone: 'success', message: `${organisation.name} is scheduled for deletion. You can restore it until ${organisation.purgeAfter.slice(0, 10)}.` });
      props.onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={rename} className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-2 font-semibold">Organisation name</h2>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Name" htmlFor="org-name">
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </Field>
          <Button type="submit" busy={renaming} disabled={!name.trim() || name.trim() === props.name}>Save name</Button>
        </div>
      </form>

      {props.isOwner ? (
        <form onSubmit={remove} className="rounded-xl border border-danger/40 bg-surface p-4" aria-labelledby="danger-heading">
          <h2 id="danger-heading" className="font-semibold text-danger">Delete organisation</h2>
          <p className="mt-1 text-[13px] text-muted">
            Everyone loses access immediately and members are emailed. Owners can restore it from Account & data for 30 days; after that all its
            workspaces, projects, tasks, documents, comments and history are erased permanently.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={`Type “${props.name}” to confirm`} htmlFor="org-confirm-name">
              <Input id="org-confirm-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" required />
            </Field>
            <Field label="Your password" htmlFor="org-delete-password">
              <Input id="org-delete-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </div>
          {error ? <p role="alert" className="mt-2 text-danger">{error}</p> : null}
          <Button className="mt-3" type="submit" variant="danger" busy={deleting} disabled={confirmName !== props.name || !password}>
            Delete organisation
          </Button>
        </form>
      ) : (
        <p className="text-[13px] text-muted">Only an owner can delete this organisation.</p>
      )}
    </div>
  );
}
