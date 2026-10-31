'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { CenteredCard } from '@/components/CenteredCard';
import { Button, Field, Input, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ResetPassword />
    </Suspense>
  );
}

function ResetPassword() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('The passwords don’t match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.auth.confirmPasswordReset(token, password);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <CenteredCard title="Password changed">
        <p role="status">Your password has been changed and you’ve been signed out on every device.</p>
        <Link className="flex h-8 items-center justify-center rounded-lg bg-accent text-[13px] font-medium text-accent-fg" href="/login">
          Sign in
        </Link>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard title="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password" htmlFor="password" hint="At least 10 characters.">
          <Input id="password" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm">
          <Input id="confirm" type="password" autoComplete="new-password" minLength={10} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error ? (
          <p role="alert" className="text-danger">
            {error}{' '}
            {/expired|invalid/i.test(error) ? <Link className="underline" href="/forgot-password">Request a new link</Link> : null}
          </p>
        ) : null}
        <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!password || !confirm}>
          Change password
        </Button>
      </form>
    </CenteredCard>
  );
}
