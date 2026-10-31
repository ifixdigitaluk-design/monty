'use client';

import type { InvitationPreviewDto, UserDto } from '@monty/validation';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, ErrorBanner, PageLoading } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { ORG_ROLE_LABEL } from '@/lib/labels';

export default function InvitePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Invite />
    </Suspense>
  );
}

function Invite() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [invite, setInvite] = useState<InvitationPreviewDto | null>(null);
  const [user, setUser] = useState<UserDto | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.invitations
      .preview(token)
      .then((r) => setInvite(r.invitation))
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? 'This invitation link is not valid.' : errorMessage(err)));
    api.auth
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, [token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const { workspaceId } = await api.invitations.accept(token);
      router.replace(workspaceId ? `/workspace?id=${workspaceId}` : '/tasks');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const next = encodeURIComponent(`/invite?token=${token}`);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-line bg-surface p-6">
        {error && !invite ? (
          <ErrorBanner message={error} />
        ) : !invite || user === undefined ? (
          <PageLoading />
        ) : (
          <>
            <h1 className="text-lg font-semibold">Join {invite.organisationName}</h1>
            <p className="text-muted">
              {invite.invitedByName} invited <strong className="text-fg">{invite.email}</strong> to join as{' '}
              {ORG_ROLE_LABEL[invite.role].toLowerCase()}
              {invite.workspaceName ? <> with access to <strong className="text-fg">{invite.workspaceName}</strong></> : null}.
            </p>
            {invite.status !== 'pending' ? (
              <ErrorBanner message={`This invitation is ${invite.status}. Ask ${invite.invitedByName} for a new one.`} />
            ) : user ? (
              <>
                {user.email !== invite.email ? (
                  <p role="alert" className="text-danger">
                    You’re signed in as {user.email}. This invitation is for {invite.email}; sign in with that account to accept.
                  </p>
                ) : null}
                {error ? <p role="alert" className="text-danger">{error}</p> : null}
                <Button variant="primary" className="w-full" busy={busy} disabled={user.email !== invite.email} onClick={() => void accept()}>
                  Accept invitation
                </Button>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-[13px] text-muted">Sign in or create an account with {invite.email} to accept. Your personal workspace stays separate.</p>
                <div className="flex gap-2">
                  <Link
                    className="flex h-8 flex-1 items-center justify-center rounded-lg bg-accent text-[13px] font-medium text-accent-fg hover:opacity-90"
                    href={`/register?next=${next}&email=${encodeURIComponent(invite.email)}`}
                  >
                    Create account
                  </Link>
                  <Link
                    className="flex h-8 flex-1 items-center justify-center rounded-lg border border-line bg-surface text-[13px] font-medium hover:bg-surface-2"
                    href={`/login?next=${next}&email=${encodeURIComponent(invite.email)}`}
                  >
                    Sign in
                  </Link>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
