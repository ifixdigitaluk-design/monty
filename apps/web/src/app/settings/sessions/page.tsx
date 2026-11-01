'use client';

import type { SessionDto } from '@monty/validation';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge, Button, ErrorBanner, PageLoading, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { TwoFactor } from '@/components/security/TwoFactor';

export default function SessionsPage() {
  return (
    <AppShell>
      <Sessions />
    </AppShell>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions((await api.auth.sessions()).sessions);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    try {
      await api.auth.revokeSession(id);
      setSessions((all) => all?.filter((s) => s.id !== id) ?? null);
      toast({ tone: 'success', message: 'Session signed out.' });
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!sessions) return <PageLoading />;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">Sessions & security</h1>
      <div className="mb-6 mt-4">
        <TwoFactor />
      </div>
      <h2 className="font-semibold">Signed-in devices</h2>
      <p className="mb-3 text-muted">Devices currently signed in to your account. Sign out any you don’t recognise.</p>
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate">{s.userAgent ?? 'Unknown device'}</p>
              <p className="text-[12px] text-muted">
                {s.ip ?? 'Unknown IP'} · signed in {new Date(s.createdAt).toLocaleString()} · last active{' '}
                {new Date(s.lastSeenAt).toLocaleString()}
              </p>
            </div>
            {s.current ? (
              <Badge tone="accent">This device</Badge>
            ) : (
              <Button variant="danger" onClick={() => void revoke(s.id)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
