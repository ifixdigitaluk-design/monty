'use client';

import { canInOrg } from '@monty/domain';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, ReactNode, Suspense, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { RequireSession, useSession } from '@/lib/session';
import { Button, cx, Field, Input, Modal, PageLoading } from './ui';
import { SearchPalette } from './SearchPalette';

export function AppShell({ children }: { children: ReactNode }) {
  // Suspense is required because the shell and pages read query parameters (static-export friendly routing, ADR-005).
  return (
    <Suspense fallback={<PageLoading />}>
      <RequireSession fallback={<PageLoading />}>
        <Shell>{children}</Shell>
      </RequireSession>
    </Suspense>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r border-line bg-surface transition-transform md:static md:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Sidebar onNavigate={() => setNavOpen(false)} />
      </aside>
      {navOpen ? <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setNavOpen(false)} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center border-b border-line px-3 md:hidden">
          <Button variant="ghost" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
            ☰
          </Button>
          <span className="ml-2 font-semibold">Monty</span>
        </header>
        <VerifyBanner />
        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { user, organisations, refreshOrganisations, logout } = useSession();
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const activeWorkspace = pathname === '/workspace' ? params.get('id') : null;
  const [orgModal, setOrgModal] = useState(false);
  const [wsModalOrg, setWsModalOrg] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [chatUnread, setChatUnread] = useState({ unread: 0, mentions: 0 });
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api.chat
        .unread()
        .then((r) => alive && setChatUnread(r.workspaces.reduce((a, w) => ({ unread: a.unread + w.unread, mentions: a.mentions + w.mentions }), { unread: 0, mentions: 0 })))
        .catch(() => undefined);
    void poll();
    const t = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pathname]);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    api.notifications
      .list(true)
      .then((r) => setUnread(r.unread))
      .catch(() => undefined);
  }, [pathname]);

  const navItem = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx('block rounded-md px-2 py-1.5 hover:bg-surface-2', active && 'bg-surface-2 font-medium')}
    >
      {label}
    </Link>
  );

  return (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="flex h-12 items-center px-4 font-semibold tracking-tight">Monty</div>
      <div className="flex-1 space-y-5 overflow-y-auto px-2 pb-4">
        <div>
          <button
            className="mb-1 flex w-full items-center justify-between rounded-md border border-line px-2 py-1.5 text-left text-muted hover:bg-surface-2"
            onClick={() => setSearchOpen(true)}
          >
            Search <kbd className="text-[11px]">Ctrl K</kbd>
          </button>
          {navItem('/home', 'Home', pathname === '/home')}
          {navItem('/inbox', unread > 0 ? `Inbox (${unread})` : 'Inbox', pathname === '/inbox')}
          {navItem('/chat', chatUnread.mentions > 0 ? `Chat (@${chatUnread.mentions})` : chatUnread.unread > 0 ? `Chat (${chatUnread.unread})` : 'Chat', pathname === '/chat')}
          {navItem('/databases', 'Databases', pathname === '/databases')}
          {navItem('/crm', 'CRM', pathname.startsWith('/crm'))}
          {organisations.some((o) => o.kind === 'TEAM' && o.role !== 'GUEST') ? navItem('/hr', 'HR', pathname === '/hr') : null}
          {navItem('/tasks', 'My Tasks', pathname === '/tasks')}
          {navItem('/calendar', 'Calendar', pathname === '/calendar')}
        </div>

        {organisations.map((org) => (
          <div key={org.id}>
            <div className="flex items-center justify-between px-2 pb-1">
              <span className="truncate text-[12px] font-medium uppercase tracking-wide text-muted" title={org.name}>
                {org.kind === 'PERSONAL' ? 'Personal' : org.name}
              </span>
              {canInOrg(org.role, 'workspace.create') ? (
                <button
                  className="rounded px-1 text-muted hover:bg-surface-2 hover:text-fg"
                  aria-label={`New workspace in ${org.name}`}
                  title="New workspace"
                  onClick={() => setWsModalOrg(org.id)}
                >
                  +
                </button>
              ) : null}
            </div>
            {org.kind === 'TEAM' && canInOrg(org.role, 'org.read')
              ? navItem(`/organisation?id=${org.id}`, 'Members & settings', pathname === '/organisation' && params.get('id') === org.id)
              : null}
            {org.workspaces.length === 0 ? (
              <p className="px-2 text-[12px] text-muted">No workspaces you can access.</p>
            ) : (
              org.workspaces.map((ws) => (
                <div key={ws.id}>{navItem(`/workspace?id=${ws.id}`, ws.name, activeWorkspace === ws.id)}</div>
              ))
            )}
          </div>
        ))}

        <div className="px-2">
          <Button variant="ghost" className="w-full justify-start px-0" onClick={() => setOrgModal(true)}>
            + New organisation
          </Button>
        </div>
      </div>
      <div className="border-t border-line p-2">
        {navItem('/settings/sessions', 'Sessions & security', pathname === '/settings/sessions')}
        {navItem('/settings/account', 'Account & data', pathname === '/settings/account')}
        <div className="flex items-center justify-between px-2 pt-2">
          <span className="truncate text-[13px] text-muted" title={user.email}>
            {user.name}
          </span>
          <Button variant="ghost" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </div>

      {searchOpen ? <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} /> : null}
      <NameModal
        open={orgModal}
        title="New organisation"
        label="Organisation name"
        placeholder="Acme Agency"
        onClose={() => setOrgModal(false)}
        onSubmit={async (name) => {
          const { organisation } = await api.organisations.create({ name });
          await refreshOrganisations();
          router.push(`/workspace?id=${organisation.workspaces[0]!.id}`);
        }}
      />
      <NameModal
        open={wsModalOrg !== null}
        title="New workspace"
        label="Workspace name"
        placeholder="Marketing"
        onClose={() => setWsModalOrg(null)}
        onSubmit={async (name) => {
          const { workspace } = await api.organisations.createWorkspace(wsModalOrg!, { name });
          await refreshOrganisations();
          router.push(`/workspace?id=${workspace.id}`);
        }}
      />
    </nav>
  );
}

function NameModal(props: {
  open: boolean;
  title: string;
  label: string;
  placeholder: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `name-${props.title.replace(/\s/g, '-').toLowerCase()}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(name.trim());
      setName('');
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.open} onClose={props.onClose} title={props.title}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={props.label} htmlFor={id}>
          <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={props.placeholder} required autoFocus />
        </Field>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Reminds unverified users to confirm their email (needed for password recovery to be trustworthy). */
function VerifyBanner() {
  const { user } = useSession();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  if (user.emailVerified) return null;
  return (
    <div role="region" aria-label="Email confirmation" className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[13px]">
      <span>Please confirm your email address ({user.email}). We sent you a link when you signed up.</span>
      {state === 'sent' ? (
        <span className="text-success">New link sent.</span>
      ) : (
        <Button
          variant="ghost"
          busy={state === 'sending'}
          onClick={async () => {
            setState('sending');
            try {
              await api.auth.resendVerification();
              setState('sent');
            } catch {
              setState('error');
            }
          }}
        >
          Resend link
        </Button>
      )}
      {state === 'error' ? <span className="text-danger">Couldn’t send — try again shortly.</span> : null}
    </div>
  );
}
